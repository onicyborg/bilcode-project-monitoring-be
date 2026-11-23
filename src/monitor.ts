import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Client } from "pg";
import { Bids } from "./bids";
import { createHash } from "node:crypto";
import { Database } from "./database";
import { Secrets } from "./secrets";
import { Audit } from "./audit";
import { SettingsDto } from "./dto";
import { isRecord, Upstream, UpstreamError } from "./upstream";
import { CheckRun, Configuration, Prisma } from "./generated/prisma/client";

export function jsonMessages(project: unknown) {
  const text = JSON.stringify(project, null, 2).replace(/`/g, "\\u0060");
  const characters = Array.from(text);
  const pieces: string[] = [];
  for (let i = 0; i < characters.length; i += 3500)
    pieces.push(characters.slice(i, i + 3500).join(""));
  const id =
    isRecord(project) && Number.isSafeInteger(project.id)
      ? Number(project.id)
      : null;
  const origin = (process.env.APP_ORIGIN || "http://localhost:3100").split(
    ",",
  )[0];
  const link = id
    ? `\nBuka proyek & konfirmasi penawaran: ${origin}/bids?project=${id}`
    : "";
  return pieces.map(
    (piece, i) =>
      `Proyek Bilcode baru${pieces.length > 1 ? ` (${i + 1}/${pieces.length})` : ""}\n\`\`\`\n${piece}\n\`\`\`${i === pieces.length - 1 ? link : ""}`,
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function projectKey(project: unknown) {
  if (project && typeof project === "object" && !Array.isArray(project)) {
    const value = project as Record<string, unknown>;
    for (const field of ["id", "uuid", "project_id"]) {
      if (typeof value[field] === "string" || typeof value[field] === "number")
        return `${field}:${value[field]}`;
    }
  }
  return `sha256:${createHash("sha256").update(canonical(project)).digest("hex")}`;
}

export function extractCookie(raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BadRequestException(
      "JSON cookie tidak valid. Gunakan hasil export cookie browser.",
    );
  }
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.cookies)
      ? value.cookies
      : [value];
  const cookie = list
    .filter(isRecord)
    .find(
      (item) =>
        item.name === "bilcode_refresh_token" &&
        ["bilcode.id", "api.bilcode.id"].includes(
          String(item.domain || "").replace(/^\./, ""),
        ),
    );
  if (
    !cookie ||
    typeof cookie.value !== "string" ||
    !/^[^\s;,\r\n]{16,4096}$/.test(cookie.value)
  ) {
    throw new BadRequestException(
      "Cookie bilcode_refresh_token untuk domain bilcode.id tidak ditemukan atau tidak valid.",
    );
  }
  if (
    typeof cookie.expirationDate === "number" &&
    cookie.expirationDate * 1000 < Date.now()
  ) {
    throw new BadRequestException(
      "Cookie sudah kedaluwarsa. Ekspor cookie dari sesi login yang baru.",
    );
  }
  return cookie.value as string;
}

@Injectable()
export class Monitor implements OnModuleInit, OnModuleDestroy {
  private gate: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private inFlight?: Promise<void>;
  private pauseRequested = true;
  private busy = false;
  private accessToken?: string;
  private lease?: Client;
  private leaseHealthy = false;
  private pendingOtp?: { email: string; expiresAt: number; attempts: number };
  private otpRequestedAt = 0;

  constructor(
    private readonly db: Database,
    private readonly secrets: Secrets,
    private readonly upstream: Upstream,
    private readonly audit: Audit,
    private readonly bids: Bids,
  ) {}

  async onModuleInit() {
    // Session advisory locks require a direct connection, outside Neon's transaction pooler.
    this.lease = new Client({
      connectionString:
        process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL,
      keepAlive: true,
      connectionTimeoutMillis: 15000,
    });
    await this.lease.connect();
    const lock = await this.lease.query(
      "SELECT pg_try_advisory_lock(19860204, 741) AS acquired",
    );
    if (!lock.rows[0]?.acquired)
      throw new Error(
        "Another monitoring backend is already using this database",
      );
    this.leaseHealthy = true;
    await this.bids.recover();
    this.lease.on("error", () => {
      this.leaseHealthy = false;
      this.pauseRequested = true;
      clearTimeout(this.timer);
      this.controller?.abort();
      console.error("Monitoring lease connection lost; monitoring halted.");
      process.kill(process.pid, "SIGTERM");
    });
    await this.db.configuration.upsert({
      where: { id: "main" },
      update: {},
      create: {
        id: "main",
        gowaPasswordEncrypted: process.env.INITIAL_GOWA_PASSWORD
          ? this.secrets.encrypt(process.env.INITIAL_GOWA_PASSWORD)
          : null,
      },
    });
    await this.db.bilcodeSession.upsert({
      where: { id: "main" },
      update: {},
      create: { id: "main" },
    });
    const state = await this.db.monitorState.upsert({
      where: { id: "main" },
      update: {},
      create: { id: "main" },
    });
    await this.db.checkRun.updateMany({
      where: { status: "RUNNING" },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        error: "Backend sebelumnya berhenti sebelum pengecekan selesai.",
      },
    });
    await this.db.eventLog.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 14 * 86400000) } },
    });
    await this.audit.record(
      "BACKEND_STARTED",
      "Backend siap. Status monitoring dipulihkan dari database.",
    );
    this.pauseRequested = !state.desiredRunning;
    if (state.desiredRunning) this.schedule(0);
  }
  async onModuleDestroy() {
    this.pauseRequested = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    await this.inFlight?.catch(() => undefined);
    await this.lease?.end();
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.gate;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  private async stoppedOnly() {
    const state = await this.db.monitorState.findUniqueOrThrow({
      where: { id: "main" },
    });
    if (state.desiredRunning || !this.pauseRequested)
      throw new ConflictException(
        "Hentikan monitoring sebelum mengubah sesi atau konfigurasi.",
      );
  }
  private assertLease() {
    if (!this.leaseHealthy)
      throw new ServiceUnavailableException(
        "Koneksi pengendali monitoring terputus. Restart backend sebelum melanjutkan.",
      );
  }
  async summary() {
    const [state, session, config, checks, notifications, latestChecks] =
      await Promise.all([
        this.db.monitorState.findUniqueOrThrow({ where: { id: "main" } }),
        this.db.bilcodeSession.findUniqueOrThrow({ where: { id: "main" } }),
        this.db.configuration.findUniqueOrThrow({ where: { id: "main" } }),
        this.db.checkRun.count({
          where: { startedAt: { gte: new Date(Date.now() - 86400000) } },
        }),
        this.db.notification.count({ where: { status: "SENT" } }),
        this.db.checkRun.findMany({ take: 6, orderBy: { startedAt: "desc" } }),
      ]);
    const { refreshTokenEncrypted, ...safeSession } = session;
    const { gowaPasswordEncrypted, ...safeConfig } = config;
    return {
      state: { ...state, busy: this.busy, leaseHealthy: this.leaseHealthy },
      session: { ...safeSession, hasCookie: Boolean(refreshTokenEncrypted) },
      config: {
        ...safeConfig,
        hasGowaPassword: Boolean(gowaPasswordEncrypted),
      },
      statistics: { checks24h: checks, notificationsSent: notifications },
      latestChecks,
    };
  }
  private async authorized<T>(
    request: (token: string) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (!this.accessToken) await this.refresh(signal);
    try {
      return await request(this.accessToken!);
    } catch (error) {
      if (!(error instanceof UpstreamError) || !error.auth || signal.aborted)
        throw error;
      await this.refresh(signal);
      return request(this.accessToken!);
    }
  }
  async refreshBidDashboard() {
    return this.bidOperation(async (signal) => {
      await this.bids.rememberProjects(await this.fetchProjects(signal));
      await this.bids.sync(
        (request) => this.authorized(request, signal),
        signal,
      );
      const config = await this.db.configuration.findUniqueOrThrow({
        where: { id: "main" },
      });
      await this.bids.notify(config, signal);
      return { message: "Proyek dan status bid diperbarui." };
    });
  }
  async submitBid(projectId: number, version: string) {
    return this.bidOperation(async (signal) => {
      const result = await this.bids.submit(
        projectId,
        version,
        (request) => this.authorized(request, signal),
        async () => {
          await this.bids.rememberProjects(await this.fetchProjects(signal));
        },
        signal,
      );
      const config = await this.db.configuration.findUniqueOrThrow({
        where: { id: "main" },
      });
      await this.bids.notify(config, signal);
      return result;
    });
  }
  private async bidOperation<T>(work: (signal: AbortSignal) => Promise<T>) {
    if (this.busy || this.inFlight)
      throw new ConflictException(
        "Pengecekan atau pengajuan lain sedang berjalan. Coba sebentar lagi.",
      );
    return this.exclusive(async () => {
      this.assertLease();
      const session = await this.db.bilcodeSession.findUniqueOrThrow({
        where: { id: "main" },
      });
      if (session.authStatus !== "VALID")
        throw new BadRequestException("Validasi sesi Bilcode terlebih dahulu.");
      this.busy = true;
      this.controller = new AbortController();
      try {
        return await work(this.controller.signal);
      } catch (error) {
        if (
          error instanceof BadRequestException ||
          error instanceof ConflictException
        )
          throw error;
        if (error instanceof UpstreamError && error.auth) {
          this.accessToken = undefined;
          await this.db.bilcodeSession.update({
            where: { id: "main" },
            data: {
              authStatus: "INVALID",
              lastError: "Sesi Bilcode ditolak saat memproses bid.",
            },
          });
        }
        await this.bids.syncFailure(error);
        throw new BadRequestException(
          "Operasi bid belum selesai. Periksa status pengajuan dan sesi sebelum mencoba kembali.",
        );
      } finally {
        this.busy = false;
        this.controller = undefined;
      }
    });
  }
  async importCookie(raw: string) {
    const token = extractCookie(raw);
    return this.exclusive(async () => {
      await this.stoppedOnly();
      this.pendingOtp = undefined;
      this.accessToken = undefined;
      await this.db.bilcodeSession.update({
        where: { id: "main" },
        data: {
          refreshTokenEncrypted: this.secrets.encrypt(token),
          authStatus: "UNVERIFIED",
          importedAt: new Date(),
          validatedAt: null,
          refreshedAt: null,
          lastError: null,
        },
      });
      await this.audit.record(
        "COOKIE_IMPORTED",
        "Cookie Bilcode diganti. Validasi diperlukan sebelum monitoring dimulai.",
      );
      return this.summary();
    });
  }
  async removeCookie() {
    return this.exclusive(async () => {
      await this.stoppedOnly();
      this.pendingOtp = undefined;
      this.accessToken = undefined;
      await this.db.bilcodeSession.update({
        where: { id: "main" },
        data: {
          refreshTokenEncrypted: null,
          authStatus: "MISSING",
          importedAt: null,
          validatedAt: null,
          refreshedAt: null,
          lastError: null,
        },
      });
      await this.audit.record(
        "COOKIE_REMOVED",
        "Credential Bilcode dihapus dari penyimpanan.",
      );
      return this.summary();
    });
  }
  async requestOtp(email: string) {
    return this.exclusive(async () => {
      await this.stoppedOnly();
      if (Date.now() - this.otpRequestedAt < 60000)
        throw new BadRequestException(
          "Tunggu 60 detik sebelum meminta OTP kembali.",
        );
      this.otpRequestedAt = Date.now();
      this.pendingOtp = undefined;
      try {
        await this.upstream.requestEmailOtp(email);
        this.pendingOtp = {
          email,
          expiresAt: Date.now() + 10 * 60000,
          attempts: 0,
        };
        await this.audit.record(
          "BILCODE_OTP_REQUESTED",
          "Kode login Bilcode diminta melalui email.",
        );
        return {
          message: "Periksa email untuk kode OTP Bilcode.",
          retryAfterSeconds: 60,
        };
      } catch (error) {
        await this.audit.record(
          "BILCODE_OTP_REQUEST_FAILED",
          "Permintaan OTP Bilcode gagal.",
          "ERROR",
        );
        throw new BadRequestException(
          error instanceof UpstreamError && error.auth
            ? "Bilcode menolak permintaan OTP. Periksa email akun dan coba kembali."
            : "OTP belum dapat dikirim. Tunggu 60 detik lalu coba kembali.",
        );
      }
    });
  }
  async verifyOtp(email: string, code: string) {
    return this.exclusive(async () => {
      await this.stoppedOnly();
      const pending = this.pendingOtp;
      if (
        !pending ||
        pending.email !== email ||
        pending.expiresAt <= Date.now() ||
        pending.attempts >= 5
      )
        throw new BadRequestException(
          "Permintaan OTP tidak berlaku. Minta kode baru dari panel ini.",
        );
      pending.attempts++;
      let token: string;
      try {
        token = await this.upstream.verifyEmailOtp(email, code);
      } catch {
        await this.audit.record(
          "BILCODE_OTP_VERIFY_FAILED",
          "Verifikasi kode login Bilcode gagal.",
          "WARNING",
        );
        throw new BadRequestException(
          "Verifikasi OTP gagal. Periksa kode terbaru atau minta kode baru setelah 60 detik.",
        );
      }
      this.pendingOtp = undefined;
      this.accessToken = undefined;
      await this.db.bilcodeSession.update({
        where: { id: "main" },
        data: {
          refreshTokenEncrypted: this.secrets.encrypt(token),
          authStatus: "UNVERIFIED",
          importedAt: new Date(),
          validatedAt: null,
          refreshedAt: null,
          lastError: null,
        },
      });
      await this.audit.record(
        "BILCODE_OTP_LOGIN",
        "Login OTP berhasil. Sesi tersimpan; validasi diperlukan sebelum monitoring dimulai.",
        "SUCCESS",
      );
      return {
        message:
          "Sesi Bilcode tersimpan. Jalankan validasi sesi sebelum Mulai.",
      };
    });
  }
  private async refresh(signal: AbortSignal) {
    const session = await this.db.bilcodeSession.findUniqueOrThrow({
      where: { id: "main" },
    });
    if (!session.refreshTokenEncrypted)
      throw new UpstreamError("Cookie Bilcode belum tersedia.", true);
    const result = await this.upstream.refresh(
      this.secrets.decrypt(session.refreshTokenEncrypted),
      signal,
    );
    // Persist rotation before any subsequent API request can fail.
    await this.db.bilcodeSession.update({
      where: { id: "main" },
      data: {
        refreshTokenEncrypted: this.secrets.encrypt(result.refreshToken),
        refreshedAt: new Date(),
      },
    });
    this.accessToken = result.accessToken;
    await this.audit.record(
      "TOKEN_REFRESHED",
      "Access token diperbarui dan refresh cookie tersimpan.",
    );
  }
  private async fetchProjects(signal: AbortSignal) {
    if (!this.accessToken) await this.refresh(signal);
    const projects: unknown[] = [];
    for (let page = 1; page <= 1000; page++) {
      let result;
      try {
        result = await this.upstream.projects(this.accessToken!, page, signal);
      } catch (error) {
        if (!(error instanceof UpstreamError) || !error.auth) throw error;
        await this.refresh(signal);
        result = await this.upstream.projects(this.accessToken!, page, signal);
      }
      projects.push(...result.items);
      if (page >= result.lastPage) {
        await this.db.bilcodeSession.update({
          where: { id: "main" },
          data: {
            authStatus: "VALID",
            validatedAt: new Date(),
            lastError: null,
          },
        });
        return projects;
      }
    }
    throw new UpstreamError("Batas pagination terlampaui.");
  }
  async validateSession() {
    return this.exclusive(async () => {
      await this.stoppedOnly();
      this.controller = new AbortController();
      try {
        // Force validation against the stored refresh cookie, not a cached access token.
        this.accessToken = undefined;
        const projects = await this.fetchProjects(this.controller.signal);
        await this.audit.record(
          "SESSION_VALIDATED",
          `Validasi sesi berhasil. ${projects.length} proyek tersedia.`,
          "SUCCESS",
        );
        return {
          message: "Sesi valid. Monitoring dapat dimulai.",
          available: projects.length,
          summary: await this.summary(),
        };
      } catch (error) {
        const message = this.controller.signal.aborted
          ? "Validasi dibatalkan."
          : this.safeError(error);
        if (error instanceof UpstreamError && error.auth) {
          await this.db.bilcodeSession.update({
            where: { id: "main" },
            data: { authStatus: "INVALID", lastError: message },
          });
        }
        await this.audit.record("SESSION_VALIDATION_FAILED", message, "ERROR");
        throw new BadRequestException(message);
      } finally {
        this.controller = undefined;
      }
    });
  }
  async start() {
    return this.exclusive(async () => {
      this.assertLease();
      const state = await this.db.monitorState.findUniqueOrThrow({
        where: { id: "main" },
      });
      if (state.desiredRunning && !this.pauseRequested) return this.summary();
      const session = await this.db.bilcodeSession.findUniqueOrThrow({
        where: { id: "main" },
      });
      const config = await this.db.configuration.findUniqueOrThrow({
        where: { id: "main" },
      });
      if (session.authStatus !== "VALID" || !session.refreshTokenEncrypted)
        throw new BadRequestException(
          "Unggah dan validasi cookie Bilcode terlebih dahulu.",
        );
      if (!config.gowaPasswordEncrypted)
        throw new BadRequestException(
          "Lengkapi konfigurasi GOWA terlebih dahulu.",
        );
      this.pauseRequested = false;
      await this.db.monitorState.update({
        where: { id: "main" },
        data: { desiredRunning: true, nextCheckAt: new Date() },
      });
      await this.audit.record(
        "MONITOR_STARTED",
        "Monitoring dimulai oleh operator.",
      );
      this.schedule(0);
      return this.summary();
    });
  }
  async stop() {
    this.pauseRequested = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    return this.exclusive(async () => {
      // A queued start may have completed since stop was requested.
      this.pauseRequested = true;
      clearTimeout(this.timer);
      this.controller?.abort();
      await this.db.monitorState.update({
        where: { id: "main" },
        data: { desiredRunning: false, nextCheckAt: null },
      });
      await this.audit.record(
        "MONITOR_STOPPED",
        "Monitoring dihentikan. Tidak ada request Bilcode berjalan.",
      );
      return this.summary();
    });
  }
  async checkOnce() {
    if (this.inFlight || this.busy)
      throw new ConflictException("Pengecekan lain sedang berjalan.");
    return this.exclusive(async () => {
      await this.stoppedOnly();
      this.assertLease();
      const session = await this.db.bilcodeSession.findUniqueOrThrow({
        where: { id: "main" },
      });
      if (session.authStatus !== "VALID")
        throw new BadRequestException("Validasi sesi terlebih dahulu.");
      await this.cycle(true);
      return this.summary();
    });
  }
  private schedule(milliseconds: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.inFlight = this.exclusive(() => this.cycle(false))
        .catch(() => {
          console.error("Monitoring cycle failed; inspect application logs.");
        })
        .finally(async () => {
          this.inFlight = undefined;
          if (!this.pauseRequested && this.leaseHealthy) {
            try {
              const config = await this.db.configuration.findUniqueOrThrow({
                where: { id: "main" },
              });
              const delay = config.intervalSeconds * 1000;
              await this.db.monitorState.update({
                where: { id: "main" },
                data: { nextCheckAt: new Date(Date.now() + delay) },
              });
              if (!this.pauseRequested) this.schedule(delay);
            } catch {
              console.error("Failed to schedule next monitoring check.");
            }
          }
        });
    }, milliseconds);
    this.timer.unref();
  }
  private safeError(error: unknown) {
    return error instanceof UpstreamError
      ? error.message
      : "Terjadi kesalahan internal saat memproses pengecekan.";
  }
  private async authNotification(
    config: Configuration,
    recovered: boolean,
    signal: AbortSignal,
  ) {
    if (!config.authAlerts) return;
    const state = await this.db.monitorState.findUniqueOrThrow({
      where: { id: "main" },
    });
    if (recovered !== state.authAlerted) return;
    const status = recovered
      ? "authentication_recovered"
      : "authentication_failed";
    const message = recovered
      ? "Autentikasi Bilcode pulih. Pengecekan dapat dilanjutkan."
      : "Autentikasi Bilcode gagal. Hentikan monitoring dan perbarui cookie melalui panel.";
    try {
      await this.upstream.send(
        config,
        `${recovered ? "Autentikasi Bilcode pulih" : "Peringatan autentikasi Bilcode"}\n\`\`\`\n${JSON.stringify({ status, message, time: new Date().toISOString() }, null, 2)}\n\`\`\``,
        signal,
      );
      await this.db.monitorState.update({
        where: { id: "main" },
        data: { authAlerted: !recovered },
      });
      await this.audit.record(
        status.toUpperCase(),
        message,
        recovered ? "SUCCESS" : "WARNING",
        "NOTIFICATION",
      );
    } catch {
      if (!signal.aborted)
        await this.audit.record(
          "AUTH_ALERT_SEND_FAILED",
          "Peringatan autentikasi gagal dikirim. Akan dicoba pada siklus berikutnya.",
          "ERROR",
          "NOTIFICATION",
        );
    }
  }
  private async cycle(manual: boolean) {
    if ((!manual && this.pauseRequested) || !this.leaseHealthy) return;
    this.busy = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const started = Date.now();
    let run: CheckRun;
    let config: Configuration;
    try {
      run = await this.db.checkRun.create({ data: {} });
      config = await this.db.configuration.findUniqueOrThrow({
        where: { id: "main" },
      });
    } catch (error) {
      this.busy = false;
      this.controller = undefined;
      throw error;
    }
    let available = 0;
    let newProjects = 0;
    let sent = 0;
    try {
      try {
        await this.bids.sync(
          (request) => this.authorized(request, signal),
          signal,
        );
      } catch (error) {
        if (signal.aborted || (error instanceof UpstreamError && error.auth))
          throw error;
        await this.bids.syncFailure(error);
      }
      await this.bids.notify(config, signal);
      const projects = await this.fetchProjects(signal);
      await this.bids.rememberProjects(projects);
      available = projects.length;
      await this.authNotification(config, true, signal);
      for (const project of projects) {
        if (signal.aborted) throw new Error("Cancelled");
        const inserted = await this.db.notification.createMany({
          skipDuplicates: true,
          data: [
            {
              projectKey: projectKey(project),
              payload:
                project === null
                  ? Prisma.JsonNull
                  : (project as Prisma.InputJsonValue),
              parts: jsonMessages(project),
            },
          ],
        });
        newProjects += inserted.count;
      }
      const pending = await this.db.notification.findMany({
        where: { status: { not: "SENT" } },
        orderBy: { createdAt: "asc" },
      });
      for (const notification of pending) {
        if (signal.aborted) throw new Error("Cancelled");
        await this.db.notification.update({
          where: { id: notification.id },
          data: { attempts: { increment: 1 } },
        });
        try {
          const parts = notification.parts as string[];
          for (let part = notification.nextPart; part < parts.length; part++) {
            await this.upstream.send(config, parts[part], signal);
            await this.db.notification.update({
              where: { id: notification.id },
              data: { nextPart: part + 1 },
            });
          }
          await this.db.notification.update({
            where: { id: notification.id },
            data: { status: "SENT", sentAt: new Date(), lastError: null },
          });
          sent++;
          await this.audit.record(
            "PROJECT_SENT",
            "Notifikasi proyek dikonfirmasi oleh GOWA.",
            "SUCCESS",
            "NOTIFICATION",
          );
        } catch (error) {
          if (!signal.aborted)
            await this.db.notification.update({
              where: { id: notification.id },
              data: { status: "FAILED", lastError: this.safeError(error) },
            });
          throw error;
        }
      }
      await this.db.checkRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCESS",
          available: projects.length,
          newProjects,
          sent,
          completedAt: new Date(),
          durationMs: Date.now() - started,
        },
      });
      await this.db.monitorState.update({
        where: { id: "main" },
        data: {
          lastCheckAt: new Date(),
          lastSuccessAt: new Date(),
          lastError: null,
        },
      });
      await this.audit.record(
        "CHECK_COMPLETED",
        `Pengecekan selesai: ${projects.length} tersedia, ${newProjects} baru, ${sent} dinotifikasikan.`,
        "SUCCESS",
      );
    } catch (error) {
      const cancelled = signal.aborted;
      const auth = error instanceof UpstreamError && error.auth;
      const message = cancelled
        ? "Pengecekan dibatalkan oleh operator."
        : this.safeError(error);
      if (auth && !cancelled) {
        this.accessToken = undefined;
        await this.db.bilcodeSession.update({
          where: { id: "main" },
          data: { authStatus: "INVALID", lastError: message },
        });
        await this.authNotification(config, false, signal);
      }
      await this.db.checkRun.update({
        where: { id: run.id },
        data: {
          status: cancelled ? "CANCELLED" : auth ? "AUTH_ERROR" : "ERROR",
          available,
          newProjects,
          sent,
          error: message,
          completedAt: new Date(),
          durationMs: Date.now() - started,
        },
      });
      await this.db.monitorState.update({
        where: { id: "main" },
        data: {
          lastCheckAt: new Date(),
          lastError: cancelled ? null : message,
        },
      });
      await this.audit.record(
        cancelled ? "CHECK_CANCELLED" : "CHECK_FAILED",
        message,
        cancelled ? "INFO" : "ERROR",
      );
    } finally {
      this.busy = false;
      this.controller = undefined;
    }
  }
  async settings(input: SettingsDto) {
    let url: URL;
    try {
      url = new URL(input.gowaUrl);
    } catch {
      throw new BadRequestException("URL GOWA tidak valid.");
    }
    const allowed = (process.env.GOWA_ALLOWED_HOSTS || "wa.geats.web.id").split(
      ",",
    );
    const localTest =
      process.env.ALLOW_LOCAL_UPSTREAM === "true" &&
      ["localhost", "127.0.0.1"].includes(url.hostname);
    if (
      !allowed.includes(url.hostname) ||
      (!localTest && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new BadRequestException(
        "Gunakan origin HTTPS GOWA yang diizinkan, tanpa path atau credential pada URL.",
      );
    }
    return this.exclusive(async () => {
      await this.stoppedOnly();
      const { gowaPassword, ...values } = input;
      await this.db.configuration.update({
        where: { id: "main" },
        data: {
          ...values,
          gowaUrl: url.origin,
          ...(gowaPassword
            ? { gowaPasswordEncrypted: this.secrets.encrypt(gowaPassword) }
            : {}),
        },
      });
      await this.db.monitorState.update({
        where: { id: "main" },
        data: { gowaConnected: null, gowaCheckedAt: null },
      });
      await this.audit.record(
        "SETTINGS_UPDATED",
        "Konfigurasi interval, penerima, dan GOWA diperbarui.",
      );
      return this.summary();
    });
  }
  async testConnection() {
    const config = await this.db.configuration.findUniqueOrThrow({
      where: { id: "main" },
    });
    try {
      const connected = await this.upstream.connection(config);
      await this.db.monitorState.update({
        where: { id: "main" },
        data: { gowaConnected: connected, gowaCheckedAt: new Date() },
      });
      await this.audit.record(
        "GOWA_CONNECTION_CHECKED",
        connected
          ? "Device GOWA terhubung dan login."
          : "Device GOWA belum terhubung.",
        connected ? "SUCCESS" : "WARNING",
      );
      return { connected };
    } catch (error) {
      await this.db.monitorState.update({
        where: { id: "main" },
        data: { gowaConnected: false, gowaCheckedAt: new Date() },
      });
      await this.audit.record(
        "GOWA_CONNECTION_FAILED",
        this.safeError(error),
        "ERROR",
      );
      throw new BadRequestException(this.safeError(error));
    }
  }
  async testMessage() {
    const config = await this.db.configuration.findUniqueOrThrow({
      where: { id: "main" },
    });
    try {
      await this.upstream.send(
        config,
        jsonMessages({
          dummy: true,
          source: "bilcode-project-monitoring",
          message: "Uji pengiriman dari panel lokal.",
          time: new Date().toISOString(),
        })[0],
      );
      await this.audit.record(
        "TEST_MESSAGE_SENT",
        "Pesan percobaan dikonfirmasi oleh GOWA.",
        "SUCCESS",
        "NOTIFICATION",
      );
      return {
        message: "GOWA mengonfirmasi pesan percobaan berhasil dikirim.",
      };
    } catch (error) {
      await this.audit.record(
        "TEST_MESSAGE_FAILED",
        this.safeError(error),
        "ERROR",
        "NOTIFICATION",
      );
      throw new BadRequestException(this.safeError(error));
    }
  }
}

import { Injectable } from "@nestjs/common";
import { Configuration } from "./generated/prisma/client";
import { Secrets } from "./secrets";

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly auth = false,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function call(
  url: string,
  options: RequestInit,
  signal?: AbortSignal,
): Promise<{ data: Record<string, unknown>; response: Response }> {
  try {
    const response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new UpstreamError(
        `HTTP ${response.status}`,
        response.status === 401 || response.status === 403,
        response.status,
      );
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new UpstreamError("Respons API bukan JSON yang valid.");
    }
    if (!isRecord(data))
      throw new UpstreamError("Struktur respons API tidak sesuai.");
    return { data, response };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError(
      "Koneksi API gagal atau melewati batas waktu 15 detik.",
    );
  }
}

@Injectable()
export class Upstream {
  constructor(private readonly secrets: Secrets) {}
  async requestEmailOtp(email: string) {
    const base = process.env.BILCODE_API_URL || "https://api.bilcode.id/api";
    await call(`${base}/auth/send-otp-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dashboard.bilcode.id",
      },
      body: JSON.stringify({ email }),
    });
  }
  async verifyEmailOtp(email: string, code: string) {
    const base = process.env.BILCODE_API_URL || "https://api.bilcode.id/api";
    const { response } = await call(`${base}/auth/verify-otp-email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dashboard.bilcode.id",
      },
      body: JSON.stringify({ email, code }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const match = /^bilcode_refresh_token=([^;]+)/.exec(cookie);
      if (match && /^[^\s;,\r\n]{16,4096}$/.test(match[1])) return match[1];
    }
    throw new UpstreamError(
      "Bilcode tidak memberikan sesi refresh. Coba login kembali.",
    );
  }
  async refresh(token: string, signal?: AbortSignal) {
    const base = process.env.BILCODE_API_URL || "https://api.bilcode.id/api";
    const { data, response } = await call(
      `${base}/auth/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Cookie: `bilcode_refresh_token=${token}`,
          Origin: "https://dashboard.bilcode.id",
        },
        body: "{}",
      },
      signal,
    );
    if (typeof data.access_token !== "string" || !data.access_token)
      throw new UpstreamError(
        "Access token tidak diberikan oleh Bilcode.",
        true,
      );
    let refreshToken = token;
    for (const cookie of response.headers.getSetCookie()) {
      const match = /^bilcode_refresh_token=([^;]*)/.exec(cookie);
      if (match && match[1]) refreshToken = match[1];
    }
    return { accessToken: data.access_token as string, refreshToken };
  }
  async projects(accessToken: string, page: number, signal?: AbortSignal) {
    const base = process.env.BILCODE_API_URL || "https://api.bilcode.id/api";
    const { data } = await call(
      `${base}/worker/projects/available?page=${page}&per_page=15`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      signal,
    );
    const projects = data.projects;
    if (
      !isRecord(projects) ||
      !Array.isArray(projects.data) ||
      typeof projects.last_page !== "number" ||
      !Number.isInteger(projects.last_page) ||
      projects.last_page < page ||
      projects.last_page > 1000
    ) {
      throw new UpstreamError(
        "Struktur projects.data atau pagination tidak sesuai.",
      );
    }
    return {
      items: projects.data as unknown[],
      lastPage: projects.last_page as number,
    };
  }
  async bids(accessToken: string, page: number, signal: AbortSignal) {
    const base = process.env.BILCODE_API_URL || "https://api.bilcode.id/api";
    const { data } = await call(
      `${base}/worker/my-bids?page=${page}&per_page=15`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      signal,
    );
    const bids = data.bids;
    if (
      !isRecord(bids) ||
      !Array.isArray(bids.data) ||
      !Number.isInteger(bids.last_page) ||
      Number(bids.last_page) < page ||
      Number(bids.last_page) > 1000
    )
      throw new UpstreamError(
        "Struktur bids.data atau pagination tidak sesuai.",
      );
    return { items: bids.data as unknown[], lastPage: Number(bids.last_page) };
  }
  async submitBid(
    accessToken: string,
    projectId: number,
    payload: unknown,
    signal: AbortSignal,
  ) {
    const base = process.env.BILCODE_API_URL || "https://api.bilcode.id/api";
    await call(
      `${base}/worker/projects/${projectId}/bid`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Origin: "https://dashboard.bilcode.id",
        },
        body: JSON.stringify(payload),
      },
      signal,
    );
  }
  private gowaHeaders(config: Configuration) {
    if (!config.gowaPasswordEncrypted)
      throw new UpstreamError("Password GOWA belum dikonfigurasi.");
    return {
      Authorization: `Basic ${Buffer.from(`${config.gowaUsername}:${this.secrets.decrypt(config.gowaPasswordEncrypted)}`).toString("base64")}`,
      "Content-Type": "application/json",
      "X-Device-Id": config.deviceId,
    };
  }
  async send(config: Configuration, message: string, signal?: AbortSignal) {
    const { data } = await call(
      `${config.gowaUrl}/send/message`,
      {
        method: "POST",
        headers: this.gowaHeaders(config),
        body: JSON.stringify({ phone: config.phone, message }),
      },
      signal,
    );
    if (data.code !== "SUCCESS")
      throw new UpstreamError("GOWA belum mengonfirmasi pengiriman pesan.");
  }
  async connection(config: Configuration) {
    const { data } = await call(
      `${config.gowaUrl}/devices/${encodeURIComponent(config.deviceId)}/status`,
      {
        headers: this.gowaHeaders(config),
      },
    );
    return (
      isRecord(data.results) &&
      data.results.is_connected === true &&
      data.results.is_logged_in === true
    );
  }
}

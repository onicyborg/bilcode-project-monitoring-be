import { Injectable } from "@nestjs/common";
import { Configuration } from "./generated/prisma/client";
import { Secrets } from "./secrets";

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly auth = false,
    readonly status?: number,
    readonly code?: string,
    readonly fields: string[] = [],
  ) {
    super(message);
  }
}

export function upstreamDiagnostic(error: unknown) {
  if (!(error instanceof UpstreamError)) return "INTERNAL_OR_CANCELLED";
  return [
    error.status ? `HTTP ${error.status}` : "UPSTREAM_ERROR",
    error.code,
    error.fields.length ? `fields=${error.fields.join(",")}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
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
    if (!response.ok) {
      let code: string | undefined;
      let fields: string[] = [];
      if (response.headers.get("cf-mitigated") === "challenge")
        code = "CF_CHALLENGE";
      else {
        // Keep only an explicit machine code; upstream bodies may contain credentials or project text.
        const body: unknown = await response.json().catch(() => null);
        const candidate = isRecord(body)
          ? (body.code ?? body.error_code)
          : null;
        if (
          typeof candidate === "string" &&
          /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate)
        )
          code = candidate;
        if (isRecord(body) && isRecord(body.errors)) {
          fields = Object.keys(body.errors)
            .filter((field) =>
              /^(proposed_amount|estimated_days|proposal|worker_analysis(?:\.(?:features|tech_stack|estimated_days|technical_notes|client_clarifications|additional_notes)(?:\.\d{1,3})?)?)$/.test(
                field,
              ),
            )
            .slice(0, 20);
        }
      }
      throw new UpstreamError(
        `HTTP ${response.status}`,
        response.status === 401,
        response.status,
        code,
        fields,
      );
    }
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
    const cause =
      error && typeof error === "object" && "cause" in error
        ? error.cause
        : null;
    const code =
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      [
        "EAI_AGAIN",
        "ENOTFOUND",
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(String(cause.code))
        ? String(cause.code)
        : error instanceof Error && error.name === "TimeoutError"
          ? "TIMEOUT"
          : "NETWORK_FAILURE";
    throw new UpstreamError(
      "Koneksi API gagal atau melewati batas waktu 15 detik.",
      false,
      undefined,
      code,
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
          Accept: "application/json",
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

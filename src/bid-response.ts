export type SafeResponse = {
  message?: string;
  errors?: Record<string, string[]>;
};
const fieldPattern =
  /^(proposed_amount|estimated_days|proposal|worker_analysis(?:\.(?:features|tech_stack|estimated_days|technical_notes|client_clarifications|additional_notes)(?:\.\d{1,3})?)?)$/;
export const bidField = (field: string) => fieldPattern.test(field);

export function safeResponse(
  body: unknown,
  options: RequestInit,
): SafeResponse {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const values = Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL/.test(key) &&
        value &&
        value.length >= 6,
    )
    .map(([, value]) => value!);
  const headers = new Headers(options.headers);
  const authorization = headers.get("authorization") || "";
  if (authorization) {
    values.push(authorization, authorization.replace(/^\S+\s+/, ""));
    if (/^Basic /i.test(authorization))
      values.push(
        ...Buffer.from(authorization.slice(6), "base64").toString().split(":"),
      );
  }
  for (const cookie of (headers.get("cookie") || "").split(";")) {
    const index = cookie.indexOf("=");
    if (index >= 0) values.push(cookie.slice(index + 1).trim());
  }
  const redact = (input: string) => {
    let text = input.slice(0, 10000);
    for (const value of values
      .filter((v) => v.length >= 4)
      .sort((a, b) => b.length - a.length))
      text = text.split(value).join("[REDACTED]");
    return text
      .replace(
        /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        "[REDACTED]",
      )
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, "[REDACTED]")
      .replace(
        /\b(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|bilcode_refresh_token|authorization|cookie)\s*[:=]\s*["']?[^\s,;"'}]+/gi,
        "[REDACTED]",
      )
      .replace(
        /\b(?:vk-[a-f0-9-]{36}|npg_[A-Za-z0-9]+|gh[opusr]_[A-Za-z0-9]+)\b/g,
        "[REDACTED]",
      )
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .slice(0, 1000)
      .trim();
  };
  const data = body as Record<string, unknown>;
  const result: SafeResponse = {};
  if (typeof data.message === "string") result.message = redact(data.message);
  if (
    data.errors &&
    typeof data.errors === "object" &&
    !Array.isArray(data.errors)
  ) {
    const errors: Record<string, string[]> = {};
    for (const [field, value] of Object.entries(data.errors)
      .filter(([key]) => bidField(key))
      .slice(0, 20)) {
      const messages = (Array.isArray(value) ? value : [value])
        .filter((v): v is string => typeof v === "string")
        .slice(0, 3)
        .map(redact);
      if (messages.length) errors[field] = messages;
    }
    if (Object.keys(errors).length) result.errors = errors;
  }
  return result;
}

export function bidAction(
  outcome: string,
  phase: string,
  status?: number,
  code?: string,
) {
  if (outcome === "CONFIRMED")
    return "Pantau status penawaran. Tidak perlu mengirim ulang.";
  if (outcome === "UNKNOWN")
    return "Sinkronkan riwayat bid dan tunggu kepastian. Jangan mengirim ulang sebelum hasil sebelumnya jelas.";
  if (code === "OPERATION_CANCELLED")
    return "Operasi dihentikan sebelum pengiriman. Konfirmasi ulang hanya jika kamu ingin melanjutkan dan proyek masih tersedia.";
  if (phase === "AI")
    return "Periksa konfigurasi/koneksi AI. Proposal belum dikirim; konfirmasi ulang hanya setelah masalah diperbaiki.";
  if (code === "CF_CHALLENGE")
    return "Akses API dari VPS mendapat challenge. Hubungi admin Bilcode untuk memeriksa akses server sebelum mencoba lagi.";
  if (code === "BID_SKILL_MISMATCH")
    return "Periksa bidang keahlian pada profil Bilcode. Pilih proyek yang sesuai, atau perbarui profil hanya jika memang memiliki keahlian tersebut.";
  if (status === 401)
    return "Hentikan monitoring, hubungkan kembali sesi Bilcode melalui OTP, lalu validasi sesi sebelum konfirmasi ulang.";
  if (status === 403)
    return "Periksa alasan penolakan dan persyaratan proyek/akun Bilcode. Hubungi admin Bilcode jika izin sudah sesuai; login ulang belum tentu menyelesaikan penolakan ini.";
  if (status === 422 || status === 400)
    return "Periksa pesan validasi dan field yang ditolak. Sesuaikan persyaratan atau konfigurasi sebelum mengonfirmasi pengajuan lagi.";
  if (status === 404 || status === 410)
    return "Segarkan daftar proyek; proyek mungkin sudah tidak tersedia. Pilih proyek yang masih dapat diajukan.";
  return "Segarkan proyek dan periksa sesi serta koneksi. Konfirmasi ulang hanya jika proyek masih tersedia dan masalah sudah diperbaiki.";
}

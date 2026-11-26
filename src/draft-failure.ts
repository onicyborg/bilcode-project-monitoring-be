import { UpstreamError } from "./upstream";

export function draftFailure(error: unknown, cancelled = false): string {
  const retry =
    "Konfirmasi manual untuk mencoba kembali; tidak ada retry otomatis.";
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (cancelled || name === "AbortError" || message === "Cancelled")
    return `[DRAFT_CANCELLED] Pembuatan draft dibatalkan. ${retry}`;
  if (name === "TimeoutError")
    return `[AI_TIMEOUT] Penyedia AI melewati batas waktu 60 detik. ${retry}`;
  if (message === "Waktu pengerjaan tersisa kurang dari satu hari.")
    return "[DEADLINE_TOO_CLOSE] Sisa deadline kurang dari 24 jam; draft tidak dibuat. Periksa deadline proyek. Mengulang tanpa perubahan deadline akan tetap ditolak.";
  if (
    message ===
    "Deadline proyek belum jelas; pengajuan otomatis tidak tersedia."
  )
    return "[DEADLINE_INVALID] Deadline proyek belum tersedia atau formatnya tidak valid. Periksa deadline dan sinkronkan proyek sebelum mencoba kembali.";
  if (message === "AI key missing")
    return "[AI_NOT_CONFIGURED] Kredensial AI belum dikonfigurasi. Hubungi pengelola untuk memeriksa konfigurasi backend.";
  if (error instanceof UpstreamError && error.code === "AI_REQUEST_FAILED") {
    const status = error.status;
    if (status === 401 || status === 403)
      return `[AI_AUTH_FAILED] Penyedia AI menolak kredensial (HTTP ${status}). Periksa kredensial AI; tidak perlu login ulang Bilcode.`;
    if (status === 429)
      return `[AI_RATE_LIMITED] Batas permintaan atau kuota AI tercapai (HTTP 429). Periksa kuota dan tunggu sebelum mencoba kembali. ${retry}`;
    return `[AI_REQUEST_FAILED] Permintaan ke penyedia AI gagal${Number.isInteger(status) ? ` (HTTP ${status})` : ""}. ${retry}`;
  }
  if (
    error instanceof SyntaxError ||
    [
      "Invalid AI content",
      "Invalid AI classification",
      "Invalid AI proposal",
      "Invalid AI text",
      "Invalid AI list",
      "Invalid AI duration",
    ].includes(message)
  )
    return `[AI_OUTPUT_INVALID] Respons AI tidak memenuhi format proposal atau aturan durasi. Klasifikasi belum dapat digunakan. ${retry}`;
  if (error instanceof TypeError && message === "fetch failed")
    return `[AI_CONNECTION_FAILED] Koneksi ke penyedia AI gagal. ${retry}`;
  return `[DRAFT_FAILED] Pembuatan draft gagal karena kesalahan internal yang belum teridentifikasi. Hubungi pengelola dengan ID proyek. ${retry}`;
}

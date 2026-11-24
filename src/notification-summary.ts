import { isRecord } from "./upstream";

export const summaryText = (value: unknown, limit = 300) =>
  typeof value === "string"
    ? value
        .replace(/[\r\n\t`*_~]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, limit)
    : "";

export function projectSummary(project: unknown) {
  if (!isRecord(project))
    return "Data proyek baru tersedia di panel monitoring.";
  const title = summaryText(project.title) || "Proyek tanpa judul";
  const description = summaryText(project.description, 450);
  const deadline = summaryText(project.deadline, 30) || "belum tersedia";
  const applicants =
    Number.isSafeInteger(project.bids_count) && Number(project.bids_count) >= 0
      ? ` · ${project.bids_count} pelamar`
      : "";
  return `${title}\nDeadline: ${deadline}${applicants}${description ? `\nKebutuhan: ${description}` : ""}`;
}

export function bidSummary(value: unknown) {
  if (!isRecord(value))
    return "Periksa perkembangan penawaran di panel monitoring.";
  const title = summaryText(value.title) || `Proyek #${value.project_id}`;
  const status = summaryText(value.status, 100);
  const labels: Record<string, string> = {
    applied: "menunggu keputusan",
    selected: "diterima",
    rejected: "ditolak",
    CONFIRMED: "tercatat di Bilcode",
    FAILED: "gagal; periksa detail dan tindakan di panel",
    UNKNOWN: "belum pasti; menunggu sinkronisasi, jangan kirim ulang",
  };
  const previous = summaryText(value.previous_status, 100);
  const prefix = value.source === "AUTO" ? "Pengajuan otomatis" : "Penawaran";
  return `${prefix}: ${title}\n${previous ? `Status: ${labels[previous] || previous} → ` : "Status: "}${labels[status] || status || "belum diketahui"}.`;
}

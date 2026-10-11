export type ActivitySummary = { title: string; message?: string | null };

const quietTitlePatterns = [
  "renamed *", "reordered *", "imported serials *",
  "updated the photo*", "updated an LED cabinet photo*",
];
const criticalMessagePatterns = [
  "*status changed*", "*certificate*", "*damage photos*", "*stock quantity changed*",
];

// Apply before order/limit so old routine entries cannot crowd out important ones.
export const IMPORTANT_ACTIVITY_FILTER = `and(${[
  ...quietTitlePatterns.map((pattern) => `title.not.ilike.${pattern}`),
  `or(title.not.ilike.edited *,${criticalMessagePatterns.map((pattern) => `message.ilike.${pattern}`).join(",")})`,
].join(",")})`;

export function isImportantActivity(entry: ActivitySummary): boolean {
  const title = entry.title.trim();
  if (/^(renamed |reordered |imported serials |updated the photo|updated an LED cabinet photo)/i.test(title)) {
    return false;
  }
  if (/^edited /i.test(title)) {
    return /status changed|certificate|damage photos|stock quantity changed/i.test(entry.message ?? "");
  }
  // Preserve workflow notifications and equipment additions/deletions, including
  // notifications written by database workflows outside logActivity.
  return true;
}

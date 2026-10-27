export const MAX_REPORT_ROW_BATCH = 100;

export function reportRowCount(value: string | number) {
  const text = String(value).trim();
  const count = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(count) || count < 1 || count > MAX_REPORT_ROW_BATCH) {
    throw new Error(`Enter a whole number from 1 to ${MAX_REPORT_ROW_BATCH}.`);
  }
  return count;
}

export function buildReportRowBatch(options: {
  itemId: string;
  count: number;
  units: readonly { unit_no: string | number | null }[];
  kind: "serialized" | "projector" | "chain_hoist";
  testingDate?: string | null;
  includeTestingDate?: boolean;
  editorName?: string;
}) {
  const count = reportRowCount(options.count);
  if (!options.itemId) throw new Error("Open an equipment report before adding rows.");
  let maximum = 0;
  for (const unit of options.units) {
    const number = Number(unit.unit_no);
    if (Number.isSafeInteger(number) && number > maximum) maximum = number;
  }
  if (!Number.isSafeInteger(maximum + count)) throw new Error("The next unit number is too large.");
  const timestamp = new Date().toISOString();
  return Array.from({ length: count }, (_, index) => {
    const row: Record<string, unknown> = {
      item_id: options.itemId,
      unit_no: options.kind === "chain_hoist" ? String(maximum + index + 1) : maximum + index + 1,
      serial: "", status: "available", notes: "", damage_photos: [],
    };
    if (options.includeTestingDate !== false) row.testing_date = options.testingDate || null;
    if (options.kind === "projector") {
      row.lamp_hours = 0;
      row.updated_by = options.editorName || "Unknown User";
      row.updated_at = timestamp;
    }
    if (options.kind === "chain_hoist") {
      row.cert_date = null;
      row.expiry_date = null;
    }
    return row;
  });
}

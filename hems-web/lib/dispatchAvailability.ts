import type { SupabaseClient } from "@supabase/supabase-js";
import type { EquipmentListItem } from "./equipmentLists";

export type DispatchUnitIssue = { itemId: string; name: string; label: string; status: string };

export function isSerialAvailabilityError(error: { message?: string; details?: string | null } | null) {
  if (/selected serial numbers are no longer available/i.test(error?.message || "")) return true;
  try {
    const details = JSON.parse(error?.details || "null");
    return details?.record_type === "unit" && typeof details.record_id === "string";
  } catch { return false; }
}

// Diagnostic only: the atomic dispatch RPC remains the authority for stock.
// Called after a rejected dispatch, never during page loading or successful dispatch.
export async function readDispatchUnitIssues(
  client: SupabaseClient,
  items: EquipmentListItem[],
  isOffline: () => boolean = () => false,
): Promise<DispatchUnitIssue[]> {
  const selected = items.filter((item) => item.inventory_record_type === "unit"
    && item.metadata?.custom_item !== true && item.metadata?.custom_item !== "true");
  const ids = [...new Set(selected.map((item) => item.inventory_record_id))];
  const units = new Map<string, { unit_no: number | null; serial: string | null; status: string | null }>();
  for (let offset = 0; offset < ids.length; offset += 80) {
    if (isOffline()) throw new Error("Live availability requires an online connection.");
    const result = await client.from("units").select("id,unit_no,serial,status")
      .in("id", ids.slice(offset, offset + 80)).abortSignal(AbortSignal.timeout(10000));
    if (isOffline()) throw new Error("Live availability requires an online connection.");
    if (result.error) throw result.error;
    for (const unit of result.data || []) units.set(unit.id, unit);
  }
  const issues: DispatchUnitIssue[] = [];
  for (const item of selected) {
    const unit = units.get(item.inventory_record_id);
    // Missing rows can also mean RLS denied access: do not claim deletion.
    if (!unit) {
      issues.push({ itemId: item.id, name: item.display_name,
        label: `ID: ${item.metadata?.unit_no ?? item.inventory_record_id}`,
        status: "Unit could not be read. Refresh or check access." });
      continue;
    }
    if ((unit.status ?? "available") === "available") continue;
    const labels: Record<string, string> = {
      in_use: "In use", in_ksa: "In KSA", maintenance: "Maintenance / Failed",
    };
    issues.push({ itemId: item.id, name: item.display_name,
      label: `ID: ${unit.unit_no ?? item.metadata?.unit_no ?? item.inventory_record_id}${unit.serial?.trim() ? ` · Serial: ${unit.serial.trim()}` : ""}`,
      status: labels[unit.status || ""] || unit.status || "Unknown status" });
  }
  return issues;
}

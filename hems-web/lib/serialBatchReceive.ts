import type { EquipmentList, EquipmentListItem } from "./equipmentLists";

export const MAX_SERIAL_RECEIPT_BATCH = 1000;
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function canBatchReceiveSerials(list: Pick<EquipmentList,"list_type"|"status">, manager: boolean) {
  return manager && list.list_type === "local_event" && ["active","partially_returned"].includes(list.status);
}
export function isOutstandingSerial(item: EquipmentListItem) {
  return item.inventory_record_type === "unit" && Number(item.approved_quantity) === 1
    && item.returned_ok_quantity != null && item.returned_maintenance_quantity != null
    && Number(item.returned_ok_quantity) === 0 && Number(item.returned_maintenance_quantity) === 0
    && Number(item.missing_quantity ?? 0) === 0
    && item.metadata?.custom_item !== true && item.metadata?.custom_item !== "true";
}
export function selectSerialReceiptLines(items: readonly EquipmentListItem[], selected: ReadonlySet<string>) {
  const chosen = items.filter(item => selected.has(item.id));
  if (!chosen.length) throw new Error("Select at least one outstanding serial.");
  if (chosen.length !== selected.size || chosen.some(item => !isOutstandingSerial(item)))
    throw new Error("Some selected serials changed. Refresh and review the selection again.");
  return chosen;
}
export function buildSerialReceiptPayload(listId: string, items: readonly EquipmentListItem[]) {
  if (!uuid(listId) || !items.length || items.length > MAX_SERIAL_RECEIPT_BATCH)
    throw new Error(`Select from 1 to ${MAX_SERIAL_RECEIPT_BATCH} serial units from one event.`);
  const lines = new Set<string>(), units = new Set<string>();
  for (const item of items) {
    if (item.list_id !== listId || !uuid(item.id) || !uuid(item.inventory_record_id) || !isOutstandingSerial(item))
      throw new Error("The selected serials are no longer eligible. Refresh the list.");
    if (lines.has(item.id) || units.has(item.inventory_record_id)) throw new Error("A serial appears more than once. Review the list before receiving it.");
    lines.add(item.id); units.add(item.inventory_record_id);
  }
  return [...items].sort((a,b) => a.id.localeCompare(b.id)).map(item => ({
    id: item.id, approved: Number(item.approved_quantity), ok: Number(item.returned_ok_quantity),
    maintenance: Number(item.returned_maintenance_quantity), missing: Number(item.missing_quantity ?? 0),
  }));
}

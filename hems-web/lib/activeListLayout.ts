import type { EquipmentListItem } from "./equipmentLists";
import { listReturnQuantities } from "./listReturnQuantities";

export type ActiveEquipmentGroup = {
  key: string;
  displayName: string;
  blockName: string | null;
  items: EquipmentListItem[];
};

const count = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function isCustomActiveItem(item: EquipmentListItem) {
  return item.inventory_record_type === "item" || item.metadata?.custom_item === true || item.metadata?.custom_item === "true";
}

export function activeGroupKind(group: ActiveEquipmentGroup) {
  if (group.items.every(item => item.inventory_record_type === "unit")) return "serial";
  if (group.items.every(isCustomActiveItem)) return "custom";
  if (group.items.every(item => item.inventory_record_type === "matrix_row" &&
    item.metadata?.matrix_source === "generic" && Boolean(item.parent_record_id))) return "lengths";
  return "quantity";
}

/** Display only; never turns a historical Sent total into a new dispatch. */
export function activeRowCounts(items: readonly EquipmentListItem[]) {
  const amounts = listReturnQuantities(items);
  const squareMetres = items.length > 0 && items.every(item =>
    item.inventory_record_type === "matrix_row" && item.metadata?.matrix_source !== "generic") &&
    amounts.sentSquareMetres > 0;
  const custom = items.length > 0 && items.every(isCustomActiveItem);
  return {
    sent: custom ? items.reduce((sum, item) => sum + (count(item.approved_quantity) || count(item.requested_quantity)), 0)
      : squareMetres ? amounts.sentSquareMetres : amounts.sent,
    received: squareMetres ? amounts.receivedSquareMetres : amounts.received,
    outside: squareMetres ? amounts.outsideSquareMetres : amounts.outside,
    maintenance: items.reduce((sum, item) => sum + count(item.returned_maintenance_quantity), 0),
    squareMetres, custom,
  };
}

export function activeQuantityText(value: number, squareMetres = false) {
  return `${Number(count(value).toFixed(3))}${squareMetres ? " SQM" : ""}`;
}

export function activeLineOutside(item: EquipmentListItem) {
  return Math.max(0, count(item.approved_quantity) - count(item.returned_ok_quantity) - count(item.returned_maintenance_quantity));
}

export function canReceiveActiveItem(item: EquipmentListItem) {
  return !isCustomActiveItem(item) && activeLineOutside(item) > 0;
}

export function activeSerialReference(item: EquipmentListItem) {
  const number = item.metadata?.unit_no;
  const id = (typeof number === "number" || typeof number === "string") && String(number).trim()
    ? String(number).trim() : item.inventory_record_id.slice(0, 8).toUpperCase();
  const serial = item.serial_number?.trim() || "—";
  return { id, serial };
}

export function activeSerialStatus(item: EquipmentListItem) {
  if (activeLineOutside(item) > 0) return { label: "Out", tone: "out" } as const;
  if (count(item.returned_maintenance_quantity) > 0) return { label: "Maintenance", tone: "repair" } as const;
  if (count(item.returned_ok_quantity) > 0) return { label: "Received", tone: "received" } as const;
  return { label: "—", tone: "muted" } as const;
}

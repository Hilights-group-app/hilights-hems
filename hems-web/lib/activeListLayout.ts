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

function cabinetAreaFromSavedSize(value: unknown) {
  if (typeof value !== "string") return 0;
  const size = value.toLowerCase().replace(/,/g, ".").replace(/[×*]/g, "x").trim();
  const match = size.match(/^(\d+(?:\.\d+)?)\s*(mm|cm|m)?\s*x\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)?$/);
  if (!match) return 0;
  const toMetres = (number: number, unit: string) => unit === "mm" ? number / 1000
    : unit === "cm" ? number / 100 : unit === "m" ? number
    : number > 100 ? number / 1000 : number > 2 ? number / 100 : number;
  // Unitless sizes follow the existing LED picker convention, not a 1sqm default.
  const area = toMetres(Number(match[1]), match[2] || match[4] || "") *
    toMetres(Number(match[3]), match[4] || match[2] || "");
  return count(area);
}

/** Resolve the saved cabinet geometry; never read or mutate live stock. */
export function localEventLedCabinetArea(item: EquipmentListItem) {
  if (item.inventory_record_type !== "matrix_row" || item.metadata?.matrix_source === "generic" || isCustomActiveItem(item)) return 0;
  const explicit = count(item.metadata?.cabinet_area_sqm);
  if (explicit > 0) return explicit;
  const sizeArea = cabinetAreaFromSavedSize(item.metadata?.cabinet_size);
  if (sizeArea > 0) return sizeArea;
  // Older list snapshots may have geometry only in the last display-name segment.
  const segments = item.display_name.split("·").map(segment => segment.trim());
  const nameArea = segments.length > 1 ? cabinetAreaFromSavedSize(segments[segments.length - 1]) : 0;
  if (nameArea > 0) return nameArea;
  const requested = count(item.requested_quantity), actual = count(item.metadata?.actual_sqm);
  return requested > 0 ? count(actual / requested) : 0;
}

/** Display only; never turns a historical Sent total into a new dispatch. */
export function activeRowCounts(items: readonly EquipmentListItem[], localEvent = false) {
  const amounts = listReturnQuantities(items);
  const squareMetres = items.length > 0 && items.every(item =>
    item.inventory_record_type === "matrix_row" && item.metadata?.matrix_source !== "generic") &&
    amounts.sentSquareMetres > 0;
  const custom = items.length > 0 && items.every(isCustomActiveItem);
  const result = {
    sent: custom ? items.reduce((sum, item) => sum + (count(item.approved_quantity) || count(item.requested_quantity)), 0)
      : squareMetres ? amounts.sentSquareMetres : amounts.sent,
    received: squareMetres ? amounts.receivedSquareMetres : amounts.received,
    outside: squareMetres ? amounts.outsideSquareMetres : amounts.outside,
    maintenance: items.reduce((sum, item) => sum + count(item.returned_maintenance_quantity), 0),
    squareMetres, custom,
  };
  const led = localEvent && items.length > 0 && items.every(item =>
    item.inventory_record_type === "matrix_row" && item.metadata?.matrix_source !== "generic" && !isCustomActiveItem(item));
  if (!led) return result;
  const areas = items.map(localEventLedCabinetArea);
  if (areas.some(area => !(area > 0))) return { ...result, squareMetres: true, areaUnknown: true };
  let sent = 0, received = 0, outside = 0, maintenance = 0;
  items.forEach((item, index) => {
    const quantity = count(item.approved_quantity), repair = count(item.returned_maintenance_quantity);
    const back = Math.min(quantity, count(item.returned_ok_quantity) + repair), area = areas[index];
    sent += quantity * area; received += back * area; outside += Math.max(0,quantity - back - count(item.missing_quantity)) * area; maintenance += repair * area;
  });
  return { ...result, sent, received, outside, maintenance, squareMetres: true };
}

export function activeQuantityText(value: number, squareMetres = false) {
  return `${Number(count(value).toFixed(3))}${squareMetres ? " SQM" : ""}`;
}

export function activeLineOutside(item: EquipmentListItem) {
  return Math.max(0, count(item.approved_quantity) - count(item.returned_ok_quantity) - count(item.returned_maintenance_quantity) - count(item.missing_quantity));
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
  if (count(item.missing_quantity) > 0) return { label: "Missing", tone: "missing" } as const;
  if (activeLineOutside(item) > 0) return { label: "Out", tone: "out" } as const;
  if (count(item.returned_maintenance_quantity) > 0) return { label: "Maintenance", tone: "repair" } as const;
  if (count(item.returned_ok_quantity) > 0) return { label: "Received", tone: "received" } as const;
  return { label: "—", tone: "muted" } as const;
}

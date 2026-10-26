import type { EquipmentListItem } from "@/lib/equipmentLists";

type ReturnLine = Pick<EquipmentListItem,
  "inventory_record_type" | "requested_quantity" | "approved_quantity" |
  "returned_ok_quantity" | "returned_maintenance_quantity" | "metadata"
>;

/** Display-only: draft, delivery-note, KSA and maintenance quantities are unchanged. */
export function showActiveReturnQuantities(list: {list_type: string; status: string} | null) {
  return Boolean(list?.list_type === "local_event" &&
    (list.status === "active" || list.status === "partially_returned"));
}

function nonnegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/** Sum per line so an invalid over-return on one serial cannot hide another. */
export function listReturnQuantities(items: readonly ReturnLine[]) {
  let sent = 0, received = 0, outside = 0;
  let sentSquareMetres = 0, receivedSquareMetres = 0, outsideSquareMetres = 0;
  for (const item of items) {
    if (item.inventory_record_type === "item" || item.metadata?.custom_item === true) continue;
    const lineSent = nonnegative(item.approved_quantity);
    const lineReceived = Math.min(lineSent,
      nonnegative(item.returned_ok_quantity) + nonnegative(item.returned_maintenance_quantity));
    const lineOutside = lineSent - lineReceived;
    sent += lineSent; received += lineReceived; outside += lineOutside;

    if (item.inventory_record_type === "matrix_row" && item.metadata?.matrix_source !== "generic") {
      const cabinetArea = nonnegative(item.metadata?.cabinet_area_sqm);
      const requested = nonnegative(item.requested_quantity);
      const actualArea = nonnegative(item.metadata?.actual_sqm);
      const area = cabinetArea || (requested > 0 ? actualArea / requested : 0);
      sentSquareMetres += lineSent * area;
      receivedSquareMetres += lineReceived * area;
      outsideSquareMetres += lineOutside * area;
    }
  }
  return {sent, received, outside, sentSquareMetres, receivedSquareMetres, outsideSquareMetres};
}

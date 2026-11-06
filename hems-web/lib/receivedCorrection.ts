import type { EquipmentList, EquipmentListItem } from "./equipmentLists";

export type ReceiptCounts = Pick<EquipmentListItem,"requested_quantity" | "approved_quantity" |
  "returned_ok_quantity" | "returned_maintenance_quantity" | "missing_quantity">;
const integer=(value:unknown)=>Number.isFinite(Number(value)) ? Math.max(0,Math.floor(Number(value))) : 0;

export function receiptProgress(line: Partial<ReceiptCounts> | null) {
  const sent=integer(line?.approved_quantity ?? line?.requested_quantity);
  const received=Math.min(sent,integer(line?.returned_ok_quantity)+integer(line?.returned_maintenance_quantity));
  return {sent,received,outside:Math.max(0,sent-received-integer(line?.missing_quantity))};
}
export function canCorrectReceived(list: Pick<EquipmentList,"list_type"|"status">,line: EquipmentListItem,manager:boolean) {
  return manager && ["local_event","dry_hire"].includes(list.list_type)
    && ["active","partially_returned"].includes(list.status)
    && ["unit","matrix_model","matrix_row"].includes(line.inventory_record_type)
    && line.metadata?.custom_item !== true && line.metadata?.custom_item !== "true"
    && integer(line.returned_ok_quantity)>0;
}
export function correctionPreview(line:ReceiptCounts,newOk:number) {
  const approved=integer(line.approved_quantity),oldOk=integer(line.returned_ok_quantity);
  const maintenance=integer(line.returned_maintenance_quantity);
  if(!Number.isSafeInteger(newOk) || newOk<0 || newOk>=oldOk || oldOk+maintenance>approved)
    throw new Error("Enter a lower Received OK total, from 0 to "+Math.max(0,oldOk-1)+".");
  return {sent:approved,oldOk,newOk,maintenance,reinstated:oldOk-newOk,
    outside:Math.max(0,approved-newOk-maintenance-integer(line.missing_quantity))};
}

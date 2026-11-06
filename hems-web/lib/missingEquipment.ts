import type { EquipmentList, EquipmentListItem } from "./equipmentLists";

export const MISSING_EQUIPMENT_EVENT = "hems:missing-equipment-change";
export const missingCount = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
export function missingOutside(item: Pick<EquipmentListItem,"approved_quantity"|"returned_ok_quantity"|"returned_maintenance_quantity"|"missing_quantity">) {
  return Math.max(0,missingCount(item.approved_quantity)-missingCount(item.returned_ok_quantity)-missingCount(item.returned_maintenance_quantity)-missingCount(item.missing_quantity));
}
export function canMarkMissing(list: Pick<EquipmentList,"list_type"|"status">, item: EquipmentListItem, manager: boolean) {
  return manager && ["local_event","dry_hire"].includes(list.list_type) && ["active","partially_returned"].includes(list.status)
    && ["unit","matrix_model","matrix_row"].includes(item.inventory_record_type)
    && item.metadata?.custom_item !== true && item.metadata?.custom_item !== "true" && missingOutside(item)>0;
}
export function validateMissingQuantity(value: unknown, maximum: number) {
  const quantity=Number(value);
  if (String(value).trim()==="" || !Number.isSafeInteger(quantity) || quantity<1 || quantity>maximum) throw new Error(`Enter a whole quantity from 1 to ${maximum}.`);
  return quantity;
}
export function missingLineLabel(item: EquipmentListItem) {
  const identity=item.metadata?.unit_no;
  return item.inventory_record_type==="unit" ? `ID ${identity ?? item.inventory_record_id.slice(0,8)} · Serial: ${item.serial_number || "—"}`
    : String(item.metadata?.row_label || item.display_name);
}
export type MissingEquipment = {
  id:string;list_id:string;list_item_id:string;inventory_record_type:"unit"|"matrix_model"|"matrix_row";inventory_record_id:string;
  display_name:string;serial_number:string|null;metadata:Record<string,unknown>;list_reference:string;list_type:string;
  event_name:string;location:string;list_created_at:string;list_created_by_name:string;
  quantity:number;recovered_quantity:number;remaining_quantity:number;note:string;
  reported_by_name:string;reported_at:string;recovered_at:string|null;recovered_by_name:string|null;
};
export const MISSING_SELECT="id,list_id,list_item_id,inventory_record_type,inventory_record_id,display_name,serial_number,metadata,list_reference,list_type,event_name,location,list_created_at,list_created_by_name,quantity,recovered_quantity,remaining_quantity,note,reported_by_name,reported_at,recovered_at,recovered_by_name";
export function missingSearchPattern(value:string) {
  return "%"+value.trim().slice(0,150).replace(/[\\%_]/g,character=>"\\"+character)+"%";
}

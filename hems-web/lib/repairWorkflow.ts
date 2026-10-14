export type RepairStatus = {
  id: string; list_id: string; parent_record_id: string | null;
  inventory_record_type: "unit" | "matrix_model" | "matrix_row";
  inventory_record_id: string; reference: string; label: string;
  phase: "sent" | "received"; quantity: number; stock_conflict?: boolean;
};
export type RepairMovement = {listId:string;reference:string;label:string;repairPhase?:"sent"|"received";stockConflict?:boolean};

export function mergeRepairMovements<T extends RepairMovement>(base:Record<string,T>,repairs:RepairStatus[]):Record<string,T|RepairMovement> {
  const next:Record<string,T|RepairMovement>={...base};
  for(const repair of repairs){
    if(repair.inventory_record_type!=="unit" || repair.quantity<=0)continue;
    next[repair.inventory_record_id]={listId:repair.list_id,reference:repair.reference,
      label:repair.stock_conflict?"Repair / stock mismatch · Open list":repair.label,
      repairPhase:repair.phase,stockConflict:repair.stock_conflict};
  }
  return next;
}
export function repairMovementClass(movement?:RepairMovement) {
  if(movement?.stockConflict)return "bg-red-50 text-red-700 hover:bg-red-100";
  if(movement?.repairPhase==="received")return "bg-violet-50 text-violet-800 hover:bg-violet-100";
  if(movement?.repairPhase==="sent")return "bg-amber-50 text-amber-800 hover:bg-amber-100";
  return "bg-blue-50 text-blue-700 hover:bg-blue-100";
}
export function groupRepairBadges(repairs:RepairStatus[],parentId:string) {
  const map=new Map<string,RepairStatus>();
  for(const row of repairs){
    if(row.parent_record_id!==parentId || row.quantity<=0)continue;
    const key=`${row.list_id}:${row.phase}:${Boolean(row.stock_conflict)}`;
    const old=map.get(key);map.set(key,old?{...old,quantity:old.quantity+row.quantity}:{...row});
  }
  return Array.from(map.values());
}

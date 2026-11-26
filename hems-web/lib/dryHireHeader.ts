import type { EquipmentList } from "./equipmentLists";
export function canEditDryHireHeader(list:Pick<EquipmentList,"list_type"|"status">,owner:string|null,role:string){
  return Boolean(owner&&role==="admin"&&list.list_type==="dry_hire"&&["pending","active","partially_returned","closed"].includes(list.status));
}
function isDay(value:string){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}
export function dryHireHeaderInput(name:string,pickup:string,returned:string){
  const company=name.trim();
  if(!company||company.length>200)throw new Error("Enter a client/company name from 1 to 200 characters.");
  if(!isDay(pickup)||!isDay(returned)||returned<pickup)throw new Error("Enter valid Pickup and Return dates. Return must be on or after Pickup.");
  return {client_company:company,pickup_date:pickup,return_date:returned};
}

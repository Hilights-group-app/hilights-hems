import type { EquipmentList } from "./equipmentLists";

export function canEditLocalEventHeader(list: Pick<EquipmentList,"list_type"|"status"|"created_by"|"shared_with">, owner: string|null, role: string) {
  if (!owner || list.list_type!=="local_event") return false;
  if (list.status==="draft") return role==="admin" || list.created_by===owner || Boolean(list.shared_with?.includes(owner));
  return role==="admin" && ["pending","active","partially_returned","closed"].includes(list.status);
}
export function localEventHeaderInput(list: Pick<EquipmentList,"status"|"venue">, name: string, location: string) {
  const eventName=name.trim();
  if (!eventName || eventName.length>200) throw new Error("Enter an event name from 1 to 200 characters.");
  if (list.status!=="draft") return {eventName,venue:list.venue};
  const venue=location.trim();
  if (!venue || venue.length>300) throw new Error("Enter a location from 1 to 300 characters.");
  return {eventName,venue};
}

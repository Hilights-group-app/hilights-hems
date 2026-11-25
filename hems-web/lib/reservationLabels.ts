export type ReservationLabel = {
  record_type: string; record_id: string; parent_id: string | null;
  list_id: string; list_type: string; label: string; quantity: number;
  start_date: string | null; end_date: string | null;
};
type HiddenReservation = Pick<ReservationLabel,"record_type"|"record_id"|"parent_id">;
const key=(type:string,id:string)=>`${type}:${id}`;
export function reservationLabelIndex(rows:ReservationLabel[],hidden:HiddenReservation[]=[]){
  const records=new Map<string,Map<string,ReservationLabel>>(),parents=new Map<string,Map<string,ReservationLabel>>();
  const hiddenRecords=new Set<string>(),hiddenParents=new Set<string>();
  function add(map:Map<string,Map<string,ReservationLabel>>,id:string,row:ReservationLabel){
    let lists=map.get(id);if(!lists){lists=new Map();map.set(id,lists);}
    const previous=lists.get(row.list_id);
    lists.set(row.list_id,{...row,quantity:row.quantity+(previous?.quantity||0)});
  }
  for(const raw of rows){
    if(!raw||!raw.record_type||!raw.record_id||!raw.list_id||typeof raw.label!=="string")continue;
    const quantity=Math.max(0,Math.floor(Number(raw.quantity)||0));if(!Number.isFinite(quantity)||!quantity)continue;
    const row={...raw,quantity};add(records,key(row.record_type,row.record_id),row);
    if(row.parent_id)add(parents,key(row.record_type,row.parent_id),row);
  }
  for(const row of hidden){if(!row?.record_type||!row.record_id)continue;hiddenRecords.add(key(row.record_type,row.record_id));if(row.parent_id)hiddenParents.add(key(row.record_type,row.parent_id));}
  return {
    details(type:string,id:string,parent=false){return [...((parent?parents:records).get(key(type,id))?.values()||[])].sort((a,b)=>(a.start_date||"9999").localeCompare(b.start_date||"9999")||a.label.localeCompare(b.label)||a.list_id.localeCompare(b.list_id));},
    hidden(type:string,id:string,parent=false){return(parent?hiddenParents:hiddenRecords).has(key(type,id));},
  };
}
function validDate(value:string|null){return Boolean(value&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T12:00:00Z`)));}
export function reservationDateLabel(start:string|null,end:string|null,currentYear=new Date().toLocaleDateString("en-GB",{year:"numeric",timeZone:"Asia/Dubai"})){
  if(!start&&!end)return "No date limit";
  if(!validDate(start)||!validDate(end))return "Dates unavailable";
  const first=start as string,last=end as string;
  const withYear=first.slice(0,4)!==last.slice(0,4)||last.slice(0,4)!==String(currentYear);
  const format=(value:string)=>new Date(`${value}T12:00:00Z`).toLocaleDateString("en-GB",{day:"numeric",month:"short",...(withYear?{year:"numeric" as const}:{}),timeZone:"Asia/Dubai"});
  return first===last?format(first):`${format(first)} – ${format(last)}`;
}

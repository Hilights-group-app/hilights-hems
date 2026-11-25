"use client";
import { refreshPendingReservations, usePendingReservations } from "@/lib/usePendingReservations";
import { reservationDateLabel } from "@/lib/reservationLabels";

export function ReservationReadStatus({listId}:{listId?:string}={}){
  const {loading,error}=usePendingReservations(listId);
  if(!error)return loading ? <span className="text-[10px] text-gray-400">Checking reservations…</span> : null;
  return <button type="button" className="rounded-lg bg-amber-50 px-2 py-1 text-[10px] text-amber-800"
    onClick={()=>void refreshPendingReservations(listId)}>{error} Tap to retry.</button>;
}
export default function ReservedStockBadge({quantity,unit="pcs"}:{quantity:number;unit?:string}){
  if(quantity<=0)return null;
  return <span className="inline-flex rounded-lg bg-orange-50 px-2 py-1 text-[9px] font-semibold text-orange-800">
    {Number(quantity.toFixed(3))} {unit} · Reserved
  </span>;
}
export function ReservedForStock({type,id,parent=false,area=1,unit="pcs"}:{type:string;id:string;parent?:boolean;area?:number;unit?:string}){
  const {index,labels,ready}=usePendingReservations();
  if(!Number.isFinite(area)||area<=0)return null;
  const quantity=(parent?index.parent(type,id):index.quantity(type,id))*area;
  const details=ready===false?[]:labels.details(type,id,parent);
  if(!details.length)return <ReservedStockBadge quantity={quantity} unit={unit}/>;
  return <span className="flex flex-wrap gap-1" aria-label="Pending reservations">
    {labels.hidden(type,id,parent)&&quantity>0?<span className="inline-flex rounded-lg bg-orange-50 px-2 py-1 text-[9px] font-semibold text-orange-800">{Number(quantity.toFixed(3))} {unit} · Reserved for checked period (includes other lists)</span>:null}
    {details.map(detail=><span key={detail.list_id} className="inline-flex max-w-full flex-wrap gap-x-1 rounded-lg bg-orange-50 px-2 py-1 text-[9px] font-semibold text-orange-800">
      <span>{Number((detail.quantity*area).toFixed(3))} {unit} · Reserved for {detail.label}</span>
      <span>· {reservationDateLabel(detail.start_date,detail.end_date)}</span>
    </span>)}
  </span>;
}

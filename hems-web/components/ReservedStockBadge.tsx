"use client";
import { refreshPendingReservations, usePendingReservations } from "@/lib/usePendingReservations";

export function ReservationReadStatus(){
  const {loading,error}=usePendingReservations();
  if(!error)return loading ? <span className="text-[10px] text-gray-400">Checking reservations…</span> : null;
  return <button type="button" className="rounded-lg bg-amber-50 px-2 py-1 text-[10px] text-amber-800"
    onClick={()=>void refreshPendingReservations()}>{error} Tap to retry.</button>;
}
export default function ReservedStockBadge({quantity,unit="pcs"}:{quantity:number;unit?:string}){
  if(quantity<=0)return null;
  return <span className="inline-flex rounded-lg bg-orange-50 px-2 py-1 text-[9px] font-semibold text-orange-800">
    {Number(quantity.toFixed(3))} {unit} · Reserved
  </span>;
}
export function ReservedForStock({type,id,parent=false,area=1,unit="pcs"}:{type:string;id:string;parent?:boolean;area?:number;unit?:string}){
  const {index}=usePendingReservations();
  return <ReservedStockBadge quantity={(parent ? index.parent(type,id) : index.quantity(type,id))*area} unit={unit} />;
}

"use client";
import { refreshPendingReservations, usePendingReservations } from "@/lib/usePendingReservations";

function dateLabel(value:string){
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Dubai"});
}
export default function ReservationPeriodNotice(){
  const state=usePendingReservations();
  if(state.error)return <button type="button" onClick={()=>void refreshPendingReservations()} className="text-left text-xs text-amber-800">{state.error} Tap to retry.</button>;
  if(!state.ready)return <p className="text-xs text-gray-400">Checking dated reservations…</p>;
  const period=state.period;
  return <p className="text-xs text-gray-500" role="status">
    Availability: {period?.start&&period.end?`${dateLabel(period.start)} – ${dateLabel(period.end)} (inclusive)`:"all dates"}.
    {state.contextId?" For the selected list.":" Today's stock."} Dispatched equipment stays unavailable until received.
  </p>;
}

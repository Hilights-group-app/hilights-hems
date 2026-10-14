"use client";

import Link from "next/link";
import { useRepairStatus, invalidateRepairStatus } from "@/lib/useRepairStatus";
import { groupRepairBadges, repairMovementClass } from "@/lib/repairWorkflow";

export function invalidateMaintenanceRepairBadges(){invalidateRepairStatus();}
export default function MaintenanceRepairBadge({itemId,recordId}:{itemId?:string;recordId?:string}) {
  const {rows}=useRepairStatus();
  const badges=recordId ? rows.filter(row=>row.inventory_record_id===recordId && row.quantity>0) : groupRepairBadges(rows,itemId || "");
  if(!badges.length)return null;
  return <div className="mt-1 flex flex-wrap gap-1">{badges.map(badge=><Link
    key={`${badge.list_id}:${badge.phase}:${Boolean(badge.stock_conflict)}`}
    href={`/inventory/lists/${badge.list_id}`} onClick={event=>event.stopPropagation()}
    title={`${badge.reference} · ${badge.label}`}
    className={`max-w-full rounded-lg px-2 py-1 text-[9px] font-semibold transition ${repairMovementClass({listId:badge.list_id,reference:badge.reference,label:badge.label,repairPhase:badge.phase,stockConflict:badge.stock_conflict})}`}>
      {badge.quantity} pcs · {badge.stock_conflict?"Repair / stock mismatch":badge.label}
  </Link>)}</div>;
}

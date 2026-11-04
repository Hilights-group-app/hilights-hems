"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { PencilLine, X } from "lucide-react";
import type { EquipmentList, EquipmentListItem } from "@/lib/equipmentLists";
import { canCorrectReceived, receiptProgress } from "@/lib/receivedCorrection";

export function receiptLineLabel(item: EquipmentListItem) {
  const detail = [item.metadata?.row_label,
    item.metadata?.unit_no ? `ID ${item.metadata.unit_no}` : "",
    item.serial_number && item.serial_number !== "Not Available" ? `Serial ${item.serial_number}` : ""]
    .filter(Boolean).join(" · ");
  return `${item.display_name}${detail ? ` · ${detail}` : ` · ${item.inventory_record_id.slice(-8)}`}`;
}

/** One group-level action, including returned serials hidden by ID / Serial. */
export default function ReceivedCorrectionAction({ list, items, manager, disabled, onOpen, iconOnly = false }: {
  list: EquipmentList;
  items: readonly EquipmentListItem[];
  manager: boolean;
  disabled: boolean;
  onOpen: (item: EquipmentListItem) => void;
  iconOnly?: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const eligible = items.filter(item => canCorrectReceived(list, item, manager));
  if (!eligible.length) return null;
  return <>
    <button type="button" disabled={disabled} title="Correct an incorrectly recorded Received OK total"
      aria-label={`Correct Received for ${items[0]?.display_name || "equipment"}`}
      onClick={() => eligible.length === 1 ? onOpen(eligible[0]) : setChoosing(true)}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center gap-1 rounded-lg border border-gray-300 bg-white text-gray-600 hover:border-black disabled:opacity-40 ${iconOnly ? "" : "sm:w-auto sm:px-2 sm:text-[8px] sm:font-bold"}`}>
      <PencilLine size={12} /><span className={iconOnly ? "sr-only" : "hidden sm:inline"}>Correct Received</span>
    </button>
    {choosing && typeof document !== "undefined" ? createPortal(
      <div role="dialog" aria-modal="true" aria-label="Choose a receipt to correct"
        className="fixed inset-0 z-[10040] flex items-end justify-center sm:items-center sm:p-5">
        <button type="button" aria-label="Close receipt picker" onClick={() => setChoosing(false)} className="absolute inset-0 bg-black/50" />
        <div className="relative flex max-h-[85dvh] w-full flex-col rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-lg sm:rounded-3xl">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-bold">Correct Received</h2>
            <button type="button" aria-label="Close" onClick={() => setChoosing(false)} className="rounded-full bg-gray-100 p-2"><X size={16} /></button>
          </div>
          <p className="mb-3 text-xs text-gray-500">Choose the exact serial or cable length whose Received OK total is incorrect.</p>
          <div className="space-y-2 overflow-y-auto">
            {eligible.map(item => {
              const progress = receiptProgress(item);
              return <button key={item.id} type="button" disabled={disabled}
                onClick={() => { setChoosing(false); onOpen(item); }}
                className="w-full rounded-xl border border-gray-200 p-3 text-left hover:border-black disabled:opacity-40">
                <span className="block text-xs font-semibold text-gray-900">{receiptLineLabel(item)}</span>
                <span className="mt-1 block text-[10px] text-gray-500">Sent {progress.sent} · Received OK {item.returned_ok_quantity} · Out {progress.outside}</span>
              </button>;
            })}
          </div>
        </div>
      </div>, document.body) : null}
  </>;
}

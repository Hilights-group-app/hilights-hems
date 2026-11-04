"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { canManageEquipmentLists, getUserId } from "@/lib/authStore";
import { createClient } from "@/lib/supabase/client";
import { isOffline } from "@/lib/offline";
import { EQUIPMENT_LIST_ITEMS_EVENT, EQUIPMENT_LISTS_EVENT,
  type EquipmentList, type EquipmentListItem } from "@/lib/equipmentLists";
import { canCorrectReceived, correctionPreview } from "@/lib/receivedCorrection";
import { receiptLineLabel } from "./ReceivedCorrectionAction";

export default function ReceivedCorrectionDialog({ list, item, onClose, onSaved, onRefresh }: {
  list: EquipmentList;
  item: EquipmentListItem;
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  const [owner] = useState(() => getUserId());
  const [newOk, setNewOk] = useState(String(Math.max(0, item.returned_ok_quantity - 1)));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  let preview: ReturnType<typeof correctionPreview> | null = null;
  try { if (newOk.trim()) preview = correctionPreview(item, Number(newOk)); } catch { /* Inline validation below. */ }
  const cabinet = item.inventory_record_type === "matrix_row" && item.metadata?.matrix_source !== "generic";
  const units = cabinet ? "cabinets" : "units";
  const cabinetArea = Number(item.metadata?.cabinet_area_sqm) ||
    (item.requested_quantity > 0 ? Number(item.metadata?.actual_sqm) / item.requested_quantity : 0);
  const valid = Boolean(preview && reason.trim().length >= 5 && reason.trim().length <= 1000);

  async function save() {
    if (busy.current || blocked || !valid || !preview) return;
    if (!owner || owner !== getUserId() || !canCorrectReceived(list, item, canManageEquipmentLists())) {
      setError("Your access changed. Close and reopen the list."); return;
    }
    if (isOffline()) { setError("The app is offline. Connect to correct Received."); return; }
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await createClient().rpc("hems_correct_received_ok_quantity", {
        p_list_item_id: item.id,
        p_expected_ok: item.returned_ok_quantity,
        p_expected_maintenance: item.returned_maintenance_quantity,
        p_expected_approved: item.approved_quantity,
        p_corrected_ok: preview.newOk,
        p_reason: reason.trim(),
      });
      if (result.error) throw result.error;
      if (!mounted.current || getUserId() !== owner) return;
      const detail = { listId: list.id, status: result.data?.list_status };
      window.dispatchEvent(new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, { detail }));
      window.dispatchEvent(new CustomEvent(EQUIPMENT_LISTS_EVENT, { detail }));
      onSaved();
    } catch (failure: unknown) {
      if (!mounted.current || getUserId() !== owner) return;
      const problem = failure as { code?: string; message?: string };
      const uncertain = !problem?.code || !/^[A-Z0-9]{5}$/.test(problem.code);
      setBlocked(uncertain || problem.code === "40001");
      setError(uncertain
        ? "Could not confirm the correction. Refresh the list to check Received before trying again."
        : problem.message || "Could not correct Received. No correction was saved.");
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Correct Received OK"
      className="fixed inset-0 z-[10050] flex items-end justify-center sm:items-center sm:p-5">
      <button type="button" aria-label="Close correction" disabled={saving} onClick={onClose} className="absolute inset-0 bg-black/50" />
      <form onSubmit={event => { event.preventDefault(); void save(); }}
        className="relative max-h-[90dvh] w-full space-y-4 overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-lg sm:rounded-3xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold">Correct Received OK</h2>
            <p className="mt-1 text-[11px] text-gray-500">{list.reference} · {receiptLineLabel(item)}</p>
          </div>
          <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className="rounded-full bg-gray-100 p-2 disabled:opacity-40"><X size={16} /></button>
        </div>
        <p className="text-xs text-gray-600">Fix an incorrectly recorded receipt. Sent quantity stays unchanged. Use Received for equipment that actually returns.</p>
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-gray-50 p-3 text-center text-[10px]">
          <div>Sent<strong className="mt-1 block text-sm">{item.approved_quantity}</strong></div>
          <div>Received OK now<strong className="mt-1 block text-sm">{item.returned_ok_quantity}</strong></div>
          <div>Maintenance<strong className="mt-1 block text-sm">{item.returned_maintenance_quantity}</strong></div>
        </div>
        <label className="block text-xs font-semibold text-gray-700">Correct Received OK total ({units})
          <input type="number" min={0} max={item.returned_ok_quantity - 1} step={1} value={newOk} autoFocus disabled={saving || blocked}
            onChange={event => setNewOk(event.target.value)} onFocus={event => event.currentTarget.select()}
            className="mt-2 h-11 w-full rounded-xl border border-gray-300 px-3 text-base font-bold outline-none focus:border-black" />
        </label>
        {preview ? <div className="rounded-xl bg-blue-50 p-3 text-xs text-blue-900" aria-live="polite">
          After correction: <strong>{preview.newOk + preview.maintenance} Received · {preview.outside} Out</strong>
          <span className="mt-1 block">{preview.reinstated} {units} will move from Available back to this event / hire. Sent stays {preview.sent}.</span>
          {cabinet && cabinetArea > 0 ? <span className="mt-1 block">Out: {Number((preview.outside * cabinetArea).toFixed(3))} SQM.</span> : null}
        </div> : <p className="text-xs text-red-700">Enter a whole number from 0 to {item.returned_ok_quantity - 1}.</p>}
        <label className="block text-xs font-semibold text-gray-700">Reason (saved in history)
          <textarea value={reason} maxLength={1000} rows={3} disabled={saving || blocked} onChange={event => setReason(event.target.value)}
            placeholder="Example: received 1 pc, but entered 8 by mistake."
            className="mt-2 w-full resize-y rounded-xl border border-gray-300 p-3 text-sm font-normal outline-none focus:border-black" />
        </label>
        {error ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</p> : null}
        {blocked ? <button type="button" onClick={onRefresh} className="h-11 w-full rounded-xl bg-black text-xs font-semibold text-white">Refresh list</button>
          : <button type="submit" disabled={saving || !valid} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-black text-xs font-semibold text-white disabled:opacity-40">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}{saving ? "Saving..." : "Save Correction"}
          </button>}
      </form>
    </div>, document.body);
}

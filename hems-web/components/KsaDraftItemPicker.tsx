"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Plus, Search, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { EquipmentList } from "@/lib/equipmentLists";
import { ksaRequestedQuantity, type KsaInventoryGroup, type KsaUnitChoice } from "@/lib/ksaInventory";

export default function KsaDraftItemPicker({item,list,onClose,onAdded}: {
  item:KsaInventoryGroup; list:EquipmentList; onClose:()=>void; onAdded:(quantity:number)=>void;
}) {
  const supabase=useMemo(() => createClient(),[]);
  const [units,setUnits]=useState<KsaUnitChoice[]>([]);
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [search,setSearch]=useState("");
  const [loading,setLoading]=useState(item.record_type==="unit");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [quantity,setQuantity]=useState("1");
  const [mode,setMode]=useState<"units"|"sqm">("units");
  const scope=useRef(0),busy=useRef(false);
  const area=Number(item.metadata?.cabinet_area_sqm)||0;
  const allowSqm=item.record_type==="matrix_row" && item.metadata?.matrix_source!=="generic" && area>0;
  const required=ksaRequestedQuantity(Number(quantity),mode,area);
  const valid=item.record_type==="unit" ? selected.size>0 : required>0 && required<=item.selectable_quantity;

  async function reloadUnits(version=scope.current) {
    setLoading(true);
    try {
      const {data,error:readError}=await supabase.rpc("hems_ksa_unit_choices",{p_item_id:item.parent_record_id});
      if (readError) throw readError;
      if (scope.current===version) {
        const next=(data?.units || []) as KsaUnitChoice[];
        setUnits(next);
        const available=new Set(next.filter((unit) => unit.selectable).map((unit) => unit.id));
        setSelected((current) => new Set([...current].filter((id) => available.has(id))));
      }
    } catch (readError:any) {if(scope.current===version) setError(readError?.message || "Serial numbers could not be loaded.");}
    finally {if(scope.current===version) setLoading(false);}
  }
  useEffect(() => {
    const version=++scope.current;
    setSelected(new Set());setError("");setSearch("");setQuantity("1");setMode("units");
    setLoading(item.record_type==="unit");
    if (item.record_type==="unit") void reloadUnits(version);
    return () => {++scope.current;};
    // Reload only when the equipment or target draft changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.record_type,item.parent_record_id,item.record_id,list.id,supabase]);

  const visible=units.filter((unit) => `${unit.unit_no ?? ""} ${unit.serial || ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selectable=visible.filter((unit) => unit.selectable);
  const allVisibleSelected=selectable.length>0 && selectable.every((unit) => selected.has(unit.id));
  function toggleUnit(unit:KsaUnitChoice) {
    if (!unit.selectable || busy.current) return;
    setSelected((current) => {const next=new Set(current);if(next.has(unit.id))next.delete(unit.id);else if(next.size<1000)next.add(unit.id);return next;});
  }
  function toggleVisible() {
    if (busy.current) return;
    setSelected((current) => {const next=new Set(current);for(const unit of selectable){if(allVisibleSelected)next.delete(unit.id);else if(next.size<1000)next.add(unit.id);}return next;});
  }
  async function addSelected() {
    if (busy.current || loading || !valid) return;
    const version=scope.current;
    busy.current=true;setSaving(true);setError("");
    try {
      const count=item.record_type==="unit" ? selected.size : required;
      const {error:addError}=item.record_type==="unit"
        ? await supabase.rpc("hems_add_ksa_units",{p_list_id:list.id,p_item_id:item.parent_record_id,p_unit_ids:[...selected]})
        : await supabase.rpc("hems_add_ksa_item",{p_list_id:list.id,p_record_type:item.record_type,p_record_id:item.record_id,p_quantity:required});
      if (addError) throw addError;
      if (scope.current===version) onAdded(count);
    } catch (addError:any) {if(scope.current===version) setError(addError?.message || "Equipment could not be added. Refresh and try again.");}
    finally {busy.current=false;if(scope.current===version) setSaving(false);}
  }
  if (typeof document==="undefined") return null;
  return createPortal(<div className="fixed inset-0 z-[10040] flex items-end justify-center sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-label={`Add ${item.display_name} to ${list.reference}`}>
    <button type="button" aria-label="Close equipment picker" disabled={saving} onClick={onClose} className="absolute inset-0 bg-black/50"/>
    <div className="relative flex max-h-[88dvh] w-full flex-col rounded-t-3xl bg-white p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-2xl sm:max-w-lg sm:rounded-3xl sm:p-5">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words text-base font-bold text-gray-900">{item.display_name}</h2><p className="mt-1 text-xs text-gray-500">Add to {list.reference} · {item.record_type==="unit" ? "Select serial numbers to return" : `${item.selectable_quantity} unreserved in KSA`}</p></div>
        <button type="button" aria-label="Close picker" disabled={saving} onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gray-100"><X size={17}/></button></div>
      {item.record_type==="unit" ? <>
        <div className="relative mt-4"><Search size={16} className="absolute left-3 top-3.5 text-gray-400"/><input type="search" value={search} disabled={saving} onChange={(event) => setSearch(event.target.value)} placeholder="Search serial or fixture ID" aria-label="Search serials" className="min-h-11 w-full rounded-xl border border-gray-200 pl-9 pr-3 text-base outline-none focus:border-blue-500 sm:text-sm"/></div>
        <div className="my-3 flex items-center justify-between gap-2 text-xs"><span className="font-semibold text-gray-600">{selected.size} selected</span><button type="button" disabled={loading || saving} onClick={() => {setError("");void reloadUnits();}} className="min-h-9 rounded-lg px-2 font-semibold text-blue-700 disabled:opacity-40">Reload serials</button><button type="button" disabled={loading || saving || !selectable.length} onClick={toggleVisible} className="min-h-9 rounded-lg bg-gray-100 px-3 font-semibold text-gray-700 disabled:opacity-40">{allVisibleSelected ? "Clear visible" : "Select visible"}</button></div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain">
          {loading ? <div className="flex justify-center p-8"><Loader2 className="animate-spin text-blue-700"/></div> : !visible.length ? <p className="p-5 text-center text-xs text-gray-500">No matching KSA serials.</p> : visible.map((unit) => <label key={unit.id} className={`flex min-h-12 items-center gap-3 rounded-xl border px-3 py-2 ${!unit.selectable ? "border-gray-100 bg-gray-50 text-gray-400" : selected.has(unit.id) ? "border-blue-300 bg-blue-50 text-blue-900" : "border-gray-200 text-gray-800"}`}>
            <input type="checkbox" checked={selected.has(unit.id)} disabled={saving || !unit.selectable} onChange={() => toggleUnit(unit)} className="h-5 w-5 shrink-0 accent-blue-700"/>
            <span className="min-w-0 flex-1"><span className="block break-words text-sm font-semibold">{unit.serial ? `SN ${unit.serial}` : `Unit ${unit.unit_no ?? ""}`}</span><span className="mt-0.5 block text-[11px]">{!unit.selectable ? "Already selected for return" : unit.unit_no != null ? `Fixture ID ${unit.unit_no}` : "In KSA"}</span></span>
          </label>)}
        </div>
      </> : <div className="mt-5 space-y-3">
        {allowSqm ? <div className="flex gap-2">{(["units","sqm"] as const).map((option) => <button key={option} type="button" disabled={saving} onClick={() => {setMode(option);setQuantity("1");}} className={`min-h-11 rounded-xl px-4 text-xs font-semibold ${mode===option ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-600"}`}>{option==="sqm" ? "SQM" : "Cabinets"}</button>)}</div> : null}
        <label className="block text-xs font-semibold text-gray-600">{mode==="sqm" ? "Area in SQM" : allowSqm ? "Cabinet quantity" : "Quantity"}<input type="number" inputMode={mode==="sqm" ? "decimal" : "numeric"} min={mode==="sqm" ? 0.001 : 1} step={mode==="sqm" ? "any" : 1} max={mode==="sqm" ? item.selectable_quantity*area : item.selectable_quantity} value={quantity} disabled={saving} onChange={(event) => setQuantity(event.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-gray-200 px-3 text-base font-bold outline-none focus:border-blue-500"/></label>
        {mode==="sqm" ? <p className="text-xs text-gray-500">{required} cabinets · {Number((required*area).toFixed(3))} SQM</p> : null}
        {!valid ? <p className="text-xs text-red-600">Choose a quantity within the unreserved KSA stock.</p> : null}
      </div>}
      {error ? <div role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-xs leading-5 text-red-700">{error}</div> : null}
      <button type="button" disabled={saving || loading || !valid} onClick={() => void addSelected()} className="mt-4 flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-700 px-4 text-sm font-bold text-white disabled:opacity-40">{saving ? <Loader2 size={16} className="animate-spin"/> : <Plus size={16}/>} {saving ? "Adding…" : item.record_type==="unit" ? `Add ${selected.size} selected` : "Add to draft"}</button>
    </div>
  </div>,document.body);
}

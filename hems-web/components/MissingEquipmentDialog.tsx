"use client";
import { useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle,Loader2,X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { canManageEquipmentLists,getUserId } from "@/lib/authStore";
import { createBrowserId } from "@/lib/browserId";
import { isOffline } from "@/lib/offline";
import { EQUIPMENT_LISTS_EVENT,EQUIPMENT_LIST_ITEMS_EVENT,type EquipmentList,type EquipmentListItem } from "@/lib/equipmentLists";
import { canMarkMissing,missingCount,missingOutside,missingLineLabel,validateMissingQuantity,MISSING_EQUIPMENT_EVENT,type MissingEquipment } from "@/lib/missingEquipment";

type Props=({mode:"mark";list:EquipmentList;items:EquipmentListItem[]}|{mode:"recover";entry:MissingEquipment}) & {onClose:()=>void;onSaved:()=>void;onRefresh:()=>void};
export default function MissingEquipmentDialog(props:Props) {
  const [owner]=useState(()=>getUserId()),[selected,setSelected]=useState(props.mode==="mark"?props.items[0]?.id||"":"");
  const [quantity,setQuantity]=useState("1"),[note,setNote]=useState(""),[confirmed,setConfirmed]=useState(false);
  const [saving,setSaving]=useState(false),[blocked,setBlocked]=useState(false),[error,setError]=useState("");
  const busy=useRef(false),mounted=useRef(true),requestId=useRef(""),request=useRef<AbortController|null>(null);
  const panel=useRef<HTMLFormElement>(null);
  useEffect(()=>{mounted.current=true;const previous=document.activeElement;panel.current?.querySelector<HTMLElement>("select,input,button")?.focus();return()=>{mounted.current=false;request.current?.abort();if(previous instanceof HTMLElement)previous.focus();};},[]);
  const item=props.mode==="mark"?props.items.find(item=>item.id===selected):undefined;
  const max=props.mode==="mark"?(item?missingOutside(item):0):missingCount(props.entry.remaining_quantity);
  const name=props.mode==="mark"?item?.display_name||"Equipment":props.entry.display_name;
  let amount=0;try{amount=validateMissingQuantity(quantity,max);}catch{/* Inline validation below. */}
  const valid=amount>0&&confirmed&&note.length<=1000;
  async function save() {
    if(busy.current||blocked||!valid)return;
    if(!owner||owner!==getUserId()||!canManageEquipmentLists()){setError("Your access changed. Reopen this page.");return;}
    if(isOffline()){setError("The app is offline. Connect before changing Missing equipment.");return;}
    if(props.mode==="mark"&&(!item||!canMarkMissing(props.list,item,true))){setError("This equipment is no longer eligible. Refresh the list.");return;}
    busy.current=true;setSaving(true);setError("");requestId.current||=createBrowserId();
    const abort=new AbortController();request.current=abort;const timer=window.setTimeout(()=>abort.abort(),25000);
    try {
      const result=props.mode==="mark"&&item ? await createClient().rpc("hems_mark_missing",{
        p_list_item_id:item.id,p_quantity:amount,p_expected_approved:item.approved_quantity,p_expected_ok:item.returned_ok_quantity,
        p_expected_maintenance:item.returned_maintenance_quantity,p_expected_missing:missingCount(item.missing_quantity),p_note:note.trim(),p_request_id:requestId.current,
      }).abortSignal(abort.signal):props.mode==="recover"?await createClient().rpc("hems_recover_missing",{
        p_missing_id:props.entry.id,p_quantity:amount,p_expected_recovered:props.entry.recovered_quantity,p_note:note.trim(),p_request_id:requestId.current,
      }).abortSignal(abort.signal):null;
      if(!result)throw new Error("Choose equipment first.");if(result.error)throw result.error;
      if(!mounted.current||owner!==getUserId())return;
      const detail={listId:props.mode==="mark"?props.list.id:props.entry.list_id,action:props.mode==="mark"?"missing":"recovered"};
      for(const event of [EQUIPMENT_LIST_ITEMS_EVENT,EQUIPMENT_LISTS_EVENT,MISSING_EQUIPMENT_EVENT])window.dispatchEvent(new CustomEvent(event,{detail}));
      props.onSaved();
    }catch(failure:unknown){
      if(!mounted.current||owner!==getUserId())return;
      const problem=failure as {code?:string;message?:string},uncertain=!problem.code||!/^[A-Z0-9]{5}$/.test(problem.code);
      setBlocked(true);setError(uncertain?"The result could not be confirmed. Refresh before retrying; it may already be saved.":problem.message||"The change could not be saved. Refresh before retrying.");
    }finally{clearTimeout(timer);if(request.current===abort)request.current=null;busy.current=false;if(mounted.current)setSaving(false);}
  }
  if(typeof document==="undefined")return null;
  return createPortal(<div role="dialog" aria-modal="true" aria-label={props.mode==="mark"?"Mark equipment Missing":"Recover Missing equipment"}
    className="fixed inset-0 z-[10060] flex items-end justify-center sm:items-center sm:p-5"
    onKeyDown={event=>{
      if(event.key==="Escape"&&!busy.current)props.onClose();
      if(event.key==="Tab"){const nodes=panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])');if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
    }}>
    <button type="button" aria-label="Close" disabled={saving} onClick={props.onClose} className="absolute inset-0 bg-black/50"/>
    <form ref={panel} onSubmit={event=>{event.preventDefault();void save();}} className="relative max-h-[90dvh] w-full space-y-4 overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-w-lg sm:rounded-3xl">
      <div className="flex items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-base font-bold"><AlertTriangle size={17} className="text-red-600"/>{props.mode==="mark"?"Mark Missing":"Found / Recovered"}</h2><p className="mt-1 text-xs text-gray-500">{name}</p></div><button type="button" disabled={saving} onClick={props.onClose} aria-label="Close" className="rounded-full bg-gray-100 p-2"><X size={16}/></button></div>
      {props.mode==="mark"?<>
        <p className="text-xs text-gray-600">{props.list.event_name||props.list.client_company||props.list.reference}{props.list.venue?` · ${props.list.venue}`:""}. Only mark equipment confirmed lost, not equipment still returning.</p>
        {props.items.length>1?<label className="block text-xs font-semibold">Choose exact equipment / serial<select value={selected} disabled={saving||blocked} onChange={event=>{setSelected(event.target.value);setQuantity("1");setConfirmed(false);}} className="mt-2 w-full rounded-xl border p-3 text-sm">{props.items.map(line=><option key={line.id} value={line.id}>{missingLineLabel(line)} · {missingOutside(line)} Out</option>)}</select></label>:item?<p className="text-xs font-semibold">{missingLineLabel(item)}</p>:null}
      </>:<p className="text-xs text-gray-600">{props.entry.event_name} · {props.entry.location||"No location"}. Check the equipment first: this action returns it to Available stock, not Maintenance.</p>}
      <label className="block text-xs font-semibold">{props.mode==="mark"?"Missing":"Recovered"} quantity ({item?.inventory_record_type==="matrix_row"&&item.metadata?.matrix_source!=="generic"||props.mode==="recover"&&props.entry.inventory_record_type==="matrix_row"&&props.entry.metadata?.matrix_source!=="generic"?"cabinets":"pcs"})<input type="number" inputMode="numeric" step={1} min={1} max={max} value={quantity} disabled={saving||blocked||item?.inventory_record_type==="unit"||props.mode==="recover"&&props.entry.inventory_record_type==="unit"} onChange={event=>{setQuantity(event.target.value);setConfirmed(false);}} className="mt-2 h-11 w-full rounded-xl border px-3 text-base font-bold"/><span className="mt-1 block font-normal text-gray-500">Maximum: {max}</span></label>
      <label className="block text-xs font-semibold">Note (optional)<textarea rows={3} maxLength={1000} value={note} disabled={saving||blocked} onChange={event=>setNote(event.target.value)} className="mt-2 w-full rounded-xl border p-3 text-sm font-normal"/></label>
      <label className="flex gap-2 rounded-xl bg-gray-50 p-3 text-xs"><input type="checkbox" checked={confirmed} disabled={saving||blocked} onChange={event=>setConfirmed(event.target.checked)} className="mt-0.5"/><span>{props.mode==="mark"?"I confirmed this equipment is lost. It stays unavailable until Recovered.":"I checked this equipment is physically back, in working condition, and ready to become Available."}</span></label>
      {!amount?<p className="text-xs text-red-700">Enter a whole quantity from 1 to {max}.</p>:null}
      {error?<p role="alert" className="rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</p>:null}
      {blocked?<button type="button" onClick={props.onRefresh} className="h-11 w-full rounded-xl bg-black text-xs font-bold text-white">Refresh before retrying</button>:<button type="submit" disabled={saving||!valid} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-red-600 text-xs font-bold text-white disabled:opacity-40">{saving?<Loader2 size={15} className="animate-spin"/>:null}{saving?"Saving…":props.mode==="mark"?"Confirm Missing":"Confirm Recovered"}</button>}
    </form>
  </div>,document.body);
}

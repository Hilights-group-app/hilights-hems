"use client";
import { useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";
import { Loader2,Pencil,X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getUserId } from "@/lib/authStore";
import { isOffline } from "@/lib/offline";
import { EQUIPMENT_LISTS_EVENT,type EquipmentList } from "@/lib/equipmentLists";
import { canEditDryHireHeader,dryHireHeaderInput } from "@/lib/dryHireHeader";

type Fields=Pick<EquipmentList,"client_company"|"pickup_date"|"return_date">;
export default function DryHireHeaderEdit({list,owner,role,onSaved,onRefresh}:{list:EquipmentList;owner:string|null;role:string;onSaved:(fields:Fields)=>void;onRefresh:()=>void}){
  const [open,setOpen]=useState(false),[name,setName]=useState(""),[pickup,setPickup]=useState(""),[returned,setReturned]=useState("");
  const [saving,setSaving]=useState(false),[blocked,setBlocked]=useState(false),[error,setError]=useState("");
  const [snapshot,setSnapshot]=useState(list);
  const busy=useRef(false),mounted=useRef(true),request=useRef<AbortController|null>(null),panel=useRef<HTMLFormElement>(null);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current?.abort();};},[]);
  useEffect(()=>{setOpen(false);request.current?.abort();},[list.id,owner]);
  useEffect(()=>{if(!open)return;const previous=document.activeElement;panel.current?.querySelector<HTMLInputElement>('input')?.focus();return()=>{if(previous instanceof HTMLElement)previous.focus();};},[open]);
  const allowed=canEditDryHireHeader(list,owner,role);
  let input:ReturnType<typeof dryHireHeaderInput>|null=null;
  try{input=dryHireHeaderInput(name,pickup,returned);}catch{/* Inline validation. */}
  function show(){setSnapshot(list);setName(list.client_company||"");setPickup(list.pickup_date||"");setReturned(list.return_date||"");setError("");setBlocked(false);setOpen(true);}
  async function save(){
    if(busy.current||blocked)return;
    if(!owner||owner!==getUserId()||!canEditDryHireHeader(list,owner,role)){setError("Your access changed. Reopen this list.");return;}
    if(isOffline()){setError("The app is offline. Connect before editing Dry Hire.");return;}
    let fields:ReturnType<typeof dryHireHeaderInput>;
    try{fields=dryHireHeaderInput(name,pickup,returned);}catch(failure:unknown){setError(failure instanceof Error?failure.message:"Check the name and dates.");return;}
    busy.current=true;setSaving(true);setError("");const abort=new AbortController();request.current=abort;const timer=window.setTimeout(()=>abort.abort(),20000);
    try{
      const result=await createClient().rpc("hems_edit_dry_hire_header",{
        p_list_id:snapshot.id,p_client_company:fields.client_company,p_pickup_date:fields.pickup_date,p_return_date:fields.return_date,
        p_expected_name:snapshot.client_company,p_expected_pickup:snapshot.pickup_date,p_expected_return:snapshot.return_date,p_expected_status:snapshot.status,
      }).abortSignal(abort.signal);
      if(result.error)throw result.error;
      if(!mounted.current||owner!==getUserId())return;
      if(result.data?.id!==snapshot.id||result.data?.client_company!==fields.client_company||result.data?.pickup_date!==fields.pickup_date||result.data?.return_date!==fields.return_date)throw new Error("Unexpected save response.");
      window.dispatchEvent(new CustomEvent(EQUIPMENT_LISTS_EVENT,{detail:{listId:snapshot.id,action:"dry_hire_header_updated"}}));
      setOpen(false);onSaved(fields);
    }catch(failure:unknown){
      if(mounted.current&&owner===getUserId()){
        const problem=failure as {code?:string;message?:string};
        const editableError=problem.code==="23514"||problem.code==="22007";
        setBlocked(!editableError);
        setError(editableError?problem.message||"Review the name, dates and overlapping reservations.":!problem.code||!/^[A-Z0-9]{5}$/.test(problem.code)?"The save result could not be confirmed. Refresh before retrying.":problem.message||"Refresh the list before retrying.");
      }
    }finally{clearTimeout(timer);if(request.current===abort)request.current=null;busy.current=false;if(mounted.current)setSaving(false);}
  }
  if(!allowed)return null;
  return <>
    <button type="button" onClick={show} title="Edit Dry Hire name and dates" aria-label="Edit Dry Hire name and dates" className="inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-xl border border-gray-300 bg-white px-2 text-[10px] font-semibold text-gray-700 hover:bg-gray-50 hems-wide:px-3"><Pencil size={14}/><span className="hidden hems-wide:inline">Edit Dry Hire</span></button>
    {open&&typeof document!=="undefined"?createPortal(<div role="dialog" aria-modal="true" aria-label="Edit Dry Hire"
      className="fixed inset-0 z-[10060] flex items-end justify-center sm:items-center sm:p-5"
      onKeyDown={event=>{if(event.key==="Escape"&&!busy.current)setOpen(false);if(event.key==="Tab"){const nodes=panel.current?.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled])');if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}}>
      <button type="button" aria-label="Close editor" disabled={saving} onClick={()=>setOpen(false)} className="absolute inset-0 bg-black/50"/>
      <form ref={panel} onSubmit={event=>{event.preventDefault();void save();}} className="relative max-h-[90dvh] w-full space-y-4 overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-w-lg sm:rounded-3xl">
        <div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-bold">Edit Dry Hire</h2><p className="mt-1 text-xs text-gray-500">{snapshot.reference}</p></div><button type="button" aria-label="Close" disabled={saving} onClick={()=>setOpen(false)} className="rounded-full bg-gray-100 p-2"><X size={16}/></button></div>
        <label className="block text-xs font-semibold">Client / Company<input value={name} maxLength={200} disabled={saving||blocked} onChange={event=>setName(event.target.value)} className="mt-2 h-11 w-full rounded-xl border px-3 text-base"/></label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block min-w-0 text-xs font-semibold">Pickup Date<input type="date" value={pickup} disabled={saving||blocked} onChange={event=>setPickup(event.target.value)} className="mt-2 h-11 w-full min-w-0 rounded-xl border px-3 text-base"/></label>
          <label className="block min-w-0 text-xs font-semibold">Return Date<input type="date" min={pickup} value={returned} disabled={saving||blocked} onChange={event=>setReturned(event.target.value)} className="mt-2 h-11 w-full min-w-0 rounded-xl border px-3 text-base"/></label>
        </div>
        <p className="text-xs text-gray-500">Admin only. Both dates are included. Date changes are checked against Pending reservations; dispatched equipment stays out until Received.</p>
        {error?<p role="alert" className="rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</p>:null}
        {blocked?<button type="button" onClick={()=>{setOpen(false);onRefresh();}} className="h-11 w-full rounded-xl bg-black text-xs font-bold text-white">Refresh list before retrying</button>:<button type="submit" disabled={saving||!input} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-black text-xs font-bold text-white disabled:opacity-40">{saving?<Loader2 size={14} className="animate-spin"/>:null}{saving?"Saving…":"Save Dry Hire"}</button>}
      </form>
    </div>,document.body):null}
  </>;
}

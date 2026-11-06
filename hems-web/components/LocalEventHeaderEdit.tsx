"use client";
import { useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";
import { Loader2,Pencil,X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getUserId } from "@/lib/authStore";
import { isOffline } from "@/lib/offline";
import { EQUIPMENT_LISTS_EVENT,type EquipmentList } from "@/lib/equipmentLists";
import { canEditLocalEventHeader,localEventHeaderInput } from "@/lib/localEventHeader";

export default function LocalEventHeaderEdit({list,owner,role,onSaved,onRefresh}:{list:EquipmentList;owner:string|null;role:string;onSaved:(fields:Pick<EquipmentList,"event_name"|"venue">)=>void;onRefresh:()=>void}) {
  const [open,setOpen]=useState(false),[name,setName]=useState(""),[location,setLocation]=useState(""),[error,setError]=useState("");
  const [saving,setSaving]=useState(false),[blocked,setBlocked]=useState(false);
  const busy=useRef(false),mounted=useRef(true),request=useRef<AbortController|null>(null),panel=useRef<HTMLFormElement>(null);
  const [snapshot,setSnapshot]=useState(list);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current?.abort();};},[]);
  useEffect(()=>{setOpen(false);request.current?.abort();},[list.id,owner]);
  useEffect(()=>{if(!open)return;const previous=document.activeElement;panel.current?.querySelector<HTMLInputElement>('input')?.focus();return()=>{if(previous instanceof HTMLElement)previous.focus();};},[open]);
  const allowed=canEditLocalEventHeader(list,owner,role),draft=snapshot.status==="draft";
  let input:ReturnType<typeof localEventHeaderInput>|null=null;
  try{input=localEventHeaderInput(snapshot,name,location);}catch{/* Inline validation on save. */}
  function show(){setSnapshot(list);setName(list.event_name||"");setLocation(list.venue||"");setError("");setBlocked(false);setOpen(true);}
  async function save(){
    if(busy.current||blocked)return;
    if(!owner||getUserId()!==owner||!canEditLocalEventHeader(list,owner,role)){setError("Your access changed. Reopen the list.");return;}
    if(isOffline()){setError("The app is offline. Connect before editing the event.");return;}
    let fields:ReturnType<typeof localEventHeaderInput>;
    try{fields=localEventHeaderInput(snapshot,name,location);}catch(failure:unknown){setError(failure instanceof Error?failure.message:"Check the event details.");return;}
    busy.current=true;setSaving(true);setError("");const abort=new AbortController();request.current=abort;const timer=window.setTimeout(()=>abort.abort(),20000);
    try{
      const result=await createClient().rpc("hems_edit_local_event_header",{
        p_list_id:snapshot.id,p_event_name:fields.eventName,p_venue:fields.venue,
        p_expected_name:snapshot.event_name,p_expected_venue:snapshot.venue,p_expected_status:snapshot.status,
      }).abortSignal(abort.signal);
      if(result.error)throw result.error;if(!mounted.current||owner!==getUserId())return;
      window.dispatchEvent(new CustomEvent(EQUIPMENT_LISTS_EVENT,{detail:{listId:snapshot.id,action:"event_header_updated"}}));
      setOpen(false);onSaved({event_name:fields.eventName,venue:fields.venue});
    }catch(failure:unknown){if(mounted.current&&owner===getUserId()){const problem=failure as {code?:string;message?:string};setBlocked(true);setError(!problem.code||!/^[A-Z0-9]{5}$/.test(String(problem.code))?"The result could not be confirmed. Refresh the list before retrying.":problem.message||"The event could not be saved. Refresh before retrying.");}}
    finally{clearTimeout(timer);if(request.current===abort)request.current=null;busy.current=false;if(mounted.current)setSaving(false);}
  }
  if(!allowed)return null;
  return <>
    <button type="button" onClick={show} title="Edit event details" aria-label="Edit event details" className="inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-xl border border-gray-300 bg-white px-2 text-[10px] font-semibold text-gray-700 hover:bg-gray-50 hems-wide:px-3"><Pencil size={14}/><span className="hidden hems-wide:inline">Edit event</span></button>
    {open&&typeof document!=="undefined"?createPortal(<div role="dialog" aria-modal="true" aria-label="Edit local event"
      className="fixed inset-0 z-[10060] flex items-end justify-center sm:items-center sm:p-5"
      onKeyDown={event=>{if(event.key==="Escape"&&!busy.current)setOpen(false);if(event.key==="Tab"){const nodes=panel.current?.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled])');if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}}}>
      <button type="button" aria-label="Close editor" disabled={saving} onClick={()=>setOpen(false)} className="absolute inset-0 bg-black/50"/>
      <form ref={panel} onSubmit={event=>{event.preventDefault();void save();}} className="relative max-h-[90dvh] w-full space-y-4 overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:max-w-lg sm:rounded-3xl">
        <div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-bold">Edit event</h2><p className="mt-1 text-xs text-gray-500">{snapshot.reference}</p></div><button type="button" aria-label="Close" disabled={saving} onClick={()=>setOpen(false)} className="rounded-full bg-gray-100 p-2"><X size={16}/></button></div>
        <label className="block text-xs font-semibold">Event name<input value={name} maxLength={200} disabled={saving||blocked} onChange={event=>setName(event.target.value)} className="mt-2 h-11 w-full rounded-xl border px-3 text-sm"/></label>
        {draft?<label className="block text-xs font-semibold">Location<input value={location} maxLength={300} disabled={saving||blocked} onChange={event=>setLocation(event.target.value)} className="mt-2 h-11 w-full rounded-xl border px-3 text-sm"/></label>:<p className="text-xs text-gray-500">Location: {snapshot.venue||"—"}<span className="mt-1 block">After Submit, only Admin can edit the event name. Location stays unchanged.</span></p>}
        {error?<p role="alert" className="rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</p>:null}
        {blocked?<button type="button" onClick={()=>{setOpen(false);onRefresh();}} className="h-11 w-full rounded-xl bg-black text-xs font-bold text-white">Refresh list before retrying</button>:<button type="submit" disabled={saving||!input} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-black text-xs font-bold text-white disabled:opacity-40">{saving?<Loader2 size={14} className="animate-spin"/>:null}{saving?"Saving…":"Save event"}</button>}
      </form>
    </div>,document.body):null}
  </>;
}

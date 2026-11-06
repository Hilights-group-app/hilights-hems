"use client";
import { useEffect,useMemo,useRef,useState } from "react";
import Link from "next/link";
import { AlertTriangle,Check,ChevronLeft,ChevronRight,Loader2,RefreshCw,Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { canManageEquipmentLists,getUserId } from "@/lib/authStore";
import { isOffline } from "@/lib/offline";
import NavigationFeedbackLink from "./NavigationFeedbackLink";
import MissingEquipmentDialog from "./MissingEquipmentDialog";
import { MISSING_EQUIPMENT_EVENT,MISSING_SELECT,missingSearchPattern,type MissingEquipment } from "@/lib/missingEquipment";

const PAGE_SIZE=50;
function date(value:string|null) {if(!value)return "—";const time=new Date(value);return Number.isFinite(time.getTime())?new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Dubai"}).format(time):"—";}
export default function MissingEquipmentClient() {
  const client=useMemo(()=>createClient(),[]),[owner,setOwner]=useState(()=>getUserId()||"");
  const [query,setQuery]=useState(""),[search,setSearch]=useState(""),[filter,setFilter]=useState("missing"),[page,setPage]=useState(0),[revision,setRevision]=useState(0);
  const [rows,setRows]=useState<MissingEquipment[]>([]),[hasMore,setHasMore]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const [dataOwner,setDataOwner]=useState(""),[manager,setManager]=useState(false),[entry,setEntry]=useState<MissingEquipment|null>(null);
  const [historyId,setHistoryId]=useState("");
  const latest=useRef(0);
  useEffect(()=>{
    const {data}=client.auth.onAuthStateChange((_event:string,session:{user:{id:string}}|null)=>{setOwner(session?.user.id||"");});
    return()=>data.subscription.unsubscribe();
  },[client]);
  useEffect(()=>setEntry(null),[owner]);
  useEffect(()=>{const timer=window.setTimeout(()=>{setSearch(query.trim());setPage(0);},300);return()=>clearTimeout(timer);},[query]);
  useEffect(()=>{function refresh(){setPage(0);setRevision(value=>value+1);}window.addEventListener(MISSING_EQUIPMENT_EVENT,refresh);return()=>window.removeEventListener(MISSING_EQUIPMENT_EVENT,refresh);},[]);
  useEffect(()=>{
    const version=++latest.current,abort=new AbortController(),timer=window.setTimeout(()=>abort.abort(),20000);let current=true;
    setRows([]);setHasMore(false);setError("");setLoading(true);setDataOwner(owner);setManager(canManageEquipmentLists());
    async function load(){
      if(!owner){if(current)setLoading(false);return;}
      if(isOffline()){setError("Connect online to view the latest Missing Equipment records.");setLoading(false);return;}
      try{
        let request=client.from("hems_missing_equipment").select(MISSING_SELECT).order("reported_at",{ascending:false}).order("id",{ascending:false}).range(page*PAGE_SIZE,(page+1)*PAGE_SIZE).abortSignal(abort.signal);
        if(filter==="missing")request=request.gt("remaining_quantity",0);else if(filter==="recovered")request=request.eq("remaining_quantity",0);
        if(search)request=request.ilike("search_text",missingSearchPattern(search));
        const result=await request;if(result.error)throw result.error;
        if(!current||version!==latest.current||owner!==getUserId())return;
        const values=(result.data||[]) as MissingEquipment[];setRows(values.slice(0,PAGE_SIZE));setHasMore(values.length>PAGE_SIZE);
      }catch(failure:unknown){if(current&&version===latest.current&&owner===getUserId()){const problem=failure as {message?:string;code?:string};setError(["42P01","PGRST205","42703"].includes(problem.code||"")?"Missing Equipment setup is not installed. Run missing-equipment.sql first.":"Could not load Missing Equipment. Check your connection and press Refresh.");}}
      finally{clearTimeout(timer);if(current&&version===latest.current)setLoading(false);}
    }void load();return()=>{current=false;abort.abort();clearTimeout(timer);};
  },[client,owner,search,filter,page,revision]);
  const visible=owner&&owner===getUserId()&&dataOwner===owner?rows:[];
  function refresh(){setEntry(null);setPage(0);setRevision(value=>value+1);}
  return <div className="space-y-4 p-3 sm:p-5">
    <div className="flex items-start justify-between gap-3"><div><h1 className="flex items-center gap-2 text-lg font-bold"><AlertTriangle size={20} className="text-red-600"/>Missing Equipment</h1><p className="mt-1 text-xs text-gray-500">All events and dry hires in one list · Dubai dates</p></div><NavigationFeedbackLink href="/inventory" className="rounded-xl border bg-white px-3 py-2 text-xs">Inventory</NavigationFeedbackLink></div>
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-white p-3">
      <label className="flex min-w-48 flex-1 items-center gap-2 rounded-xl bg-gray-50 px-3"><Search size={15} className="text-gray-400"/><span className="sr-only">Search Missing Equipment</span><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Item, serial, event, location or creator…" className="h-10 w-full bg-transparent text-sm outline-none"/></label>
      <select aria-label="Missing status" value={filter} disabled={Boolean(entry)} onChange={event=>{setFilter(event.target.value);setPage(0);}} className="h-10 rounded-xl border px-3 text-xs"><option value="missing">Still Missing</option><option value="all">All history</option><option value="recovered">Recovered</option></select>
      <button type="button" disabled={loading||Boolean(entry)} onClick={refresh} className="flex h-10 items-center gap-2 rounded-xl border px-3 text-xs disabled:opacity-40">{loading?<Loader2 size={14} className="animate-spin"/>:<RefreshCw size={14}/>}Refresh</button>
    </div>
    {error?<p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</p>:null}
    {loading?<p role="status" className="flex items-center gap-2 p-5 text-sm text-gray-500"><Loader2 size={16} className="animate-spin"/>Loading Missing Equipment…</p>:!owner?<p className="p-5 text-sm text-gray-500">Sign in to view Missing Equipment.</p>:!error&&!visible.length?<p className="rounded-2xl border border-dashed p-8 text-center text-sm text-gray-500">No matching Missing Equipment.</p>:null}
    <div className="space-y-3">{visible.map(record=><article key={record.id} className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">{typeof record.metadata?.photo_url==="string"&&/^https?:\/\//.test(record.metadata.photo_url)?<img src={record.metadata.photo_url} alt="" loading="lazy" onError={event=>{event.currentTarget.style.display="none";}} className="h-10 w-10 rounded-lg border object-contain"/>:null}<div className="min-w-0 flex-1"><h2 className="break-words text-sm font-bold">{record.display_name}</h2>{record.serial_number||record.inventory_record_type==="unit"?<p className="mt-1 break-words text-xs text-gray-500">ID: {String(record.metadata?.unit_no??record.inventory_record_id.slice(0,8))} · Serial: {record.serial_number||"—"}</p>:null}{record.metadata?.row_label?<p className="mt-1 text-xs text-gray-500">{String(record.metadata.row_label)}</p>:null}</div><div className="text-right"><strong className={record.remaining_quantity>0?"text-sm text-red-600":"text-sm text-green-700"}>{record.remaining_quantity>0?`${record.remaining_quantity} Missing`:"Recovered"}</strong><p className="mt-1 text-[10px] text-gray-500">{record.quantity} reported · {record.recovered_quantity} recovered</p><p className="mt-1 text-[10px] text-gray-500">{record.inventory_record_type==="matrix_row"&&record.metadata?.matrix_source!=="generic"?"Cabinets":"pcs"}</p></div></div>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3 border-t border-gray-100 pt-3"><div className="min-w-0 text-xs"><Link href={`/inventory/lists/${record.list_id}`} className="break-words font-bold text-gray-900 hover:text-red-600">{record.event_name}</Link><p className="mt-1 break-words text-gray-500">{record.location||"No location"} · {record.list_reference}</p><p className="mt-2 text-[11px] text-gray-500">List created by {record.list_created_by_name} · {date(record.list_created_at)}</p><p className="mt-1 text-[11px] text-gray-500">Missing recorded by {record.reported_by_name} · {date(record.reported_at)}</p>{record.note?<p className="mt-2 whitespace-pre-wrap break-words text-xs text-gray-600">{record.note}</p>:null}{record.recovered_at?<p className="mt-2 text-[11px] text-green-700">Last recovered by {record.recovered_by_name||"Warehouse"} · {date(record.recovered_at)}</p>:null}</div>
        {manager&&record.remaining_quantity>0?<button type="button" onClick={()=>setEntry(record)} className="flex shrink-0 items-center gap-1.5 rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-xs font-bold text-green-800"><Check size={14}/>Found / Recovered</button>:null}
      </div>
      {record.recovered_quantity>0?<div className="mt-3 border-t border-gray-100 pt-2"><button type="button" aria-expanded={historyId===record.id} onClick={()=>setHistoryId(value=>value===record.id?"":record.id)} className="text-[11px] font-semibold text-gray-600">{historyId===record.id?"Hide":"Show"} recovery history</button>{historyId===record.id?<MissingRecoveryHistory key={`${record.id}:${record.recovered_quantity}`} missingId={record.id} owner={owner}/>:null}</div>:null}
    </article>)}</div>
    {!loading&&!error?<div className="flex items-center justify-between gap-3 text-xs"><button type="button" disabled={page===0} onClick={()=>setPage(value=>value-1)} className="flex items-center gap-1 rounded-xl border px-3 py-2 disabled:opacity-30"><ChevronLeft size={14}/>Previous</button><span>Page {page+1}</span><button type="button" disabled={!hasMore} onClick={()=>setPage(value=>value+1)} className="flex items-center gap-1 rounded-xl border px-3 py-2 disabled:opacity-30">Next<ChevronRight size={14}/></button></div>:null}
    {entry&&owner===getUserId()?<MissingEquipmentDialog key={entry.id} mode="recover" entry={entry} onClose={()=>setEntry(null)} onSaved={refresh} onRefresh={refresh}/>:null}
  </div>;
}

function MissingRecoveryHistory({missingId,owner}:{missingId:string;owner:string}) {
  type Recovery={id:string;quantity:number;note:string;recovered_by_name:string;recovered_at:string};
  const [rows,setRows]=useState<Recovery[]>([]),[page,setPage]=useState(0),[more,setMore]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState("");
  useEffect(()=>{const abort=new AbortController();let current=true;const timer=window.setTimeout(()=>abort.abort(),20000);setLoading(true);setError("");setRows([]);
    async function read(){try{if(isOffline())throw new Error("Offline");const result=await createClient().from("hems_missing_recoveries").select("id,quantity,note,recovered_by_name,recovered_at").eq("missing_id",missingId).order("recovered_at",{ascending:false}).order("id",{ascending:false}).range(page*25,(page+1)*25).abortSignal(abort.signal);if(result.error)throw result.error;if(current&&getUserId()===owner){const data=(result.data||[]) as Recovery[];setRows(data.slice(0,25));setMore(data.length>25);}}catch{if(current&&getUserId()===owner)setError("Could not load recovery history. Close and reopen it online.");}finally{clearTimeout(timer);if(current)setLoading(false);}}
    void read();return()=>{current=false;abort.abort();clearTimeout(timer);};
  },[missingId,owner,page]);
  if(owner!==getUserId())return null;
  return <div className="mt-2 space-y-2 text-[11px] text-gray-600">{loading?<p>Loading recovery history…</p>:error?<p role="alert" className="text-red-700">{error}</p>:<>{rows.map(row=><div key={row.id} className="rounded-xl bg-gray-50 p-3"><strong>{row.quantity} recovered</strong> · {row.recovered_by_name} · {date(row.recovered_at)}{row.note?<p className="mt-1 whitespace-pre-wrap break-words">{row.note}</p>:null}</div>)}<div className="flex gap-3"><button type="button" disabled={page===0} onClick={()=>setPage(value=>value-1)} className="disabled:opacity-30">Previous</button><button type="button" disabled={!more} onClick={()=>setPage(value=>value+1)} className="disabled:opacity-30">Next</button></div></>}</div>;
}

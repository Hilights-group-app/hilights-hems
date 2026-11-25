"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getUserId } from "@/lib/authStore";
import { isOffline } from "@/lib/offline";
import { ACTIVE_EQUIPMENT_LIST_EVENT, ACTIVE_EQUIPMENT_LIST_KEY } from "@/lib/equipmentLists";
import { reservationIndex, type PendingReservation } from "@/lib/pendingReservations";
import { reservationLabelIndex, type ReservationLabel } from "@/lib/reservationLabels";

type Snapshot = { owner: string; contextId: string; rows: PendingReservation[]; ready: boolean;
  loading: boolean; error: string; period: { start: string | null; end: string | null } | null;
  labels: ReturnType<typeof reservationLabelIndex>; index: ReturnType<typeof reservationIndex> };
const EMPTY: Snapshot = { owner:"",contextId:"",rows:[],ready:false,loading:true,error:"",period:null,labels:reservationLabelIndex([]),index:reservationIndex([]) };
type Entry = { snapshot: Snapshot; version: number; lastRead: number; running: Promise<void> | null;
  timer?: ReturnType<typeof setTimeout>; listeners: Set<()=>void> };
const entries = new Map<string,Entry>();
const selectionListeners = new Set<()=>void>();
let selectedId="", installed=false;
let midnightTimer:ReturnType<typeof setTimeout>|undefined;
function keyOf(id?: string | null){return id ?? selectedId;}
function entryFor(id:string){
  let entry=entries.get(id);
  if(!entry){entry={snapshot:{...EMPTY,contextId:id},version:0,lastRead:0,running:null,listeners:new Set()};entries.set(id,entry);}
  return entry;
}
function emit(entry:Entry){entry.listeners.forEach(fn=>fn());}
function ownerFor(entry:Entry){
  const owner=getUserId() || "";
  if(entry.snapshot.owner!==owner){entry.version++;entry.lastRead=0;entry.snapshot={...EMPTY,owner,contextId:entry.snapshot.contextId};emit(entry);}
  return owner;
}
function readSelection(){
  let next="";try{next=localStorage.getItem(ACTIVE_EQUIPMENT_LIST_KEY)||"";}catch{}
  if(next!==selectedId){selectedId=next;selectionListeners.forEach(fn=>fn());}
}
function install(){
  if(installed||typeof window==="undefined")return;
  installed=true;readSelection();
  for(const name of ["hems:equipment-lists-change","hems:equipment-list-items-change","hems:pending-reservations-change"])
    window.addEventListener(name,invalidatePendingReservations);
  window.addEventListener(ACTIVE_EQUIPMENT_LIST_EVENT,readSelection);
  window.addEventListener("storage",event=>{
    if(event.key===ACTIVE_EQUIPMENT_LIST_KEY)readSelection();
    if(event.key==="hems:user_id")invalidatePendingReservations();
  });
  const wake=()=>{
    if(document.visibilityState!=="visible")return;
    readSelection();
    for(const [id,entry] of entries)if(entry.listeners.size&&Date.now()-entry.lastRead>15000)void refreshPendingReservations(id);
  };
  window.addEventListener("focus",wake);window.addEventListener("online",wake);
  document.addEventListener("visibilitychange",wake);
  const midnight=()=>{
    clearTimeout(midnightTimer);
    const offset=4*60*60*1000,day=24*60*60*1000;
    const until=day-((Date.now()+offset)%day)+100;
    midnightTimer=setTimeout(()=>{invalidatePendingReservations();midnight();},until);
  };
  midnight();
  createClient().auth.onAuthStateChange((_event:AuthChangeEvent,_session:Session|null)=>{
    if([...entries.values()].some(entry=>entry.snapshot.owner!==(getUserId()||"")))invalidatePendingReservations();
  });
}
export async function refreshPendingReservations(contextId?:string|null){
  install();const id=keyOf(contextId),entry=entryFor(id),owner=ownerFor(entry);
  clearTimeout(entry.timer);entry.timer=undefined;
  if(entry.running)return entry.running;
  if(!owner)return;
  const version=entry.version;
  entry.running=(async()=>{
    try{
      if(isOffline())throw new Error("Connect online to verify reservations.");
      const {data,error}=await createClient().rpc("hems_dated_pending_reservations",{p_list_id:id||null}).abortSignal(AbortSignal.timeout(10000));
      if(owner!==getUserId()||owner!==entry.snapshot.owner||version!==entry.version)return;
      if(error)throw error;
      if(isOffline()||!data||data.version!==1||!Array.isArray(data.rows))throw new Error("Invalid reservation response.");
      const rows=data.rows as PendingReservation[];
      const labels=reservationLabelIndex(Array.isArray(data.labels?.rows)?data.labels.rows as ReservationLabel[]:[],Array.isArray(data.labels?.hidden)?data.labels.hidden:[]);
      entry.lastRead=Date.now();entry.snapshot={owner,contextId:id,rows,ready:true,loading:false,error:"",period:data.period,labels,index:reservationIndex(rows)};emit(entry);
    }catch(failure:unknown){
      if(owner===entry.snapshot.owner&&version===entry.version){
        const message=(failure as {code?:string;message?:string})?.code==="22007"
          ? "Set valid start and end dates before choosing equipment."
          : "Reservations could not be checked. Retry before adding equipment.";
        entry.snapshot={...entry.snapshot,ready:false,loading:false,error:message};emit(entry);
      }
    }
  })().finally(()=>{
    entry.running=null;
    if(version!==entry.version&&entry.listeners.size)void refreshPendingReservations(id);
  });
  return entry.running;
}
export function invalidatePendingReservations(){
  for(const [id,entry] of entries){
    entry.version++;entry.lastRead=0;clearTimeout(entry.timer);ownerFor(entry);
    entry.snapshot={...entry.snapshot,ready:false,loading:true};emit(entry);
    if(entry.listeners.size)entry.timer=setTimeout(()=>void refreshPendingReservations(id),180);
    else if(!entry.running)entries.delete(id);
  }
}
function subscribeSelection(listener:()=>void){install();selectionListeners.add(listener);readSelection();return()=>{selectionListeners.delete(listener);};}
function subscribeContext(id:string,listener:()=>void){
  install();const entry=entryFor(id);entry.listeners.add(listener);ownerFor(entry);
  if(!entry.snapshot.ready||Date.now()-entry.lastRead>15000)void refreshPendingReservations(id);
  return()=>{entry.listeners.delete(listener);};
}
export function usePendingReservations(contextId?:string|null){
  const selection=useSyncExternalStore(subscribeSelection,()=>selectedId,()=>"");
  const id=contextId??selection;
  const subscribe=useCallback((listener:()=>void)=>subscribeContext(id,listener),[id]);
  const getSnapshot=useCallback(()=>entryFor(id).snapshot,[id]);
  const state=useSyncExternalStore(subscribe,getSnapshot,()=>EMPTY),owner=getUserId()||"";
  useEffect(()=>{const entry=entryFor(id);ownerFor(entry);if(owner&&!entry.snapshot.ready)void refreshPendingReservations(id);},[id,owner]);
  return state.owner===owner&&state.contextId===id?state:EMPTY;
}
export async function readVerifiedPendingReservations(contextId?:string|null){
  install();const id=keyOf(contextId);await refreshPendingReservations(id);
  const state=entryFor(id).snapshot;
  if(!state.ready||state.owner!==getUserId())throw new Error("Could not verify reservations. Retry online.");
  return state;
}

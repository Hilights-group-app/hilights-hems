"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getUserId } from "@/lib/authStore";
import { createBrowserId } from "@/lib/browserId";
import type { RepairStatus } from "@/lib/repairWorkflow";

type Snapshot={owner:string;rows:RepairStatus[];epoch:number;loading:boolean};
const EMPTY:Snapshot={owner:"",rows:[],epoch:0,loading:true};
let snapshot=EMPTY,revision=0,lastRead=0,lastWake=0;
let request:Promise<void>|null=null,queued=false;
let timer:ReturnType<typeof setTimeout>|undefined;
let stop:(()=>void)|null=null;
const listeners=new Set<()=>void>();
function emit(){listeners.forEach(fn=>fn());}
async function read(){
  if(request){queued=true;return request;}
  const owner=snapshot.owner,readRevision=revision;
  if(!owner)return;
  request=(async()=>{
    try{
      const {data,error}=await createClient().rpc("hems_repair_status");
      if(owner!==snapshot.owner || readRevision!==revision)return;
      if(error){console.error("repair status load error",error);snapshot={...snapshot,loading:false};emit();return;}
      lastRead=Date.now();snapshot={...snapshot,rows:Array.isArray(data)?data:[],loading:false};emit();
    }catch(error){if(owner===snapshot.owner && readRevision===revision){console.error("repair status load error",error);snapshot={...snapshot,loading:false};emit();}}
  })().finally(()=>{request=null;if(queued){queued=false;void read();}});
  return request;
}
export function invalidateRepairStatus(){
  ++revision;lastRead=0;clearTimeout(timer);
  timer=setTimeout(()=>{snapshot={...snapshot,epoch:snapshot.epoch+1};emit();void read();},350);
}
function subscribe(listener:()=>void){
  listeners.add(listener);
  if(listeners.size===1){
    const owner=getUserId() || "";
    if(snapshot.owner!==owner){++revision;snapshot={owner,rows:[],epoch:snapshot.epoch+1,loading:true};lastRead=0;emit();}
    const supabase=createClient();
    let active=true;
    const {data:{subscription:authSubscription}}=supabase.auth.onAuthStateChange((_event:AuthChangeEvent,session:Session|null)=>{
      if(!active)return;
      const nextOwner=session?.user.id || "";
      if(nextOwner===snapshot.owner)return;
      ++revision;lastRead=0;
      snapshot={owner:nextOwner,rows:[],epoch:snapshot.epoch+1,loading:Boolean(nextOwner)};emit();
      invalidateRepairStatus();
    });
    const channel=supabase.channel(`repair-status:${owner}:${createBrowserId()}`)
      .on("postgres_changes",{event:"*",schema:"public",table:"maintenance_requests"},invalidateRepairStatus)
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"equipment_lists",filter:"list_type=eq.maintenance"},invalidateRepairStatus)
      .subscribe();
    const wake=()=>{
      const now=Date.now();
      if(document.visibilityState!=="visible" || now-lastRead<30000 || now-lastWake<1500)return;
      lastWake=now;invalidateRepairStatus();
    };
    window.addEventListener("hems:maintenance-requests-change",invalidateRepairStatus);
    window.addEventListener("focus",wake);document.addEventListener("visibilitychange",wake);
    stop=()=>{active=false;authSubscription.unsubscribe();void supabase.removeChannel(channel);window.removeEventListener("hems:maintenance-requests-change",invalidateRepairStatus);
      window.removeEventListener("focus",wake);document.removeEventListener("visibilitychange",wake);};
    if(Date.now()-lastRead>10000)void read();
  }
  return()=>{listeners.delete(listener);if(!listeners.size){stop?.();stop=null;clearTimeout(timer);}};
}
const getSnapshot=()=>snapshot;
const serverSnapshot=()=>EMPTY;
export function useRepairStatus(){return useSyncExternalStore(subscribe,getSnapshot,serverSnapshot);}

/** Refresh mounted stock views quietly after a repair transition or returning to the app. */
export function useRepairRefresh(refresh:()=>void){
  const {epoch}=useRepairStatus();
  const lastEpoch=useRef(epoch),callback=useRef(refresh);
  useEffect(()=>{callback.current=refresh;});
  useEffect(()=>{if(lastEpoch.current!==epoch){lastEpoch.current=epoch;callback.current();}},[epoch]);
}

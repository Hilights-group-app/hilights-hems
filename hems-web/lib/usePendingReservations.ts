"use client";
import { useEffect, useSyncExternalStore } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getUserId } from "@/lib/authStore";
import { isOffline } from "@/lib/offline";
import { reservationIndex, type PendingReservation } from "@/lib/pendingReservations";

type Snapshot = { owner: string; rows: PendingReservation[]; ready: boolean; loading: boolean;
  error: string; index: ReturnType<typeof reservationIndex> };
const EMPTY: Snapshot = { owner:"",rows:[],ready:false,loading:true,error:"",index:reservationIndex([]) };
let snapshot=EMPTY, revision=0, lastRead=0;
let running: Promise<void> | null=null;
let timer: ReturnType<typeof setTimeout> | undefined;
let installed=false;
const listeners=new Set<()=>void>();
function emit(){ listeners.forEach(listener=>listener()); }
function setOwner(owner:string){
  if(snapshot.owner===owner)return;
  revision++;lastRead=0;snapshot={...EMPTY,owner};emit();
}
export async function refreshPendingReservations() {
  clearTimeout(timer);timer=undefined;
  setOwner(getUserId() || "");
  if(running)return running;
  const owner=snapshot.owner, version=revision;
  if(!owner)return;
  running=(async()=>{
    try{
      if(isOffline())throw new Error("Connect online to verify reservations.");
      const {data,error}=await createClient().rpc("hems_pending_reservations").abortSignal(AbortSignal.timeout(10000));
      if(owner!==getUserId() || owner!==snapshot.owner || version!==revision)return;
      if(error)throw error;
      if(isOffline())throw new Error("Connect online to verify reservations.");
      if(!Array.isArray(data))throw new Error("Invalid reservation response.");
      const rows=data as PendingReservation[];
      lastRead=Date.now();snapshot={owner,rows,ready:true,loading:false,error:"",index:reservationIndex(rows)};emit();
    }catch{
      if(owner===snapshot.owner && version===revision){
        snapshot={...snapshot,ready:false,loading:false,error:"Reservations could not be checked. Retry before adding equipment."};emit();
      }
    }
  })().finally(()=>{
    running=null;
    if(version!==revision && listeners.size)void refreshPendingReservations();
  });
  return running;
}
export function invalidatePendingReservations(){
  revision++;lastRead=0;clearTimeout(timer);
  // Keep the last good counters visible, but do not treat them as verified.
  snapshot={...snapshot,ready:false,loading:true};emit();
  if(listeners.size)timer=setTimeout(()=>void refreshPendingReservations(),180);
}
function subscribe(listener:()=>void){
  listeners.add(listener);setOwner(getUserId() || "");
  if(!installed && typeof window!=="undefined"){
    installed=true;
    for(const name of ["hems:equipment-lists-change","hems:equipment-list-items-change","hems:pending-reservations-change"])
      window.addEventListener(name,invalidatePendingReservations);
    const wake=()=>{if(document.visibilityState==="visible" && Date.now()-lastRead>15000)invalidatePendingReservations();};
    window.addEventListener("focus",wake);window.addEventListener("online",wake);
    window.addEventListener("storage",(event)=>{
      if(event.key === "hems:user_id"){setOwner(getUserId() || "");invalidatePendingReservations();}
    });
    document.addEventListener("visibilitychange",wake);
    createClient().auth.onAuthStateChange((_event: AuthChangeEvent,session: Session | null)=>{
      const owner=session?.user.id || "";
      if(owner!==snapshot.owner){setOwner(owner);if(listeners.size)invalidatePendingReservations();}
    });
  }
  if(!snapshot.ready || Date.now()-lastRead>15000)void refreshPendingReservations();
  return()=>{listeners.delete(listener);};
}
export function usePendingReservations(){
  const state=useSyncExternalStore(subscribe,()=>snapshot,()=>EMPTY);
  const owner=getUserId() || "";
  useEffect(()=>{
    if(owner!==snapshot.owner){setOwner(owner);if(owner)void refreshPendingReservations();}
  },[owner]);
  // Never return another signed-in user's cached quantities, even briefly.
  return state.owner===owner ? state : EMPTY;
}
export async function readVerifiedPendingReservations(){
  await refreshPendingReservations();
  if(!snapshot.ready || snapshot.owner !== getUserId())throw new Error("Could not verify reservations. Retry online.");
  return snapshot;
}

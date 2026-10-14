"use client";
import {useSyncExternalStore} from "react";
let active=false;
const listeners=new Set<()=>void>();
export function inventoryPickingActive(compact:boolean,hasList:boolean,path:string){
 return compact && hasList && path.startsWith("/inventory") && !path.startsWith("/inventory/lists") && path.split("/").filter(Boolean).length<=3;
}
export function setInventoryPickingMode(next:boolean){
 if(next===active)return;
 active=next;
 if(typeof document!=="undefined")document.documentElement.dataset.hemsInventoryPicking=next?"true":"false";
 listeners.forEach(listener=>listener());
}
function subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
const snapshot=()=>active,serverSnapshot=()=>false;
export function useInventoryPickingMode(){return useSyncExternalStore(subscribe,snapshot,serverSnapshot);}

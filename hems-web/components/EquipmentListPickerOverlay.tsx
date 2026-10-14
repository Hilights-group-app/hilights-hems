"use client";
import {useEffect,useRef,useState,type ReactNode} from "react";
import {createPortal} from "react-dom";

/** Body portal: a picker must never inherit an equipment row's stacking context. */
export default function EquipmentListPickerOverlay({label,children}:{label:string;children:ReactNode}){
 const [mounted,setMounted]=useState(false);
 const [viewport,setViewport]=useState<{height:number;top:number}|null>(null);
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  setMounted(true);
  const vv=window.visualViewport;
  const sync=()=>setViewport({height:vv?.height || window.innerHeight,top:vv?.offsetTop || 0});
  sync();vv?.addEventListener("resize",sync);vv?.addEventListener("scroll",sync);window.addEventListener("resize",sync);
  return()=>{vv?.removeEventListener("resize",sync);vv?.removeEventListener("scroll",sync);window.removeEventListener("resize",sync);};
 },[]);
 useEffect(()=>{
  if(!mounted)return;
  const previous=document.activeElement as HTMLElement|null;
  root.current?.focus({preventScroll:true});
  return()=>{if(previous?.isConnected)previous.focus({preventScroll:true});};
 },[mounted]);
 if(!mounted)return null;
 return createPortal(<div ref={root} data-hems-list-picker="true" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}
  className="fixed inset-x-0 top-0 z-[10040] flex h-dvh items-end justify-center outline-none sm:items-center sm:p-5"
  style={viewport?{height:viewport.height,top:viewport.top}:undefined}
  onClick={event=>event.stopPropagation()}
  onKeyDown={event=>{
   if(event.key!=="Tab")return;
   const controls=Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')||[]).filter(node=>node.getClientRects().length>0);
   const first=controls[0],last=controls.at(-1);if(!first){event.preventDefault();return;}
   if(event.shiftKey && (document.activeElement===first || document.activeElement===root.current)){event.preventDefault();last?.focus();}
   else if(!event.shiftKey && (document.activeElement===last || document.activeElement===root.current)){event.preventDefault();first.focus();}
  }}>{children}</div>,document.body);
}

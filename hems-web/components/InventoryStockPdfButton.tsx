"use client";
import { useEffect,useRef,useState } from "react";
import { Download,Loader2,X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getUserId } from "@/lib/authStore";
import { isOffline } from "@/lib/offline";

export default function InventoryStockPdfButton({subcategoryId,stockPath}:{subcategoryId:string;stockPath?:string}) {
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState("");
  const running=useRef(false),active=useRef(true),request=useRef<AbortController|null>(null);
  useEffect(()=>{active.current=true;setNotice("");return()=>{active.current=false;request.current?.abort();};},[subcategoryId,stockPath]);
  async function download() {
    if(running.current)return;
    if(isOffline()){setNotice("Connect online to export complete, verified stock.");return;}
    const owner=getUserId();if(!owner){setNotice("Sign in before exporting stock.");return;}
    running.current=true;setBusy(true);setNotice("");const controller=new AbortController();request.current=controller;
    const timer=setTimeout(()=>controller.abort(),120000);
    try {
      const [{readInventoryStock},{makeInventoryStockPdf}]=await Promise.all([import("@/lib/inventoryStockData"),import("@/lib/inventoryStockPdf")]);
      const stock=await readInventoryStock(createClient(),subcategoryId,controller.signal,new Date(),stockPath);
      if(!active.current||controller.signal.aborted||getUserId()!==owner||isOffline())throw new Error("Export cancelled or the connection/user changed. Retry online.");
      const result=await makeInventoryStockPdf(stock,controller.signal);
      if(!active.current||getUserId()!==owner||isOffline())return;
      result.pdf.save(result.fileName);
      if(result.missingPhotos.length)setNotice(`Stock PDF downloaded. ${result.missingPhotos.length} photo(s) could not be loaded: ${result.missingPhotos.join(" · ")}. Upload a local photo if its host refuses downloads.`);
    } catch(error:unknown) {
      if(active.current&&getUserId()===owner)setNotice(error instanceof Error?error.message:"Stock PDF could not be created.");
    } finally {clearTimeout(timer);running.current=false;if(active.current)setBusy(false);if(request.current===controller)request.current=null;}
  }
  return <div className="relative">
    <button type="button" disabled={busy} aria-busy={busy} onClick={()=>void download()} aria-label="Download full subcategory stock PDF" title="Download full subcategory stock PDF"
      className="inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-xl border border-gray-300 bg-white px-2 text-[10px] font-semibold text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:opacity-60 hems-wide:px-3">
      {busy?<Loader2 size={15} className="animate-spin"/>:<Download size={15}/>}
      <span className="hidden hems-wide:inline">{busy?"Preparing…":"PDF"}</span>
    </button>
    {notice?<div role="status" className="absolute right-0 top-11 z-50 max-h-64 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto break-words rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-normal text-amber-950 shadow-lg">
      <button type="button" onClick={()=>setNotice("")} aria-label="Dismiss PDF message" className="float-right ml-2"><X size={14}/></button>{notice}
    </div>:null}
  </div>;
}

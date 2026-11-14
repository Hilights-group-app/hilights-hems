"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, RotateCcw, X } from "lucide-react";
import type { EquipmentList, EquipmentListItem } from "@/lib/equipmentLists";
import { activeSerialReference, activeSerialStatus } from "@/lib/activeListLayout";
import { canBatchReceiveSerials, isOutstandingSerial, selectSerialReceiptLines, MAX_SERIAL_RECEIPT_BATCH } from "@/lib/serialBatchReceive";
import styles from "./ActiveListEquipmentTable.module.css";

export default function SerialBatchReceiveDialog({ list, title, items, canReceive, busy, onClose, onConfirm, onRefresh }: {
  list: EquipmentList; title: string; items: EquipmentListItem[]; canReceive: boolean; busy: boolean;
  onClose: () => void; onConfirm: (items: EquipmentListItem[]) => Promise<boolean>; onRefresh: () => void;
}) {
  const [selected,setSelected] = useState<Set<string>>(() => new Set());
  const [saving,setSaving] = useState(false),[blocked,setBlocked] = useState(false),[error,setError] = useState("");
  const allRef = useRef<HTMLInputElement>(null),panel = useRef<HTMLDivElement>(null),running = useRef(false),mounted = useRef(true);
  const eligible = items.filter(isOutstandingSerial),eligibleIds = new Set(eligible.map(item => item.id));
  const selectedCount = eligible.filter(item => selected.has(item.id)).length;
  const changed = [...selected].some(id => !eligibleIds.has(id));
  const all = eligible.length > 0 && !changed && selectedCount === eligible.length;
  const partial = selectedCount > 0 && !all;
  const waiting = busy || saving;
  const allowed = canBatchReceiveSerials(list,canReceive);
  useEffect(() => { if(allRef.current)allRef.current.indeterminate=partial; },[partial]);
  useEffect(() => {
    mounted.current=true;const previous=document.activeElement;allRef.current?.focus();
    return()=>{mounted.current=false;if(previous instanceof HTMLElement)previous.focus();};
  },[]);
  function toggleAll(){if(waiting||blocked||!allowed)return;setError("");setSelected(all?new Set():new Set(eligible.map(item=>item.id)));}
  function toggle(id:string){if(waiting||blocked||!allowed||!eligibleIds.has(id))return;setError("");setSelected(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});}
  async function receive(){
    if(running.current||waiting||blocked||!allowed)return;
    let chosen:EquipmentListItem[];
    try{chosen=selectSerialReceiptLines(items,selected);if(chosen.length>MAX_SERIAL_RECEIPT_BATCH)throw new Error(`Receive at most ${MAX_SERIAL_RECEIPT_BATCH} serials per batch.`);}catch(failure:unknown){setError(failure instanceof Error?failure.message:"Review your selection.");return;}
    running.current=true;setSaving(true);setError("");
    try{const saved=await onConfirm(chosen);if(saved&&mounted.current)onClose();}
    catch(failure:unknown){if(mounted.current){const problem=failure as {message?:string};setError(problem.message||"The result could not be confirmed. Refresh before retrying.");setBlocked(true);}}
    finally{running.current=false;if(mounted.current)setSaving(false);}
  }
  function close(){if(!waiting&&!running.current)onClose();}
  if(typeof document==="undefined")return null;
  return createPortal(<div className={styles.pickerOverlay} role="dialog" aria-modal="true" aria-label="Receive selected serial units"
    onKeyDown={event=>{
      if(event.key==="Escape")close();
      if(event.key==="Tab"){const nodes=panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])');if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
    }}>
    <button type="button" className={styles.pickerBackdrop} disabled={waiting} aria-label="Close serial selection" onClick={close}/>
    <div ref={panel} className={styles.picker}>
      <div className={styles.pickerHeading}><div><h2>Receive equipment</h2><p>{title}</p></div><button type="button" className={styles.closeButton} disabled={waiting} onClick={close} aria-label="Close"><X size={17}/></button></div>
      <p className={styles.pickerHelp}>Choose equipment physically back in the warehouse. Received and Missing units cannot be selected.</p>
      <div className={styles.batchToolbar}><label><input ref={allRef} type="checkbox" checked={all} aria-checked={partial?"mixed":all} onChange={toggleAll} disabled={waiting||blocked||!allowed||!eligible.length}/><span>Select all</span></label><span aria-live="polite">{selectedCount} / {eligible.length} selected</span></div>
      <div className={styles.pickerRows}>{items.map(item=>{
        const reference=activeSerialReference(item),available=isOutstandingSerial(item),status=activeSerialStatus(item);
        return <label key={item.id} className={`${styles.batchSerialRow} ${available?"":styles.batchDisabled}`}>
          <input type="checkbox" checked={available&&selected.has(item.id)} disabled={waiting||blocked||!allowed||!available} onChange={()=>toggle(item.id)} aria-label={`Receive ID ${reference.id} · Serial ${reference.serial}`}/>
          <span><strong>ID: {reference.id}</strong><span>{reference.serial}</span></span><small className={available?styles.out:status.tone==="missing"?styles.missing:styles.muted}>{available?"Out":status.label==="Out"?"Review":status.label}</small>
        </label>;
      })}</div>
      {changed?<p role="alert" className={styles.batchError}>Some selected serials changed. Choose Select all again or refresh before receiving.</p>:null}
      {error?<p role="alert" className={styles.batchError}>{error}</p>:null}
      {selectedCount>MAX_SERIAL_RECEIPT_BATCH?<p className={styles.batchError}>Choose up to {MAX_SERIAL_RECEIPT_BATCH} serials per receipt.</p>:null}
      <div className={styles.batchFooter}>
        <button type="button" disabled={waiting} onClick={close} className={styles.batchCancel}>Cancel</button>
        {blocked?<button type="button" onClick={onRefresh} className={styles.batchSubmit}>Refresh list</button>:<button type="button" className={styles.batchSubmit} disabled={waiting||!allowed||!selectedCount||changed||selectedCount>MAX_SERIAL_RECEIPT_BATCH} onClick={()=>void receive()}>{saving?<Loader2 size={15} className="animate-spin"/>:<RotateCcw size={15}/>}Received selected ({selectedCount})</button>}
      </div>
    </div>
  </div>,document.body);
}

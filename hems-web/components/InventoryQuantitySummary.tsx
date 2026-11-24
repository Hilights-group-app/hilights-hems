"use client";

import { useRouter } from "next/navigation";

// Non-anchor markup is intentional: inventory identity cards can themselves be
// links/buttons. Never nest another <a> or <button> inside those cards.
export function KsaQuantityStat({quantity,search="",unit="pcs",variant="pill"}: {
  quantity:number; search?:string; unit?:"pcs"|"sqm"; variant?:"pill"|"cell"|"led";
}) {
  const router=useRouter();
  const count=unit==="sqm" ? Math.round(Math.max(0,Number(quantity)||0)*100)/100 : Math.floor(Math.max(0,Number(quantity)||0));
  if(!count)return null;
  const label=`In KSA: ${count}${unit==="sqm" ? " sqm" : ""}`;
  function open(event:React.SyntheticEvent){
    event.preventDefault();event.stopPropagation();
    router.push(`/inventory/ksa${search?`?search=${encodeURIComponent(search)}`:""}`);
  }
  return <span role="link" tabIndex={0} aria-label={`${count} ${unit} in KSA${search?` · ${search}`:""}`}
    onClick={open} onKeyDown={event=>{if(event.key==="Enter"||event.key===" ")open(event);}}
    className={variant==="pill"
      ? "inline-flex cursor-pointer items-center rounded-lg bg-blue-100 px-2 py-1 text-[9px] font-semibold text-blue-800 outline-none hover:bg-blue-200 focus-visible:ring-2 focus-visible:ring-blue-500"
      : "block min-w-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-500"}>
    {variant==="pill"?label:<>
      <span className={variant==="led"?"block text-[8px] text-gray-500 hems-wide:text-[9px]":"mb-1 block text-[8px] font-semibold text-blue-700"}>In KSA</span>
      <span className={variant==="led"?"inline-flex rounded-lg bg-blue-100 px-2 py-1 font-semibold text-blue-800 hover:bg-blue-200":"block rounded-md bg-blue-100 px-1 py-0.5 text-[9px] font-semibold text-blue-800 hover:bg-blue-200"}>
        {count}{unit==="sqm"?" sqm":""}
      </span>
    </>}
  </span>;
}

export default function InventoryQuantitySummary({total,available,maintenance=0,expired=0,inKsa=0,search="",failed=false,unit="pcs"}: {
  total:number; available:number; maintenance?:number; expired?:number; inKsa?:number; search?:string; failed?:boolean; unit?:"pcs"|"sqm";
}) {
  const cells=[{label:"Total",value:total,tone:"bg-gray-100"},{label:"Available",value:available,tone:"bg-green-100"},
    ...(maintenance>0?[{label:failed?"Failed":"Maintenance",value:maintenance,tone:failed?"bg-red-100 text-red-700":"bg-yellow-100"}]:[]),
    ...(expired>0?[{label:"Expired",value:expired,tone:"bg-red-100 text-red-700"}]:[])];
  const columns=Math.min(4,cells.length+Number(inKsa>0));
  return <div data-inventory-quantity-summary="true" className="mt-2">
    <div className="grid gap-x-2 gap-y-2 text-center hems-wide:hidden" style={{gridTemplateColumns:`repeat(${columns}, minmax(0, 1fr))`}}>
      {cells.slice(0,2).map(cell=><div key={cell.label} className="min-w-0"><span className="mb-1 block text-[8px] font-semibold text-gray-500">{cell.label}</span><span className={`block rounded-md px-1 py-0.5 text-[9px] font-semibold ${cell.tone}`}>{unit==="sqm"?Math.round(cell.value*100)/100:cell.value}{unit==="sqm"?" sqm":""}</span></div>)}
      <KsaQuantityStat quantity={inKsa} search={search} unit={unit} variant="cell"/>
      {cells.slice(2).map(cell=><div key={cell.label} className="min-w-0"><span className="mb-1 block text-[8px] font-semibold text-gray-500">{cell.label}</span><span className={`block rounded-md px-1 py-0.5 text-[9px] font-semibold ${cell.tone}`}>{unit==="sqm"?Math.round(cell.value*100)/100:cell.value}{unit==="sqm"?" sqm":""}</span></div>)}
    </div>
    <div className="hidden flex-wrap items-center gap-2 hems-wide:flex">
      {cells.slice(0,2).map(cell=><span key={cell.label} className={`inline-flex rounded-lg px-2 py-1 text-[9px] font-semibold ${cell.tone}`}>{cell.label} Qty: {unit==="sqm"?Math.round(cell.value*100)/100:cell.value}{unit==="sqm"?" sqm":""}</span>)}
      <KsaQuantityStat quantity={inKsa} search={search} unit={unit}/>
      {cells.slice(2).map(cell=><span key={cell.label} className={`inline-flex rounded-lg px-2 py-1 text-[9px] font-semibold ${cell.tone}`}>{cell.label}: {unit==="sqm"?Math.round(cell.value*100)/100:cell.value}{unit==="sqm"?" sqm":""}</span>)}
    </div>
  </div>;
}

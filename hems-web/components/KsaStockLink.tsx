"use client";

import Link from "next/link";

export default function KsaStockLink({quantity,search="",unit="pcs"}: {quantity:number;search?:string;unit?:"pcs"|"sqm"}) {
  const raw=Math.max(0,Number(quantity)||0);
  const count=unit === "sqm" ? Number(raw.toFixed(2)) : Math.floor(raw);
  if (!count) return null;
  const label=unit === "sqm" ? `${count} SQM in KSA` : `${count} pcs in KSA`;
  return <Link href={`/inventory/ksa${search ? `?search=${encodeURIComponent(search)}` : ""}`}
    onClick={(event) => {event.stopPropagation();}}
    className="inline-flex max-w-full items-center rounded-lg bg-blue-100 px-2 py-1 text-[9px] font-semibold text-blue-800 transition hover:bg-blue-200"
    aria-label={`${label}${search ? ` · ${search}` : ""}`}>
    {label}
  </Link>;
}

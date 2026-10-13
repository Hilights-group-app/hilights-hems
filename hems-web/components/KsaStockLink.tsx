"use client";

import Link from "next/link";

export default function KsaStockLink({quantity,search=""}: {quantity:number;search?:string}) {
  const count=Math.max(0,Math.floor(Number(quantity)||0));
  if (!count) return null;
  return <Link href={`/inventory/ksa${search ? `?search=${encodeURIComponent(search)}` : ""}`}
    onClick={(event) => {event.stopPropagation();}}
    className="inline-flex max-w-full items-center rounded-lg bg-blue-100 px-2 py-1 text-[9px] font-semibold text-blue-800 transition hover:bg-blue-200"
    aria-label={`${count} pcs in KSA${search ? ` · ${search}` : ""}`}>
    {count} pcs in KSA
  </Link>;
}

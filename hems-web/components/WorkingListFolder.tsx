"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, Folder } from "lucide-react";

/** Presentation only. Reuses the sidebar's already loaded and authorized rows. */
export default function WorkingListFolder({ kind, title, count, children }: {
  kind: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const pending = kind === "pending";
  const folder = pending || kind === "active";

  if (!folder) return <section>
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-[9px] font-bold uppercase tracking-wider text-gray-400">{title}</h3>
      <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-bold text-gray-500">{count}</span>
    </div>
    {children}
  </section>;

  return <section data-working-list-folder={kind}>
    <button type="button" aria-expanded={open} aria-controls={regionId}
      onClick={() => setOpen(current => !current)}
      className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${pending
        ? "border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-300 hover:bg-amber-100"
        : "border-green-200 bg-green-50 text-green-800 hover:border-green-300 hover:bg-green-100"}`}>
      <span className="flex items-center gap-2"><Folder size={15} aria-hidden="true"/>
        <span className="text-[10px] font-bold">{title}</span>
      </span>
      <span className="flex items-center gap-2">
        <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[9px] font-bold">{count}</span>
        <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`}/>
      </span>
    </button>
    <div id={regionId} hidden={!open} className="mt-2 space-y-2">{children}</div>
  </section>;
}

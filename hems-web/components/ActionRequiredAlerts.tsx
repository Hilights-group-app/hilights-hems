"use client";

import Link from "next/link";
import { BellRing, ChevronRight } from "lucide-react";
import { useActionNotifications } from "@/components/ActionNotificationsProvider";

export default function ActionRequiredAlerts({compact=false,onOpen}:{compact?:boolean;onOpen?:()=>void}) {
  const {tasks}=useActionNotifications();
  if(!tasks.length)return null;
  return <section aria-label="Action required" className={compact?"mb-2 rounded-xl border-2 border-red-500 bg-red-50 p-2":"mb-4 rounded-2xl border-2 border-red-500 bg-red-50 p-3 shadow-sm"}>
    <div className="mb-3 flex items-center justify-between gap-2 text-red-700">
      <h2 className="flex items-center gap-2 text-xs font-black uppercase"><BellRing size={17}/>Action required</h2>
      <span className="rounded-full bg-red-600 px-2 py-1 text-[10px] font-bold text-white">{tasks.length===100?"100+":tasks.length}</span>
    </div>
    <div className="max-h-[40vh] space-y-2 overflow-y-auto">
      {tasks.map(task=><Link key={task.id} href={task.href} onClick={onOpen} className="block rounded-xl border border-red-200 bg-white p-3 transition hover:bg-red-100">
        <div className="text-[10px] font-black leading-4 text-red-700">{task.title}</div>
        <div className="mt-1 break-words text-[11px] font-semibold leading-4 text-gray-900">{task.message}</div>
        <div className="mt-2 flex items-center justify-between text-[10px] font-bold text-red-700"><span>{task.kind==="approval"?"Open list · Review & approve":"Open list · Test & mark Tested"}</span><ChevronRight size={14}/></div>
      </Link>)}
    </div>
  </section>;
}

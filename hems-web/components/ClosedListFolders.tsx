"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Building2, CalendarDays, ChevronDown, Folder, Loader2, Package, Wrench } from "lucide-react";
import { getUserId } from "@/lib/authStore";
import { createClient } from "@/lib/supabase/client";
import { equipmentListSummary, equipmentListTypeLabel, type EquipmentList } from "@/lib/equipmentLists";
import { CLOSED_LIST_FOLDERS, createClosedFolderController, emptyClosedFolder,
  type ClosedListFolder } from "@/lib/closedListFolders";

type Props = { owner: string; select: string; refreshToken: readonly EquipmentList[] };
const themes = {
  shipment: { button: "border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100", icon: Package },
  local_event: { button: "border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100", icon: CalendarDays },
  dry_hire: { button: "border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100", icon: Building2 },
  maintenance: { button: "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100", icon: Wrench },
};

function ClosedFolder({ owner, select, refreshToken, folder }: Props & { folder: ClosedListFolder }) {
  const supabase = useMemo(() => createClient(), []);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(emptyClosedFolder);
  const controller = useRef<ReturnType<typeof createClosedFolderController> | null>(null);
  const theme = themes[folder.key as keyof typeof themes];
  const Icon = theme.icon;
  const regionId = `closed-lists-${folder.key}`;

  useEffect(() => {
    const pager = createClosedFolderController({
      folder,
      isCurrent: () => owner === getUserId(),
      isVisible: () => document.visibilityState !== "hidden",
      publish: setState,
      async read(offset, pageSize) {
        const result = await supabase.from("equipment_lists").select(select)
          .eq("status", "closed").in("list_type", [...folder.listTypes])
          .order("created_at", { ascending: false }).order("id", { ascending: false })
          .range(offset, offset + pageSize);
        if (result.error) throw result.error;
        return (result.data ?? []) as EquipmentList[];
      },
    });
    controller.current = pager;
    function wake() { pager.wake(); }
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      pager.dispose();
      controller.current = null;
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [owner, folder, select, supabase]);

  // Reuse the existing sidebar's Realtime refresh rather than opening channels.
  useEffect(() => { controller.current?.invalidate(); }, [refreshToken]);

  return (
    <section data-closed-list-folder={folder.key}>
      <button type="button" aria-expanded={open} aria-controls={regionId}
        onClick={() => { const next = !open; setOpen(next); controller.current?.setOpen(next); }}
        className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left transition ${theme.button}`}>
        <span className="flex items-center gap-2"><Folder size={15} />
          <span className="text-[10px] font-bold">{folder.label}</span>
        </span>
        <span className="flex items-center gap-2">
          {state.loaded ? <span className="rounded-full bg-white/80 px-1.5 py-0.5 text-[9px] font-bold"
            title={`${state.rows.length} loaded${state.hasMore ? "; older lists available" : ""}`}>
            {state.rows.length}{state.hasMore ? "+" : ""}</span> : null}
          <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open ? <div id={regionId} className="mt-2 space-y-2" aria-busy={state.loading}>
        {state.rows.length ? <div className="max-h-[42vh] space-y-2 overflow-y-auto overscroll-contain pr-1">
          {state.rows.map(list => <Link key={list.id} href={`/inventory/lists/${list.id}`}
            className="block rounded-xl border border-gray-200 bg-white px-3 py-2.5 transition hover:border-gray-300 hover:shadow-sm">
            <span className="flex items-start gap-2"><Icon size={13} className="mt-0.5 shrink-0 text-gray-500" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[10px] font-bold text-gray-900">{list.reference}</span>
                <span className="mt-1 block truncate text-[10px] text-gray-600">{equipmentListSummary(list)}</span>
                <span className="mt-1 block text-[8px] text-gray-400">{equipmentListTypeLabel(list.list_type)} · Closed</span>
              </span>
            </span>
          </Link>)}
        </div> : null}
        {state.loading || (!state.loaded && !state.error) ? <div role="status" className="flex items-center gap-2 px-3 py-2 text-[10px] text-gray-500">
          <Loader2 size={12} className="animate-spin" /> Loading closed lists…
        </div> : null}
        {state.loaded && !state.loading && !state.rows.length && !state.error ?
          <p className="px-3 py-2 text-[10px] text-gray-400">No closed lists.</p> : null}
        {state.error ? <div role="alert" className="rounded-xl bg-red-50 p-3 text-[10px] text-red-700">
          {state.error}<button type="button" disabled={state.loading} onClick={() => controller.current?.retry()}
            className="mt-2 block font-bold underline disabled:opacity-40">Try again</button>
        </div> : null}
        {state.hasMore && !state.error ? <button type="button" disabled={state.loading}
          onClick={() => controller.current?.loadMore()}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-[10px] font-semibold text-gray-600 disabled:opacity-40">
          Show older lists
        </button> : null}
      </div> : null}
    </section>
  );
}

export default function ClosedListFolders(props: Props) {
  return <section className="space-y-2 border-t border-gray-200 pt-4" aria-label="Closed lists">
    <h3 className="mb-2 text-[9px] font-bold uppercase tracking-wider text-gray-400">Closed Lists</h3>
    {CLOSED_LIST_FOLDERS.map(folder => <ClosedFolder key={`${props.owner}:${folder.key}`} {...props} folder={folder} />)}
  </section>;
}

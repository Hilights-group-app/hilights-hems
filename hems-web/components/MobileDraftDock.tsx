"use client";

import {inventoryPickingActive,setInventoryPickingMode} from "@/lib/inventoryPickingMode";
import { useAppLayout } from "@/lib/useAppLayout";
import { createBrowserId } from "@/lib/browserId";

import Link from "next/link";
import { readWorkingDraft } from "@/lib/workspaceStartup";
import { usePathname } from "next/navigation";
import { Boxes, ChevronRight, ClipboardList, House, Check } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createClient, readBrowserSession } from "@/lib/supabase/client";
import { canManageEquipmentLists } from "@/lib/authStore";
import {
  ACTIVE_EQUIPMENT_LIST_EVENT, ACTIVE_EQUIPMENT_LIST_KEY,
  EQUIPMENT_LISTS_EVENT, EQUIPMENT_LIST_ITEMS_EVENT,
  canEditWorkingEquipmentList, equipmentListSummary, type EquipmentList,
} from "@/lib/equipmentLists";

const LAYOUT_KEY = "hems:mobile-layout-v1";

export default function MobileDraftDock() {
  const pathname = usePathname();
  const isLogin = pathname === "/login";
  const supabase = useMemo(() => createClient(), []);
  const mobile = useAppLayout() === "compact";
  const [enabled, setEnabled] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [list, setList] = useState<EquipmentList | null>(null);
  const [lines, setLines] = useState<number | null>(null);
  const [toast, setToast] = useState("");
  const [keyboard, setKeyboard] = useState(false);
  const activeId = useRef<string | null>(null);

  const picking=inventoryPickingActive(mobile && enabled,Boolean(list),pathname);
  useEffect(()=>{setInventoryPickingMode(picking);},[picking]);
  useEffect(()=>()=>setInventoryPickingMode(false),[]);

  useEffect(() => {
    let initial = true;
    try { initial = localStorage.getItem(LAYOUT_KEY) !== "classic"; } catch {}
    setEnabled(initial);
    const toggle = () => setEnabled(current => {
      const next = !current;
      try { localStorage.setItem(LAYOUT_KEY, next ? "new" : "classic"); } catch {}
      return next;
    });
    window.addEventListener("hems:toggle-mobile-layout", toggle);
    return () => {
      window.removeEventListener("hems:toggle-mobile-layout", toggle);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.hemsMobile = enabled && mobile && !isLogin ? "new" : "classic";
    return () => { delete document.documentElement.dataset.hemsMobile; };
  }, [enabled, mobile, isLogin]);

  useEffect(() => {
    if (!mobile) return;
    const viewport = window.visualViewport;
    const sync = () => setKeyboard(Boolean(viewport && window.innerHeight - viewport.height > 150));
    sync(); viewport?.addEventListener("resize", sync);
    return () => viewport?.removeEventListener("resize", sync);
  }, [mobile]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!mobile || !enabled || isLogin) return;
    let cancelled = false;
    let version = 0;
    let firstRead = true;
    let lastRefresh = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let subscribedId: string | null = null;

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 300);
    }
    function subscribe(id: string | null) {
      if (subscribedId === id) return;
      if (channel) void supabase.removeChannel(channel);
      channel = null; subscribedId = id;
      if (!id) return;
      channel = supabase.channel(`mobile-draft:${id}:${createBrowserId()}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "equipment_lists", filter: `id=eq.${id}` }, schedule)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "equipment_list_items", filter: `list_id=eq.${id}` }, schedule)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "equipment_list_items", filter: `list_id=eq.${id}` }, schedule)
        .on("postgres_changes", { event: "DELETE", schema: "public", table: "equipment_list_items" }, schedule)
        .subscribe();
    }
    async function refresh() {
      const readVersion = ++version;
      try {
        const { data: { session } } = await readBrowserSession();
        if (cancelled || readVersion !== version) return;
        lastRefresh = Date.now();
        setSignedIn(Boolean(session));
        let id: string | null = null;
        try { id = localStorage.getItem(ACTIVE_EQUIPMENT_LIST_KEY); } catch {}
        activeId.current = id;
        subscribe(id);
        if (!session || !id) { setList(null); setLines(null); return; }
        const [listResult, countResult] = await Promise.all([
          readWorkingDraft(supabase, id, !firstRead, session.user.id),
          supabase.from("equipment_list_items").select("id", { count: "exact", head: true }).eq("list_id", id),
        ]);
        if (cancelled || readVersion !== version) return;
        firstRead = false;
        if (listResult.error) return; // Keep the last good view on a transient failure.
        const next = listResult.data as EquipmentList | null;
        if (!canEditWorkingEquipmentList(next, session.user.id, canManageEquipmentLists())) {
          setList(null); setLines(null); return;
        }
        setList(next);
        if (!countResult.error) setLines(countResult.count ?? 0);
      } catch { /* A focus event retries without replacing the inventory page. */ }
    }
    function activeChange() { setList(null); setLines(null); schedule(); }
    function itemsChange(event: Event) {
      const detail = (event as CustomEvent<{ listId?: string }>).detail;
      if (!detail?.listId || detail.listId === activeId.current) {
        setToast("List updated"); schedule();
      }
    }
    function focus() {
      if (document.visibilityState === "visible" && Date.now() - lastRefresh > 30000) schedule();
    }
    function storage(event: StorageEvent) { if (event.key === ACTIVE_EQUIPMENT_LIST_KEY) activeChange(); }
    window.addEventListener(ACTIVE_EQUIPMENT_LIST_EVENT, activeChange);
    window.addEventListener(EQUIPMENT_LIST_ITEMS_EVENT, itemsChange);
    window.addEventListener(EQUIPMENT_LISTS_EVENT, schedule);
    window.addEventListener("storage", storage);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      if (!session) { setList(null); setLines(null); setSignedIn(false); }
      schedule();
    });
    void refresh();
    return () => {
      cancelled = true; version++; clearTimeout(timer);
      window.removeEventListener(ACTIVE_EQUIPMENT_LIST_EVENT, activeChange);
      window.removeEventListener(EQUIPMENT_LIST_ITEMS_EVENT, itemsChange);
      window.removeEventListener(EQUIPMENT_LISTS_EVENT, schedule);
      window.removeEventListener("storage", storage);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      subscription.unsubscribe(); if (channel) void supabase.removeChannel(channel);
    };
  }, [mobile, enabled, isLogin, supabase]);

  if (!mobile || !enabled || isLogin || !signedIn || keyboard) return null;
  const openLists = () => window.dispatchEvent(new CustomEvent("hems:open-mobile-lists"));
  return <div data-hems-dock className="fixed inset-x-0 bottom-0 z-[80] border-t border-gray-200 bg-white/95 shadow-[0_-8px_30px_rgba(0,0,0,0.06)] backdrop-blur-xl">
    {picking && toast ? <div role="status" className="pointer-events-none absolute inset-x-4 -top-12 flex items-center justify-center gap-2 rounded-2xl bg-gray-900 px-4 py-3 text-xs font-semibold text-white shadow-lg"><Check size={15} />{toast}</div> : null}
    {picking && list ? <div data-hems-picking-summary className="flex items-center border-b border-gray-100"><Link href={`/inventory/lists/${encodeURIComponent(list.id)}`} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-4 py-2">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-red-50 text-red-600"><ClipboardList size={18} /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-gray-900">{list.reference} <span className="font-medium text-gray-400">· {list.status === "draft" ? "Draft" : list.status === "pending" ? "Review" : "Add equipment"}</span></span><span className="mt-0.5 block truncate text-[11px] text-gray-500">{equipmentListSummary(list)}{lines !== null ? ` · ${lines} item line${lines === 1 ? "" : "s"}` : ""}</span></span>
      <span className="text-[11px] font-bold text-red-600">View</span><ChevronRight size={16} className="text-gray-400" />
    </Link><button type="button" aria-label="Finish adding items" onClick={()=>{
      try{localStorage.removeItem(ACTIVE_EQUIPMENT_LIST_KEY);}catch{}
      setList(null);setLines(null);setInventoryPickingMode(false);
      window.dispatchEvent(new CustomEvent(ACTIVE_EQUIPMENT_LIST_EVENT,{detail:{listId:null}}));
    }} className="mr-3 min-h-11 shrink-0 rounded-xl bg-gray-100 px-3 text-[11px] font-semibold text-gray-700">Done</button></div> : null}
    <nav aria-label="Mobile navigation" className="grid grid-cols-3 px-3 pt-1" style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}>
      <Link href="/" aria-current={pathname === "/" ? "page" : undefined} className={`flex min-h-12 flex-col items-center justify-center gap-1 text-[10px] font-semibold ${pathname === "/" ? "text-red-600" : "text-gray-500"}`}><House size={20} />Home</Link>
      <Link href="/inventory" aria-current={pathname.startsWith("/inventory") && !pathname.startsWith("/inventory/lists") ? "page" : undefined} className={`flex min-h-12 flex-col items-center justify-center gap-1 text-[10px] font-semibold ${pathname.startsWith("/inventory") && !pathname.startsWith("/inventory/lists") ? "text-red-600" : "text-gray-500"}`}><Boxes size={20} />Inventory</Link>
      <button type="button" onClick={openLists} className={`flex min-h-12 flex-col items-center justify-center gap-1 text-[10px] font-semibold ${pathname.startsWith("/inventory/lists") ? "text-red-600" : "text-gray-500"}`}><ClipboardList size={20} />Lists</button>
    </nav>
  </div>;
}

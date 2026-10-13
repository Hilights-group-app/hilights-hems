"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Building2, Check, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { ACTIVE_EQUIPMENT_LIST_KEY, ACTIVE_EQUIPMENT_LIST_EVENT, EQUIPMENT_LISTS_EVENT, EQUIPMENT_LIST_ITEMS_EVENT, type EquipmentList } from "@/lib/equipmentLists";
import KsaDraftItemPicker from "@/components/KsaDraftItemPicker";
import type { KsaInventoryGroup } from "@/lib/ksaInventory";

type KsaStock = KsaInventoryGroup;
type IncomingList = EquipmentList;
type LegacyTransfer = {id: string; reference: string; destination_name: string | null};
const inputClass = "min-h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-base text-gray-900 outline-none focus:border-blue-500 sm:text-xs";

export default function KsaInventoryClient() {
  const supabase = useMemo(() => createClient(), []);
  const [stock, setStock] = useState<KsaStock[]>([]);
  const [lists, setLists] = useState<IncomingList[]>([]);
  const [legacy, setLegacy] = useState<LegacyTransfer[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [manager, setManager] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [pickerItem,setPickerItem] = useState<KsaStock|null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mutationBusy = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const readVersion = useRef(0);
  const loadedCount = useRef(0);
  const alive = useRef(true);
  const selected = lists.find((list) => list.id === selectedId);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const readStock = useCallback(async (keyword: string, offset = 0, initial = false) => {
    const version = ++readVersion.current;
    if (initial) setLoading(true);
    if (offset > 0) setPaging(true);
    try {
      const pages = offset === 0 && !initial ? Math.max(1, Math.ceil(loadedCount.current / 100)) : 1;
      const results = await Promise.all(Array.from({length:pages}, (_, index) =>
        supabase.rpc("hems_ksa_inventory_groups", {p_search:keyword, p_offset:offset + index * 100, p_limit:100})));
      const stockError = results.find((result) => result.error)?.error;
      if (stockError) throw stockError;
      if (!alive.current || version !== readVersion.current) return;
      const records = results.flatMap((result) => ((result.data as {items?: KsaStock[]})?.items || []));
      setStock((current) => {
        const unique = [...new Map((offset > 0 ? [...current, ...records] : records)
          .map((item) => [`${item.record_type}:${item.record_id}`, item])).values()];
        loadedCount.current = unique.length;
        return unique;
      });
      setHasMore(Boolean((results[results.length - 1].data as {has_more?:boolean})?.has_more));
    } catch (readError: any) {
      if (alive.current && version === readVersion.current) setError(readError?.message || "KSA equipment could not be loaded.");
    } finally {
      if (alive.current && version === readVersion.current) {setLoading(false); setPaging(false);}
    }
  }, [supabase]);

  const readLists = useCallback(async (currentUserId: string, isManager: boolean) => {
    const [incoming, outgoing] = await Promise.all([
      supabase.from("equipment_lists").select("*").eq("list_type","transfer_in")
        .in("status",["draft","pending"]).order("created_at",{ascending:false}),
      isManager ? supabase.from("equipment_lists").select("id,reference,destination_name")
        .eq("list_type","transfer_out").in("status",["active","partially_returned"]).order("created_at",{ascending:false}) : Promise.resolve({data:[],error:null}),
    ]);
    if (!alive.current) return;
    if (incoming.error || outgoing.error) {setError(incoming.error?.message || outgoing.error?.message || "Transfer lists could not be loaded."); return;}
    const editable = ((incoming.data || []) as IncomingList[]).filter((list) => (list.status === "draft" && list.created_by === currentUserId) || (list.status === "pending" && isManager));
    setLists(editable);
    setSelectedId((current) => editable.some((list) => list.id === current) ? current : "");
    setLegacy((outgoing.data || []).filter((list) => /\b(ksa|saudi|riyadh|jeddah|dammam)\b/i.test(list.destination_name || "")));
  }, [supabase]);

  useEffect(() => {
    alive.current = true;
    const params = new URLSearchParams(window.location.search);
    let selectedList = params.get("list");
    if (!selectedList) {try {selectedList=localStorage.getItem(ACTIVE_EQUIPMENT_LIST_KEY);} catch {}}
    if (selectedList) setSelectedId(selectedList);
    const keyword=params.get("search") || "";
    setSearch(keyword); setQuery(keyword);
    void (async () => {
      const [{data: authData,error:authError}, {data:isManager,error:managerError}] = await Promise.all([supabase.auth.getUser(),supabase.rpc("is_equipment_list_manager")]);
      if (!alive.current) return;
      if (authError || managerError || !authData.user) {setError(authError?.message || managerError?.message || "Please sign in again."); return;}
      setUserId(authData.user.id); setManager(Boolean(isManager));
      await readLists(authData.user.id,Boolean(isManager));
    })();
    return () => {alive.current = false; ++readVersion.current;};
  }, [readLists,supabase]);

  useEffect(() => {void readStock(query,0,true);}, [query,readStock]);

  useEffect(() => {
    if (!userId) return;
    let timer: number | undefined;
    function refresh() {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {void readStock(query); void readLists(userId!,manager);},160);
    }
    function activeSelection(event:Event) {
      const detail=(event as CustomEvent<{listId?:string|null}>).detail;
      if(detail && "listId" in detail)setSelectedId(detail.listId || "");
      else {try {setSelectedId(localStorage.getItem(ACTIVE_EQUIPMENT_LIST_KEY) || "");} catch {}}
      setPickerItem(null);void readLists(userId!,manager);
    }
    window.addEventListener(ACTIVE_EQUIPMENT_LIST_EVENT,activeSelection);
    window.addEventListener(EQUIPMENT_LIST_ITEMS_EVENT,refresh);
    window.addEventListener(EQUIPMENT_LISTS_EVENT,refresh);
    window.addEventListener("focus",refresh);
    return () => {window.clearTimeout(timer); window.removeEventListener(ACTIVE_EQUIPMENT_LIST_EVENT,activeSelection); window.removeEventListener(EQUIPMENT_LIST_ITEMS_EVENT,refresh); window.removeEventListener(EQUIPMENT_LISTS_EVENT,refresh); window.removeEventListener("focus",refresh);};
  }, [userId,manager,query,readStock,readLists]);

  function notify(listId: string, status?: string) {
    window.dispatchEvent(new CustomEvent(EQUIPMENT_LISTS_EVENT,{detail:{listId,status}}));
    window.dispatchEvent(new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT,{detail:{listId,status}}));
  }

  function activateIncomingList(list: IncomingList | null) {
    setSelectedId(list?.id || "");
    try {
      if (list) localStorage.setItem(ACTIVE_EQUIPMENT_LIST_KEY,list.id);
      else localStorage.removeItem(ACTIVE_EQUIPMENT_LIST_KEY);
    } catch {}
    window.dispatchEvent(new CustomEvent(ACTIVE_EQUIPMENT_LIST_EVENT,{detail:{listId:list?.id || null,list:list || undefined}}));
  }

  async function syncLegacy(list: LegacyTransfer) {
    if (!manager || mutationBusy.current) return;
    if (!window.confirm(`Sync ${list.reference} to KSA stock and save its delivery note? Outstanding dispatched equipment moves from In Use to In KSA. Prior returns and receipts are excluded.`)) return;
    mutationBusy.current=true;setBusy(list.id);setError("");
    try {
      const {error:syncError} = await supabase.rpc("hems_archive_transfer_out",{p_list_id:list.id});
      if (syncError) throw syncError;
      if (!alive.current) return;
      setLegacy((current) => current.filter((item) => item.id !== list.id));setMessage(`${list.reference} saved. KSA stock synced.`);notify(list.id);
    } catch (syncError: any) {if(alive.current) setError(syncError?.message || "The transfer could not be synced.");}
    finally {mutationBusy.current=false;if(alive.current) setBusy(null);}
  }

  const grouped = useMemo(() => {
    const groups = new Map<string,KsaStock[]>();
    for (const item of stock) {const category=String(item.metadata?.category || "Other");groups.set(category,[...(groups.get(category)||[]),item]);}
    return [...groups.entries()];
  }, [stock]);

  return <div className="min-h-full space-y-4 bg-gray-50 p-3 sm:p-5">
    <section className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
      <Link href="/inventory" className="mb-4 inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-gray-500"><ArrowLeft size={14}/>Inventory</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="flex items-center gap-2 text-xl font-bold text-gray-900"><Building2 size={22} className="text-blue-700"/>Equipment in KSA</h1>
          <p className="mt-2 max-w-xl text-xs leading-5 text-gray-500">Choose a Transfer In draft, then tap + to select equipment to return to Dubai.</p></div>
        <button type="button" onClick={() => {setError("");void readStock(query);if(userId) void readLists(userId,manager);}}
          disabled={Boolean(busy)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-gray-200 px-3 text-xs font-semibold text-gray-600"><RefreshCw size={14}/>Refresh</button>
      </div>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <select aria-label="Transfer In list" value={selectedId} onChange={(event) => {activateIncomingList(lists.find((list) => list.id === event.target.value) || null);setMessage("");}}
          disabled={Boolean(busy)} className={inputClass}>
          <option value="">Select a Transfer In draft…</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.reference} · {list.status === "pending" ? "Pending" : "Draft"}</option>)}
        </select>
      </div>
      <div className="relative mt-4"><Search size={16} className="absolute left-3 top-3.5 text-gray-400"/><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search equipment, serial number or category" aria-label="Search KSA equipment" className={`${inputClass} pl-9`}/></div>
    </section>
    {legacy.length ? <details className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <summary className="cursor-pointer text-xs font-semibold text-amber-900">{legacy.length} existing transfers to sync</summary><p className="mt-1 text-xs leading-5 text-amber-800">These older lists still track stock as In Use. Sync each once to include its outstanding equipment in KSA and keep its delivery note.</p>
      <div className="mt-3 space-y-2">{legacy.map((list) => <div key={list.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white p-3"><Link href={`/inventory/lists/${list.id}`} className="text-xs font-bold text-gray-800">{list.reference} · {list.destination_name}</Link>
        <button type="button" disabled={Boolean(busy)} onClick={() => void syncLegacy(list)} className="min-h-11 rounded-lg bg-amber-800 px-3 text-xs font-bold text-white disabled:opacity-50">{busy === list.id ? "Syncing…" : "Sync to KSA"}</button></div>)}</div>
    </details> : null}
    {error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-700">{error}</div> : null}
    {message ? <div role="status" className="flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 p-3 text-xs leading-5 text-green-800"><Check size={15} className="mt-0.5 shrink-0"/>{message}</div> : null}
    {loading && stock.length === 0 ? <div className="flex justify-center p-10"><Loader2 className="animate-spin text-blue-700"/></div> : null}
    {!loading && stock.length === 0 ? <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">{query ? "No matching KSA equipment." : "No equipment currently in KSA."}</div> : null}
    {grouped.map(([category,items]) => <section key={category} className="rounded-2xl border border-gray-200 bg-white">
      <div data-hems-block-header className="flex items-center justify-between rounded-t-2xl border-b border-gray-100 bg-white px-4 py-3"><h2 className="text-sm font-bold capitalize text-gray-900">{category}</h2><span className="text-xs text-gray-400">{items.length} items</span></div>
      <div className="divide-y divide-gray-100">{items.map((item) => <div key={`${item.record_type}:${item.record_id}`} className="flex items-start gap-3 p-4 sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <KsaEquipmentPhoto src={typeof item.metadata?.photo_url === "string" ? item.metadata.photo_url : null} name={item.display_name} />
          <div className="min-w-0 flex-1"><div className="break-words text-sm font-semibold text-gray-900">{item.display_name}</div>

          {item.block_name ? <div className="mt-1 text-[11px] text-gray-400">{item.block_name}</div> : null}
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]"><span className="rounded-md bg-blue-50 px-2 py-1 font-semibold text-blue-800">In KSA: {item.in_ksa_quantity}</span>
            <span className="rounded-md bg-gray-100 px-2 py-1 text-gray-600">Unreserved: {item.selectable_quantity}</span>{item.reserved_quantity > 0 ? <span className="rounded-md bg-amber-50 px-2 py-1 text-amber-700">Selected for return: {item.reserved_quantity}</span> : null}</div>
          </div>
        </div>
        <button type="button" aria-label={`Add ${item.display_name} to draft`}
          title={selected ? `Add to ${selected.reference}` : "Select a Transfer In draft first"}
          onClick={() => {if(selected)setPickerItem(item);}} disabled={!selected || Boolean(busy) || item.selectable_quantity<1}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-blue-700 text-white disabled:opacity-40"><Plus size={19}/></button>
      </div>)}</div>
    </section>)}
    {hasMore ? <button type="button" disabled={paging || Boolean(busy)} onClick={() => void readStock(query,stock.length)} className="min-h-11 w-full rounded-xl border border-gray-200 bg-white text-xs font-semibold text-gray-700">{paging ? "Loading…" : "Load more equipment"}</button> : null}
    {pickerItem && selected ? <KsaDraftItemPicker key={`${selected.id}:${pickerItem.record_type}:${pickerItem.record_id}`}
      item={pickerItem} list={selected} onClose={() => setPickerItem(null)} onAdded={(quantity) => {
        setMessage(`${quantity} unit(s) of ${pickerItem.display_name} added to ${selected.reference}.`);
        setPickerItem(null); notify(selected.id,selected.status);
      }} /> : null}
  </div>;
}

function KsaEquipmentPhoto({src,name}: {src:string|null;name:string}) {
  const [failed,setFailed]=useState(false);
  useEffect(() => setFailed(false),[src]);
  return <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-gray-100 bg-gray-50">
    {src && !failed ? <img src={src} alt={name} loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-contain p-1" /> : <Building2 size={22} className="text-gray-300"/>}
  </div>;
}

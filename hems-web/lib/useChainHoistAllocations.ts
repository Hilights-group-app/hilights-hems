"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { getUserId } from "@/lib/authStore";
import { EQUIPMENT_LISTS_EVENT, EQUIPMENT_LIST_ITEMS_EVENT, type EquipmentList } from "@/lib/equipmentLists";
import { createRefreshQueue } from "@/lib/workspaceRefresh";

type MovementList = Pick<EquipmentList, "id" | "reference" | "list_type" | "status" |
  "event_name" | "venue" | "client_company" | "from_location_name" | "destination_name" | "purpose" | "assigned_to">;
type MovementLine = {
  id: string;
  list_id: string;
  parent_record_id: string | null;
  inventory_record_id: string;
  inventory_record_type?: string;
  requested_quantity: number;
  approved_quantity: number;
  returned_ok_quantity: number;
  returned_maintenance_quantity: number;
};
export type ChainHoistAllocation = {
  listId: string;
  reference: string;
  label: string;
  title: string;
  quantity: number;
  status: "active" | "partially_returned";
};
type Allocations = Record<string, ChainHoistAllocation[]>;
const MOVEMENT_TYPES = ["local_event", "dry_hire", "transfer_out", "internal_use"];
const PAGE_SIZE = 1000;
const ID_BATCH_SIZE = 80;
const LIST_SELECT = "id,reference,list_type,status,event_name,venue,client_company,from_location_name,destination_name,purpose,assigned_to";
const LINE_SELECT = "id,list_id,parent_record_id,inventory_record_id,requested_quantity,approved_quantity,returned_ok_quantity,returned_maintenance_quantity";

export function chainHoistAllocationLabel(list: MovementList) {
  if (list.list_type === "local_event") return `In ${list.venue?.trim() || list.event_name?.trim() || "Local Event"}`;
  if (list.list_type === "dry_hire") return ["Dry Hire", list.client_company?.trim()].filter(Boolean).join(" · ");
  if (list.list_type === "transfer_out") return list.destination_name?.trim() ? `In ${list.destination_name.trim()}` : "Transfer Out";
  return ["Internal Use", list.purpose?.trim(), list.assigned_to?.trim()].filter(Boolean).join(" · ");
}

export function groupChainHoistAllocations(lists: MovementList[], lines: MovementLine[], itemIds: string[]): Allocations {
  const allowedItems = new Set(itemIds);
  const parents = new Map(lists.filter(list =>
    ["active", "partially_returned"].includes(list.status) && MOVEMENT_TYPES.includes(list.list_type),
  ).map(list => [list.id, list]));
  const groups = new Map<string, { itemId: string; allocation: ChainHoistAllocation }>();
  const seenUnits = new Set<string>();
  for (const line of lines) {
    const list = parents.get(line.list_id);
    const itemId = line.parent_record_id;
    if (!list || !itemId || !allowedItems.has(itemId) || !line.inventory_record_id ||
      (line.inventory_record_type && line.inventory_record_type !== "unit")) continue;
    const serialKey = `${list.id}:${line.inventory_record_id}`;
    if (seenUnits.has(serialKey)) continue;
    const dispatched = Number(line.approved_quantity) > 0
      ? Number(line.approved_quantity) : Math.max(0, Number(line.requested_quantity) || 0);
    const returned = Math.max(0, Number(line.returned_ok_quantity) || 0) +
      Math.max(0, Number(line.returned_maintenance_quantity) || 0);
    const quantity = Math.max(0, dispatched - returned);
    if (!Number.isFinite(quantity) || quantity === 0) continue;
    seenUnits.add(serialKey);
    const key = `${itemId}:${list.id}`;
    const current = groups.get(key);
    if (current) current.allocation.quantity += quantity;
    else groups.set(key, { itemId, allocation: {
      listId: list.id, reference: list.reference, label: chainHoistAllocationLabel(list), quantity,
      title: [list.reference, list.event_name, list.venue, list.client_company,
        list.from_location_name, list.destination_name, list.purpose, list.assigned_to].filter(Boolean).join(" · "),
      status: list.status === "partially_returned" ? "partially_returned" : "active",
    } });
  }
  const byItem: Allocations = {};
  for (const { itemId, allocation } of groups.values()) (byItem[itemId] ??= []).push(allocation);
  for (const rows of Object.values(byItem)) rows.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }) || a.reference.localeCompare(b.reference));
  return byItem;
}

/** One batch for the page, never a request per rendered hoist model. */
export async function readChainHoistAllocations(
  client: ReturnType<typeof createClient>, itemIds: string[], isCurrent: () => boolean = () => true,
): Promise<Allocations | null> {
  const ids = Array.from(new Set(itemIds.filter(Boolean)));
  if (!ids.length) return {};
  const lists: MovementList[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    if (!isCurrent()) return null;
    const { data, error } = await client.from("equipment_lists").select(LIST_SELECT)
      .in("status", ["active", "partially_returned"]).in("list_type", MOVEMENT_TYPES)
      .order("id", { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as MovementList[];
    lists.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  const listIds = lists.map(list => list.id);
  const lines: MovementLine[] = [];
  for (let parentFrom = 0; parentFrom < ids.length; parentFrom += ID_BATCH_SIZE) {
    for (let listFrom = 0; listFrom < listIds.length; listFrom += ID_BATCH_SIZE) {
      for (let offset = 0; ; offset += PAGE_SIZE) {
        if (!isCurrent()) return null;
        const { data, error } = await client.from("equipment_list_items").select(LINE_SELECT)
          .eq("inventory_record_type", "unit")
          .in("parent_record_id", ids.slice(parentFrom, parentFrom + ID_BATCH_SIZE))
          .in("list_id", listIds.slice(listFrom, listFrom + ID_BATCH_SIZE))
          .order("id", { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
        if (error) throw error;
        const page = (data ?? []) as MovementLine[];
        lines.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
    }
  }
  return isCurrent() ? groupChainHoistAllocations(lists, lines, ids) : null;
}

type Snapshot = { owner: string | null; key: string; byItem: Allocations; error: string };
function browserOwner() { try { return getUserId(); } catch { return null; } }

export function useChainHoistAllocations(itemIds: string[]) {
  const client = useMemo(() => createClient(), []);
  const key = JSON.stringify(Array.from(new Set(itemIds.filter(Boolean))).sort());
  const [snapshot, setSnapshot] = useState<Snapshot>({ owner: null, key: "", byItem: {}, error: "" });
  const retryRef = useRef<() => void>(() => {});
  const retry = useCallback(() => retryRef.current(), []);
  useEffect(() => {
    const ids = JSON.parse(key) as string[];
    let owner = browserOwner(), disposed = false, revision = 0, lastRead = 0;
    setSnapshot({ owner, key, byItem: {}, error: "" });
    if (!ids.length) return;
    const current = (user: string, read: number) => !disposed && user === owner && read === revision;
    const queue = createRefreshQueue(async () => {
      if (!owner || disposed) return;
      const user = owner, read = revision;
      try {
        const byItem = await readChainHoistAllocations(client, ids, () => current(user, read));
        if (!byItem || !current(user, read)) return;
        lastRead = Date.now();
        setSnapshot({ owner: user, key, byItem, error: "" });
      } catch (error) {
        if (!current(user, read)) return;
        console.error("chain hoist locations load error", error);
        setSnapshot(previous => ({ owner: user, key,
          byItem: previous.owner === user && previous.key === key ? previous.byItem : {},
          error: "Equipment locations could not load. Your inventory quantities are unchanged.",
        }));
      }
    });
    function invalidate(event?: Event) {
      const status = (event as CustomEvent<{ status?: string }> | undefined)?.detail?.status;
      if (status === "draft" || status === "pending") return;
      ++revision; queue.schedule();
    }
    function wake() {
      if (document.visibilityState === "hidden") return;
      queue.resume();
      if (!queue.isPending() && Date.now() - lastRead >= 30000) { ++revision; queue.request(); }
    }
    retryRef.current = () => { ++revision; queue.request(); };
    const { data: { subscription } } = client.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      const next = session?.user.id || null;
      if (disposed || next === owner) return;
      owner = next; ++revision; lastRead = 0;
      setSnapshot({ owner, key, byItem: {}, error: "" });
      if (owner) queue.request();
    });
    window.addEventListener(EQUIPMENT_LISTS_EVENT, invalidate);
    window.addEventListener(EQUIPMENT_LIST_ITEMS_EVENT, invalidate);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    queue.request();
    return () => {
      disposed = true; ++revision; retryRef.current = () => {};
      queue.dispose(); subscription.unsubscribe();
      window.removeEventListener(EQUIPMENT_LISTS_EVENT, invalidate);
      window.removeEventListener(EQUIPMENT_LIST_ITEMS_EVENT, invalidate);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [client, key]);
  const ownSnapshot = snapshot.owner === browserOwner() && snapshot.key === key;
  return { byItem: ownSnapshot ? snapshot.byItem : {}, error: ownSnapshot ? snapshot.error : "", retry };
}

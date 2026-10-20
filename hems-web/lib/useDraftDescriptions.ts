"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { EquipmentListItem } from "@/lib/equipmentLists";

function source(item: EquipmentListItem): { table: "items" | "matrix_models"; id: string } | null {
  if (item.metadata?.custom_item === true) return null;
  const type = item.inventory_record_type;
  if (type === "matrix_model") return { table: "matrix_models", id: item.inventory_record_id };
  if (type === "matrix_row") return item.parent_record_id ? { table: "matrix_models", id: item.parent_record_id } : null;
  const id = type === "unit" ? item.parent_record_id || String(item.metadata?.item_id || "") : item.inventory_record_id;
  return id ? { table: "items", id } : null;
}

export function draftDescriptionKey(item: EquipmentListItem): string {
  const record = source(item);
  return record ? `${record.table}:${record.id}` : item.id;
}

/** Two batched sources, not a separate request for every equipment row. */
export function useDraftDescriptions(items: EquipmentListItem[]): Record<string, string> {
  const client = useMemo(() => createClient(), []);
  const [live, setLive] = useState<Record<string, string>>({});
  const keys = [...new Set(items.flatMap(item => {
    const record = source(item);
    return record ? [`${record.table}:${record.id}`] : [];
  }))].sort().join(",");

  useEffect(() => {
    let cancelled = false;
    if (!keys) { setLive({}); return; }
    const requests: Promise<void>[] = [];
    const next: Record<string, string> = {};
    for (const table of ["items", "matrix_models"] as const) {
      const ids = keys.split(",").filter(key => key.startsWith(`${table}:`)).map(key => key.slice(table.length + 1));
      for (let start = 0; start < ids.length; start += 150) {
        requests.push((async () => {
          const { data, error } = await client.from(table).select("id,description").in("id", ids.slice(start, start + 150));
          if (error) return; // The list remains usable if offline or the source was removed.
          for (const row of data ?? []) next[`${table}:${row.id}`] = row.description || "";
        })());
      }
    }
    void Promise.all(requests).then(() => { if (!cancelled) setLive(next); }).catch(() => {});
    return () => { cancelled = true; };
  }, [client, keys]);

  const result: Record<string, string> = {};
  for (const item of items) {
    const key = draftDescriptionKey(item);
    const snapshot = typeof item.metadata?.description === "string" ? item.metadata.description : "";
    result[key] = live[key] ?? snapshot;
  }
  return result;
}

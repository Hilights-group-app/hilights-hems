"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type MatrixManualOrder = {
  blockOrder: string[];
  itemOrderByBlock: Record<string, string[]>;
};

export function normalizeMatrixOrder(value: unknown): MatrixManualOrder {
  const source = value && typeof value === "object"
    ? value as Partial<MatrixManualOrder>
    : {};
  const strings = (values: unknown): string[] => Array.isArray(values)
    ? Array.from(new Set(values.filter((entry): entry is string =>
        typeof entry === "string" && entry.length > 0)))
    : [];
  return {
    blockOrder: strings(source.blockOrder),
    itemOrderByBlock: Object.fromEntries(
      source.itemOrderByBlock && typeof source.itemOrderByBlock === "object"
        && !Array.isArray(source.itemOrderByBlock)
        ? Object.entries(source.itemOrderByBlock).map(([block, ids]) => [block, strings(ids)])
        : [],
    ),
  };
}

type OrderIO = {
  read: () => Promise<unknown | null>;
  seed: (order: MatrixManualOrder) => Promise<void>;
  write: (order: MatrixManualOrder) => Promise<void>;
  onChange: (order: MatrixManualOrder, cache?: boolean) => void;
  onReady: () => void;
  onError: (message: string) => void;
  onSaving?: (saving: boolean) => void;
};

// Serialize rapid drops and ignore reads started before a newer local edit.
export function createMatrixOrderSync(io: OrderIO, seed?: MatrixManualOrder) {
  let current = normalizeMatrixOrder(seed);
  let ready = false;
  let dirty = false;
  let disposed = false;
  let revision = 0;
  let pendingWrites = 0;
  let readTask: Promise<void> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  function refresh(): Promise<void> {
    if (disposed || dirty || pendingWrites > 0) return Promise.resolve();
    if (readTask) return readTask;
    const version = revision;
    readTask = (async () => {
      try {
        let data = await io.read();
        if (disposed) return;
        if (data === null && seed &&
          (seed.blockOrder.length > 0 || Object.values(seed.itemOrderByBlock).some(ids => ids.length > 0))) {
          // INSERT ... ON CONFLICT DO NOTHING preserves a concurrent first save.
          await io.seed(normalizeMatrixOrder(seed));
          data = await io.read();
          if (data === null) throw new Error("Order migration was not saved");
        }
        if (disposed || version !== revision) return;
        current = normalizeMatrixOrder(data);
        ready = true;
        // A mobile/initial read with no shared row must not erase the laptop's
        // legacy order before its desktop capability has been detected.
        io.onChange(current, data !== null);
        io.onReady();
        io.onError("");
      } catch {
        if (!disposed && version === revision) {
          io.onError("Could not load the shared order. Retry before rearranging items.");
        }
      } finally {
        readTask = null;
      }
    })();
    return readTask;
  }

  async function save(order: MatrixManualOrder): Promise<boolean> {
    if (disposed || !ready) return false;
    const snapshot = normalizeMatrixOrder(order);
    const version = ++revision;
    current = snapshot;
    dirty = true;
    pendingWrites += 1;
    io.onSaving?.(true);
    io.onChange(snapshot);
    const task = writeQueue.then(() => io.write(snapshot));
    writeQueue = task.catch(() => {});
    try {
      await task;
      if (!disposed && version === revision) {
        dirty = false;
        io.onError("");
      }
      return true;
    } catch {
      if (!disposed && version === revision) {
        io.onError("Order has not been saved to other devices. Retry saving it.");
      }
      return false;
    } finally {
      pendingWrites -= 1;
      if (!disposed) io.onSaving?.(pendingWrites > 0);
    }
  }

  return {
    refresh,
    save,
    retry: () => dirty ? save(current) : refresh(),
    dispose: () => { disposed = true; },
  };
}

export function useMatrixManualOrder(
  categoryId: string | null,
  subcategoryId: string | null,
  canSave: boolean,
  seedFromDesktop: boolean,
) {
  const [order, setOrder] = useState<MatrixManualOrder>(() => normalizeMatrixOrder(null));
  const [ready, setReady] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [saving, setSaving] = useState(false);
  const syncRef = useRef<ReturnType<typeof createMatrixOrderSync> | null>(null);

  useEffect(() => {
    setReady(false);
    setSyncError("");
    setSaving(false);
    setOrder(normalizeMatrixOrder(null));
    if (!categoryId || !subcategoryId) return;

    const cacheKey = `hems:${categoryId}:${subcategoryId}:matrix-manual-order-v1`;
    let seed: MatrixManualOrder | undefined;
    // Only the desktop admin may migrate a legacy browser's saved arrangement.
    if (seedFromDesktop) {
      try {
        seed = normalizeMatrixOrder(JSON.parse(localStorage.getItem(cacheKey) || "null"));
        setOrder(seed);
      } catch {}
    }
    const supabase = createClient();
    const read = async () => {
      const { data, error } = await supabase.from("matrix_manual_orders")
        .select("block_order,item_order_by_block")
        .eq("subcategory_id", subcategoryId).maybeSingle();
      if (error) throw error;
      return data ? { blockOrder: data.block_order, itemOrderByBlock: data.item_order_by_block } : null;
    };
    const write = async (value: MatrixManualOrder, ignoreDuplicates = false) => {
      const { error } = await supabase.from("matrix_manual_orders").upsert({
        subcategory_id: subcategoryId,
        block_order: value.blockOrder,
        item_order_by_block: value.itemOrderByBlock,
      }, { onConflict: "subcategory_id", ignoreDuplicates });
      if (error) throw error;
    };
    const sync = createMatrixOrderSync({
      read,
      seed: value => write(value, true),
      write,
      onChange: (value, cache = true) => {
        setOrder(value);
        if (cache) {
          try { localStorage.setItem(cacheKey, JSON.stringify(value)); } catch {}
        }
      },
      onReady: () => setReady(true),
      onError: setSyncError,
      onSaving: setSaving,
    }, seed);
    syncRef.current = sync;
    void sync.refresh();
    const refresh = () => {
      if (document.visibilityState === "visible") void sync.refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      sync.dispose();
      if (syncRef.current === sync) syncRef.current = null;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [categoryId, subcategoryId, seedFromDesktop]);

  function saveManualOrder(
    blockOrder = order.blockOrder,
    itemOrderByBlock = order.itemOrderByBlock,
  ): Promise<boolean> {
    if (!canSave || !syncRef.current) return Promise.resolve(false);
    return syncRef.current.save({ blockOrder, itemOrderByBlock });
  }

  function retryManualOrder() {
    // A failed save may be retried only by an inventory editor.
    if (canSave || !ready) void syncRef.current?.retry();
    else void syncRef.current?.refresh();
  }

  return { ...order, ready, saving, syncError, saveManualOrder, retryManualOrder };
}

"use client";

import { Loader2, PackagePlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  canCreateEquipmentLists,
  canEditReportForRoute,
  canManageEquipmentLists,
  getUserId,
} from "@/lib/authStore";
import { createClient } from "@/lib/supabase/client";
import {
  ACTIVE_EQUIPMENT_LIST_EVENT,
  ACTIVE_EQUIPMENT_LIST_KEY,
  EQUIPMENT_LIST_ITEMS_EVENT,
  equipmentListSummary,
  canAddToEquipmentList,
  type EquipmentList,
} from "@/lib/equipmentLists";

export type MatrixListTarget = {
  id: string;
  parentId: string | null;
  recordType: "matrix_model" | "matrix_row";
  displayName: string;
  blockName?: string | null;
  photoUrl?: string | null;
  itemType?: "unit" | "cable" | "rack" | null;
  rowLabel?: string | null;
  total: number;
  inUse: number;
  maintenance: number;
  activeMaintenance?: number;
  inKsa: number;
};

type ExistingLine = {
  id: string;
  requested_quantity: number;
};

type MatrixLineRow = ExistingLine & {
  inventory_record_type: "matrix_model" | "matrix_row";
  inventory_record_id: string;
};

type SupabaseBrowserClient = ReturnType<typeof createClient>;

const activeListCache = new Map<string, EquipmentList | null>();
const activeListRequests = new Map<
  string,
  Promise<EquipmentList | null>
>();
const matrixLinesCache = new Map<string, Map<string, ExistingLine>>();
const matrixLinesRequests = new Map<
  string,
  Promise<Map<string, ExistingLine>>
>();

const ACTIVE_LIST_SELECT = `
  id, reference, list_type, status, client_company, event_name, venue,
  purpose, assigned_to, from_location_name, destination_name, pickup_date,
  return_date, setup_date, dismantling_date, loading_date, receiving_date,
  repair_company, maintenance_sent_date,
  notes, created_by, created_by_name, shared_with, created_at, updated_at
`;

function qty(value: unknown) {
  const parsed = Math.floor(Number(value) || 0);
  return Math.max(0, parsed);
}

function matrixLineKey(
  recordType: "matrix_model" | "matrix_row",
  recordId: string,
) {
  return `${recordType}:${recordId}`;
}

async function loadActiveListShared(
  supabase: SupabaseBrowserClient,
  listId: string,
  force = false,
) {
  if (!force && activeListCache.has(listId)) {
    return activeListCache.get(listId) ?? null;
  }

  const pending = activeListRequests.get(listId);
  if (pending) return pending;

  const request = (async () => {
    const { data, error } = await supabase
      .from("equipment_lists")
      .select(ACTIVE_LIST_SELECT)
      .eq("id", listId)
      .maybeSingle();

    if (error) throw error;

    const userId = getUserId();
    const manager = canManageEquipmentLists();
    const nextList =
      canAddToEquipmentList(data as EquipmentList | null, userId, manager)
        ? (data as EquipmentList)
        : null;
    activeListCache.set(listId, nextList);
    return nextList;
  })().finally(() => {
    activeListRequests.delete(listId);
  });

  activeListRequests.set(listId, request);
  return request;
}

async function loadMatrixLinesShared(
  supabase: SupabaseBrowserClient,
  listId: string,
  force = false,
) {
  if (!force && matrixLinesCache.has(listId)) {
    return matrixLinesCache.get(listId)!;
  }

  const pending = matrixLinesRequests.get(listId);
  if (pending) return pending;

  const request = (async () => {
    const { data, error } = await supabase
      .from("equipment_list_items")
      .select(
        "id,inventory_record_type,inventory_record_id,requested_quantity",
      )
      .eq("list_id", listId)
      .in("inventory_record_type", ["matrix_model", "matrix_row"])
      .order("created_at", { ascending: true });

    if (error) throw error;

    const lines = new Map<string, ExistingLine>();
    for (const row of (data ?? []) as MatrixLineRow[]) {
      const key = matrixLineKey(
        row.inventory_record_type,
        row.inventory_record_id,
      );
      if (!lines.has(key)) {
        lines.set(key, {
          id: row.id,
          requested_quantity: row.requested_quantity,
        });
      }
    }

    matrixLinesCache.set(listId, lines);
    return lines;
  })().finally(() => {
    matrixLinesRequests.delete(listId);
  });

  matrixLinesRequests.set(listId, request);
  return request;
}

function writeMatrixLineCache(
  listId: string,
  recordType: "matrix_model" | "matrix_row",
  recordId: string,
  line: ExistingLine | null,
) {
  const lines = matrixLinesCache.get(listId) ?? new Map<string, ExistingLine>();
  const key = matrixLineKey(recordType, recordId);
  if (line) lines.set(key, line);
  else lines.delete(key);
  matrixLinesCache.set(listId, lines);
}

export default function EquipmentListMatrixQuantityAction({
  target,
  category,
  subcategory,
  compact = false,
}: {
  target: MatrixListTarget;
  category: string;
  subcategory: string;
  compact?: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);
  const canBuildLists = canCreateEquipmentLists();
  const [activeList, setActiveList] = useState<EquipmentList | null>(null);
  const [open, setOpen] = useState(false);
  const [existingLine, setExistingLine] = useState<ExistingLine | null>(null);
  const [requested, setRequested] = useState(1);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const maintenanceList = activeList?.list_type === "maintenance";
  const available = maintenanceList
    ? Math.max(0, qty(target.maintenance) - qty(target.activeMaintenance))
    : Math.max(
        0,
        qty(target.total) -
          qty(target.inUse) -
          qty(target.maintenance) -
          qty(target.inKsa),
      );
  const canUseMaintenanceList =
    !maintenanceList ||
    canManageEquipmentLists() ||
    canEditReportForRoute(category, subcategory);

  useEffect(() => {
    let cancelled = false;
    let loadVersion = 0;

    async function syncActiveList(
      listId?: string | null,
      force = false,
    ) {
      const version = ++loadVersion;
      let nextListId = listId;

      if (nextListId === undefined) {
        try {
          nextListId = localStorage.getItem(ACTIVE_EQUIPMENT_LIST_KEY);
        } catch {
          nextListId = null;
        }
      }

      setOpen(false);
      setMessage("");

      if (!nextListId) {
        setActiveList(null);
        return;
      }

      try {
        const data = await loadActiveListShared(supabase, nextListId, force);
        if (cancelled || version !== loadVersion) return;
        setActiveList(data);
      } catch (loadError) {
        if (cancelled || version !== loadVersion) return;
        console.error("load active equipment list error", loadError);
        setActiveList(null);
      }
    }

    function handleActiveListChange(event: Event) {
      const listId = (event as CustomEvent<{ listId?: string | null }>).detail
        ?.listId;
      void syncActiveList(listId ?? null, true);
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === ACTIVE_EQUIPMENT_LIST_KEY) {
        void syncActiveList(event.newValue, true);
      }
    }

    void syncActiveList();
    window.addEventListener(ACTIVE_EQUIPMENT_LIST_EVENT, handleActiveListChange);
    window.addEventListener("storage", handleStorage);

    return () => {
      cancelled = true;
      window.removeEventListener(
        ACTIVE_EQUIPMENT_LIST_EVENT,
        handleActiveListChange,
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, [supabase]);

  useEffect(() => {
    if ((!open && !compact) || !activeList) return;
    let cancelled = false;

    async function loadExistingLine(force = false) {
      if (!matrixLinesCache.has(activeList!.id)) setLoading(true);
      setError("");

      try {
        const lines = await loadMatrixLinesShared(
          supabase,
          activeList!.id,
          force,
        );
        if (cancelled) return;

        const first =
          lines.get(matrixLineKey(target.recordType, target.id)) ?? null;
        setExistingLine(first);
        setRequested(
          first
            ? Math.min(qty(first.requested_quantity), available)
            : available > 0
              ? 1
              : 0,
        );
      } catch (loadError) {
        if (cancelled) return;
        console.error("load matrix list quantity error", loadError);
        setExistingLine(null);
        setRequested(available > 0 ? 1 : 0);
        setError("Could not check this item in the list.");
      }

      setLoading(false);
    }

    function handleItemsChange(event: Event) {
      const detail = (
        event as CustomEvent<{
          listId?: string;
          matrixLinesCached?: boolean;
        }>
      ).detail;
      if (!detail?.listId || detail.listId === activeList!.id) {
        void loadExistingLine(!detail?.matrixLinesCached);
      }
    }

    void loadExistingLine();
    window.addEventListener(EQUIPMENT_LIST_ITEMS_EVENT, handleItemsChange);
    return () => {
      cancelled = true;
      window.removeEventListener(EQUIPMENT_LIST_ITEMS_EVENT, handleItemsChange);
    };
  }, [activeList, available, compact, open, supabase, target.id, target.recordType]);

  async function saveQuantity(requestedOverride?: number) {
    const list = activeList;

    if (
      !list ||
      saving ||
      !(
        list.status === "draft" ||
        (list.status === "pending" && canManageEquipmentLists())
      )
    ) {
      return;
    }

    const nextQuantity = qty(requestedOverride ?? requested);
    if (nextQuantity < 1) {
      setError("Enter a quantity of at least 1.");
      return;
    }
    if (nextQuantity > available) {
      setError(
        maintenanceList
          ? `Only ${available} Maintenance unit${available === 1 ? " is" : "s are"} available for repair.`
          : `Only ${available} unit${available === 1 ? " is" : "s are"} available.`,
      );
      return;
    }

    setSaving(true);
    setError("");

    const metadata = {
      category,
      subcategory,
      matrix_source: "generic",
      item_type: target.itemType || null,
      item_id: target.parentId || target.id,
      row_id: target.recordType === "matrix_row" ? target.id : null,
      row_label: target.rowLabel || null,
      photo_url: target.photoUrl || null,
    };

    const result = existingLine
      ? await supabase
          .from("equipment_list_items")
          .update({
            requested_quantity: nextQuantity,
            display_name: target.displayName,
            block_name: target.blockName || null,
            metadata,
          })
          .eq("id", existingLine.id)
          .eq("list_id", list.id)
          .select("id,requested_quantity")
          .single()
      : await supabase.from("equipment_list_items").insert({
          list_id: list.id,
          inventory_record_type: target.recordType,
          inventory_record_id: target.id,
          parent_record_id: target.parentId,
          display_name: target.displayName,
          serial_number: null,
          block_name: target.blockName || null,
          requested_quantity: nextQuantity,
          approved_quantity: 0,
          metadata,
        }).select("id,requested_quantity").single();

    if (result.error) {
      console.error("save matrix list quantity error", result.error);
      setError(result.error.message || "Failed to add this item.");
      setSaving(false);
      return;
    }

    const savedLine = result.data as ExistingLine;
    setExistingLine(savedLine);
    setRequested(nextQuantity);
    writeMatrixLineCache(
      list.id,
      target.recordType,
      target.id,
      savedLine,
    );
    window.dispatchEvent(
      new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, {
        detail: { listId: list.id, matrixLinesCached: true },
      }),
    );

    const nextMessage = `${nextQuantity} unit${nextQuantity === 1 ? "" : "s"} added to ${list.reference}`;
    setMessage(nextMessage);
    setTimeout(() => {
      setMessage((current) => (current === nextMessage ? "" : current));
    }, 1800);
    setSaving(false);
    setOpen(false);
  }

  async function decreaseQuantity() {
    const list = activeList;
    if (!list || !existingLine || saving) return;
    const currentQuantity = qty(requested);
    if (currentQuantity > 1) {
      await saveQuantity(currentQuantity - 1);
      return;
    }

    setSaving(true);
    setError("");

    const { error: deleteError } = await supabase
      .from("equipment_list_items")
      .delete()
      .eq("id", existingLine.id)
      .eq("list_id", list.id);

    if (deleteError) {
      console.error("remove matrix list quantity error", deleteError);
      alert(deleteError.message || "Failed to remove this item.");
      setSaving(false);
      return;
    }

    setExistingLine(null);
    setRequested(0);
    writeMatrixLineCache(
      list.id,
      target.recordType,
      target.id,
      null,
    );
    window.dispatchEvent(
      new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, {
        detail: { listId: list.id, matrixLinesCached: true },
      }),
    );
    setSaving(false);
  }

  if (!canBuildLists) return null;

  if (!activeList || !canUseMaintenanceList) {
    if (compact) return null;

    return (
      <button
        type="button"
        disabled
        title="Choose a Draft list from the left sidebar first"
        className="w-full cursor-not-allowed rounded-xl border border-dashed border-gray-300 bg-gray-50 px-3 py-2.5 text-center text-[10px] font-semibold text-gray-500"
      >
        + Add Units — Select a Draft List First
      </button>
    );
  }

  const quantityDialog = open ? (
    <div
      className="fixed inset-0 z-[10020] flex items-end justify-center sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label={`Add ${target.displayName} to ${activeList.reference}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Close quantity picker"
        onClick={() => {
          if (!saving) setOpen(false);
        }}
        className="absolute inset-0 bg-black/50"
      />

      <div className="relative w-full rounded-t-3xl bg-white shadow-2xl sm:max-w-md sm:rounded-3xl">
        <div className="flex items-start gap-3 border-b border-gray-200 px-4 py-4 sm:px-5">
          {target.photoUrl ? (
            <img
              src={target.photoUrl}
              alt={target.displayName}
              className="h-12 w-12 shrink-0 rounded-xl border border-gray-100 bg-white object-cover"
            />
          ) : (
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gray-100 text-gray-400">
              <PackagePlus size={20} />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-gray-900">
              {target.displayName}
            </div>
            {target.rowLabel ? (
              <div className="mt-0.5 text-[10px] font-semibold text-gray-600">
                {target.rowLabel}
              </div>
            ) : null}
            <div className="mt-0.5 text-[10px] text-gray-500">
              Add to{" "}
              <span className="font-bold text-gray-800">
                {activeList.reference}
              </span>
              {equipmentListSummary(activeList)
                ? ` · ${equipmentListSummary(activeList)}`
                : ""}
            </div>
          </div>

          <button
            type="button"
            aria-label="Close"
            disabled={saving}
            onClick={() => setOpen(false)}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </div>

        <div className="space-y-4 px-4 py-5 sm:px-5">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-gray-100 px-2 py-2.5">
              <div className="text-[8px] font-bold uppercase text-gray-400">
                Total
              </div>
              <div className="mt-1 text-sm font-bold text-gray-900">
                {qty(target.total)}
              </div>
            </div>
            <div className="rounded-xl bg-yellow-100 px-2 py-2.5">
              <div className="text-[8px] font-bold uppercase text-yellow-700">
                Maintenance
              </div>
              <div className="mt-1 text-sm font-bold text-yellow-800">
                {qty(target.maintenance)}
              </div>
            </div>
            <div className="rounded-xl bg-green-100 px-2 py-2.5">
              <div className="text-[8px] font-bold uppercase text-green-700">
                {maintenanceList ? "Can Send" : "Available"}
              </div>
              <div className="mt-1 text-sm font-bold text-green-800">
                {available}
              </div>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-5 text-xs text-gray-500">
              <Loader2 size={15} className="animate-spin" /> Loading quantity...
            </div>
          ) : (
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Quantity
              <input
                type="number"
                min={1}
                max={available || undefined}
                value={requested}
                autoFocus
                disabled={saving || available === 0}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setRequested(qty(event.target.value))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveQuantity();
                }}
                className="mt-2 h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm font-bold text-gray-900 outline-none focus:border-black disabled:bg-gray-100"
              />
            </label>
          )}

          {error ? (
            <div className="rounded-xl bg-red-50 px-3 py-2 text-[10px] font-medium text-red-700">
              {error}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void saveQuantity()}
            disabled={loading || saving || requested < 1 || requested > available}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-black px-4 text-[11px] font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <PackagePlus size={14} />
            )}
            {saving
              ? "Saving..."
              : existingLine
                ? "Update List Quantity"
                : "Add to List"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (compact) {
    const currentQuantity = existingLine ? qty(requested) : 0;

    if (currentQuantity > 0) {
      return (
        <>
          <div
            onClick={(event) => event.stopPropagation()}
            className="inline-flex h-6 items-center overflow-hidden rounded-full border border-gray-200 bg-gray-50 text-gray-800"
            title={`Quantity in ${activeList.reference}`}
          >
            <button
              type="button"
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void decreaseQuantity();
              }}
              aria-label={currentQuantity === 1 ? "Remove item from list" : "Decrease quantity"}
              className="grid h-full w-6 place-items-center text-[14px] font-medium hover:bg-gray-100 disabled:opacity-50"
            >
              −
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setError("");
                setOpen(true);
              }}
              aria-label="Enter quantity"
              className="min-w-7 border-x border-gray-200 px-1 text-center text-[9px] font-semibold hover:bg-white disabled:opacity-50"
              title="Click to enter a quantity"
            >
              {saving ? (
                <Loader2 size={12} className="mx-auto animate-spin" />
              ) : (
                currentQuantity
              )}
            </button>
            <button
              type="button"
              disabled={saving || currentQuantity >= available}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void saveQuantity(currentQuantity + 1);
              }}
              aria-label="Increase quantity"
              className="grid h-full w-6 place-items-center text-[14px] font-medium leading-none hover:bg-gray-100 disabled:opacity-30"
            >
              +
            </button>
          </div>
          {quantityDialog}
        </>
      );
    }

    return (
      <>
        <button
          type="button"
          disabled={saving || loading || available < 1}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setRequested(available > 0 ? 1 : 0);
            setError("");
            setOpen(true);
          }}
          title={`Enter quantity for ${activeList.reference}`}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-gray-300 bg-white text-[14px] font-medium leading-none text-gray-700 transition hover:border-gray-400 hover:bg-gray-50 disabled:opacity-40"
          aria-label="Enter quantity"
        >
          {saving || loading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            "+"
          )}
        </button>
        {quantityDialog}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        className="w-full rounded-xl bg-red-600 px-3 py-2.5 text-center text-[11px] font-semibold text-white transition hover:bg-red-700"
      >
        + Add Units to {activeList.reference}
      </button>

      {message ? (
        <div className="rounded-lg bg-green-50 px-2.5 py-2 text-[9px] font-medium text-green-700">
          {message}
        </div>
      ) : null}

      {quantityDialog}
    </>
  );
}

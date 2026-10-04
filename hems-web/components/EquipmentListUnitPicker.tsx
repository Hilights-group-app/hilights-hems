"use client";

import { Check, Loader2, PackagePlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  EQUIPMENT_LIST_ITEMS_EVENT,
  equipmentListSummary,
  type EquipmentList,
} from "@/lib/equipmentLists";

type UnitRow = {
  id: string;
  unit_no: number | null;
  serial: string | null;
  status: string | null;
};

type PickerItem = {
  id: string;
  name: string;
  photo_url?: string | null;
  fixture_type?: string | null;
};

function unitLabel(unit: UnitRow) {
  if (unit.serial?.trim()) return unit.serial.trim();
  if (unit.unit_no !== null) return `Unit ${unit.unit_no}`;
  return "No serial number";
}

export default function EquipmentListUnitPicker({
  list,
  item,
  category,
  subcategory,
  allowPendingReview = false,
  onClose,
  onAdded,
}: {
  list: EquipmentList;
  item: PickerItem;
  category: string;
  subcategory: string;
  allowPendingReview?: boolean;
  onClose: () => void;
  onAdded: (count: number) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [existingIds, setExistingIds] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [autoQuantity, setAutoQuantity] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    let cancelled = false;

    async function loadUnits() {
      setLoading(true);
      setError("");

      const [unitsResult, existingResult] = await Promise.all([
        supabase
          .from("units")
          .select("id,unit_no,serial,status")
          .eq("item_id", item.id)
          .or("status.eq.available,status.is.null")
          .order("unit_no", { ascending: true }),
        supabase
          .from("equipment_list_items")
          .select("inventory_record_id")
          .eq("list_id", list.id)
          .eq("inventory_record_type", "unit")
          .eq("parent_record_id", item.id),
      ]);

      if (cancelled) return;

      if (unitsResult.error) {
        console.error("load available units error", unitsResult.error);
        setError("Could not load the available units.");
        setUnits([]);
      } else {
        setUnits((unitsResult.data ?? []) as UnitRow[]);
      }

      if (existingResult.error) {
        console.error("load existing list units error", existingResult.error);
        setError("Could not check the units already in this list.");
        setExistingIds(new Set());
      } else {
        setExistingIds(
          new Set(
            (existingResult.data ?? []).map((row) =>
              String(row.inventory_record_id),
            ),
          ),
        );
      }

      setLoading(false);
    }

    void loadUnits();

    return () => {
      cancelled = true;
    };
  }, [item.id, list.id, supabase]);

  const selectableIds = useMemo(
    () => units.filter((unit) => !existingIds.has(unit.id)).map((unit) => unit.id),
    [existingIds, units],
  );

  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((unitId) => selectedIds.has(unitId));
  const canAddToList =
    list.status === "draft" ||
    (allowPendingReview && list.status === "pending");

  function toggleUnit(unitId: string) {
    if (existingIds.has(unitId) || saving) return;

    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      setAutoQuantity(next.size);
      return next;
    });
  }

  function toggleAll() {
    if (saving) return;
    const next = allSelected ? new Set<string>() : new Set(selectableIds);
    setSelectedIds(next);
    setAutoQuantity(next.size);
  }

  function autoSelectQuantity(value: unknown) {
    if (saving) return;

    const parsed = Math.floor(Number(value) || 0);
    const nextQuantity = Math.max(0, Math.min(selectableIds.length, parsed));
    setAutoQuantity(nextQuantity);
    setSelectedIds(new Set(selectableIds.slice(0, nextQuantity)));
  }

  async function addSelectedUnits() {
    if (saving || !canAddToList) return;

    const selectedUnits = units.filter(
      (unit) => selectedIds.has(unit.id) && !existingIds.has(unit.id),
    );

    if (selectedUnits.length === 0) return;

    setSaving(true);
    setError("");

    const payload = selectedUnits.map((unit) => ({
      list_id: list.id,
      inventory_record_type: "unit" as const,
      inventory_record_id: unit.id,
      parent_record_id: item.id,
      display_name: item.name,
      serial_number: unit.serial?.trim() || null,
      requested_quantity: 1,
      approved_quantity: 0,
      metadata: {
        category,
        subcategory,
        item_id: item.id,
        unit_no: unit.unit_no,
        fixture_type: item.fixture_type || null,
        photo_url: item.photo_url || null,
      },
    }));

    const { error: insertError } = await supabase
      .from("equipment_list_items")
      .insert(payload);

    if (insertError) {
      console.error("add units to equipment list error", insertError);
      setError(insertError.message || "Failed to add the selected units.");
      setSaving(false);
      return;
    }

    const insertedIds = new Set(selectedUnits.map((unit) => unit.id));
    setExistingIds((current) => new Set([...current, ...insertedIds]));
    setSelectedIds(new Set());
    setAutoQuantity(0);

    window.dispatchEvent(
      new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, {
        detail: { listId: list.id },
      }),
    );

    onAdded(selectedUnits.length);
    setSaving(false);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[10020] flex items-end justify-center sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label={`Add ${item.name} to ${list.reference}`}
    >
      <button
        type="button"
        aria-label="Close unit picker"
        onClick={() => {
          if (!saving) onClose();
        }}
        className="absolute inset-0 bg-black/50"
      />

      <div className="relative flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:max-w-xl sm:rounded-3xl">
        <div className="flex items-start gap-3 border-b border-gray-200 px-4 py-4 sm:px-5">
          {item.photo_url ? (
            <img
              src={item.photo_url}
              alt={item.name}
              className="h-12 w-12 shrink-0 rounded-xl border border-gray-100 bg-white object-cover"
            />
          ) : (
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gray-100 text-gray-400">
              <PackagePlus size={20} />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-gray-900">
              {item.name}
            </div>
            <div className="mt-0.5 text-[10px] text-gray-500">
              Add to <span className="font-bold text-gray-800">{list.reference}</span>
              {equipmentListSummary(list)
                ? ` · ${equipmentListSummary(list)}`
                : ""}
            </div>
          </div>

          <button
            type="button"
            aria-label="Close"
            disabled={saving}
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-600 transition hover:bg-gray-200 disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 sm:px-5">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Available Units
            </div>
            <div className="mt-0.5 text-[9px] text-gray-400">
              Choose the exact serial numbers for this list.
            </div>
          </div>

          {selectableIds.length > 0 ? (
            <button
              type="button"
              onClick={toggleAll}
              disabled={saving}
              className="shrink-0 rounded-full border border-gray-300 px-2.5 py-1 text-[9px] font-semibold text-gray-600 transition hover:border-black hover:text-black disabled:opacity-50"
            >
              {allSelected ? "Clear all" : "Select all"}
            </button>
          ) : null}
        </div>

        {selectableIds.length > 0 ? (
          <div className="border-b border-gray-100 bg-gray-50 px-4 py-3 sm:px-5">
            <label className="block">
              <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">
                Quantity — Auto Select Fixture IDs
              </span>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={selectableIds.length}
                  value={autoQuantity}
                  disabled={saving}
                  onChange={(event) => autoSelectQuantity(event.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-xl border border-gray-300 bg-white px-3 text-sm font-bold text-gray-900 outline-none focus:border-black disabled:opacity-50"
                />
                <div className="shrink-0 rounded-xl border border-gray-200 bg-white px-3 py-2 text-[9px] text-gray-500">
                  Max {selectableIds.length}
                </div>
              </div>
              <span className="mt-1.5 block text-[9px] leading-4 text-gray-400">
                Enter a quantity and the first available fixture IDs will be
                selected automatically. You can still change them manually.
              </span>
            </label>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-xs text-gray-500">
              <Loader2 size={15} className="animate-spin" />
              Loading units...
            </div>
          ) : units.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-300 px-4 py-10 text-center text-[11px] text-gray-500">
              No available units for this fixture.
            </div>
          ) : (
            <div className="space-y-2">
              {units.map((unit) => {
                const alreadyAdded = existingIds.has(unit.id);
                const selected = selectedIds.has(unit.id);

                return (
                  <button
                    key={unit.id}
                    type="button"
                    onClick={() => toggleUnit(unit.id)}
                    disabled={alreadyAdded || saving}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${
                      alreadyAdded
                        ? "cursor-default border-gray-100 bg-gray-50 opacity-60"
                        : selected
                          ? "border-black bg-gray-50"
                          : "border-gray-200 bg-white hover:border-gray-400"
                    }`}
                  >
                    <span
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${
                        selected || alreadyAdded
                          ? "border-black bg-black text-white"
                          : "border-gray-300 bg-white"
                      }`}
                    >
                      {selected || alreadyAdded ? <Check size={12} /> : null}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-semibold text-gray-900">
                        {unitLabel(unit)}
                      </span>
                      <span className="mt-0.5 block text-[9px] text-gray-400">
                        Unit {unit.unit_no ?? "—"}
                        {unit.serial?.trim() ? ` · Serial ${unit.serial.trim()}` : " · Serial not entered"}
                      </span>
                    </span>

                    <span
                      className={`shrink-0 rounded-full px-2 py-1 text-[8px] font-bold ${
                        alreadyAdded
                          ? "bg-gray-200 text-gray-500"
                          : "bg-green-100 text-green-700"
                      }`}
                    >
                      {alreadyAdded ? "Added" : "Available"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {error ? (
            <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-[10px] font-medium text-red-700">
              {error}
            </div>
          ) : null}
        </div>

        <div className="border-t border-gray-200 bg-white px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-3 sm:px-5 sm:pb-4">
          <button
            type="button"
            onClick={() => void addSelectedUnits()}
            disabled={saving || selectedIds.size === 0 || !canAddToList}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-black px-4 text-[11px] font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <PackagePlus size={14} />}
            {saving
              ? "Adding..."
              : `Add ${selectedIds.size || ""} Unit${selectedIds.size === 1 ? "" : "s"}`.replace(
                  "Add  Units",
                  "Select Units",
                )}
          </button>
        </div>
      </div>
    </div>
  );
}

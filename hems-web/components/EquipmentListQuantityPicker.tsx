"use client";

import { Loader2, PackagePlus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  EQUIPMENT_LIST_ITEMS_EVENT,
  equipmentListSummary,
  type EquipmentList,
} from "@/lib/equipmentLists";

type MatrixRowTarget = {
  id: string;
  model_id: string;
  size: string;
  cabinet_model?: string | null;
  qty: number;
  maintenance_qty: number;
  photo_data?: string | null;
};

type ExistingLine = {
  id: string;
  requested_quantity: number;
};

function clampQty(value: unknown) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return 0;
  return Math.floor(numberValue);
}

function cabinetAreaFromSize(size: string) {
  const normalized = size
    .toLowerCase()
    .replace(/,/g, ".")
    .replace(/[×*]/g, "x")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(
    /(\d+(?:\.\d+)?)\s*(mm|cm|m)?\s*x\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)?/,
  );
  if (!match) return 0;

  const widthValue = Number(match[1]);
  const heightValue = Number(match[3]);
  const widthUnit = match[2] || match[4] || "";
  const heightUnit = match[4] || match[2] || "";

  if (!Number.isFinite(widthValue) || !Number.isFinite(heightValue)) return 0;

  function toMetres(value: number, unit: string) {
    if (unit === "mm") return value / 1000;
    if (unit === "cm") return value / 100;
    if (unit === "m") return value;
    if (value > 100) return value / 1000;
    if (value > 2) return value / 100;
    return value;
  }

  const width = toMetres(widthValue, widthUnit);
  const height = toMetres(heightValue, heightUnit);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;

  const area = width * height;
  return Number.isFinite(area) && area > 0 ? area : 0;
}

function formatSquareMetres(value: number) {
  return Number(value.toFixed(3)).toString();
}

export default function EquipmentListQuantityPicker({
  list,
  row,
  modelName,
  category,
  subcategory,
  activeAllocatedQuantity,
  onClose,
  onAdded,
}: {
  list: EquipmentList;
  row: MatrixRowTarget;
  modelName: string;
  category: string;
  subcategory: string;
  activeAllocatedQuantity: number;
  onClose: () => void;
  onAdded: (quantity: number) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [existingLine, setExistingLine] = useState<ExistingLine | null>(null);
  const [squareMetres, setSquareMetres] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const availableQuantity = Math.max(
    0,
    clampQty(row.qty) -
      clampQty(row.maintenance_qty) -
      clampQty(activeAllocatedQuantity),
  );
  const cabinetArea = cabinetAreaFromSize(row.size);
  const requestedSquareMetres = Math.max(0, Number(squareMetres) || 0);
  const quantity =
    cabinetArea > 0 && requestedSquareMetres > 0
      ? Math.ceil(requestedSquareMetres / cabinetArea - 0.0000001)
      : 0;
  const actualSquareMetres = quantity * cabinetArea;
  const availableSquareMetres = availableQuantity * cabinetArea;
  const displayName = [
    modelName,
    row.cabinet_model?.trim() || null,
    row.size.trim() || null,
  ]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  useEffect(() => {
    let cancelled = false;

    async function loadExistingLine() {
      setLoading(true);
      setError("");

      const { data, error: loadError } = await supabase
        .from("equipment_list_items")
        .select("id,requested_quantity")
        .eq("list_id", list.id)
        .eq("inventory_record_type", "matrix_row")
        .eq("inventory_record_id", row.id)
        .order("created_at", { ascending: true })
        .limit(1);

      if (cancelled) return;

      if (loadError) {
        console.error("load LED list quantity error", loadError);
        setError("Could not load this cabinet quantity from the list.");
        setExistingLine(null);
        setSquareMetres(
          availableQuantity > 0 && cabinetArea > 0
            ? formatSquareMetres(cabinetArea)
            : "",
        );
      } else {
        const first = ((data ?? [])[0] ?? null) as ExistingLine | null;
        const startingQuantity = first
          ? Math.min(clampQty(first.requested_quantity), availableQuantity)
          : availableQuantity > 0
            ? 1
            : 0;
        setExistingLine(first);
        setSquareMetres(
          startingQuantity > 0 && cabinetArea > 0
            ? formatSquareMetres(startingQuantity * cabinetArea)
            : "",
        );
      }

      setLoading(false);
    }

    void loadExistingLine();
    return () => {
      cancelled = true;
    };
  }, [availableQuantity, cabinetArea, list.id, row.id, supabase]);

  async function saveQuantity() {
    if (saving || list.status !== "draft") return;

    const nextQuantity = clampQty(quantity);
    if (cabinetArea <= 0) {
      setError(`Cabinet size "${row.size}" could not be converted to square metres.`);
      return;
    }

    if (requestedSquareMetres <= 0) {
      setError("Enter the required LED area in square metres.");
      return;
    }

    if (nextQuantity < 1) {
      setError("Enter the required LED area in square metres.");
      return;
    }

    if (nextQuantity > availableQuantity) {
      setError(`Only ${availableQuantity} cabinets are currently available.`);
      return;
    }

    setSaving(true);
    setError("");

    const payload = {
      list_id: list.id,
      inventory_record_type: "matrix_row" as const,
      inventory_record_id: row.id,
      parent_record_id: row.model_id,
      display_name: displayName || modelName,
      serial_number: null,
      requested_quantity: nextQuantity,
      approved_quantity: 0,
      metadata: {
        category,
        subcategory,
        model_id: row.model_id,
        matrix_row_id: row.id,
        cabinet_model: row.cabinet_model || null,
        cabinet_size: row.size,
        requested_sqm: requestedSquareMetres,
        actual_sqm: actualSquareMetres,
        cabinet_area_sqm: cabinetArea,
        photo_url: row.photo_data || null,
      },
    };

    const result = existingLine
      ? await supabase
          .from("equipment_list_items")
          .update({
            requested_quantity: nextQuantity,
            display_name: payload.display_name,
            metadata: payload.metadata,
          })
          .eq("id", existingLine.id)
          .eq("list_id", list.id)
      : await supabase.from("equipment_list_items").insert(payload);

    if (result.error) {
      console.error("save LED cabinet list quantity error", result.error);
      setError(result.error.message || "Failed to add the cabinets.");
      setSaving(false);
      return;
    }

    window.dispatchEvent(
      new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, {
        detail: { listId: list.id },
      }),
    );

    onAdded(nextQuantity);
    setSaving(false);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[10020] flex items-end justify-center sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label={`Add ${displayName || modelName} to ${list.reference}`}
    >
      <button
        type="button"
        aria-label="Close cabinet quantity picker"
        onClick={() => {
          if (!saving) onClose();
        }}
        className="absolute inset-0 bg-black/50"
      />

      <div className="relative w-full rounded-t-3xl bg-white shadow-2xl sm:max-w-md sm:rounded-3xl">
        <div className="flex items-start gap-3 border-b border-gray-200 px-4 py-4 sm:px-5">
          {row.photo_data ? (
            <img
              src={row.photo_data}
              alt={displayName || modelName}
              className="h-12 w-12 shrink-0 rounded-xl border border-gray-100 bg-white object-cover"
            />
          ) : (
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gray-100 text-gray-400">
              <PackagePlus size={20} />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-gray-900">
              {displayName || modelName}
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

        <div className="space-y-4 px-4 py-5 sm:px-5">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-gray-100 px-2 py-2.5">
              <div className="text-[8px] font-bold uppercase text-gray-400">Total</div>
              <div className="mt-1 text-sm font-bold text-gray-900">
                {cabinetArea > 0
                  ? `${formatSquareMetres(clampQty(row.qty) * cabinetArea)} SQM`
                  : clampQty(row.qty)}
              </div>
              <div className="mt-0.5 text-[8px] text-gray-500">
                {clampQty(row.qty)} cabinets
              </div>
            </div>
            <div className="rounded-xl bg-yellow-100 px-2 py-2.5">
              <div className="text-[8px] font-bold uppercase text-yellow-700">Maintenance</div>
              <div className="mt-1 text-sm font-bold text-yellow-800">
                {cabinetArea > 0
                  ? `${formatSquareMetres(
                      clampQty(row.maintenance_qty) * cabinetArea,
                    )} SQM`
                  : clampQty(row.maintenance_qty)}
              </div>
              <div className="mt-0.5 text-[8px] text-yellow-700">
                {clampQty(row.maintenance_qty)} cabinets
              </div>
            </div>
            <div className="rounded-xl bg-green-100 px-2 py-2.5">
              <div className="text-[8px] font-bold uppercase text-green-700">Available</div>
              <div className="mt-1 text-sm font-bold text-green-800">
                {cabinetArea > 0
                  ? `${formatSquareMetres(availableSquareMetres)} SQM`
                  : availableQuantity}
              </div>
              <div className="mt-0.5 text-[8px] text-green-700">
                {availableQuantity} cabinets
              </div>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-5 text-xs text-gray-500">
              <Loader2 size={15} className="animate-spin" />
              Loading quantity...
            </div>
          ) : (
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500">
              Required Area (SQM)
              <input
                type="number"
                min={cabinetArea || 0.01}
                max={availableSquareMetres || undefined}
                step="0.01"
                inputMode="decimal"
                value={squareMetres}
                disabled={
                  saving || availableQuantity === 0 || cabinetArea <= 0
                }
                onChange={(event) => setSquareMetres(event.target.value)}
                placeholder="Example: 10"
                className="mt-2 h-12 w-full rounded-xl border border-gray-300 px-4 text-base font-semibold text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
              />
            </label>
          )}

          {!loading && cabinetArea > 0 && requestedSquareMetres > 0 ? (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-[10px] text-blue-800">
              <span className="font-bold">{quantity} cabinets</span>
              {` × ${formatSquareMetres(cabinetArea)} SQM = `}
              <span className="font-bold">
                {formatSquareMetres(actualSquareMetres)} SQM actual area
              </span>
              {actualSquareMetres > requestedSquareMetres ? (
                <span className="mt-1 block text-[9px] text-blue-600">
                  Rounded up to the next complete cabinet.
                </span>
              ) : null}
            </div>
          ) : null}

          {!loading && cabinetArea <= 0 ? (
            <div className="rounded-xl bg-red-50 px-3 py-2 text-[10px] font-medium text-red-700">
              Cabinet size “{row.size}” is not readable. Use a size such as
              500×500 mm.
            </div>
          ) : null}

          {existingLine ? (
            <div className="rounded-xl bg-blue-50 px-3 py-2 text-[10px] text-blue-700">
              This cabinet is already in the list. Saving updates its quantity.
            </div>
          ) : null}

          {availableQuantity === 0 ? (
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-[10px] font-medium text-amber-800">
              No cabinets are currently available.
            </div>
          ) : null}

          {error ? (
            <div className="rounded-xl bg-red-50 px-3 py-2 text-[10px] font-medium text-red-700">
              {error}
            </div>
          ) : null}
        </div>

        <div className="border-t border-gray-200 px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-3 sm:px-5 sm:pb-4">
          <button
            type="button"
            onClick={() => void saveQuantity()}
            disabled={
              loading ||
              saving ||
              quantity < 1 ||
              quantity > availableQuantity ||
              cabinetArea <= 0 ||
              list.status !== "draft"
            }
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-black px-4 text-[11px] font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <PackagePlus size={14} />}
            {saving
              ? "Saving..."
              : existingLine
                ? `Update to ${formatSquareMetres(actualSquareMetres)} SQM`
                : `Add ${formatSquareMetres(actualSquareMetres)} SQM (${quantity} cabinets)`}
          </button>
        </div>
      </div>
    </div>
  );
}

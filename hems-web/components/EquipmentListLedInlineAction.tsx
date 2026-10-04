"use client";

import { Loader2, Minus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  EQUIPMENT_LIST_ITEMS_EVENT,
  type EquipmentList,
} from "@/lib/equipmentLists";

type LedRow = {
  id: string;
  model_id: string;
  size: string;
  cabinet_model?: string | null;
  qty: number;
  maintenance_qty: number;
  photo_data?: string | null;
};

type ExistingLine = { id: string; requested_quantity: number };

function clampQty(value: unknown) {
  const parsed = Math.floor(Number(value) || 0);
  return Math.max(0, parsed);
}

function cabinetAreaFromSize(size: string) {
  const normalized = size
    .toLowerCase()
    .replace(/,/g, ".")
    .replace(/[×*]/g, "x")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/);
  if (!match) return 0;

  let width = Number(match[1]);
  let height = Number(match[2]);
  if (normalized.includes("mm") || Math.max(width, height) > 100) {
    width /= 1000;
    height /= 1000;
  } else if (normalized.includes("cm") || Math.max(width, height) > 2) {
    width /= 100;
    height /= 100;
  }
  return width > 0 && height > 0 ? width * height : 0;
}

function formatSqm(value: number) {
  return Number(value.toFixed(3)).toString();
}

export default function EquipmentListLedInlineAction({
  list,
  row,
  modelName,
  category,
  subcategory,
  activeAllocatedQuantity,
}: {
  list: EquipmentList | null;
  row: LedRow;
  modelName: string;
  category: string;
  subcategory: string;
  activeAllocatedQuantity: number;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [line, setLine] = useState<ExistingLine | null>(null);
  const [loading, setLoading] = useState(Boolean(list));
  const [saving, setSaving] = useState(false);

  const area = cabinetAreaFromSize(row.size);
  const available = Math.max(
    0,
    clampQty(row.qty) -
      clampQty(row.maintenance_qty) -
      clampQty(activeAllocatedQuantity),
  );
  const quantity = line ? clampQty(line.requested_quantity) : 0;

  useEffect(() => {
    if (!list) {
      setLine(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function loadLine() {
      setLoading(true);
      const { data, error } = await supabase
        .from("equipment_list_items")
        .select("id,requested_quantity")
        .eq("list_id", list!.id)
        .eq("inventory_record_type", "matrix_row")
        .eq("inventory_record_id", row.id)
        .order("created_at", { ascending: true })
        .limit(1);

      if (cancelled) return;
      if (error) console.error("load inline LED quantity error", error);
      setLine((((data ?? [])[0] ?? null) as ExistingLine | null));
      setLoading(false);
    }

    function handleItemsChange(event: Event) {
      const listId = (event as CustomEvent<{ listId?: string }>).detail?.listId;
      if (!listId || listId === list!.id) void loadLine();
    }

    void loadLine();
    window.addEventListener(EQUIPMENT_LIST_ITEMS_EVENT, handleItemsChange);
    return () => {
      cancelled = true;
      window.removeEventListener(EQUIPMENT_LIST_ITEMS_EVENT, handleItemsChange);
    };
  }, [list, row.id, supabase]);

  async function saveQuantity(nextQuantity: number) {
    if (!list || saving || nextQuantity < 1 || nextQuantity > available) return;
    setSaving(true);

    const displayName = [
      modelName,
      row.cabinet_model?.trim() || null,
      row.size.trim() || null,
    ].filter(Boolean).join(" · ");
    const requestedSqm = nextQuantity * area;
    const metadata = {
      category,
      subcategory,
      model_id: row.model_id,
      matrix_row_id: row.id,
      cabinet_model: row.cabinet_model || null,
      cabinet_size: row.size,
      requested_sqm: requestedSqm,
      actual_sqm: requestedSqm,
      cabinet_area_sqm: area,
      photo_url: row.photo_data || null,
    };

    const result = line
      ? await supabase
          .from("equipment_list_items")
          .update({ requested_quantity: nextQuantity, display_name: displayName, metadata })
          .eq("id", line.id)
          .eq("list_id", list.id)
          .select("id,requested_quantity")
          .single()
      : await supabase
          .from("equipment_list_items")
          .insert({
            list_id: list.id,
            inventory_record_type: "matrix_row",
            inventory_record_id: row.id,
            parent_record_id: row.model_id,
            display_name: displayName || modelName,
            serial_number: null,
            requested_quantity: nextQuantity,
            approved_quantity: 0,
            metadata,
          })
          .select("id,requested_quantity")
          .single();

    if (result.error) {
      console.error("save inline LED quantity error", result.error);
      alert(result.error.message || "Failed to update the LED quantity.");
      setSaving(false);
      return;
    }

    setLine(result.data as ExistingLine);
    window.dispatchEvent(
      new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, { detail: { listId: list.id } }),
    );
    setSaving(false);
  }

  async function decreaseLine() {
    if (!list || !line || saving) return;
    if (quantity > 1) {
      await saveQuantity(quantity - 1);
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from("equipment_list_items")
      .delete()
      .eq("id", line.id)
      .eq("list_id", list.id);

    if (error) {
      console.error("remove inline LED quantity error", error);
      alert(error.message || "Failed to remove the LED item.");
      setSaving(false);
      return;
    }

    setLine(null);
    window.dispatchEvent(
      new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, { detail: { listId: list.id } }),
    );
    setSaving(false);
  }

  if (!list) return null;

  if (quantity > 0) {
    return (
      <div
        onClick={(event) => event.stopPropagation()}
        className="inline-flex h-7 items-center overflow-hidden rounded-full border-[3px] border-yellow-400 bg-white text-black shadow-sm"
      >
        <button
          type="button"
          disabled={saving}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void decreaseLine();
          }}
          className="grid h-full w-8 place-items-center hover:bg-yellow-50 disabled:opacity-50"
          aria-label={quantity === 1 ? "Remove LED cabinets from list" : "Decrease LED cabinet quantity"}
        >
          {quantity === 1 ? (
            <Trash2 size={13} strokeWidth={2.4} />
          ) : (
            <Minus size={14} strokeWidth={2.4} />
          )}
        </button>
        <span className="min-w-12 px-1 text-center text-[10px] font-bold">
          {saving ? (
            <Loader2 size={12} className="mx-auto animate-spin" />
          ) : area > 0 ? (
            `${formatSqm(quantity * area)}m²`
          ) : (
            quantity
          )}
        </span>
        <button
          type="button"
          disabled={saving || quantity >= available}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void saveQuantity(quantity + 1);
          }}
          className="grid h-full w-8 place-items-center text-lg font-medium leading-none hover:bg-yellow-50 disabled:opacity-30"
          aria-label="Add one LED cabinet"
        >
          +
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={loading || saving || available < 1}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void saveQuantity(1);
      }}
      title={`Add cabinet to ${list.reference}`}
      className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-black text-base font-medium leading-none text-white shadow-sm hover:bg-gray-800 disabled:opacity-40"
    >
      {loading || saving ? <Loader2 size={12} className="animate-spin" /> : "+"}
    </button>
  );
}

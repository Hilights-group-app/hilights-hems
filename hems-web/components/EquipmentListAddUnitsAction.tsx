"use client";

import { useEffect, useMemo, useState } from "react";
import { canEditInventory } from "@/lib/authStore";
import { createClient } from "@/lib/supabase/client";
import EquipmentListUnitPicker from "@/components/EquipmentListUnitPicker";
import {
  ACTIVE_EQUIPMENT_LIST_EVENT,
  ACTIVE_EQUIPMENT_LIST_KEY,
  type EquipmentList,
} from "@/lib/equipmentLists";

type PickerItem = {
  id: string;
  name: string;
  photo_url?: string | null;
  fixture_type?: string | null;
};

const ACTIVE_LIST_SELECT = `
  id,
  reference,
  list_type,
  status,
  client_company,
  event_name,
  venue,
  purpose,
  assigned_to,
  from_location_name,
  destination_name,
  pickup_date,
  return_date,
  setup_date,
  dismantling_date,
  loading_date,
  receiving_date,
  notes,
  created_by_name,
  created_at,
  updated_at
`;

export default function EquipmentListAddUnitsAction({
  item,
  category,
  subcategory,
  compact = false,
}: {
  item: PickerItem;
  category: string;
  subcategory: string;
  compact?: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);
  const editable = canEditInventory();
  const [activeList, setActiveList] = useState<EquipmentList | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    let loadVersion = 0;

    async function syncActiveList(listId?: string | null) {
      const version = ++loadVersion;
      let nextListId = listId;

      if (nextListId === undefined) {
        try {
          nextListId = localStorage.getItem(ACTIVE_EQUIPMENT_LIST_KEY);
        } catch {
          nextListId = null;
        }
      }

      setPickerOpen(false);
      setMessage("");

      if (!nextListId) {
        setActiveList(null);
        return;
      }

      const { data, error } = await supabase
        .from("equipment_lists")
        .select(ACTIVE_LIST_SELECT)
        .eq("id", nextListId)
        .maybeSingle();

      if (cancelled || version !== loadVersion) return;

      if (error || !data || data.status !== "draft") {
        if (error) console.error("load active equipment list error", error);
        setActiveList(null);
        return;
      }

      setActiveList(data as EquipmentList);
    }

    function handleActiveListChange(event: Event) {
      const listId = (event as CustomEvent<{ listId?: string | null }>).detail
        ?.listId;
      void syncActiveList(listId ?? null);
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === ACTIVE_EQUIPMENT_LIST_KEY) {
        void syncActiveList(event.newValue);
      }
    }

    void syncActiveList();
    window.addEventListener(
      ACTIVE_EQUIPMENT_LIST_EVENT,
      handleActiveListChange,
    );
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

  if (!editable) return null;

  if (!activeList) {
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

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setPickerOpen(true);
        }}
        title={`Add units to ${activeList.reference}`}
        className={
          compact
            ? "inline-flex rounded-full bg-black px-2.5 py-1 text-[9px] font-semibold text-white shadow-sm transition hover:bg-gray-800"
            : "w-full rounded-xl bg-red-600 px-3 py-2.5 text-center text-[11px] font-semibold text-white transition hover:bg-red-700"
        }
      >
        {compact ? "+ List" : `+ Add Units to ${activeList.reference}`}
      </button>

      {!compact && message ? (
        <div className="rounded-lg bg-green-50 px-2.5 py-2 text-[9px] font-medium text-green-700">
          {message}
        </div>
      ) : null}

      {pickerOpen ? (
        <EquipmentListUnitPicker
          list={activeList}
          item={item}
          category={category}
          subcategory={subcategory}
          onClose={() => setPickerOpen(false)}
          onAdded={(count) => {
            const nextMessage = `${count} unit${count === 1 ? "" : "s"} added to ${activeList.reference}`;
            setMessage(nextMessage);
            setTimeout(() => {
              setMessage((current) =>
                current === nextMessage ? "" : current,
              );
            }, 1800);
          }}
        />
      ) : null}
    </>
  );
}

"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Archive,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  CircleUserRound,
  ClipboardList,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { canEditInventory, getUserName } from "@/lib/authStore";
import { createClient } from "@/lib/supabase/client";
import {
  ACTIVE_EQUIPMENT_LIST_EVENT,
  ACTIVE_EQUIPMENT_LIST_KEY,
  EQUIPMENT_LIST_ITEMS_EVENT,
  EQUIPMENT_LISTS_EVENT,
  EQUIPMENT_LIST_TYPE_OPTIONS,
  equipmentListStatusLabel,
  equipmentListSummary,
  equipmentListTypeLabel,
  type EquipmentList,
  type EquipmentListItem,
  type EquipmentListStatus,
  type EquipmentListType,
  type InventoryLocation,
} from "@/lib/equipmentLists";

type FormState = {
  clientCompany: string;
  eventName: string;
  venue: string;
  purpose: string;
  assignedTo: string;
  transferLocationCode: string;
  otherLocation: string;
  pickupDate: string;
  returnDate: string;
  setupDate: string;
  dismantlingDate: string;
  loadingDate: string;
  receivingDate: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
  clientCompany: "",
  eventName: "",
  venue: "",
  purpose: "",
  assignedTo: "",
  transferLocationCode: "KSA",
  otherLocation: "",
  pickupDate: "",
  returnDate: "",
  setupDate: "",
  dismantlingDate: "",
  loadingDate: "",
  receivingDate: "",
  notes: "",
};

const LIST_SELECT = `
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

const LIST_ITEM_SELECT = `
  id,
  list_id,
  inventory_record_type,
  inventory_record_id,
  parent_record_id,
  display_name,
  serial_number,
  block_name,
  requested_quantity,
  approved_quantity,
  returned_ok_quantity,
  returned_maintenance_quantity,
  metadata,
  created_at
`;

function typeIcon(type: EquipmentListType, size = 14) {
  if (type === "dry_hire") return <Building2 size={size} />;
  if (type === "local_event") return <CalendarDays size={size} />;
  if (type === "transfer_out") return <ArrowUpFromLine size={size} />;
  if (type === "transfer_in") return <ArrowDownToLine size={size} />;
  return <BriefcaseBusiness size={size} />;
}

function formatShortDate(value: string | null) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  });
}

function listDates(list: EquipmentList) {
  if (list.list_type === "dry_hire") {
    return [formatShortDate(list.pickup_date), formatShortDate(list.return_date)]
      .filter(Boolean)
      .join(" → ");
  }

  if (list.list_type === "local_event") {
    return [formatShortDate(list.setup_date), formatShortDate(list.dismantling_date)]
      .filter(Boolean)
      .join(" → ");
  }

  return formatShortDate(
    list.list_type === "transfer_out"
      ? list.loading_date
      : list.receiving_date,
  );
}

function inputClass() {
  return "w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-[11px] text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-red-400 focus:ring-2 focus:ring-red-100";
}

function statusClass(status: EquipmentListStatus) {
  if (status === "draft") return "bg-gray-100 text-gray-600";
  if (status === "pending") return "bg-amber-100 text-amber-700";
  if (status === "partially_returned") return "bg-purple-100 text-purple-700";
  if (status === "active") return "bg-blue-100 text-blue-700";
  if (status === "closed") return "bg-green-100 text-green-700";
  return "bg-red-100 text-red-700";
}

function listItemUnitLabel(item: EquipmentListItem) {
  if (item.inventory_record_type === "matrix_row") {
    const actualSquareMetres = Number(item.metadata?.actual_sqm);
    if (Number.isFinite(actualSquareMetres) && actualSquareMetres > 0) {
      return `${Number(actualSquareMetres.toFixed(3))} m² · ${item.requested_quantity} cabinet${item.requested_quantity === 1 ? "" : "s"}`;
    }
    return `${item.requested_quantity} cabinet${item.requested_quantity === 1 ? "" : "s"}`;
  }

  if (item.serial_number?.trim()) return item.serial_number.trim();

  const unitNo = item.metadata?.unit_no;
  if (typeof unitNo === "number" || typeof unitNo === "string") {
    return `Unit ${unitNo}`;
  }

  return "Unit without serial";
}

export default function EquipmentListsSidebar() {
  const supabase = useMemo(() => createClient(), []);
  const [mounted, setMounted] = useState(false);
  const [editable, setEditable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [lists, setLists] = useState<EquipmentList[]>([]);
  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [activeListItems, setActiveListItems] = useState<EquipmentListItem[]>(
    [],
  );
  const [loadingListItems, setLoadingListItems] = useState(false);
  const [removingListItemId, setRemovingListItemId] = useState<string | null>(
    null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<EquipmentListType | null>(
    null,
  );
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    let cancelled = false;

    setMounted(true);
    setEditable(canEditInventory());

    try {
      setActiveListId(localStorage.getItem(ACTIVE_EQUIPMENT_LIST_KEY));
    } catch {
      setActiveListId(null);
    }

    async function load(showLoading = true) {
      if (showLoading) setLoading(true);
      setError("");

      const [listResult, locationResult] = await Promise.all([
        supabase
          .from("equipment_lists")
          .select(LIST_SELECT)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("inventory_locations")
          .select("id,code,name")
          .eq("enabled", true)
          .order("name", { ascending: true }),
      ]);

      if (cancelled) return;

      if (listResult.error) {
        console.error("equipment lists load error", listResult.error);
        setError("Run the Equipment Lists SQL setup first.");
        setLists([]);
      } else {
        setLists((listResult.data ?? []) as EquipmentList[]);
      }

      if (!locationResult.error) {
        setLocations((locationResult.data ?? []) as InventoryLocation[]);
      }

      setLoading(false);
    }

    function handleListsChange() {
      void load(false);
    }

    void load(true);
    window.addEventListener(EQUIPMENT_LISTS_EVENT, handleListsChange);

    return () => {
      cancelled = true;
      window.removeEventListener(EQUIPMENT_LISTS_EVENT, handleListsChange);
    };
  }, [supabase]);

  const activeList = useMemo(
    () => lists.find((list) => list.id === activeListId) ?? null,
    [activeListId, lists],
  );

  const activeListItemGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        displayName: string;
        items: EquipmentListItem[];
      }
    >();

    for (const item of activeListItems) {
      const key =
        item.inventory_record_type === "matrix_row"
          ? `matrix_row:${item.inventory_record_id}`
          : item.parent_record_id
            ? `${item.inventory_record_type}:${item.parent_record_id}`
            : `${item.inventory_record_type}:${item.display_name}`;
      const existing = groups.get(key);

      if (existing) {
        existing.items.push(item);
      } else {
        groups.set(key, {
          key,
          displayName: item.display_name,
          items: [item],
        });
      }
    }

    return Array.from(groups.values());
  }, [activeListItems]);

  useEffect(() => {
    let cancelled = false;

    async function loadListItems() {
      if (!activeListId) {
        setActiveListItems([]);
        setLoadingListItems(false);
        return;
      }

      setLoadingListItems(true);

      const { data, error: itemsError } = await supabase
        .from("equipment_list_items")
        .select(LIST_ITEM_SELECT)
        .eq("list_id", activeListId)
        .order("created_at", { ascending: true });

      if (cancelled) return;

      if (itemsError) {
        console.error("equipment list items load error", itemsError);
        setActiveListItems([]);
      } else {
        setActiveListItems((data ?? []) as EquipmentListItem[]);
      }

      setLoadingListItems(false);
    }

    function handleItemsChange(event: Event) {
      const changedListId = (event as CustomEvent<{ listId?: string }>).detail
        ?.listId;

      if (!changedListId || changedListId === activeListId) {
        void loadListItems();
      }
    }

    void loadListItems();
    window.addEventListener(EQUIPMENT_LIST_ITEMS_EVENT, handleItemsChange);

    return () => {
      cancelled = true;
      window.removeEventListener(EQUIPMENT_LIST_ITEMS_EVENT, handleItemsChange);
    };
  }, [activeListId, supabase]);

  const visibleLists = useMemo(
    () =>
      lists.filter(
        (list) => list.status !== "closed" && list.status !== "cancelled",
      ),
    [lists],
  );

  const historyLists = useMemo(
    () =>
      lists.filter(
        (list) => list.status === "closed" || list.status === "cancelled",
      ),
    [lists],
  );

  const sections = useMemo(
    () => [
      {
        key: "draft",
        title: "Drafts",
        rows: visibleLists.filter((list) => list.status === "draft"),
      },
      {
        key: "pending",
        title: "Pending Approval",
        rows: visibleLists.filter((list) => list.status === "pending"),
      },
      {
        key: "active",
        title: "Active Lists",
        rows: visibleLists.filter(
          (list) =>
            list.status === "active" || list.status === "partially_returned",
        ),
      },
    ],
    [visibleLists],
  );

  function updateForm<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function closeCreate() {
    if (saving) return;
    setCreateOpen(false);
    setSelectedType(null);
    setForm(EMPTY_FORM);
    setError("");
  }

  function selectType(type: EquipmentListType) {
    setSelectedType(type);
    setForm(EMPTY_FORM);
    setError("");
  }

  function chooseActiveList(list: EquipmentList) {
    const nextId = activeListId === list.id ? null : list.id;
    setActiveListId(nextId);

    try {
      if (nextId) localStorage.setItem(ACTIVE_EQUIPMENT_LIST_KEY, nextId);
      else localStorage.removeItem(ACTIVE_EQUIPMENT_LIST_KEY);
    } catch {
      // Selection still works for the current page.
    }

    window.dispatchEvent(
      new CustomEvent(ACTIVE_EQUIPMENT_LIST_EVENT, {
        detail: { listId: nextId },
      }),
    );
  }

  async function removeListItem(itemId: string) {
    if (!editable || activeList?.status !== "draft" || removingListItemId) {
      return;
    }

    setRemovingListItemId(itemId);

    const { error: deleteError } = await supabase
      .from("equipment_list_items")
      .delete()
      .eq("id", itemId)
      .eq("list_id", activeList.id);

    if (deleteError) {
      console.error("remove equipment list item error", deleteError);
      setError(deleteError.message || "Failed to remove equipment from list.");
      setRemovingListItemId(null);
      return;
    }

    setActiveListItems((current) =>
      current.filter((item) => item.id !== itemId),
    );
    setRemovingListItemId(null);

    window.dispatchEvent(
      new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, {
        detail: { listId: activeList.id },
      }),
    );
  }

  function validateForm(type: EquipmentListType) {
    if (type === "dry_hire") {
      if (!form.clientCompany.trim()) return "Client Company is required.";
      if (!form.pickupDate) return "Pickup Date is required.";
      if (!form.returnDate) return "Return Date is required.";
      if (form.returnDate < form.pickupDate)
        return "Return Date cannot be before Pickup Date.";
    }

    if (type === "local_event") {
      if (!form.eventName.trim()) return "Event Name is required.";
      if (!form.venue.trim()) return "Venue is required.";
      if (!form.setupDate) return "Setup Date is required.";
      if (!form.dismantlingDate) return "Dismantling Date is required.";
      if (form.dismantlingDate < form.setupDate)
        return "Dismantling Date cannot be before Setup Date.";
    }

    if (type === "transfer_out") {
      if (
        form.transferLocationCode === "OTHER" &&
        !form.otherLocation.trim()
      ) {
        return "Destination is required.";
      }
      if (!form.loadingDate) return "Loading Date is required.";
    }

    if (type === "transfer_in") {
      if (
        form.transferLocationCode === "OTHER" &&
        !form.otherLocation.trim()
      ) {
        return "From Location is required.";
      }
      if (!form.receivingDate) return "Receiving Date is required.";
    }

    if (type === "internal_use") {
      if (!form.purpose.trim()) return "Purpose is required.";
      if (!form.assignedTo.trim()) return "Assigned To is required.";
    }

    return "";
  }

  async function createList() {
    if (!selectedType || !editable || saving) return;

    const validationError = validateForm(selectedType);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError("");

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const dubai = locations.find((location) => location.code === "DUBAI");
      const transferLocation = locations.find(
        (location) => location.code === form.transferLocationCode,
      );
      const transferLocationName =
        form.transferLocationCode === "OTHER"
          ? form.otherLocation.trim()
          : transferLocation?.name || form.transferLocationCode;

      const payload = {
        list_type: selectedType,
        status: "draft" as const,
        client_company:
          selectedType === "dry_hire" ? form.clientCompany.trim() : null,
        event_name:
          selectedType === "local_event" ? form.eventName.trim() : null,
        venue: selectedType === "local_event" ? form.venue.trim() : null,
        purpose:
          selectedType === "internal_use" ? form.purpose.trim() : null,
        assigned_to:
          selectedType === "internal_use" ? form.assignedTo.trim() : null,
        from_location_id:
          selectedType === "transfer_out"
            ? dubai?.id || null
            : selectedType === "transfer_in"
              ? transferLocation?.id || null
              : null,
        destination_location_id:
          selectedType === "transfer_in"
            ? dubai?.id || null
            : selectedType === "transfer_out"
              ? transferLocation?.id || null
              : null,
        from_location_name:
          selectedType === "transfer_out"
            ? "Dubai Warehouse"
            : selectedType === "transfer_in"
              ? transferLocationName
              : null,
        destination_name:
          selectedType === "transfer_in"
            ? "Dubai Warehouse"
            : selectedType === "transfer_out"
              ? transferLocationName
              : null,
        pickup_date: selectedType === "dry_hire" ? form.pickupDate : null,
        return_date: selectedType === "dry_hire" ? form.returnDate : null,
        setup_date:
          selectedType === "local_event" ? form.setupDate : null,
        dismantling_date:
          selectedType === "local_event" ? form.dismantlingDate : null,
        loading_date:
          selectedType === "transfer_out" ? form.loadingDate : null,
        receiving_date:
          selectedType === "transfer_in" ? form.receivingDate : null,
        notes: form.notes.trim() || null,
        created_by: user?.id || null,
        created_by_name: getUserName() || user?.email || "A team member",
      };

      const { data, error: insertError } = await supabase
        .from("equipment_lists")
        .insert(payload)
        .select(LIST_SELECT)
        .single();

      if (insertError || !data) {
        throw insertError || new Error("List was not created.");
      }

      const created = data as EquipmentList;
      setLists((current) => [created, ...current]);
      chooseActiveList(created);
      setCreateOpen(false);
      setSelectedType(null);
      setForm(EMPTY_FORM);
    } catch (createError: any) {
      console.error("create equipment list error", createError);
      setError(createError?.message || "Failed to create list.");
    } finally {
      setSaving(false);
    }
  }

  if (!mounted) {
    return <div className="p-4" />;
  }

  return (
    <div className="flex min-h-full flex-col p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
            Equipment Lists
          </h2>
          <p className="mt-1 text-[10px] text-gray-400">
            Prepare and track equipment movements.
          </p>
        </div>

        {createOpen ? (
          <button
            type="button"
            onClick={closeCreate}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-gray-200 text-gray-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
            title="Close"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>

      {editable && !createOpen ? (
        <button
          type="button"
          onClick={() => {
            setCreateOpen(true);
            setSelectedType(null);
            setError("");
          }}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-black px-3 py-2.5 text-[11px] font-semibold text-white transition hover:bg-gray-800 active:scale-[0.99]"
        >
          <Plus size={14} />
          Create List
        </button>
      ) : null}

      {createOpen ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
          {!selectedType ? (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold text-gray-900">
                Choose list type
              </div>

              {EQUIPMENT_LIST_TYPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => selectType(option.value)}
                  className="flex w-full items-center gap-2 rounded-xl border border-gray-200 px-3 py-2.5 text-left text-[11px] font-medium text-gray-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                >
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-gray-100">
                    {typeIcon(option.value, 14)}
                  </span>
                  <span className="flex-1">{option.label}</span>
                  <span className="text-[9px] font-bold text-gray-400">
                    {option.shortLabel}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => {
                  setSelectedType(null);
                  setError("");
                }}
                className="flex items-center gap-1 text-[10px] font-medium text-gray-500 hover:text-red-600"
              >
                <ChevronLeft size={12} />
                List types
              </button>

              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-xl bg-black text-white">
                  {typeIcon(selectedType, 15)}
                </span>
                <div>
                  <div className="text-xs font-bold text-gray-900">
                    {equipmentListTypeLabel(selectedType)}
                  </div>
                  <div className="text-[9px] text-gray-400">
                    Reference is created automatically
                  </div>
                </div>
              </div>

              <ListFields
                type={selectedType}
                form={form}
                locations={locations}
                updateForm={updateForm}
              />

              <label className="block">
                <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-gray-500">
                  Notes
                </span>
                <textarea
                  rows={3}
                  value={form.notes}
                  onChange={(event) => updateForm("notes", event.target.value)}
                  placeholder="Optional notes"
                  className={`${inputClass()} resize-none`}
                />
              </label>

              {error ? (
                <div className="rounded-lg bg-red-50 px-2.5 py-2 text-[10px] font-medium text-red-700">
                  {error}
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => void createList()}
                disabled={saving}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-black px-3 py-2.5 text-[11px] font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Check size={13} />
                )}
                {saving ? "Creating..." : "Create Draft"}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {!createOpen ? (
        <div className="mt-4 min-h-0 flex-1 space-y-4">
          {activeList ? (
            <section className="overflow-hidden rounded-2xl border-2 border-black bg-white shadow-sm">
              <div className="border-b border-gray-200 bg-gray-50 px-3 py-3">
                <div className="flex items-start gap-2">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-black text-white">
                    {typeIcon(activeList.list_type, 13)}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[11px] font-bold text-gray-900">
                        {activeList.reference}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-bold ${statusClass(
                          activeList.status,
                        )}`}
                      >
                        {equipmentListStatusLabel(activeList.status)}
                      </span>
                    </div>

                    <div className="mt-0.5 truncate text-[9px] text-gray-500">
                      {equipmentListSummary(activeList)}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => chooseActiveList(activeList)}
                    title="Collapse current list"
                    aria-label="Collapse current list"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-gray-200 bg-white text-gray-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                  >
                    <X size={12} />
                  </button>
                </div>

                <div className="mt-2 flex items-center justify-between border-t border-gray-200 pt-2">
                  <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">
                    Current List
                  </span>
                  <span className="rounded-full bg-black px-2 py-0.5 text-[8px] font-bold text-white">
                    {activeListItems.reduce(
                      (total, item) => total + (item.requested_quantity || 0),
                      0,
                    )}{" "}
                    pcs
                  </span>
                </div>
              </div>

              <div className="p-2">
                {loadingListItems ? (
                  <div className="flex items-center justify-center gap-2 px-2 py-5 text-[10px] text-gray-500">
                    <Loader2 size={12} className="animate-spin" />
                    Loading equipment...
                  </div>
                ) : activeListItems.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-300 px-3 py-5 text-center text-[10px] leading-4 text-gray-500">
                    Select equipment from the inventory and add its quantity or
                    serial numbers here.
                  </div>
                ) : (
                  <div className="max-h-[42vh] space-y-1.5 overflow-y-auto overscroll-contain pr-1">
                    {activeListItemGroups.map((group) => {
                      const groupQuantity = group.items.reduce(
                        (total, item) =>
                          total + (item.requested_quantity || 0),
                        0,
                      );
                      const groupSquareMetres = group.items.reduce(
                        (total, item) => {
                          const value = Number(item.metadata?.actual_sqm);
                          return total + (Number.isFinite(value) ? value : 0);
                        },
                        0,
                      );
                      const isMatrixRow =
                        group.items[0]?.inventory_record_type === "matrix_row";

                      return (
                        <div
                          key={group.key}
                          className="rounded-xl border border-gray-200 bg-white px-2.5 py-2.5"
                        >
                          <div className="truncate text-[10px] font-bold text-gray-900">
                            {isMatrixRow && groupSquareMetres > 0
                              ? `${Number(groupSquareMetres.toFixed(3))} m² (${groupQuantity} cabinets) — ${group.displayName}`
                              : `${groupQuantity} × ${group.displayName}`}
                          </div>

                          <div className="mt-1.5 text-[8px] font-bold uppercase tracking-wider text-gray-400">
                            {isMatrixRow
                              ? "LED Area / Cabinets"
                              : "Serial / Fixture ID"}
                          </div>

                          <div className="mt-1 flex flex-wrap gap-1">
                            {group.items.map((item) =>
                              editable && activeList.status === "draft" ? (
                                <button
                                  key={item.id}
                                  type="button"
                                  onClick={() => void removeListItem(item.id)}
                                  disabled={Boolean(removingListItemId)}
                                  aria-label={`Remove ${listItemUnitLabel(item)}`}
                                  title="Remove this unit"
                                  className="flex max-w-full items-center gap-1 rounded-md bg-gray-100 px-1.5 py-1 text-[8px] font-medium text-gray-600 transition hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                                >
                                  <span className="truncate">
                                    {listItemUnitLabel(item)}
                                  </span>
                                  {removingListItemId === item.id ? (
                                    <Loader2
                                      size={9}
                                      className="shrink-0 animate-spin"
                                    />
                                  ) : (
                                    <X size={9} className="shrink-0" />
                                  )}
                                </button>
                              ) : (
                                <span
                                  key={item.id}
                                  className="max-w-full truncate rounded-md bg-gray-100 px-1.5 py-1 text-[8px] font-medium text-gray-600"
                                >
                                  {listItemUnitLabel(item)}
                                </span>
                              ),
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <Link
                  href={`/inventory/lists/${activeList.id}`}
                  className="mt-2 flex w-full items-center justify-center rounded-xl bg-black px-3 py-2.5 text-[10px] font-semibold text-white transition hover:bg-gray-800"
                >
                  Open List
                </Link>
              </div>
            </section>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-3 text-[10px] text-gray-500">
              <Loader2 size={13} className="animate-spin" />
              Loading lists...
            </div>
          ) : error ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-[10px] leading-4 text-amber-800">
              {error}
            </div>
          ) : lists.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-300 px-3 py-5 text-center">
              <ClipboardList className="mx-auto text-gray-300" size={22} />
              <div className="mt-2 text-[10px] font-medium text-gray-500">
                No equipment lists yet.
              </div>
            </div>
          ) : (
            <>
              {sections.map((section) =>
                section.rows.length > 0 ? (
                <section key={section.key}>
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-[9px] font-bold uppercase tracking-wider text-gray-400">
                      {section.title}
                    </h3>
                    <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[9px] font-bold text-gray-500">
                      {section.rows.length}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {section.rows.map((list) => {
                      const selected = list.id === activeListId;
                      return (
                        <button
                          key={list.id}
                          type="button"
                          onClick={() => chooseActiveList(list)}
                          className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                            selected
                              ? "border-black bg-gray-50 shadow-sm"
                              : "border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm"
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <span
                              className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
                                selected
                                  ? "bg-black text-white"
                                  : "bg-gray-100 text-gray-600"
                              }`}
                            >
                              {typeIcon(list.list_type, 13)}
                            </span>

                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-[11px] font-bold text-gray-900">
                                  {list.reference}
                                </span>
                                <span
                                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-bold ${statusClass(
                                    list.status,
                                  )}`}
                                >
                                  {equipmentListStatusLabel(list.status)}
                                </span>
                              </span>

                              <span className="mt-1 block truncate text-[10px] text-gray-600">
                                {equipmentListSummary(list)}
                              </span>

                              {listDates(list) ? (
                                <span className="mt-1 flex items-center gap-1 text-[9px] text-gray-400">
                                  <CalendarDays size={9} />
                                  {listDates(list)}
                                </span>
                              ) : null}
                            </span>
                          </div>

                          {selected ? (
                            <span className="mt-2 flex items-center gap-1 border-t border-gray-200 pt-2 text-[9px] font-semibold text-gray-600">
                              <CircleUserRound size={10} />
                              Active list
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </section>
                ) : null,
              )}

              {historyLists.length > 0 ? (
                <section>
                  <button
                    type="button"
                    onClick={() => setHistoryOpen((current) => !current)}
                    aria-expanded={historyOpen}
                    className="flex w-full items-center justify-between rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-left transition hover:border-gray-300 hover:bg-gray-100"
                  >
                    <span className="flex items-center gap-2">
                      <Archive size={13} className="text-gray-500" />
                      <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">
                        History
                      </span>
                    </span>

                    <span className="flex items-center gap-2">
                      <span className="rounded-full bg-white px-1.5 py-0.5 text-[9px] font-bold text-gray-500">
                        {historyLists.length}
                      </span>
                      <ChevronDown
                        size={13}
                        className={`text-gray-500 transition-transform ${
                          historyOpen ? "rotate-180" : ""
                        }`}
                      />
                    </span>
                  </button>

                  {historyOpen ? (
                    <div className="mt-2 space-y-2">
                      {historyLists.map((list) => (
                        <Link
                          key={list.id}
                          href={`/inventory/lists/${list.id}`}
                          className="block w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-left transition hover:border-gray-300 hover:shadow-sm"
                        >
                          <span className="flex items-start gap-2">
                            <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gray-100 text-gray-500">
                              {typeIcon(list.list_type, 13)}
                            </span>

                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-[11px] font-bold text-gray-900">
                                  {list.reference}
                                </span>
                                <span
                                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[8px] font-bold ${statusClass(
                                    list.status,
                                  )}`}
                                >
                                  {equipmentListStatusLabel(list.status)}
                                </span>
                              </span>

                              <span className="mt-1 block truncate text-[10px] text-gray-600">
                                {equipmentListSummary(list)}
                              </span>

                              {listDates(list) ? (
                                <span className="mt-1 flex items-center gap-1 text-[9px] text-gray-400">
                                  <CalendarDays size={9} />
                                  {listDates(list)}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ListFields({
  type,
  form,
  locations,
  updateForm,
}: {
  type: EquipmentListType;
  form: FormState;
  locations: InventoryLocation[];
  updateForm: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}) {
  const externalLocations = locations.filter(
    (location) => location.code !== "DUBAI",
  );

  if (type === "dry_hire") {
    return (
      <div className="space-y-2.5">
        <TextField
          label="Client Company"
          value={form.clientCompany}
          placeholder="Company name"
          onChange={(value) => updateForm("clientCompany", value)}
        />
        <DateField
          label="Pickup Date"
          value={form.pickupDate}
          onChange={(value) => updateForm("pickupDate", value)}
        />
        <DateField
          label="Return Date"
          value={form.returnDate}
          min={form.pickupDate}
          onChange={(value) => updateForm("returnDate", value)}
        />
      </div>
    );
  }

  if (type === "local_event") {
    return (
      <div className="space-y-2.5">
        <TextField
          label="Event Name"
          value={form.eventName}
          placeholder="Event name"
          onChange={(value) => updateForm("eventName", value)}
        />
        <TextField
          label="Venue"
          value={form.venue}
          placeholder="Venue"
          onChange={(value) => updateForm("venue", value)}
        />
        <DateField
          label="Setup Date"
          value={form.setupDate}
          onChange={(value) => updateForm("setupDate", value)}
        />
        <DateField
          label="Dismantling Date"
          value={form.dismantlingDate}
          min={form.setupDate}
          onChange={(value) => updateForm("dismantlingDate", value)}
        />
      </div>
    );
  }

  if (type === "transfer_out" || type === "transfer_in") {
    const isOut = type === "transfer_out";
    return (
      <div className="space-y-2.5">
        <label className="block">
          <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-gray-500">
            {isOut ? "From" : "To"}
          </span>
          <div className="rounded-xl border border-gray-200 bg-gray-100 px-3 py-2 text-[11px] font-medium text-gray-600">
            Dubai Warehouse
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-gray-500">
            {isOut ? "Destination" : "From Location"}
          </span>
          <select
            value={form.transferLocationCode}
            onChange={(event) =>
              updateForm("transferLocationCode", event.target.value)
            }
            className={inputClass()}
          >
            {externalLocations.length > 0 ? (
              externalLocations.map((location) => (
                <option key={location.id} value={location.code}>
                  {location.name}
                </option>
              ))
            ) : (
              <>
                <option value="KSA">KSA</option>
                <option value="EGYPT">Egypt</option>
              </>
            )}
            <option value="OTHER">Other</option>
          </select>
        </label>

        {form.transferLocationCode === "OTHER" ? (
          <TextField
            label={isOut ? "Other Destination" : "Other From Location"}
            value={form.otherLocation}
            placeholder="Location name"
            onChange={(value) => updateForm("otherLocation", value)}
          />
        ) : null}

        <DateField
          label={isOut ? "Loading Date" : "Receiving Date"}
          value={isOut ? form.loadingDate : form.receivingDate}
          onChange={(value) =>
            updateForm(isOut ? "loadingDate" : "receivingDate", value)
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <TextField
        label="Purpose"
        value={form.purpose}
        placeholder="Testing, demo, office use..."
        onChange={(value) => updateForm("purpose", value)}
      />
      <TextField
        label="Assigned To"
        value={form.assignedTo}
        placeholder="Person or department"
        onChange={(value) => updateForm("assignedTo", value)}
      />
    </div>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass()}
      />
    </label>
  );
}

function DateField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: string;
  min?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-gray-500">
        {label}
      </span>
      <input
        type="date"
        value={value}
        min={min || undefined}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass()}
      />
    </label>
  );
}

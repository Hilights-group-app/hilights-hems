"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ImagePlus, Trash2 } from "lucide-react";
import { logActivity } from "@/lib/activityStore";
import {
  EQUIPMENT_LIST_ITEMS_EVENT,
  EQUIPMENT_LISTS_EVENT,
  equipmentListSummary,
  equipmentListTypeLabel,
  type EquipmentList,
} from "@/lib/equipmentLists";
import UnitReportFilterBar from "@/components/UnitReportFilterBar";
import {
  buildSerialPastePlan,
  isMultiLineSerialPaste,
  type UnitReportStatusFilter,
} from "@/lib/unitReportTools";

type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

type Unit = {
  id: string;
  unit_no: number | null;
  serial: string | null;
  status: string | null;
  notes: string | null;
  testing_date: string | null;
  damage_photos: string[] | null;
};

type Stats = {
  total: number;
  available: number;
  inUse: number;
  maintenance: number;
  inKsa: number;
};

type UnitPatch = Partial<Unit>;

type UnitMovement = {
  listId: string;
  reference: string;
  label: string;
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
  repair_company,
  maintenance_sent_date,
  notes,
  created_by_name,
  created_at,
  updated_at
`;

function toStatus(v: any): UnitStatus {
  if (v === "available" || v === "in_use" || v === "maintenance" || v === "in_ksa") {
    return v;
  }
  return "available";
}

function getStatusTextColor(status: string | null) {
  switch (status) {
    case "available":
      return "#16a34a";
    case "in_use":
      return "#2563eb";
    case "maintenance":
      return "#ca8a04";
    case "in_ksa":
      return "#7c3aed";
    default:
      return "#374151";
  }
}

function formatDisplayDate(value: string | null) {
  if (!value) return "-";
  return value;
}

function resizeNoteField(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function statusLabel(value: string | null | undefined) {
  if (value === "in_use") return "In Use";
  if (value === "in_ksa") return "In KSA";
  if (value === "maintenance") return "Maintenance";
  return "Available";
}

function isMovementStatus(value: string | null | undefined) {
  return value === "in_use" || value === "in_ksa";
}

function movementLabel(list: EquipmentList) {
  const type = equipmentListTypeLabel(list.list_type);
  const summary = equipmentListSummary(list);
  return summary ? `${type} · ${summary}` : type;
}

function valuesMatch(a: unknown, b: unknown) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  }
  return String(a ?? "") === String(b ?? "");
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

export function SerializedRowsBlock({
  itemId,
  itemName,
  activityLink,
  editable = true,
  workflowControlledStatus = false,
  onStatsChange,
}: {
  itemId: string;
  itemName?: string;
  activityLink?: string;
  editable?: boolean;
  workflowControlledStatus?: boolean;
  onStatsChange?: (stats: Stats) => void;
}) {
  const supabase = createClient();
  const [units, setUnits] = useState<Unit[]>([]);
  const unitsRef = useRef<Unit[]>([]);
  const [movementByUnit, setMovementByUnit] = useState<
    Record<string, UnitMovement>
  >({});
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<UnitReportStatusFilter>("all");
  const [bulkPasting, setBulkPasting] = useState(false);

  useEffect(() => {
    void loadUnits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  useEffect(() => {
    if (!workflowControlledStatus) return;

    function refreshMovements() {
      void loadUnits();
    }

    window.addEventListener(EQUIPMENT_LISTS_EVENT, refreshMovements);
    window.addEventListener(EQUIPMENT_LIST_ITEMS_EVENT, refreshMovements);

    return () => {
      window.removeEventListener(EQUIPMENT_LISTS_EVENT, refreshMovements);
      window.removeEventListener(EQUIPMENT_LIST_ITEMS_EVENT, refreshMovements);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, workflowControlledStatus]);

  async function loadUnitMovements(unitIds: string[]) {
    if (!workflowControlledStatus || unitIds.length === 0) {
      setMovementByUnit({});
      return;
    }

    const activeListsResult = await supabase
      .from("equipment_lists")
      .select(ACTIVE_LIST_SELECT)
      .in("status", ["active", "partially_returned"])
      .order("created_at", { ascending: false })
      .limit(200);

    if (activeListsResult.error) {
      console.error("load serialized active lists error", activeListsResult.error);
      setMovementByUnit({});
      return;
    }

    const activeLists = (activeListsResult.data ?? []) as EquipmentList[];
    const activeListIds = activeLists.map((list) => list.id);

    if (activeListIds.length === 0) {
      setMovementByUnit({});
      return;
    }

    const { data, error } = await supabase
      .from("equipment_list_items")
      .select(
        "list_id,inventory_record_id,requested_quantity,approved_quantity,returned_ok_quantity,returned_maintenance_quantity",
      )
      .eq("inventory_record_type", "unit")
      .in("list_id", activeListIds)
      .in("inventory_record_id", unitIds);

    if (error) {
      console.error("load serialized unit movements error", error);
      setMovementByUnit({});
      return;
    }

    const activeListsById = new Map(
      activeLists.map((activeList) => [activeList.id, activeList]),
    );
    const nextMovements: Record<string, UnitMovement> = {};

    for (const row of data ?? []) {
      const activeList = activeListsById.get(String(row.list_id));
      if (!activeList) continue;

      const dispatchedQuantity =
        Number(row.approved_quantity) > 0
          ? Number(row.approved_quantity)
          : Number(row.requested_quantity) || 0;
      const remaining = Math.max(
        0,
        dispatchedQuantity -
          (Number(row.returned_ok_quantity) || 0) -
          (Number(row.returned_maintenance_quantity) || 0),
      );

      if (remaining === 0) continue;

      nextMovements[String(row.inventory_record_id)] = {
        listId: activeList.id,
        reference: activeList.reference,
        label: movementLabel(activeList),
      };
    }

    setMovementByUnit(nextMovements);
  }

  async function loadUnits() {
    const { data, error } = await supabase
      .from("units")
      .select("id, unit_no, serial, status, notes, testing_date, damage_photos")
      .eq("item_id", itemId)
      .order("unit_no", { ascending: true });

    if (error) {
      console.error("loadUnits error:", error);
      return;
    }

    const nextUnits = (data ?? []) as Unit[];
    unitsRef.current = nextUnits;
    setUnits(nextUnits);
    await loadUnitMovements(nextUnits.map((unit) => unit.id));
  }

  useEffect(() => {
    onStatsChange?.({
      total: units.length,
      available: units.filter((u) => toStatus(u.status) === "available").length,
      inUse: units.filter((u) => toStatus(u.status) === "in_use").length,
      maintenance: units.filter((u) => toStatus(u.status) === "maintenance").length,
      inKsa: units.filter((u) => toStatus(u.status) === "in_ksa").length,
    });
  }, [units, onStatsChange]);

  const filteredUnits = useMemo(() => {
    const query = filterQuery.trim().toLocaleLowerCase();

    return units.filter((unit) => {
      const assigned =
        Boolean(movementByUnit[unit.id]) || isMovementStatus(unit.status);
      const statusMatches =
        statusFilter === "all" ||
        (statusFilter === "available" && toStatus(unit.status) === "available") ||
        (statusFilter === "maintenance" &&
          toStatus(unit.status) === "maintenance") ||
        (statusFilter === "assigned" && assigned);

      if (!statusMatches) return false;
      if (!query) return true;

      return [unit.unit_no, unit.serial, unit.notes]
        .some((value) =>
          String(value ?? "").toLocaleLowerCase().includes(query),
        );
    });
  }, [filterQuery, movementByUnit, statusFilter, units]);

  async function updateUnit(id: string, patch: UnitPatch) {
    if (!editable) return;

    const previous = unitsRef.current.find((unit) => unit.id === id);
    if (!previous) return;

    const nextPatch: UnitPatch = { ...patch };

    if (patch.unit_no !== undefined) {
      nextPatch.unit_no = Number(patch.unit_no) || 0;
    }

    const changedEntries = Object.entries(nextPatch).filter(
      ([key, value]) => !valuesMatch(previous[key as keyof Unit], value)
    );

    if (changedEntries.length === 0) return;

    const optimisticUnits = unitsRef.current.map((unit) =>
      unit.id === id ? { ...unit, ...nextPatch } : unit
    );
    unitsRef.current = optimisticUnits;
    setUnits(optimisticUnits);

    const { error } = await supabase.from("units").update(nextPatch).eq("id", id);

    if (error) {
      console.error("updateUnit error:", error);
      await loadUnits();
      return;
    }

    const unitLabel = `Unit #${nextPatch.unit_no ?? previous.unit_no ?? "-"}`;
    const equipmentName = itemName || "equipment";
    const changedKeys = changedEntries.map(([key]) => key);

    let title = `edited ${equipmentName}`;
    let message = `${unitLabel} was updated`;

    if (changedKeys.includes("status")) {
      message = `${unitLabel} status changed to ${statusLabel(nextPatch.status)}`;
    } else if (changedKeys.includes("serial")) {
      message = `${unitLabel} serial changed to ${nextPatch.serial || "empty"}`;
    } else if (changedKeys.includes("notes")) {
      message = `${unitLabel} notes were updated`;
    } else if (changedKeys.includes("testing_date")) {
      message = `${unitLabel} testing date was updated`;
    } else if (changedKeys.includes("damage_photos")) {
      message = `${unitLabel} damage photos were updated`;
    } else if (changedKeys.includes("unit_no")) {
      message = `${unitLabel} number was updated`;
    }

    await logActivity({ title, message, link: activityLink });
  }

  async function addRow() {
    if (!editable) return;

    const nextNumber =
      units.length > 0
        ? Math.max(
            ...units.map((u) => {
              const n = Number(u.unit_no);
              return Number.isFinite(n) ? n : 0;
            })
          ) + 1
        : 1;

    const { data, error } = await supabase
      .from("units")
      .insert({
        item_id: itemId,
        unit_no: nextNumber,
        serial: "",
        status: "available",
        notes: "",
        testing_date: null,
        damage_photos: [],
      })
      .select("id, unit_no, serial, status, notes, testing_date, damage_photos")
      .single();

    if (error) {
      console.error("addRow error:", error);
      return;
    }
    
    const nextUnits = [...unitsRef.current, data as Unit];
    unitsRef.current = nextUnits;
    setUnits(nextUnits);

    await logActivity({
      title: `added a unit to ${itemName || "equipment"}`,
      message: `Unit #${(data as Unit).unit_no ?? nextNumber} was added`,
      link: activityLink,
    });
  }

  async function pasteSerialColumn(unitId: string, clipboardText: string) {
    if (!editable || bulkPasting) return;

    const plan = buildSerialPastePlan(
      unitsRef.current,
      unitId,
      clipboardText,
    );

    if (plan.assignments.length === 0) {
      alert("No new serial numbers were found in the pasted column.");
      return;
    }

    if (
      plan.overwriteCount > 0 &&
      !confirm(
        `${plan.overwriteCount} existing serial number${
          plan.overwriteCount === 1 ? "" : "s"
        } will be overwritten. Continue?`,
      )
    ) {
      return;
    }

    setBulkPasting(true);

    try {
      const existingAssignments = plan.assignments.filter(
        (assignment) => assignment.target,
      );
      const updateResults = await Promise.all(
        existingAssignments.map((assignment) =>
          supabase
            .from("units")
            .update({ serial: assignment.serial })
            .eq("id", assignment.target!.id),
        ),
      );
      const updateError = updateResults.find((result) => result.error)?.error;
      if (updateError) throw updateError;

      const newAssignments = plan.assignments.filter(
        (assignment) => !assignment.target,
      );

      if (newAssignments.length > 0) {
        const firstNumber =
          unitsRef.current.length > 0
            ? Math.max(
                ...unitsRef.current.map((unit) => Number(unit.unit_no) || 0),
              ) + 1
            : 1;
        const { error: insertError } = await supabase.from("units").insert(
          newAssignments.map((assignment, index) => ({
            item_id: itemId,
            unit_no: firstNumber + index,
            serial: assignment.serial,
            status: "available",
            notes: "",
            testing_date: null,
            damage_photos: [],
          })),
        );
        if (insertError) throw insertError;
      }

      await loadUnits();
      await logActivity({
        title: `imported serials for ${itemName || "equipment"}`,
        message: `${plan.assignments.length} serial number${
          plan.assignments.length === 1 ? "" : "s"
        } pasted from Excel`,
        link: activityLink,
      });

      const skipped = plan.duplicateCount;
      alert(
        `${plan.assignments.length} serial number${
          plan.assignments.length === 1 ? "" : "s"
        } saved${
          skipped > 0
            ? `. ${skipped} duplicate${skipped === 1 ? " was" : "s were"} skipped.`
            : "."
        }`,
      );
    } catch (pasteError: any) {
      console.error("bulk serial paste error", pasteError);
      alert(pasteError?.message || "The serial numbers could not be saved.");
      await loadUnits();
    } finally {
      setBulkPasting(false);
    }
  }

  async function deleteRow(id: string) {
    if (!editable) return;

    const selectedUnit = unitsRef.current.find((unit) => unit.id === id);
    if (
      workflowControlledStatus &&
      (Boolean(movementByUnit[id]) || isMovementStatus(selectedUnit?.status))
    ) {
      alert(
        "This unit is on an active equipment list. Return or close it from the list before deleting it.",
      );
      return;
    }

    if (!confirm("Delete this unit?")) return;

    const deletedUnit = selectedUnit;

    const { error } = await supabase.from("units").delete().eq("id", id);

    if (error) {
      console.error("deleteRow error:", error);
      return;
    }

    const nextUnits = unitsRef.current.filter((unit) => unit.id !== id);
    unitsRef.current = nextUnits;
    setUnits(nextUnits);

    await logActivity({
      title: `deleted a unit from ${itemName || "equipment"}`,
      message: `Unit #${deletedUnit?.unit_no ?? "-"} was deleted`,
      link: activityLink,
    });
  }

  async function onPickDamagePhotos(unitId: string, files: FileList | null) {
    if (!editable || !files || files.length === 0) return;

    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;

    const currentPhotos = unit.damage_photos ?? [];
    if (currentPhotos.length >= 3) return;

    const remainingSlots = Math.max(0, 3 - currentPhotos.length);
    const picked = Array.from(files).slice(0, remainingSlots);
    const dataUrls = await Promise.all(picked.map((file) => fileToDataUrl(file)));
    const nextPhotos = [...currentPhotos, ...dataUrls].slice(0, 3);

    await updateUnit(unitId, { damage_photos: nextPhotos });
  }

  async function deleteDamagePhoto(unitId: string, photoIndex: number) {
    if (!editable) return;

    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;

    const currentPhotos = unit.damage_photos ?? [];
    const nextPhotos = currentPhotos.filter((_, idx) => idx !== photoIndex);

    await updateUnit(unitId, { damage_photos: nextPhotos });
  }

  function openPhoto(url: string) {
    setPreviewPhoto(url);
  }

  return (
    <>
      {previewPhoto ? (
        <div className="fixed inset-0 z-[999999] bg-black/90 flex items-center justify-center p-4">
          <button
            type="button"
            onClick={() => setPreviewPhoto(null)}
            className="absolute top-4 right-4 rounded-full bg-white px-3 py-1 text-xs font-semibold text-black"
          >
            Close
          </button>

          <img
            src={previewPhoto}
            alt="Damage Photo"
            className="max-w-full max-h-[85vh] object-contain rounded-lg bg-white"
          />
        </div>
      ) : null}

      <div className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white px-[2px] pb-5 pt-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] lg:px-5 lg:pt-5">
        <UnitReportFilterBar
          query={filterQuery}
          status={statusFilter}
          resultCount={filteredUnits.length}
          totalCount={units.length}
          onQueryChange={setFilterQuery}
          onStatusChange={setStatusFilter}
        />

        <div className="hidden min-w-0 grid-cols-[32px_minmax(0,0.9fr)_minmax(0,1.05fr)_minmax(0,1.45fr)_minmax(0,0.95fr)_minmax(0,1.45fr)_24px] items-center gap-1 pb-4 pt-2 text-[10px] font-semibold text-gray-600 lg:grid">
          <div className="min-w-0 text-center">ID</div>
          <div className="min-w-0 truncate">Serial</div>
          <div className="min-w-0 truncate">Status</div>
          <div className="min-w-0 truncate">Note</div>
          <div className="min-w-0 truncate">Test Date</div>
          <div className="min-w-0 truncate">Damage</div>
          <div aria-hidden="true" />
        </div>

        {units.length === 0 ? (
          <div className="text-sm text-gray-500">No units found.</div>
        ) : filteredUnits.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-500">
            No units match these filters.
          </div>
        ) : (
          filteredUnits.map((unit) => (
            <SerializedUnitRow
              key={unit.id}
              unit={unit}
              index={units.findIndex((current) => current.id === unit.id)}
              editable={editable}
              workflowControlledStatus={workflowControlledStatus}
              movement={movementByUnit[unit.id]}
              onChange={updateUnit}
              onPickDamagePhotos={onPickDamagePhotos}
              onDeleteDamagePhoto={deleteDamagePhoto}
              onOpenPhoto={openPhoto}
              onDeleteRow={deleteRow}
              onBulkSerialPaste={pasteSerialColumn}
            />
          ))
        )}

        {editable ? (
          <div className="flex justify-start mt-8 pb-4">
            <button
              type="button"
              onClick={addRow}
              className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
            >
              + Add Row
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

function DamagePhotoThumb({
  photo,
  index,
  editable,
  onDelete,
  onOpenPhoto,
}: {
  photo: string;
  index: number;
  editable: boolean;
  onDelete: () => void;
  onOpenPhoto: (url: string) => void;
}) {
  const [hover, setHover] = useState(false);

  return (
    <div
      className="relative w-[10px] h-[10px] lg:w-10 lg:h-10 overflow-visible bg-white shrink-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <img
        src={photo}
        alt={`Damage ${index + 1}`}
        className="w-[10px] h-[10px] lg:w-10 lg:h-10 object-cover cursor-pointer rounded-[2px] lg:rounded-lg"
        onClick={() => onOpenPhoto(photo)}
      />

      {editable ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute -top-[5px] -right-[5px] w-[8px] h-[8px] lg:w-4 lg:h-4 rounded-full bg-white border text-[5px] lg:text-[9px] flex items-center justify-center hover:bg-gray-50 z-20"
          title="Delete photo"
        >
          ✕
        </button>
      ) : null}

      {hover ? (
        <div
          className="hidden lg:block"
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "300px",
            height: "300px",
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: "12px",
            padding: "10px",
            boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
            zIndex: 999999,
          }}
        >
          <img
            src={photo}
            alt={`Damage ${index + 1}`}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              borderRadius: "8px",
              display: "block",
              background: "#ffffff",
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function UnitStatusField({
  status,
  editable,
  workflowControlledStatus,
  movement,
  wide = false,
  onChange,
}: {
  status: string;
  editable: boolean;
  workflowControlledStatus: boolean;
  movement?: UnitMovement;
  wide?: boolean;
  onChange: (status: UnitStatus) => void;
}) {
  const lockedByMovement =
    workflowControlledStatus && isMovementStatus(status);
  const widthClass = wide ? "w-full min-w-0" : "w-full";

  if (lockedByMovement) {
    if (movement) {
      return (
        <Link
          href={`/inventory/lists/${movement.listId}`}
          title={`${movement.reference} · ${movement.label}`}
          className={`${widthClass} block truncate rounded-lg bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700 transition hover:bg-blue-100`}
        >
          {movement.label}
        </Link>
      );
    }

    return (
      <div
        className={`${widthClass} truncate rounded-lg bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-600`}
        title="This legacy movement is not linked to an active list"
      >
        Existing movement
      </div>
    );
  }

  if (editable) {
    return (
      <select
        value={status}
        onChange={(event) => onChange(event.target.value as UnitStatus)}
        style={{ color: getStatusTextColor(status) }}
        className={`${widthClass} rounded-lg border-none bg-white px-1 py-1 text-[12px] outline-none`}
      >
        <option value="available">Available</option>
        {!workflowControlledStatus ? (
          <option value="in_use">In Use</option>
        ) : null}
        <option value="maintenance">Maintenance</option>
        {!workflowControlledStatus ? (
          <option value="in_ksa">In KSA</option>
        ) : null}
      </select>
    );
  }

  return (
    <div
      style={{ color: getStatusTextColor(status) }}
      className={`${widthClass} rounded-lg bg-white px-1 py-1 text-[12px] font-semibold`}
    >
      {statusLabel(status)}
    </div>
  );
}

function SerializedUnitRow({
  unit,
  index,
  editable,
  workflowControlledStatus,
  movement,
  onChange,
  onPickDamagePhotos,
  onDeleteDamagePhoto,
  onOpenPhoto,
  onDeleteRow,
  onBulkSerialPaste,
}: {
  unit: Unit;
  index: number;
  editable: boolean;
  workflowControlledStatus: boolean;
  movement?: UnitMovement;
  onChange: (unitId: string, patch: Partial<Unit>) => Promise<void>;
  onPickDamagePhotos: (unitId: string, files: FileList | null) => Promise<void>;
  onDeleteDamagePhoto: (unitId: string, photoIndex: number) => Promise<void>;
  onOpenPhoto: (url: string) => void;
  onDeleteRow: (id: string) => Promise<void>;
  onBulkSerialPaste: (unitId: string, text: string) => Promise<void>;
}) {
  const [unitNo, setUnitNo] = useState(String(unit.unit_no ?? ""));
  const [serial, setSerial] = useState(unit.serial || "");
  const [status, setStatus] = useState(unit.status || "available");
  const [notes, setNotes] = useState(unit.notes || "");
  const [testingDate, setTestingDate] = useState(unit.testing_date || "");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const didInitRef = useRef(false);

  useEffect(() => {
    if (!didInitRef.current) {
      setUnitNo(String(unit.unit_no ?? ""));
      setSerial(unit.serial || "");
      setStatus(unit.status || "available");
      setNotes(unit.notes || "");
      setTestingDate(unit.testing_date || "");
      didInitRef.current = true;
    }
  }, [unit]);

  const photos = unit.damage_photos ?? [];
  const lockedByMovement =
    workflowControlledStatus &&
    (isMovementStatus(status) || Boolean(movement));

  function debounceSave(key: string, fn: () => void) {
    if (timerRef.current[key]) clearTimeout(timerRef.current[key]);
    timerRef.current[key] = setTimeout(fn, 800);
  }

  return (
    <div className="border-t border-gray-200 pt-3">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={async (e) => {
          if (!editable) return;
          await onPickDamagePhotos(unit.id, e.target.files);
          e.target.value = "";
        }}
      />

      {/* MOBILE CARD STYLE */}
      <div className="lg:hidden rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-gray-400">
              Unit
            </div>

            <input
              value={unitNo}
              readOnly={!editable}
              onChange={(e) => {
                if (!editable) return;
                const v = e.target.value;
                setUnitNo(v);
                debounceSave("unit_no_mobile", () => {
                  void onChange(unit.id, { unit_no: Number(v) || 0 });
                });
              }}
              onBlur={() => {
                if (!editable) return;
                void onChange(unit.id, { unit_no: Number(unitNo) || 0 });
              }}
              className="mt-1 w-full border-none bg-transparent p-0 text-[22px] font-extrabold tracking-tight text-gray-900 outline-none"
            />
          </div>

          <div className="flex items-center gap-2">
            <span
              style={{ color: getStatusTextColor(status) }}
              className="max-w-[190px] truncate rounded-full bg-gray-100 px-2 py-1 text-[10px] font-semibold"
              title={
                movement
                  ? `${movement.reference} · ${movement.label}`
                  : undefined
              }
            >
              {workflowControlledStatus && isMovementStatus(status)
                ? movement?.label || "Existing movement"
                : statusLabel(status)}
            </span>

            {editable && !lockedByMovement ? (
              <Trash2
                size={16}
                className="cursor-pointer text-red-500"
                onClick={() => void onDeleteRow(unit.id)}
              />
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="rounded-xl bg-gray-50 p-2">
            <div className="text-[10px] font-semibold text-gray-400">Serial</div>
            <input
              value={serial}
              readOnly={!editable}
              placeholder="Serial"
              onPaste={(event) => {
                const text = event.clipboardData.getData("text");
                if (!editable || !isMultiLineSerialPaste(text)) return;
                event.preventDefault();
                void onBulkSerialPaste(unit.id, text);
              }}
              onChange={(e) => {
                if (!editable) return;
                const v = e.target.value;
                setSerial(v);
                debounceSave("serial_mobile", () => {
                  void onChange(unit.id, { serial: v });
                });
              }}
              onBlur={() => {
                if (!editable) return;
                void onChange(unit.id, { serial });
              }}
              className="mt-1 w-full border-none bg-transparent p-0 text-[12px] font-medium text-gray-800 outline-none"
            />
          </label>

          <label className="rounded-xl bg-gray-50 p-2">
            <div className="text-[10px] font-semibold text-gray-400">Status</div>
            <UnitStatusField
              status={status}
              editable={editable}
              workflowControlledStatus={workflowControlledStatus}
              movement={movement}
              onChange={(nextStatus) => {
                setStatus(nextStatus);
                void onChange(unit.id, { status: nextStatus });
              }}
            />
          </label>

          <label className="rounded-xl bg-gray-50 p-2 col-span-2">
            <div className="text-[10px] font-semibold text-gray-400">Test Date</div>
            {editable ? (
              <input
                type="date"
                value={testingDate}
                onChange={(e) => {
                  const v = e.target.value;
                  setTestingDate(v);
                  debounceSave("testing_date_mobile", () => {
                    void onChange(unit.id, { testing_date: v || null });
                  });
                }}
                onBlur={() => {
                  void onChange(unit.id, { testing_date: testingDate || null });
                }}
                className="mt-1 w-full border-none bg-transparent p-0 text-[11px] text-gray-800 outline-none"
              />
            ) : (
              <div className="mt-1 w-full rounded-lg bg-white px-1 py-1 text-[11px] font-medium text-gray-800">
                {formatDisplayDate(testingDate)}
              </div>
            )}
          </label>
        </div>

        <label className="mt-2 block rounded-xl bg-gray-50 p-2">
          <div className="text-[10px] font-semibold text-gray-400">Note</div>
          <textarea
            ref={resizeNoteField}
            value={notes}
            readOnly={!editable}
            placeholder="Write note..."
            onChange={(e) => {
              if (!editable) return;
              const v = e.target.value;
              setNotes(v);
              debounceSave("notes_mobile", () => {
                void onChange(unit.id, { notes: v });
              });
            }}
            onBlur={() => {
              if (!editable) return;
              void onChange(unit.id, { notes });
            }}
            onInput={(event) => resizeNoteField(event.currentTarget)}
            rows={2}
            className="mt-1 w-full resize-none overflow-hidden whitespace-pre-wrap break-words border-none bg-transparent p-0 text-[12px] text-gray-800 outline-none [field-sizing:content]"
          />
        </label>

        <div className="mt-3 rounded-xl bg-gray-50 p-2">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[10px] font-semibold text-gray-400">
              Damage Photos ({photos.length}/3)
            </div>

            {editable ? (
              <ImagePlus
                size={17}
                className="cursor-pointer text-red-500"
                onClick={() => fileRef.current?.click()}
              />
            ) : null}
          </div>

          {photos.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {photos.slice(0, 3).map((photo, idx) => (
                <div key={`${unit.id}-mobile-${idx}`} className="relative">
                  <img
                    src={photo}
                    alt={`Damage ${idx + 1}`}
                    onClick={() => onOpenPhoto(photo)}
                    className="h-12 w-12 cursor-pointer rounded-lg object-cover"
                  />

                  {editable ? (
                    <button
                      type="button"
                      onClick={() => void onDeleteDamagePhoto(unit.id, idx)}
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border bg-white text-[9px] text-red-500 shadow-sm"
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-gray-400">No photos</div>
          )}
        </div>
      </div>

      {/* DESKTOP TABLE STYLE */}
      <div className="hidden min-w-0 grid-cols-[32px_minmax(0,0.9fr)_minmax(0,1.05fr)_minmax(0,1.45fr)_minmax(0,0.95fr)_minmax(0,1.45fr)_24px] items-center gap-1 lg:grid">
        <input
          value={unitNo}
          readOnly={!editable}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setUnitNo(v);
            debounceSave("unit_no", () => {
              void onChange(unit.id, { unit_no: Number(v) || 0 });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onChange(unit.id, { unit_no: Number(unitNo) || 0 });
          }}
          className="w-full min-w-0 rounded-lg border-none bg-white px-0 py-1 text-center text-[10px] outline-none read-only:text-gray-700"
        />

        <input
          value={serial}
          readOnly={!editable}
          placeholder={editable ? "Serial" : ""}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!editable || !isMultiLineSerialPaste(text)) return;
            event.preventDefault();
            void onBulkSerialPaste(unit.id, text);
          }}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setSerial(v);
            debounceSave("serial", () => {
              void onChange(unit.id, { serial: v });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onChange(unit.id, { serial });
          }}
          className="w-full min-w-0 truncate rounded-lg border-none bg-white px-1 py-1 text-[11px] outline-none read-only:text-gray-700"
        />

        <UnitStatusField
          status={status}
          editable={editable}
          workflowControlledStatus={workflowControlledStatus}
          movement={movement}
          wide
          onChange={(nextStatus) => {
            setStatus(nextStatus);
            void onChange(unit.id, { status: nextStatus });
          }}
        />

        <textarea
          ref={resizeNoteField}
          value={notes}
          readOnly={!editable}
          placeholder={editable ? "Note..." : ""}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setNotes(v);
            debounceSave("notes", () => {
              void onChange(unit.id, { notes: v });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onChange(unit.id, { notes });
          }}
          onInput={(event) => resizeNoteField(event.currentTarget)}
          rows={1}
          className="w-full min-w-0 resize-none overflow-hidden rounded-lg border-none bg-white px-1 py-1 text-[10px] outline-none read-only:text-gray-700 [field-sizing:content]"
          style={{
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            wordBreak: "break-word",
          }}
        />

        {editable ? (
          <input
            type="date"
            value={testingDate}
            onChange={(e) => {
              const v = e.target.value;
              setTestingDate(v);
              debounceSave("testing_date", () => {
                void onChange(unit.id, { testing_date: v || null });
              });
            }}
            onBlur={() => {
              void onChange(unit.id, { testing_date: testingDate || null });
            }}
            className="w-full min-w-0 rounded-lg border-none bg-white px-0.5 py-1 text-[10px] outline-none"
          />
        ) : (
          <div className="w-full min-w-0 truncate rounded-lg bg-white px-1 py-1 text-[10px] font-medium text-gray-700">
            {formatDisplayDate(testingDate)}
          </div>
        )}

        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {editable ? (
            <ImagePlus
              size={20}
              className="cursor-pointer shrink-0 transition-colors duration-200"
              style={{ color: "#ef4444" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#000000")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
              onClick={() => fileRef.current?.click()}
            />
          ) : null}

          {editable ? (
            <span className="text-xs text-gray-400 shrink-0">
              {photos.length}/3
            </span>
          ) : null}

          {photos.length > 0 ? (
            <div className="flex min-w-0 items-center gap-1 overflow-hidden">
              {photos.slice(0, 3).map((photo, idx) => (
                <DamagePhotoThumb
                  key={`${unit.id}-${idx}`}
                  photo={photo}
                  index={idx}
                  editable={editable}
                  onOpenPhoto={onOpenPhoto}
                  onDelete={() => void onDeleteDamagePhoto(unit.id, idx)}
                />
              ))}
            </div>
          ) : editable ? (
            <span className="text-xs text-gray-400 shrink-0">No photos</span>
          ) : null}
        </div>

        <div className="flex min-w-0 justify-center">
          {editable && !lockedByMovement ? (
            <Trash2
              size={16}
              className="cursor-pointer transition-colors duration-200"
              style={{ color: "#ef4444" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#000000")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
              onClick={() => void onDeleteRow(unit.id)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

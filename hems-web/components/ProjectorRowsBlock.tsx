"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ImagePlus, Trash2 } from "lucide-react";
import { getUserName } from "@/lib/authStore";
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

export type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

export type Unit = {
  id: string;
  item_id?: string;
  unit_no: string | number | null;
  serial: string | null;
  status: string | null;
  notes: string | null;
  lamp_hours: number | null;
  testing_date: string | null;
  damage_photos: string[] | null;
  updated_by: string | null;
  updated_at: string | null;
};

export type Stats = {
  total: number;
  available: number;
  inUse: number;
  maintenance: number;
  inKsa: number;
};

type UnitMovement = {
  listId: string;
  reference: string;
  label: string;
};

export type UnitPatch = Partial<
  Pick<
    Unit,
    | "unit_no"
    | "serial"
    | "status"
    | "notes"
    | "lamp_hours"
    | "testing_date"
    | "damage_photos"
  >
>;

const PROJECTOR_SELECT_WITH_TESTING =
  "id, item_id, unit_no, serial, status, notes, lamp_hours, testing_date, damage_photos, updated_by, updated_at";

const PROJECTOR_SELECT_WITHOUT_TESTING =
  "id, item_id, unit_no, serial, status, notes, lamp_hours, damage_photos, updated_by, updated_at";

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

function clampInt(v: any, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

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

function statusLabel(status: string | null) {
  if (status === "in_use") return "In Use";
  if (status === "in_ksa") return "In KSA";
  if (status === "maintenance") return "Maintenance";
  return "Available";
}

function resizeNoteField(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function isMovementStatus(status: string | null | undefined) {
  return status === "in_use" || status === "in_ksa";
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

/* ===================================================== */
/* SHARED ROWS BLOCK */
/* ===================================================== */

export function ProjectorRowsBlock({
  itemId,
  itemName,
  activityLink,
  editable = true,
  showTestingDate = true,
  onStatsChange,
  onSaveMessageChange,
  resequenceOnDelete = false,
  reloadOnFocus = false,
  workflowControlledStatus = false,
}: {
  itemId: string;
  itemName?: string;
  activityLink?: string;
  editable?: boolean;
  showTestingDate?: boolean;
  onStatsChange?: (stats: Stats) => void;
  onSaveMessageChange?: (msg: string) => void;
  resequenceOnDelete?: boolean;
  reloadOnFocus?: boolean;
  workflowControlledStatus?: boolean;
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
  const saveMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void loadUnits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, showTestingDate]);

  useEffect(() => {
    if (!reloadOnFocus) return;

    const handleFocus = () => void loadUnits();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void loadUnits();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadOnFocus, itemId, showTestingDate]);

  useEffect(() => {
    if (!workflowControlledStatus) return;

    const refreshMovements = () => void loadUnits();

    window.addEventListener(EQUIPMENT_LISTS_EVENT, refreshMovements);
    window.addEventListener(EQUIPMENT_LIST_ITEMS_EVENT, refreshMovements);

    return () => {
      window.removeEventListener(EQUIPMENT_LISTS_EVENT, refreshMovements);
      window.removeEventListener(EQUIPMENT_LIST_ITEMS_EVENT, refreshMovements);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, showTestingDate, workflowControlledStatus]);

  useEffect(() => {
    return () => {
      if (saveMsgTimerRef.current) clearTimeout(saveMsgTimerRef.current);
    };
  }, []);

  function setTransientMessage(msg: string, clearAfterMs = 1500) {
    onSaveMessageChange?.(msg);

    if (saveMsgTimerRef.current) clearTimeout(saveMsgTimerRef.current);

    if (clearAfterMs > 0) {
      saveMsgTimerRef.current = setTimeout(() => {
        onSaveMessageChange?.("");
      }, clearAfterMs);
    }
  }

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
      console.error("load projector active lists error", activeListsResult.error);
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
      console.error("load projector unit movements error", error);
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
      .select(showTestingDate ? PROJECTOR_SELECT_WITH_TESTING : PROJECTOR_SELECT_WITHOUT_TESTING)
      .eq("item_id", itemId)
      .order("unit_no", { ascending: true });

    if (error) {
      console.error("loadUnits error:", error);
      return;
    }



    const nextUnits = (data ?? []) as unknown as Unit[];
    unitsRef.current = nextUnits;
    setUnits(nextUnits);
    await loadUnitMovements(nextUnits.map((unit) => unit.id));
  }

  useEffect(() => {
    const nextStats: Stats = {
      total: units.length,
      available: units.filter((u) => toStatus(u.status) === "available").length,
      inUse: units.filter((u) => toStatus(u.status) === "in_use").length,
      maintenance: units.filter((u) => toStatus(u.status) === "maintenance").length,
      inKsa: units.filter((u) => toStatus(u.status) === "in_ksa").length,
    };

    onStatsChange?.(nextStats);
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

      return [unit.unit_no, unit.serial, unit.notes].some((value) =>
        String(value ?? "").toLocaleLowerCase().includes(query),
      );
    });
  }, [filterQuery, movementByUnit, statusFilter, units]);

  async function updateUnit(id: string, patch: UnitPatch) {
    if (!editable) return;

    const current = unitsRef.current.find((u) => u.id === id);
    if (!current) return;

    const nextPatch: Partial<Unit> = { ...patch };

    if (patch.lamp_hours !== undefined) {
      nextPatch.lamp_hours = clampInt(patch.lamp_hours, 0);
    }

    const changedEntries = Object.entries(nextPatch).filter(
      ([key, value]) => !valuesMatch(current[key as keyof Unit], value)
    );

    if (changedEntries.length === 0) return;

    const editorName = getUserName?.() || "Unknown User";
    const updatedAt = new Date().toISOString();

    nextPatch.updated_by = editorName;
    nextPatch.updated_at = updatedAt;

    const optimisticUnits = unitsRef.current.map((u) =>
      u.id === id ? { ...u, ...nextPatch } : u
    );
    unitsRef.current = optimisticUnits;
    setUnits(optimisticUnits);

    const payload: Partial<Unit> = {
      unit_no: nextPatch.unit_no ?? current.unit_no,
      serial: nextPatch.serial ?? current.serial ?? "",
      status: nextPatch.status ?? current.status ?? "available",
      notes: nextPatch.notes ?? current.notes ?? "",
      lamp_hours: nextPatch.lamp_hours ?? current.lamp_hours ?? 0,
      damage_photos: nextPatch.damage_photos ?? current.damage_photos ?? [],
      updated_by: nextPatch.updated_by,
      updated_at: nextPatch.updated_at,
    };

    if (showTestingDate) {
      payload.testing_date =
        nextPatch.testing_date !== undefined
          ? nextPatch.testing_date
          : current.testing_date;
    }

    const { data, error } = await supabase
      .from("units")
      .update(payload)
      .eq("id", id)
      .select(showTestingDate ? PROJECTOR_SELECT_WITH_TESTING : PROJECTOR_SELECT_WITHOUT_TESTING)
      .single();

    if (error) {
      console.error("updateUnit error:", error);
      onSaveMessageChange?.("Save failed");
      await loadUnits();
      return;
    }

    if (data) {
      const savedUnit = data as unknown as Unit;
      const savedUnits = unitsRef.current.map((u) =>
        u.id === id ? savedUnit : u
      );
      unitsRef.current = savedUnits;
      setUnits(savedUnits);
    }

    onSaveMessageChange?.("");

    const changedKeys = changedEntries.map(([key]) => key);
    const unitLabel = `Unit #${nextPatch.unit_no ?? current.unit_no ?? "-"}`;
    const equipmentName = itemName || "projector";
    let message = `${unitLabel} was updated`;

    if (changedKeys.includes("status")) {
      message = `${unitLabel} status changed to ${statusLabel(String(nextPatch.status ?? current.status))}`;
    } else if (changedKeys.includes("serial")) {
      message = `${unitLabel} serial changed to ${nextPatch.serial || "empty"}`;
    } else if (changedKeys.includes("lamp_hours")) {
      message = `${unitLabel} lamp hours changed to ${nextPatch.lamp_hours ?? 0}`;
    } else if (changedKeys.includes("notes")) {
      message = `${unitLabel} notes were updated`;
    } else if (changedKeys.includes("testing_date")) {
      message = `${unitLabel} testing date changed to ${nextPatch.testing_date || "empty"}`;
    } else if (changedKeys.includes("damage_photos")) {
      message = `${unitLabel} damage photos were updated`;
    } else if (changedKeys.includes("unit_no")) {
      message = `${unitLabel} number was updated`;
    }

    await logActivity({
      title: `edited ${equipmentName}`,
      message,
      link: activityLink,
    });
  }

  async function addRow() {
    if (!editable) return;

    const nextNumber =
      units.length > 0
        ? Math.max(...units.map((u) => clampInt(u.unit_no, 0))) + 1
        : 1;

    const editorName = getUserName?.() || "Unknown User";
    const updatedAt = new Date().toISOString();

    const insertPayload: Record<string, any> = {
      item_id: itemId,
      unit_no: nextNumber,
      serial: "",
      status: "available",
      notes: "",
      lamp_hours: 0,
      damage_photos: [],
      updated_by: editorName,
      updated_at: updatedAt,
    };

    if (showTestingDate) insertPayload.testing_date = null;

    const { data, error } = await supabase
      .from("units")
      .insert(insertPayload)
      .select(showTestingDate ? PROJECTOR_SELECT_WITH_TESTING : PROJECTOR_SELECT_WITHOUT_TESTING)
      .single();

    if (error) {
      console.error("addRow error:", error);
      onSaveMessageChange?.("Add row failed");
      return;
    }

    const addedUnit = data as unknown as Unit;
    const nextUnits = [...unitsRef.current, addedUnit];
    unitsRef.current = nextUnits;
    setUnits(nextUnits);
    setTransientMessage("Row added");

    await logActivity({
      title: `added a unit to ${itemName || "projector"}`,
      message: `Unit #${addedUnit.unit_no ?? nextNumber} was added`,
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
    setTransientMessage("Saving pasted serials...", 0);

    try {
      const editorName = getUserName?.() || "Unknown User";
      const updatedAt = new Date().toISOString();
      const existingAssignments = plan.assignments.filter(
        (assignment) => assignment.target,
      );
      const updateResults = await Promise.all(
        existingAssignments.map((assignment) =>
          supabase
            .from("units")
            .update({
              serial: assignment.serial,
              updated_by: editorName,
              updated_at: updatedAt,
            })
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
                ...unitsRef.current.map((unit) => clampInt(unit.unit_no, 0)),
              ) + 1
            : 1;
        const payload = newAssignments.map((assignment, index) => {
          const row: Record<string, unknown> = {
            item_id: itemId,
            unit_no: firstNumber + index,
            serial: assignment.serial,
            status: "available",
            notes: "",
            lamp_hours: 0,
            damage_photos: [],
            updated_by: editorName,
            updated_at: updatedAt,
          };
          if (showTestingDate) row.testing_date = null;
          return row;
        });
        const { error: insertError } = await supabase
          .from("units")
          .insert(payload);
        if (insertError) throw insertError;
      }

      await loadUnits();
      const skipped = plan.duplicateCount;
      const savedMessage = `${plan.assignments.length} serial number${
        plan.assignments.length === 1 ? "" : "s"
      } saved${
        skipped > 0
          ? ` · ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`
          : ""
      }`;
      setTransientMessage(savedMessage, 3000);
      await logActivity({
        title: `imported serials for ${itemName || "projector"}`,
        message: `${plan.assignments.length} serial number${
          plan.assignments.length === 1 ? "" : "s"
        } pasted from Excel`,
        link: activityLink,
      });
    } catch (pasteError: any) {
      console.error("bulk projector serial paste error", pasteError);
      onSaveMessageChange?.(
        pasteError?.message || "The serial numbers could not be saved.",
      );
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
        "This projector is on an active equipment list. Return or close it from the list before deleting it.",
      );
      return;
    }

    const ok = confirm("Delete this unit?");
    if (!ok) return;

    const deletedUnit = selectedUnit;

    const { error } = await supabase.from("units").delete().eq("id", id);

    if (error) {
      console.error("deleteRow error:", error);
      onSaveMessageChange?.("Delete failed");
      return;
    }

    let nextUnits = unitsRef.current.filter((u) => u.id !== id);

    if (resequenceOnDelete) {
      const resequence = nextUnits.map((u, idx) => ({
        id: u.id,
        unit_no: idx + 1,
      }));

      const { error: resequenceError } = await supabase
        .from("units")
        .upsert(resequence, { onConflict: "id" });

      if (!resequenceError) {
        nextUnits = nextUnits.map((u, idx) => ({
          ...u,
          unit_no: idx + 1,
        }));
      }
    }

    unitsRef.current = nextUnits;
    setUnits(nextUnits);
    setTransientMessage("Row deleted");

    await logActivity({
      title: `deleted a unit from ${itemName || "projector"}`,
      message: `Unit #${deletedUnit?.unit_no ?? "-"} was deleted`,
      link: activityLink,
    });
  }

  async function onPickDamagePhotos(unitId: string, files: FileList | null) {
    if (!editable || !files || files.length === 0) return;

    try {
      const unit = units.find((u) => u.id === unitId);
      if (!unit) return;

      const currentPhotos = unit.damage_photos ?? [];
      if (currentPhotos.length >= 3) return;

      const remainingSlots = Math.max(0, 3 - currentPhotos.length);
      const picked = Array.from(files).slice(0, remainingSlots);
      const dataUrls = await Promise.all(picked.map((file) => fileToDataUrl(file)));
      const nextPhotos = [...currentPhotos, ...dataUrls].slice(0, 3);

      await updateUnit(unitId, { damage_photos: nextPhotos });
    } catch (error) {
      console.error("damage photos error", error);
      onSaveMessageChange?.("Photo upload failed");
    }
  }

  function deleteDamagePhoto(unitId: string, photoIndex: number) {
    if (!editable) return;

    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;

    const currentPhotos = unit.damage_photos ?? [];
    const nextPhotos = currentPhotos.filter((_, idx) => idx !== photoIndex);

    void updateUnit(unitId, { damage_photos: nextPhotos });
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

        <div
          className={`hidden min-w-0 items-center gap-1 pb-4 pt-2 text-[10px] font-semibold text-gray-600 lg:grid ${
            showTestingDate
              ? "grid-cols-[32px_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.55fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_24px]"
              : "grid-cols-[32px_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.55fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_24px]"
          }`}
        >
          <div className="min-w-0 text-center">ID</div>
          <div className="min-w-0 truncate">Serial</div>
          <div className="min-w-0 truncate">Status</div>
          <div className="min-w-0 truncate">Lamp</div>
          <div className="min-w-0 truncate">Note</div>
          {showTestingDate ? (
            <div className="min-w-0 truncate">Test Date</div>
          ) : null}
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
            <ProjectorUnitRow
              key={unit.id}
              unit={unit}
              index={units.findIndex((current) => current.id === unit.id)}
              editable={editable}
              workflowControlledStatus={workflowControlledStatus}
              movement={movementByUnit[unit.id]}
              showTestingDate={showTestingDate}
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

/* ===================================================== */
/* ROW */
/* ===================================================== */

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

function ProjectorStatusField({
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
    workflowControlledStatus &&
    (isMovementStatus(status) || Boolean(movement));
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
        title="This legacy movement is not linked to an active list"
        className={`${widthClass} truncate rounded-lg bg-gray-100 px-2 py-1 text-[11px] font-semibold text-gray-600`}
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
        {!workflowControlledStatus ? <option value="in_use">In Use</option> : null}
        <option value="maintenance">Maintenance</option>
        {!workflowControlledStatus ? <option value="in_ksa">In KSA</option> : null}
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

function ProjectorUnitRow({
  unit,
  index,
  editable,
  workflowControlledStatus,
  movement,
  showTestingDate,
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
  showTestingDate: boolean;
  onChange: (unitId: string, patch: UnitPatch) => Promise<void>;
  onPickDamagePhotos: (unitId: string, files: FileList | null) => Promise<void>;
  onDeleteDamagePhoto: (unitId: string, photoIndex: number) => void;
  onOpenPhoto: (url: string) => void;
  onDeleteRow: (id: string) => Promise<void>;
  onBulkSerialPaste: (unitId: string, text: string) => Promise<void>;
}) {
  const [unitNo, setUnitNo] = useState(String(unit.unit_no ?? ""));
  const [serial, setSerial] = useState(unit.serial || "");
  const [status, setStatus] = useState(unit.status || "available");
  const [lampHours, setLampHours] = useState(String(unit.lamp_hours ?? 0));
  const [notes, setNotes] = useState(unit.notes || "");
  const [testingDate, setTestingDate] = useState(unit.testing_date || "");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    setUnitNo(String(unit.unit_no ?? ""));
    setSerial(unit.serial || "");
    setStatus(unit.status || "available");
    setLampHours(String(unit.lamp_hours ?? 0));
    setNotes(unit.notes || "");
    setTestingDate(unit.testing_date || "");
  }, [unit, index]);

  useEffect(() => {
    return () => {
      Object.values(timerRef.current).forEach(clearTimeout);
    };
  }, []);

  function debounceSave(key: string, fn: () => void) {
    if (timerRef.current[key]) clearTimeout(timerRef.current[key]);
    timerRef.current[key] = setTimeout(fn, 500);
  }

  function flushSave(key: string, fn: () => void) {
    if (timerRef.current[key]) clearTimeout(timerRef.current[key]);
    fn();
  }

  const photos = unit.damage_photos ?? [];
  const lockedByMovement =
    workflowControlledStatus &&
    (isMovementStatus(status) || Boolean(movement));

  return (
    <div className="border-t border-gray-200 pt-3">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={async (e) => {
          await onPickDamagePhotos(unit.id, e.target.files);
          e.target.value = "";
        }}
      />

      {/* MOBILE CARD STYLE */}
      <div className="lg:hidden rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-gray-400">
              Projector Unit
            </div>

            <input
              value={unitNo}
              readOnly={!editable}
              onChange={(e) => {
                if (!editable) return;
                const v = e.target.value;
                setUnitNo(v);
                debounceSave("unit_no_mobile", () => {
                  void onChange(unit.id, { unit_no: v.trim() });
                });
              }}
              onBlur={() => {
                if (!editable) return;
                flushSave("unit_no_mobile", () => {
                  void onChange(unit.id, { unit_no: unitNo.trim() });
                });
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
              {lockedByMovement
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
                flushSave("serial_mobile", () => {
                  void onChange(unit.id, { serial });
                });
              }}
              className="mt-1 w-full border-none bg-transparent p-0 text-[12px] font-medium text-gray-800 outline-none"
            />
          </label>

          <label className="rounded-xl bg-gray-50 p-2">
            <div className="text-[10px] font-semibold text-gray-400">Status</div>
            <div className="mt-1">
              <ProjectorStatusField
                status={status}
                editable={editable}
                workflowControlledStatus={workflowControlledStatus}
                movement={movement}
                onChange={(nextStatus) => {
                  setStatus(nextStatus);
                  void onChange(unit.id, { status: nextStatus });
                }}
              />
            </div>
          </label>

          <label className="rounded-xl bg-gray-50 p-2">
            <div className="text-[10px] font-semibold text-gray-400">Lamp Hours</div>
            <input
              value={lampHours}
              readOnly={!editable}
              onChange={(e) => {
                if (!editable) return;
                const v = e.target.value;
                setLampHours(v);
                debounceSave("lamp_mobile", () => {
                  void onChange(unit.id, { lamp_hours: clampInt(v, 0) });
                });
              }}
              onBlur={() => {
                if (!editable) return;
                flushSave("lamp_mobile", () => {
                  void onChange(unit.id, { lamp_hours: clampInt(lampHours, 0) });
                });
              }}
              className="mt-1 w-full border-none bg-transparent p-0 text-[12px] font-medium text-gray-800 outline-none"
            />
          </label>

          {showTestingDate ? (
            <label className="rounded-xl bg-gray-50 p-2">
              <div className="text-[10px] font-semibold text-gray-400">Test Date</div>
              <input
                type="date"
                value={testingDate}
                readOnly={!editable}
                onChange={(e) => {
                  if (!editable) return;
                  const v = e.target.value;
                  setTestingDate(v);
                  debounceSave("testing_mobile", () => {
                    void onChange(unit.id, { testing_date: v || null });
                  });
                }}
                onBlur={() => {
                  if (!editable) return;
                  flushSave("testing_mobile", () => {
                    void onChange(unit.id, { testing_date: testingDate || null });
                  });
                }}
                className="mt-1 w-full border-none bg-transparent p-0 text-[11px] text-gray-800 outline-none"
              />
            </label>
          ) : null}
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
              flushSave("notes_mobile", () => {
                void onChange(unit.id, { notes });
              });
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
                      onClick={() => onDeleteDamagePhoto(unit.id, idx)}
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
      <div
        className={`hidden min-w-0 items-center gap-1 lg:grid ${
          showTestingDate
            ? "grid-cols-[32px_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.55fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_24px]"
            : "grid-cols-[32px_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.55fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_24px]"
        }`}
      >
        <input
          value={unitNo}
          readOnly={!editable}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setUnitNo(v);
            debounceSave("unit_no", () => void onChange(unit.id, { unit_no: v.trim() }));
          }}
          onBlur={() => {
            if (!editable) return;
            flushSave("unit_no", () => void onChange(unit.id, { unit_no: unitNo.trim() }));
          }}
          className="w-full min-w-0 rounded-lg border-none bg-white px-0 py-1 text-center text-[10px] outline-none read-only:text-gray-700"
        />

        <input
          value={serial}
          readOnly={!editable}
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
            debounceSave("serial", () => void onChange(unit.id, { serial: v }));
          }}
          onBlur={() => {
            if (!editable) return;
            flushSave("serial", () => void onChange(unit.id, { serial }));
          }}
          className="w-full min-w-0 truncate rounded-lg border-none bg-white px-1 py-1 text-[11px] outline-none read-only:text-gray-700"
        />

        <ProjectorStatusField
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

        <input
          value={lampHours}
          readOnly={!editable}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setLampHours(v);
            debounceSave("lamp_hours", () =>
              void onChange(unit.id, { lamp_hours: clampInt(v, 0) })
            );
          }}
          onBlur={() => {
            if (!editable) return;
            flushSave("lamp_hours", () =>
              void onChange(unit.id, { lamp_hours: clampInt(lampHours, 0) })
            );
          }}
          className="w-full min-w-0 rounded-lg border-none bg-white px-0 py-1 text-center text-[10px] outline-none read-only:text-gray-700"
        />

        <textarea
          ref={resizeNoteField}
          value={notes}
          readOnly={!editable}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setNotes(v);
            debounceSave("notes", () => void onChange(unit.id, { notes: v }));
          }}
          onBlur={() => {
            if (!editable) return;
            flushSave("notes", () => void onChange(unit.id, { notes }));
          }}
          onInput={(event) => resizeNoteField(event.currentTarget)}
          rows={1}
          className="w-full min-w-0 resize-none overflow-hidden rounded-lg border-none bg-white px-1 py-1 text-[10px] outline-none read-only:text-gray-700 [field-sizing:content]"
          style={{
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            wordBreak: "break-word",
          }}
          placeholder={editable ? "Note..." : ""}
        />

        {showTestingDate ? (
          <input
            type="date"
            value={testingDate}
            readOnly={!editable}
            onChange={(e) => {
              if (!editable) return;
              const v = e.target.value;
              setTestingDate(v);
              debounceSave("testing_date", () =>
                void onChange(unit.id, { testing_date: v || null })
              );
            }}
            onBlur={() => {
              if (!editable) return;
              flushSave("testing_date", () =>
                void onChange(unit.id, { testing_date: testingDate || null })
              );
            }}
            className="w-full min-w-0 rounded-lg border-none bg-white px-0.5 py-1 text-[10px] outline-none read-only:text-gray-700"
          />
        ) : null}

        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={async (e) => {
              await onPickDamagePhotos(unit.id, e.target.files);
              e.target.value = "";
            }}
          />

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
                  onDelete={() => onDeleteDamagePhoto(unit.id, idx)}
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

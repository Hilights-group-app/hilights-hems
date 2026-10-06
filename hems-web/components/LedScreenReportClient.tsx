"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { canEditReportForRoute, getUserName } from "@/lib/authStore";
import { logActivity } from "@/lib/activityStore";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  EQUIPMENT_LIST_ITEMS_EVENT,
  EQUIPMENT_LISTS_EVENT,
  equipmentListSummary,
  equipmentListTypeLabel,
  type EquipmentList,
} from "@/lib/equipmentLists";

type QtyViewMode = "cabinet" | "sqm";

type MatrixRow = {
  id: string;
  model_id: string;
  size: string;
  qty: number;
  available_qty: number;
  in_use_qty: number;
  maintenance_qty: number;
  in_ksa_qty: number;
  cabinet_model: string | null;
  photo_data: string | null;
};

type MatrixModel = {
  id: string;
  name: string;
};

type IssueType =
  | "dead_pixels"
  | "ic_problem"
  | "hub_card_problem"
  | "damaged_pixels"
  | "damaged_housing";

type MaintenanceLog = {
  id: string;
  matrix_row_id: string;
  problem_type: IssueType;
  qty: number;
  team_name: string | null;
  event_name: string | null;
  event_date: string | null;
  note: string | null;
  photo_data: string | null;
  photo_data_list: string[] | null;
  created_at: string;
  created_by: string | null;
};

type ActiveAllocation = {
  listId: string;
  reference: string;
  label: string;
  quantity: number;
  status: "active" | "partially_returned";
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

const ISSUE_OPTIONS: { value: IssueType; label: string }[] = [
  { value: "dead_pixels", label: "Dead Pixels" },
  { value: "ic_problem", label: "IC Problem" },
  { value: "hub_card_problem", label: "Hub Card Problem" },
  { value: "damaged_pixels", label: "Damaged Pixels" },
  { value: "damaged_housing", label: "Damaged Housing" },
];

function normalizeText(v: string) {
  return v.trim().replace(/\s+/g, " ");
}

function parseLedName(name: string) {
  const clean = normalizeText(name);
  const parts = clean.split(" - ");

  if (parts.length >= 2) {
    return {
      brand: parts[0],
      model: parts.slice(1).join(" - "),
    };
  }

  const firstSpace = clean.indexOf(" ");
  if (firstSpace === -1) {
    return { brand: clean, model: "" };
  }

  return {
    brand: clean.slice(0, firstSpace),
    model: clean.slice(firstSpace + 1),
  };
}

function clampQty(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function parseCabinetArea(size: string): number {
  const clean = size.toLowerCase().replace(/,/g, ".");
  const nums = clean.match(/(\d+(\.\d+)?)/g);

  if (!nums || nums.length < 2) return 1;

  const a = Number(nums[0]);
  const b = Number(nums[1]);

  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return 1;
  }

  const sideA = a > 20 ? a / 1000 : a;
  const sideB = b > 20 ? b / 1000 : b;

  const sqm = sideA * sideB;
  return !Number.isFinite(sqm) || sqm <= 0 ? 1 : sqm;
}

function toDisplayQty(value: number, size: string, mode: QtyViewMode) {
  if (mode === "cabinet") return value;
  return value * parseCabinetArea(size);
}

function formatQty(value: number, mode: QtyViewMode) {
  if (mode === "cabinet") return String(clampQty(value));
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function unitSuffix(mode: QtyViewMode) {
  return mode === "cabinet" ? "Cabinet" : "SQM";
}

function isTechnicalIssue(type: IssueType) {
  return (
    type === "dead_pixels" ||
    type === "ic_problem" ||
    type === "hub_card_problem"
  );
}

function isCrewDamage(type: IssueType) {
  return type === "damaged_pixels" || type === "damaged_housing";
}

function getIssueLabel(type: IssueType) {
  return ISSUE_OPTIONS.find((x) => x.value === type)?.label || type;
}

function rowAvailableFromTotal(
  total: number,
  allocated: number,
  maintenance: number,
) {
  return Math.max(0, total - allocated - maintenance);
}

function allocationLabel(list: EquipmentList) {
  const type = equipmentListTypeLabel(list.list_type);
  const summary = equipmentListSummary(list);
  return summary ? `${type} · ${summary}` : type;
}

async function compressImageFile(
  file: File,
  maxSize = 900,
  quality = 0.72
): Promise<Blob> {
  const imageUrl = URL.createObjectURL(file);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to load image"));
      image.src = imageUrl;
    });

    const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1);
    const width = Math.max(1, Math.round(img.width * ratio));
    const height = Math.max(1, Math.round(img.height * ratio));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to prepare image");

    ctx.drawImage(img, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/webp", quality);
    });

    if (!blob) throw new Error("Failed to compress image");
    return blob;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

async function uploadReportPhoto(file: File): Promise<string> {
  const supabase = createClient();
  const compressed = await compressImageFile(file);

  const fileName = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.webp`;

  const filePath = `led-report/thumbs/${fileName}`;

  const { error } = await supabase.storage
    .from("equipment-photos")
    .upload(filePath, compressed, {
      contentType: "image/webp",
      cacheControl: "31536000",
      upsert: false,
    });

  if (error) throw error;

  const { data } = supabase.storage
    .from("equipment-photos")
    .getPublicUrl(filePath);

  return data.publicUrl;
}

function normalizePhotoList(input: unknown, fallback?: string | null): string[] {
  let raw: unknown[] = [];

  if (Array.isArray(input)) {
    raw = input;
  } else if (typeof input === "string" && input.trim()) {
    const value = input.trim();

    try {
      const parsed = JSON.parse(value);
      raw = Array.isArray(parsed) ? parsed : [value];
    } catch {
      raw = [value];
    }
  }

  const arr = raw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim())
    .filter((value, index, list) => list.indexOf(value) === index);

  if (arr.length > 0) return arr.slice(0, 3);
  if (fallback && typeof fallback === "string") return [fallback];
  return [];
}

export default function LedScreenReportClient({
  category,
  subcategory,
  rowId,
}: {
  category: string;
  subcategory: string;
  rowId: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const loadingRef = useRef(false);
  const editPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const editable = canEditReportForRoute(category, subcategory);

  const backHref = useMemo(() => {
    return `/inventory/${encodeURIComponent(category)}/${encodeURIComponent(
      subcategory
    )}`;
  }, [category, subcategory]);

  const activityLink = useMemo(() => {
    return `${backHref}/led-report/${encodeURIComponent(rowId)}`;
  }, [backHref, rowId]);

  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<QtyViewMode>("sqm");
  const [row, setRow] = useState<MatrixRow | null>(null);
  const [model, setModel] = useState<MatrixModel | null>(null);
  const [issues, setIssues] = useState<MaintenanceLog[]>([]);
  const [activeAllocations, setActiveAllocations] = useState<
    ActiveAllocation[]
  >([]);

  const [showAddModal, setShowAddModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const [issueType, setIssueType] = useState<IssueType>("dead_pixels");
  const [qty, setQty] = useState(1);
  const [teamName, setTeamName] = useState("");
  const [eventName, setEventName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [note, setNote] = useState("");
  const [photoList, setPhotoList] = useState<string[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [editIssueId, setEditIssueId] = useState<string | null>(null);
  const [editQty, setEditQty] = useState(1);
  const [editTeamName, setEditTeamName] = useState("");
  const [editEventName, setEditEventName] = useState("");
  const [editEventDate, setEditEventDate] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editPhotoList, setEditPhotoList] = useState<string[]>([]);
  const [editPhotoError, setEditPhotoError] = useState<string | null>(null);
  const [uploadingEditPhotos, setUploadingEditPhotos] = useState(false);
  const [sidebarTarget, setSidebarTarget] = useState<HTMLElement | null>(null);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);

  const activeAllocatedQuantity = useMemo(
    () =>
      activeAllocations.reduce(
        (total, allocation) => total + clampQty(allocation.quantity),
        0,
      ),
    [activeAllocations],
  );
  const existingMovementQty = row
    ? Math.max(
        0,
        clampQty(row.in_use_qty) +
          clampQty(row.in_ksa_qty) -
          activeAllocatedQuantity,
      )
    : 0;
  const trackedMovementQty = activeAllocatedQuantity + existingMovementQty;

  useEffect(() => {
    if (!rowId) {
      setLoading(false);
      return;
    }
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId]);

  useEffect(() => {
    setSidebarTarget(document.getElementById("right-sidebar-actions"));
  }, []);

  useEffect(() => {
    if (!editIssueId) return;

    function deselectOnOutsideClick(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (
        target.closest(
          "[data-led-report-issue='true'], [data-led-report-tools='true'], [data-led-report-mobile-tools='true'], [data-led-report-modal='true']",
        )
      ) {
        return;
      }

      setEditIssueId(null);
      setMobileToolsOpen(false);
      setEditPhotoError(null);
    }

    document.addEventListener("pointerdown", deselectOnOutsideClick);
    return () => {
      document.removeEventListener("pointerdown", deselectOnOutsideClick);
    };
  }, [editIssueId]);

  useEffect(() => {
    function refreshEquipmentMovements() {
      if (rowId) void loadActiveAllocations(rowId);
    }

    window.addEventListener(EQUIPMENT_LISTS_EVENT, refreshEquipmentMovements);
    window.addEventListener(
      EQUIPMENT_LIST_ITEMS_EVENT,
      refreshEquipmentMovements,
    );

    return () => {
      window.removeEventListener(
        EQUIPMENT_LISTS_EVENT,
        refreshEquipmentMovements,
      );
      window.removeEventListener(
        EQUIPMENT_LIST_ITEMS_EVENT,
        refreshEquipmentMovements,
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId]);

  async function loadActiveAllocations(targetRowId: string) {
    const activeListsResult = await supabase
      .from("equipment_lists")
      .select(ACTIVE_LIST_SELECT)
      .in("status", ["active", "partially_returned"])
      .order("created_at", { ascending: false })
      .limit(200);

    if (activeListsResult.error) {
      console.error(
        "load LED report active lists error",
        activeListsResult.error,
      );
      setActiveAllocations([]);
      return;
    }

    const activeLists = (activeListsResult.data ?? []) as EquipmentList[];
    const activeListIds = activeLists.map((activeList) => activeList.id);
    if (activeListIds.length === 0) {
      setActiveAllocations([]);
      return;
    }

    const itemsResult = await supabase
      .from("equipment_list_items")
      .select(
        "list_id,requested_quantity,approved_quantity,returned_ok_quantity,returned_maintenance_quantity",
      )
      .eq("inventory_record_type", "matrix_row")
      .eq("inventory_record_id", targetRowId)
      .in("list_id", activeListIds);

    if (itemsResult.error) {
      console.error(
        "load LED report active allocations error",
        itemsResult.error,
      );
      setActiveAllocations([]);
      return;
    }

    const activeListsById = new Map(
      activeLists.map((activeList) => [activeList.id, activeList]),
    );
    const allocationsByList = new Map<string, ActiveAllocation>();

    for (const item of itemsResult.data ?? []) {
      const activeList = activeListsById.get(String(item.list_id));
      if (!activeList) continue;

      const approved = clampQty(item.approved_quantity);
      const requested = clampQty(item.requested_quantity);
      const returned =
        clampQty(item.returned_ok_quantity) +
        clampQty(item.returned_maintenance_quantity);
      const quantity = Math.max(
        0,
        (approved > 0 ? approved : requested) - returned,
      );
      if (quantity === 0) continue;

      const current = allocationsByList.get(activeList.id);
      if (current) current.quantity += quantity;
      else {
        allocationsByList.set(activeList.id, {
          listId: activeList.id,
          reference: activeList.reference,
          label: allocationLabel(activeList),
          quantity,
          status:
            activeList.status === "partially_returned"
              ? "partially_returned"
              : "active",
        });
      }
    }

    setActiveAllocations(Array.from(allocationsByList.values()));
  }

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data: rowData, error: rowError } = await supabase
        .from("matrix_rows")
        .select(
          "id, model_id, size, cabinet_model, qty, available_qty, in_use_qty, maintenance_qty, in_ksa_qty, photo_data"
        )
        .eq("id", rowId)
        .single();

      if (rowError || !rowData) {
        console.error("load row error", rowError);
        setRow(null);
        setModel(null);
        setIssues([]);
        setActiveAllocations([]);
        setLoading(false);
        return;
      }

      const { data: modelData, error: modelError } = await supabase
        .from("matrix_models")
        .select("id, name")
        .eq("id", rowData.model_id)
        .single();

      if (modelError) {
        console.error("load model error", modelError);
      }

      const { data: issueRows, error: issueError } = await supabase
        .from("led_maintenance_logs")
        .select(
          "id, matrix_row_id, problem_type, qty, team_name, event_name, event_date, note, photo_data, photo_data_list, created_at, created_by"
        )
        .eq("matrix_row_id", rowId)
        .order("created_at", { ascending: false });

      if (issueError) {
        console.error("load issues error", issueError);
      }

      const normalizedIssues = ((issueRows ?? []) as any[]).map((item) => ({
        ...item,
        photo_data_list: normalizePhotoList(item.photo_data_list, item.photo_data),
      })) as MaintenanceLog[];

      setRow(rowData as MatrixRow);
      setModel((modelData ?? null) as MatrixModel | null);
      setIssues(normalizedIssues);
      await loadActiveAllocations(rowId);
    } catch (error) {
      console.error("loadData unexpected error", error);
      setRow(null);
      setModel(null);
      setIssues([]);
      setActiveAllocations([]);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  async function syncMaintenance(nextIssues: MaintenanceLog[]) {
    if (!row || !editable) return;

    const maintenanceQty = nextIssues
      .filter(
        (item) =>
          item.problem_type !== "damaged_housing" &&
          item.problem_type !== "hub_card_problem"
      )
      .reduce((sum, item) => sum + clampQty(item.qty), 0);

    const nextAvailable = rowAvailableFromTotal(
      clampQty(row.qty),
      trackedMovementQty,
      maintenanceQty,
    );

    const { error } = await supabase
      .from("matrix_rows")
      .update({
        maintenance_qty: maintenanceQty,
        available_qty: nextAvailable,
        in_use_qty: trackedMovementQty,
        in_ksa_qty: 0,
      })
      .eq("id", row.id);

    if (error) {
      console.error("sync maintenance error", error);
      return;
    }

    setRow((prev) =>
      prev
        ? {
            ...prev,
            maintenance_qty: maintenanceQty,
            available_qty: nextAvailable,
            in_use_qty: trackedMovementQty,
            in_ksa_qty: 0,
          }
        : prev
    );
  }

  function resetAddForm() {
    setIssueType("dead_pixels");
    setQty(1);
    setTeamName("");
    setEventName("");
    setEventDate("");
    setNote("");
    setPhotoList([]);
    setPhotoError(null);
  }

  const parsedName = useMemo(() => {
    return model ? parseLedName(model.name) : { brand: "", model: "" };
  }, [model]);

  const technicalIssues = useMemo(
    () => issues.filter((x) => isTechnicalIssue(x.problem_type)),
    [issues]
  );

  const crewIssues = useMemo(
    () => issues.filter((x) => isCrewDamage(x.problem_type)),
    [issues]
  );

  function openAddIssue() {
    if (!editable) return;
    setEditIssueId(null);
    setMobileToolsOpen(false);
    resetAddForm();
    setShowAddModal(true);
  }

  function closeAddIssue() {
    setShowAddModal(false);
    resetAddForm();
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editable) return;

    const files = Array.from(e.target.files || []);
    setPhotoError(null);

    if (files.length === 0) return;

    if (files.length > 3) {
      setPhotoError("Maximum 3 photos only.");
      e.target.value = "";
      return;
    }

    try {
      setPhotoError("Optimizing and uploading photos...");
      const list = await Promise.all(files.slice(0, 3).map((file) => uploadReportPhoto(file)));
      setPhotoList(list.slice(0, 3));
      setPhotoError(null);
    } catch (error) {
      console.error("photo read error", error);
      setPhotoError("Failed to read selected photo.");
    } finally {
      e.target.value = "";
    }
  }

  async function addIssue() {
    if (!editable || !row) return;

    const cleanQty = clampQty(qty);
    if (cleanQty <= 0) {
      alert("Please enter qty");
      return;
    }

    if (isCrewDamage(issueType)) {
      if (!teamName.trim()) {
        alert("Please enter team name");
        return;
      }
      if (!eventName.trim()) {
        alert("Please enter event name");
        return;
      }
      if (!eventDate.trim()) {
        alert("Please enter date");
        return;
      }
    }

    setSaving(true);

    try {
      if (isTechnicalIssue(issueType)) {
        const existingTechnicalList = issues.filter(
          (item) =>
            item.matrix_row_id === row.id &&
            item.problem_type === issueType &&
            isTechnicalIssue(item.problem_type)
        );

        if (existingTechnicalList.length > 0) {
          const baseIssue = existingTechnicalList[0];
          const duplicatedIssues = existingTechnicalList.slice(1);

          const mergedQty =
            existingTechnicalList.reduce(
              (sum, item) => sum + clampQty(item.qty),
              0
            ) + cleanQty;

          const { error: updateError } = await supabase
            .from("led_maintenance_logs")
            .update({
              qty: mergedQty,
              team_name: null,
              event_name: null,
              event_date: null,
              note: null,
              photo_data: null,
              photo_data_list: null,
              created_by: getUserName?.() || baseIssue.created_by || null,
            })
            .eq("id", baseIssue.id);

          if (updateError) {
            console.error("merge technical issue error", updateError);
            alert(updateError.message || "Failed to update issue qty");
            setSaving(false);
            return;
          }

          if (duplicatedIssues.length > 0) {
            const duplicateIds = duplicatedIssues.map((item) => item.id);

            const { error: deleteDuplicatesError } = await supabase
              .from("led_maintenance_logs")
              .delete()
              .in("id", duplicateIds);

            if (deleteDuplicatesError) {
              console.error(
                "delete duplicate technical issues error",
                deleteDuplicatesError
              );
            }
          }

          const normalizedUpdated: MaintenanceLog = {
            ...baseIssue,
            qty: mergedQty,
            team_name: null,
            event_name: null,
            event_date: null,
            note: null,
            photo_data: null,
            photo_data_list: null,
            created_by: getUserName?.() || baseIssue.created_by || null,
          };

          const remainingIssues = issues.filter(
            (item) => !existingTechnicalList.some((x) => x.id === item.id)
          );

          const nextIssues = [normalizedUpdated, ...remainingIssues];
          setIssues(nextIssues);
          await syncMaintenance(nextIssues);
          await logActivity({
            title: `updated LED report for ${model?.name || "LED Screen"}`,
            message: `${getIssueLabel(issueType)} quantity changed to ${mergedQty}`,
            link: activityLink,
          });
          setSaving(false);
          closeAddIssue();
          return;
        }

        const technicalPayload = {
          matrix_row_id: row.id,
          problem_type: issueType,
          qty: cleanQty,
          team_name: null,
          event_name: null,
          event_date: null,
          note: null,
          photo_data: null,
          photo_data_list: null,
          created_by: getUserName?.() || null,
        };

        const { data: insertedTechRows, error: insertTechError } = await supabase
          .from("led_maintenance_logs")
          .insert(technicalPayload)
          .select(
            "id, matrix_row_id, problem_type, qty, team_name, event_name, event_date, note, photo_data, photo_data_list, created_at, created_by"
          );

        if (
          insertTechError ||
          !insertedTechRows ||
          insertedTechRows.length === 0
        ) {
          console.error("insert technical issue error", insertTechError);
          alert(insertTechError?.message || "Failed to add issue");
          setSaving(false);
          return;
        }

        const insertedNormalized = {
          ...(insertedTechRows[0] as any),
          photo_data_list: normalizePhotoList(
            (insertedTechRows[0] as any)?.photo_data_list,
            (insertedTechRows[0] as any)?.photo_data
          ),
        } as MaintenanceLog;

        const nextIssues = [insertedNormalized, ...issues];
        setIssues(nextIssues);
        await syncMaintenance(nextIssues);
        await logActivity({
          title: `updated LED report for ${model?.name || "LED Screen"}`,
          message: `${getIssueLabel(issueType)} added — Qty ${cleanQty}`,
          link: activityLink,
        });
        setSaving(false);
        closeAddIssue();
        return;
      }

      const payload = {
        matrix_row_id: row.id,
        problem_type: issueType,
        qty: cleanQty,
        team_name: teamName.trim(),
        event_name: eventName.trim(),
        event_date: eventDate,
        note: note.trim() || null,
        photo_data: photoList[0] || null,
        photo_data_list: photoList.length > 0 ? photoList : null,
        created_by: getUserName?.() || null,
      };

      const { data: insertedRows, error } = await supabase
        .from("led_maintenance_logs")
        .insert(payload)
        .select(
          "id, matrix_row_id, problem_type, qty, team_name, event_name, event_date, note, photo_data, photo_data_list, created_at, created_by"
        );

      if (error || !insertedRows || insertedRows.length === 0) {
        console.error("add crew issue error", error);
        alert(error?.message || "Failed to add issue");
        setSaving(false);
        return;
      }

      const inserted = {
        ...(insertedRows[0] as any),
        photo_data_list: normalizePhotoList(
          (insertedRows[0] as any)?.photo_data_list,
          (insertedRows[0] as any)?.photo_data
        ),
      } as MaintenanceLog;

      const nextIssues = [inserted, ...issues];
      setIssues(nextIssues);
      await syncMaintenance(nextIssues);
      await logActivity({
        title: `updated LED report for ${model?.name || "LED Screen"}`,
        message: `${getIssueLabel(issueType)} added — Qty ${cleanQty}`,
        link: activityLink,
      });
      setSaving(false);
      closeAddIssue();
    } catch (error) {
      console.error("addIssue unexpected error", error);
      alert("Something went wrong");
      setSaving(false);
    }
  }

  function clearIssueSelection() {
    setEditIssueId(null);
    setMobileToolsOpen(false);
    setEditPhotoError(null);
  }

  function editIssue(issueId: string) {
    if (!editable) return;

    const issue = issues.find((x) => x.id === issueId);
    if (!issue) return;

    if (editIssueId === issueId) {
      clearIssueSelection();
      return;
    }

    setShowAddModal(false);
    resetAddForm();
    setEditIssueId(issueId);
    setEditQty(issue.qty);
    setEditTeamName(issue.team_name || "");
    setEditEventName(issue.event_name || "");
    setEditEventDate(issue.event_date || "");
    setEditNote(issue.note || "");
    setEditPhotoList(
      normalizePhotoList(issue.photo_data_list, issue.photo_data),
    );
    setEditPhotoError(null);
    setMobileToolsOpen(true);
  }

  async function onPickEditPhotos(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editable || !editIssueId) return;

    const files = Array.from(e.target.files || []);
    e.target.value = "";
    setEditPhotoError(null);

    if (files.length === 0) return;

    const remaining = Math.max(0, 3 - editPhotoList.length);
    if (remaining === 0) {
      setEditPhotoError("Maximum 3 photos only.");
      return;
    }

    if (files.length > remaining) {
      setEditPhotoError(`You can add ${remaining} more photo${remaining === 1 ? "" : "s"}.`);
      return;
    }

    setUploadingEditPhotos(true);

    try {
      const uploaded = await Promise.all(files.map(uploadReportPhoto));
      setEditPhotoList((current) => [...current, ...uploaded].slice(0, 3));
    } catch (error) {
      console.error("edit issue photo upload error", error);
      setEditPhotoError("Photo upload failed. Please try again.");
    } finally {
      setUploadingEditPhotos(false);
    }
  }

  async function updateSelectedIssue() {
    if (!editable || !editIssueId) return;

    const cleanQty = clampQty(editQty);
    if (cleanQty <= 0) {
      alert("Invalid qty");
      return;
    }

    const editorName = getUserName?.() || null;
    const editedIssue = issues.find((issue) => issue.id === editIssueId);
    if (!editedIssue) return;

    if (isCrewDamage(editedIssue.problem_type)) {
      if (!normalizeText(editTeamName)) {
        alert("Please enter team name");
        return;
      }
      if (!normalizeText(editEventName)) {
        alert("Please enter event name");
        return;
      }
      if (!editEventDate) {
        alert("Please enter date");
        return;
      }
    }

    const patch = isCrewDamage(editedIssue.problem_type)
      ? {
          qty: cleanQty,
          team_name: normalizeText(editTeamName),
          event_name: normalizeText(editEventName),
          event_date: editEventDate || null,
          note: normalizeText(editNote) || null,
          photo_data: editPhotoList[0] || null,
          photo_data_list: editPhotoList.length > 0 ? editPhotoList : null,
          created_by: editorName,
        }
      : {
          qty: cleanQty,
          created_by: editorName,
        };

    const { error } = await supabase
      .from("led_maintenance_logs")
      .update(patch)
      .eq("id", editIssueId);

    if (error) {
      alert("Update failed");
      console.error(error);
      return;
    }

    const nextIssues = issues.map((x) =>
      x.id === editIssueId
        ? {
            ...x,
            ...patch,
            photo_data_list: isCrewDamage(editedIssue.problem_type)
              ? [...editPhotoList]
              : x.photo_data_list,
          }
        : x
    ) as MaintenanceLog[];

    setIssues(nextIssues);
    await syncMaintenance(nextIssues);

    await logActivity({
      title: `updated LED report for ${model?.name || "LED Screen"}`,
      message: `${getIssueLabel(editedIssue.problem_type)} report was updated — Qty ${cleanQty}`,
      link: activityLink,
    });
  }

  async function deleteIssue(issueId: string) {
    if (!editable) return;

    const ok = confirm("Delete this issue?");
    if (!ok) return;

    const deletedIssue = issues.find((issue) => issue.id === issueId);

    const { error } = await supabase
      .from("led_maintenance_logs")
      .delete()
      .eq("id", issueId);

    if (error) {
      alert("Delete failed");
      console.error(error);
      return;
    }

    const nextIssues = issues.filter((x) => x.id !== issueId);
    setIssues(nextIssues);
    await syncMaintenance(nextIssues);

    await logActivity({
      title: `updated LED report for ${model?.name || "LED Screen"}`,
      message: `${getIssueLabel(deletedIssue?.problem_type || "dead_pixels")} issue was deleted`,
      link: activityLink,
    });

    if (editIssueId === issueId) {
      clearIssueSelection();
    }
  }

  const totalDisplay = row ? toDisplayQty(row.qty, row.size, viewMode) : 0;
  const availableDisplay = row
    ? toDisplayQty(
        rowAvailableFromTotal(
          clampQty(row.qty),
          trackedMovementQty,
          clampQty(row.maintenance_qty),
        ),
        row.size,
        viewMode,
      )
    : 0;
  const maintenanceDisplay = row
    ? toDisplayQty(row.maintenance_qty, row.size, viewMode)
    : 0;
  const selectedIssue = editIssueId
    ? issues.find((issue) => issue.id === editIssueId) || null
    : null;

  const reportToolsPanel = editable ? (
    <div
      data-led-report-tools="true"
      className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm"
    >
      {selectedIssue ? (
        <div className="space-y-3">
          <div>
            <div className="text-[13px] font-semibold text-gray-900">
              {getIssueLabel(selectedIssue.problem_type)}
            </div>
            <div className="mt-1 text-[10px] text-gray-500">
              Edit the selected report issue.
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-[10px] font-medium text-gray-600">
              Qty by Cabinet
            </span>
            <input
              type="number"
              min={1}
              value={editQty}
              onChange={(event) => setEditQty(clampQty(event.target.value))}
              className="h-10 w-full rounded-xl border border-gray-300 bg-white px-3 text-[12px] text-gray-900 outline-none focus:border-black"
            />
          </label>

          {isCrewDamage(selectedIssue.problem_type) ? (
            <>
              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-gray-600">
                  Team Name
                </span>
                <input
                  value={editTeamName}
                  onChange={(event) => setEditTeamName(event.target.value)}
                  className="h-10 w-full rounded-xl border border-gray-300 bg-white px-3 text-[12px] text-gray-900 outline-none focus:border-black"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-gray-600">
                  Event Name
                </span>
                <input
                  value={editEventName}
                  onChange={(event) => setEditEventName(event.target.value)}
                  className="h-10 w-full rounded-xl border border-gray-300 bg-white px-3 text-[12px] text-gray-900 outline-none focus:border-black"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-gray-600">
                  Date
                </span>
                <input
                  type="date"
                  value={editEventDate}
                  onChange={(event) => setEditEventDate(event.target.value)}
                  className="h-10 w-full rounded-xl border border-gray-300 bg-white px-3 text-[12px] text-gray-900 outline-none focus:border-black"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-gray-600">
                  Note
                </span>
                <textarea
                  value={editNote}
                  onChange={(event) => setEditNote(event.target.value)}
                  className="min-h-[76px] w-full resize-y rounded-xl border border-gray-300 bg-white px-3 py-2 text-[12px] text-gray-900 outline-none focus:border-black"
                />
              </label>

              <div>
                <div className="mb-1 text-[10px] font-medium text-gray-600">
                  Photos ({editPhotoList.length}/3)
                </div>

                {editPhotoList.length > 0 ? (
                  <div className="mb-2 grid grid-cols-3 gap-1.5">
                    {editPhotoList.map((src, index) => (
                      <div
                        key={`${selectedIssue.id}-tool-photo-${index}-${src}`}
                        className="relative"
                      >
                        <img
                          src={src}
                          alt={`Issue photo ${index + 1}`}
                          className="aspect-square w-full rounded-lg border border-gray-200 bg-gray-50 object-cover"
                        />
                        <button
                          type="button"
                          aria-label={`Remove photo ${index + 1}`}
                          onClick={() =>
                            setEditPhotoList((current) =>
                              current.filter((_, photoIndex) => photoIndex !== index),
                            )
                          }
                          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/75 text-[12px] leading-none text-white"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mb-2 rounded-lg border border-dashed border-gray-300 px-2 py-3 text-center text-[10px] text-gray-400">
                    No photos
                  </div>
                )}

                <button
                  type="button"
                  disabled={uploadingEditPhotos || editPhotoList.length >= 3}
                  onClick={() => editPhotoInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-[11px] font-medium text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Plus size={14} />
                  {uploadingEditPhotos ? "Uploading..." : "Add Photo"}
                </button>

                {editPhotoError ? (
                  <div className="mt-1.5 text-[10px] text-red-600">
                    {editPhotoError}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          <button
            type="button"
            disabled={uploadingEditPhotos}
            onClick={() => void updateSelectedIssue()}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-black px-3 py-2.5 text-[11px] font-medium text-white hover:bg-gray-800 disabled:opacity-40"
          >
            <Pencil size={14} /> Save Changes
          </button>

          <button
            type="button"
            onClick={() => void deleteIssue(selectedIssue.id)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[11px] font-medium text-red-700 hover:bg-red-100"
          >
            <Trash2 size={14} /> Delete Issue
          </button>
        </div>
      ) : showAddModal ? (
        <div className="space-y-3">
          <div>
            <div className="text-[13px] font-semibold text-gray-900">
              Add Issue
            </div>
            <div className="mt-1 text-[10px] text-gray-500">
              Add a manufacturing defect or handling damage report.
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-[10px] font-medium text-gray-600">
              Issue Type
            </span>
            <select
              value={issueType}
              onChange={(event) => {
                const nextType = event.target.value as IssueType;
                setIssueType(nextType);

                if (!isCrewDamage(nextType)) {
                  setTeamName("");
                  setEventName("");
                  setEventDate("");
                  setNote("");
                  setPhotoList([]);
                  setPhotoError(null);
                }
              }}
              className="h-10 w-full rounded-xl border border-gray-300 bg-white px-3 text-[12px] text-gray-900 outline-none focus:border-black"
            >
              {ISSUE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[10px] font-medium text-gray-600">
              Qty by Cabinet
            </span>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(event) => setQty(clampQty(event.target.value))}
              className="h-10 w-full rounded-xl border border-gray-300 bg-white px-3 text-[12px] text-gray-900 outline-none focus:border-black"
            />
          </label>

          {isCrewDamage(issueType) ? (
            <>
              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-gray-600">
                  Team Name
                </span>
                <input
                  value={teamName}
                  onChange={(event) => setTeamName(event.target.value)}
                  className="h-10 w-full rounded-xl border border-gray-300 bg-white px-3 text-[12px] text-gray-900 outline-none focus:border-black"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-gray-600">
                  Event Name
                </span>
                <input
                  value={eventName}
                  onChange={(event) => setEventName(event.target.value)}
                  className="h-10 w-full rounded-xl border border-gray-300 bg-white px-3 text-[12px] text-gray-900 outline-none focus:border-black"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-gray-600">
                  Date
                </span>
                <input
                  type="date"
                  value={eventDate}
                  onChange={(event) => setEventDate(event.target.value)}
                  className="h-10 w-full rounded-xl border border-gray-300 bg-white px-3 text-[12px] text-gray-900 outline-none focus:border-black"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-[10px] font-medium text-gray-600">
                  Note
                </span>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  className="min-h-[76px] w-full resize-y rounded-xl border border-gray-300 bg-white px-3 py-2 text-[12px] text-gray-900 outline-none focus:border-black"
                />
              </label>

              <div>
                <div className="mb-1 text-[10px] font-medium text-gray-600">
                  Photos (max 3)
                </div>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={onPickPhoto}
                  className="w-full rounded-xl border border-gray-300 bg-white px-2 py-2 text-[10px] text-gray-700"
                />

                {photoError ? (
                  <div className="mt-1.5 text-[10px] text-red-600">
                    {photoError}
                  </div>
                ) : null}

                {photoList.length > 0 ? (
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    {photoList.map((src, index) => (
                      <img
                        key={`${src}-${index}`}
                        src={src}
                        alt={`Selected issue photo ${index + 1}`}
                        className="aspect-square w-full rounded-lg border border-gray-200 bg-gray-50 object-cover"
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              onClick={closeAddIssue}
              className="rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void addIssue()}
              disabled={saving}
              className="rounded-xl bg-black px-3 py-2.5 text-[11px] font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Issue"}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div className="text-[13px] font-semibold text-gray-900">
            Add Report Issue
          </div>
          <div className="mt-1 text-[10px] leading-relaxed text-gray-500">
            Add a manufacturing defect or handling damage report.
          </div>
          <button
            type="button"
            onClick={openAddIssue}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-black px-3 py-2.5 text-[11px] font-medium text-white hover:bg-gray-800"
          >
            <Plus size={14} /> Add Issue
          </button>
        </div>
      )}
    </div>
  ) : (
    <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-[10px] text-gray-500">
      This report is view only for your account.
    </div>
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="w-full mx-auto space-y-3">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
            Loading...
          </div>
        </div>
      </div>
    );
  }

  if (!rowId || !row) {
    return (
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="w-full mx-auto space-y-3">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
            LED screen cabinet not found.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-3">
      <input
        ref={editPhotoInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onPickEditPhotos}
      />

      <div className="w-full mx-auto space-y-3">
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3 pb-1 pt-1">
              <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
                {row.photo_data ? (
                  <img
                    src={row.photo_data}
                    alt={`${model?.name || "LED screen"} cabinet`}
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <span className="px-2 text-center text-[9px] text-gray-400">
                    No photo
                  </span>
                )}
              </div>

              <div className="min-w-0">
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  <h1 className="text-[18px] font-semibold leading-none text-gray-900">
                    LED Report
                  </h1>
                </div>

                <div className="space-y-1 text-[10px] leading-[1.35] text-gray-900">
                  <div>
                    <span className="font-semibold">Brand :</span>{" "}
                    {parsedName.brand || "-"}
                  </div>
                  <div>
                    <span className="font-semibold">Model :</span>{" "}
                    {parsedName.model || "-"}
                  </div>
                  {row.cabinet_model ? (
                    <div>
                      <span className="font-semibold">Cabinet :</span>{" "}
                      {row.cabinet_model}
                    </div>
                  ) : null}
                  <div>
                    <span className="font-semibold">Cabinet size :</span>{" "}
                    {row.size}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col items-end gap-2 shrink-0 pt-1 pb-1">
              <Link
                href={backHref}
                className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
              >
                Back
              </Link>

              {editable ? (
                <button
                  type="button"
                  onClick={openAddIssue}
                  className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98] xl:hidden"
                >
                  Add Issue
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div className="text-[12px] font-semibold text-gray-800">Qty</div>

            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setViewMode("sqm")}
                className={`px-2.5 py-0.5 rounded-full border text-[10px] font-medium transition-all duration-150 ease-out ${
                  viewMode === "sqm"
                    ? "border-red-200 bg-red-50 text-red-700"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-red-50 hover:border-red-200 hover:text-red-700"
                }`}
              >
                SQM
              </button>

              <button
                type="button"
                onClick={() => setViewMode("cabinet")}
                className={`px-2.5 py-0.5 rounded-full border text-[10px] font-medium transition-all duration-150 ease-out ${
                  viewMode === "cabinet"
                    ? "border-red-200 bg-red-50 text-red-700"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-red-50 hover:border-red-200 hover:text-red-700"
                }`}
              >
                Cabinet
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className="px-2.5 py-1 rounded-lg bg-gray-100 text-gray-900 text-[10px] font-semibold">
              Total : {formatQty(totalDisplay, viewMode)} {unitSuffix(viewMode)}
            </span>

            <span className="px-2.5 py-1 rounded-lg bg-green-100 text-green-700 text-[10px] font-semibold">
              Available : {formatQty(availableDisplay, viewMode)}{" "}
              {unitSuffix(viewMode)}
            </span>

            {maintenanceDisplay > 0 ? (
              <span className="px-2.5 py-1 rounded-lg bg-yellow-100 text-yellow-700 text-[10px] font-semibold">
                Maintenance : {formatQty(maintenanceDisplay, viewMode)}{" "}
                {unitSuffix(viewMode)}
              </span>
            ) : null}

            {activeAllocations.map((allocation) => (
              <Link
                key={allocation.listId}
                href={`/inventory/lists/${allocation.listId}`}
                title={`${allocation.reference} · ${allocation.label}`}
                className={`max-w-full truncate rounded-lg px-2.5 py-1 text-[10px] font-semibold transition hover:opacity-80 ${
                  allocation.status === "partially_returned"
                    ? "bg-purple-100 text-purple-800"
                    : "bg-blue-100 text-blue-800"
                }`}
              >
                {formatQty(
                  toDisplayQty(allocation.quantity, row.size, viewMode),
                  viewMode,
                )}{" "}
                {unitSuffix(viewMode)} · {allocation.label}
              </Link>
            ))}

            {existingMovementQty > 0 ? (
              <span className="max-w-full truncate rounded-lg bg-gray-100 px-2.5 py-1 text-[10px] font-semibold text-gray-600">
                {formatQty(
                  toDisplayQty(existingMovementQty, row.size, viewMode),
                  viewMode,
                )}{" "}
                {unitSuffix(viewMode)} · Existing movement
              </span>
            ) : null}
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl px-5 py-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-1.5 h-1.5 bg-black rounded-full" />
            <div className="text-[13px] font-semibold text-red-700">
              Manufacturing Defect
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              Issues related to factory or product defects
            </div>
          </div>

          {technicalIssues.length === 0 ? (
            <div className="text-[12px] text-gray-400">No technical issues.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 px-1">
              {technicalIssues.map((log) => (
                <div
                  key={log.id}
                  data-led-report-issue="true"
                  role={editable ? "button" : undefined}
                  tabIndex={editable ? 0 : undefined}
                  onClick={() => editIssue(log.id)}
                  onKeyDown={(event) => {
                    if (editable && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      editIssue(log.id);
                    }
                  }}
                  className={`rounded-xl border p-3 text-left transition ${
                    editIssueId === log.id
                      ? "border-black bg-white ring-1 ring-black"
                      : "border-gray-200 bg-gray-50"
                  } ${editable ? "cursor-pointer hover:border-gray-400" : ""}`}
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-[14px] text-gray-900">
                        {getIssueLabel(log.problem_type)} : {log.qty} Cabinet
                      </div>
                      <div className="text-[11px] text-gray-500 mt-1">
                        Saved: {new Date(log.created_at).toLocaleString()} added by{" "}
                        {log.created_by || "-"}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-xl px-5 py-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-1.5 h-1.5 bg-black rounded-full" />
            <div className="text-[15px] font-semibold text-red-700">
              Handling Damage
            </div>
          </div>

          <div className="text-[12px] text-gray-700 mb-4">
            All Damage Qty :{" "}
            <span className="font-semibold">
              {crewIssues.reduce((sum, x) => sum + clampQty(x.qty), 0)} Cabinets
            </span>
          </div>

          {crewIssues.length === 0 ? (
            <div className="text-[12px] text-gray-400">No crew-caused damage.</div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {crewIssues.map((log) => {
                const photos = normalizePhotoList(log.photo_data_list, log.photo_data);

                return (
                  <div
                    key={log.id}
                    data-led-report-issue="true"
                    role={editable ? "button" : undefined}
                    tabIndex={editable ? 0 : undefined}
                    onClick={() => editIssue(log.id)}
                    onKeyDown={(event) => {
                      if (editable && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        editIssue(log.id);
                      }
                    }}
                    className={`w-full rounded-xl border p-3 text-left transition ${
                      editIssueId === log.id
                        ? "border-black bg-white ring-1 ring-black"
                        : "border-gray-200 bg-gray-50"
                    } ${editable ? "cursor-pointer hover:border-gray-400" : ""}`}
                  >
                    <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-semibold text-gray-900">
                          {getIssueLabel(log.problem_type)}
                        </div>

                        <div className="mt-2 space-y-1 text-[12px] text-gray-700 leading-snug">
                          <div>Qty by Cabinet : {log.qty}</div>
                          <div>Team : {log.team_name || "-"}</div>
                          <div>Event : {log.event_name || "-"}</div>
                          <div>Date : {log.event_date || "-"}</div>

                          {log.note ? (
                            <div className="text-[12px] text-gray-700">
                              Note : {log.note}
                            </div>
                          ) : null}

                          <div className="pt-1 text-[11px] text-gray-500">
                            Saved: {new Date(log.created_at).toLocaleString()} added by{" "}
                            {log.created_by || "-"}
                          </div>
                        </div>
                      </div>

                      <div className="flex w-full shrink-0 items-start gap-2 sm:w-auto">
                        {photos.length > 0 ? (
                          <div className="grid w-full grid-cols-3 gap-1 sm:flex sm:w-auto sm:items-center">
                            {photos.map((src, index) => (
                              <div
                                key={`${log.id}-${index}`}
                                className="aspect-square w-full overflow-hidden rounded-md border border-gray-300 bg-white sm:h-[120px] sm:w-[120px] sm:min-w-[120px]"
                              >
                                <img
                                  src={src}
                                  alt={`Issue ${index + 1}`}
                                  loading="lazy"
                                  decoding="async"
                                  className="block h-full w-full object-cover"
                                />
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {sidebarTarget ? createPortal(reportToolsPanel, sidebarTarget) : null}

      {editable && selectedIssue && mobileToolsOpen ? (
        <div
          data-led-report-mobile-tools="true"
          className="fixed inset-0 z-[9998] xl:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={`${getIssueLabel(selectedIssue.problem_type)} tools`}
        >
          <button
            type="button"
            aria-label="Close report tools"
            onClick={clearIssueSelection}
            className="absolute inset-0 bg-black/45"
          />

          <div
            className="absolute inset-x-0 bottom-0 max-h-[78dvh] overflow-y-auto rounded-t-3xl bg-gray-50 p-3 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-300" />
            {reportToolsPanel}
          </div>
        </div>
      ) : null}

      {editable && showAddModal ? (
        <div
          data-led-report-mobile-tools="true"
          className="fixed inset-0 z-[9998] xl:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Add LED report issue"
        >
          <button
            type="button"
            aria-label="Close add issue tools"
            onClick={closeAddIssue}
            className="absolute inset-0 bg-black/45"
          />

          <div
            className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-3xl bg-gray-50 p-3 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-300" />
            {reportToolsPanel}
          </div>
        </div>
      ) : null}
    </div>
  );
}

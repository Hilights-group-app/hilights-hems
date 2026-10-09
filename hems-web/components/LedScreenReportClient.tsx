"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { canEditReportForRoute, getUserName } from "@/lib/authStore";
import { logActivity } from "@/lib/activityStore";
import { Download, Pencil, Plus, Trash2 } from "lucide-react";
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
  repair_company,
  maintenance_sent_date,
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

type PdfImageAsset = {
  dataUrl: string;
  width: number;
  height: number;
};

async function loadPdfImageAsset(
  source: string | null | undefined,
  maxSide = 1200,
): Promise<PdfImageAsset | null> {
  if (!source?.trim()) return null;

  try {
    let dataUrl = source;

    if (!source.startsWith("data:image/")) {
      const response = await fetch(source, { cache: "force-cache" });
      if (!response.ok) return null;

      const blob = await response.blob();
      dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Failed to read PDF image."));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(blob);
      });
    }

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onerror = () => reject(new Error("Failed to load PDF image."));
      nextImage.onload = () => resolve(nextImage);
      nextImage.src = dataUrl;
    });

    const originalWidth = image.naturalWidth || image.width;
    const originalHeight = image.naturalHeight || image.height;
    if (!originalWidth || !originalHeight) return null;

    const scale = Math.min(
      1,
      maxSide / Math.max(originalWidth, originalHeight),
    );
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) return null;

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.9),
      width,
      height,
    };
  } catch (error) {
    console.warn("LED report PDF image could not be loaded", error);
    return null;
  }
}

function pdfImageSize(
  image: PdfImageAsset,
  maxWidth: number,
  maxHeight: number,
) {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  return {
    width: image.width * scale,
    height: image.height * scale,
  };
}

function cleanPdfFileName(value: string) {
  return (
    value
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "LED Report"
  );
}

function fitPdfText(pdf: any, value: string, maxWidth: number) {
  const clean = value.trim();
  if (!clean || pdf.getTextWidth(clean) <= maxWidth) return clean;

  let shortened = clean;
  while (
    shortened.length > 1 &&
    pdf.getTextWidth(`${shortened}...`) > maxWidth
  ) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened.trimEnd()}...`;
}

function resizeNoteField(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
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
  const [pdfExporting, setPdfExporting] = useState(false);

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

  async function downloadReportPdf() {
    if (!row || pdfExporting) return;

    setPdfExporting(true);

    try {
      const [{ jsPDF }, logo, photoEntries] = await Promise.all([
        import("jspdf"),
        loadPdfImageAsset("/logo.png", 1600),
        Promise.all(
          Array.from(
            new Set(
              [
                row.photo_data,
                ...issues.flatMap((issue) =>
                  normalizePhotoList(issue.photo_data_list, issue.photo_data),
                ),
              ].filter((source): source is string => Boolean(source?.trim())),
            ),
          ).map(async (source) => [
            source,
            await loadPdfImageAsset(source),
          ] as const),
        ),
      ]);

      const imageBySource = new Map<string, PdfImageAsset>();
      for (const [source, image] of photoEntries) {
        if (image) imageBySource.set(source, image);
      }

      const pdf = new jsPDF({
        orientation: "portrait",
        unit: "mm",
        format: "a4",
        compress: true,
      });

      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 12;
      const contentWidth = pageWidth - margin * 2;
      const contentTop = 28;
      const contentBottom = pageHeight - 15;
      let cursorY = contentTop;

      function drawPageHeader() {
        pdf.setFillColor(255, 255, 255);
        pdf.rect(0, 0, pageWidth, 25, "F");

        if (logo) {
          const logoSize = pdfImageSize(logo, 43, 9);
          pdf.addImage(
            logo.dataUrl,
            "JPEG",
            margin,
            7,
            logoSize.width,
            logoSize.height,
          );
        } else {
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(12);
          pdf.setTextColor(20, 20, 20);
          pdf.text("HILIGHTS GROUP", margin, 13);
        }

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(10);
        pdf.setTextColor(25, 25, 25);
        pdf.text("LED SCREEN REPORT", pageWidth - margin, 11, {
          align: "right",
        });

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(7);
        pdf.setTextColor(110, 110, 110);
        pdf.text(
          fitPdfText(
            pdf,
            [parsedName.brand, parsedName.model].filter(Boolean).join(" ") ||
              "LED Screen",
            76,
          ),
          pageWidth - margin,
          17,
          { align: "right" },
        );

        pdf.setDrawColor(225, 225, 225);
        pdf.line(margin, 23, pageWidth - margin, 23);
        cursorY = contentTop;
      }

      function addPage() {
        pdf.addPage();
        drawPageHeader();
      }

      function ensureSpace(height: number) {
        if (cursorY + height > contentBottom) addPage();
      }

      drawPageHeader();

      // Equipment header card -------------------------------------------------
      const equipmentCardHeight = 37;
      ensureSpace(equipmentCardHeight);
      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(224, 224, 224);
      pdf.roundedRect(
        margin,
        cursorY,
        contentWidth,
        equipmentCardHeight,
        3,
        3,
        "FD",
      );

      const equipmentImageX = margin + 5;
      const equipmentImageY = cursorY + 4.5;
      const equipmentImageBox = 28;
      pdf.setFillColor(249, 250, 251);
      pdf.setDrawColor(225, 225, 225);
      pdf.roundedRect(
        equipmentImageX,
        equipmentImageY,
        equipmentImageBox,
        equipmentImageBox,
        2,
        2,
        "FD",
      );

      const equipmentImage = row.photo_data
        ? imageBySource.get(row.photo_data)
        : null;
      if (equipmentImage) {
        const imageSize = pdfImageSize(
          equipmentImage,
          equipmentImageBox - 3,
          equipmentImageBox - 3,
        );
        pdf.addImage(
          equipmentImage.dataUrl,
          "JPEG",
          equipmentImageX + (equipmentImageBox - imageSize.width) / 2,
          equipmentImageY + (equipmentImageBox - imageSize.height) / 2,
          imageSize.width,
          imageSize.height,
        );
      } else {
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(6.5);
        pdf.setTextColor(165, 165, 165);
        pdf.text(
          "No photo",
          equipmentImageX + equipmentImageBox / 2,
          equipmentImageY + equipmentImageBox / 2 + 1,
          { align: "center" },
        );
      }

      const equipmentTextX = equipmentImageX + equipmentImageBox + 6;
      pdf.setFillColor(239, 68, 68);
      pdf.circle(equipmentTextX, cursorY + 8, 0.9, "F");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(12);
      pdf.setTextColor(25, 25, 25);
      pdf.text("LED Report", equipmentTextX + 3, cursorY + 9.2);

      const detailRows = [
        ["Brand", parsedName.brand || "-"],
        ["Model", parsedName.model || "-"],
        ...(row.cabinet_model
          ? [["Cabinet", row.cabinet_model] as [string, string]]
          : []),
        ["Cabinet size", row.size || "-"],
      ] as [string, string][];

      let detailY = cursorY + 16;
      for (const [label, value] of detailRows) {
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(7.2);
        pdf.setTextColor(55, 55, 55);
        pdf.text(`${label}:`, equipmentTextX, detailY);
        const labelWidth = pdf.getTextWidth(`${label}: `);
        pdf.setFont("helvetica", "normal");
        pdf.text(
          fitPdfText(
            pdf,
            value,
            pageWidth - margin - equipmentTextX - labelWidth - 5,
          ),
          equipmentTextX + labelWidth,
          detailY,
        );
        detailY += 4.3;
      }
      cursorY += equipmentCardHeight + 3;

      // Quantity card ---------------------------------------------------------
      type PdfChip = {
        text: string;
        fill: [number, number, number];
        color: [number, number, number];
      };

      const quantityChips: PdfChip[] = [
        {
          text: `Total: ${formatQty(totalDisplay, viewMode)} ${unitSuffix(viewMode)}`,
          fill: [243, 244, 246],
          color: [31, 41, 55],
        },
        {
          text: `Available: ${formatQty(availableDisplay, viewMode)} ${unitSuffix(viewMode)}`,
          fill: [220, 252, 231],
          color: [21, 128, 61],
        },
      ];

      if (maintenanceDisplay > 0) {
        quantityChips.push({
          text: `Maintenance: ${formatQty(maintenanceDisplay, viewMode)} ${unitSuffix(viewMode)}`,
          fill: [254, 249, 195],
          color: [161, 98, 7],
        });
      }

      for (const allocation of activeAllocations) {
        quantityChips.push({
          text: `${formatQty(
            toDisplayQty(allocation.quantity, row.size, viewMode),
            viewMode,
          )} ${unitSuffix(viewMode)} - ${allocation.label}`,
          fill:
            allocation.status === "partially_returned"
              ? [243, 232, 255]
              : [219, 234, 254],
          color:
            allocation.status === "partially_returned"
              ? [107, 33, 168]
              : [30, 64, 175],
        });
      }

      if (existingMovementQty > 0) {
        quantityChips.push({
          text: `${formatQty(
            toDisplayQty(existingMovementQty, row.size, viewMode),
            viewMode,
          )} ${unitSuffix(viewMode)} - Existing movement`,
          fill: [243, 244, 246],
          color: [75, 85, 99],
        });
      }

      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(7.2);
      const chipLayouts: Array<PdfChip & { x: number; row: number; width: number }> = [];
      const chipsLeft = margin + 5;
      const chipsRight = pageWidth - margin - 5;
      let chipX = chipsLeft;
      let chipRow = 0;

      for (const chip of quantityChips) {
        const displayText = fitPdfText(pdf, chip.text, 82);
        const width = Math.min(86, pdf.getTextWidth(displayText) + 7);
        if (chipX + width > chipsRight && chipX > chipsLeft) {
          chipRow += 1;
          chipX = chipsLeft;
        }
        chipLayouts.push({ ...chip, text: displayText, x: chipX, row: chipRow, width });
        chipX += width + 2;
      }

      const quantityCardHeight = 15 + (chipRow + 1) * 8;
      ensureSpace(quantityCardHeight);
      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(224, 224, 224);
      pdf.roundedRect(
        margin,
        cursorY,
        contentWidth,
        quantityCardHeight,
        3,
        3,
        "FD",
      );
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(8);
      pdf.setTextColor(55, 65, 81);
      pdf.text("Qty", margin + 5, cursorY + 7.5);

      for (const chip of chipLayouts) {
        const chipY = cursorY + 11 + chip.row * 8;
        pdf.setFillColor(chip.fill[0], chip.fill[1], chip.fill[2]);
        pdf.roundedRect(chip.x, chipY, chip.width, 5.5, 1.4, 1.4, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(7.2);
        pdf.setTextColor(chip.color[0], chip.color[1], chip.color[2]);
        pdf.text(chip.text, chip.x + 3.5, chipY + 3.75);
      }
      cursorY += quantityCardHeight + 3;

      // Manufacturing defects ------------------------------------------------
      const technicalColumns = 3;
      const technicalGap = 3;
      const technicalInnerWidth = contentWidth - 10;
      const technicalCardWidth =
        (technicalInnerWidth - technicalGap * (technicalColumns - 1)) /
        technicalColumns;
      const technicalCardHeight = 21;
      const technicalRows = Math.max(
        1,
        Math.ceil(technicalIssues.length / technicalColumns),
      );
      const technicalSectionHeight =
        16 +
        (technicalIssues.length > 0
          ? technicalRows * technicalCardHeight +
            (technicalRows - 1) * technicalGap
          : 8) +
        5;

      ensureSpace(technicalSectionHeight);
      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(224, 224, 224);
      pdf.roundedRect(
        margin,
        cursorY,
        contentWidth,
        technicalSectionHeight,
        3,
        3,
        "FD",
      );
      pdf.setFillColor(20, 20, 20);
      pdf.circle(margin + 5.5, cursorY + 7, 0.9, "F");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9);
      pdf.setTextColor(185, 28, 28);
      pdf.text("Manufacturing Defect", margin + 9, cursorY + 8);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(6.8);
      pdf.setTextColor(110, 110, 110);
      pdf.text(
        "Issues related to factory or product defects",
        margin + 49,
        cursorY + 8,
      );

      if (technicalIssues.length === 0) {
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8);
        pdf.setTextColor(160, 160, 160);
        pdf.text("No technical issues.", margin + 5, cursorY + 19);
      } else {
        technicalIssues.forEach((issue, index) => {
          const column = index % technicalColumns;
          const itemRow = Math.floor(index / technicalColumns);
          const x =
            margin + 5 + column * (technicalCardWidth + technicalGap);
          const y =
            cursorY + 14 + itemRow * (technicalCardHeight + technicalGap);

          pdf.setFillColor(249, 250, 251);
          pdf.setDrawColor(226, 228, 232);
          pdf.roundedRect(
            x,
            y,
            technicalCardWidth,
            technicalCardHeight,
            2,
            2,
            "FD",
          );
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(8.2);
          pdf.setTextColor(30, 30, 30);
          pdf.text(
            fitPdfText(
              pdf,
              `${getIssueLabel(issue.problem_type)}: ${issue.qty} Cabinet`,
              technicalCardWidth - 6,
            ),
            x + 3,
            y + 6.5,
          );

          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(6.2);
          pdf.setTextColor(115, 115, 115);
          const savedLines = pdf
            .splitTextToSize(
              `Saved: ${new Date(issue.created_at).toLocaleString()} - added by ${
                issue.created_by || "-"
              }`,
              technicalCardWidth - 6,
            )
            .slice(0, 2);
          pdf.text(savedLines, x + 3, y + 12);
        });
      }
      cursorY += technicalSectionHeight + 3;

      // Handling damage -------------------------------------------------------
      ensureSpace(20);
      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(224, 224, 224);
      pdf.roundedRect(margin, cursorY, contentWidth, 18, 3, 3, "FD");
      pdf.setFillColor(20, 20, 20);
      pdf.circle(margin + 5.5, cursorY + 6.2, 0.9, "F");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(9.5);
      pdf.setTextColor(185, 28, 28);
      pdf.text("Handling Damage", margin + 9, cursorY + 7.2);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7.5);
      pdf.setTextColor(75, 75, 75);
      pdf.text(
        `All Damage Qty: ${crewIssues.reduce(
          (sum, issue) => sum + clampQty(issue.qty),
          0,
        )} Cabinets`,
        margin + 5,
        cursorY + 13,
      );
      cursorY += 21;

      if (crewIssues.length === 0) {
        ensureSpace(16);
        pdf.setFillColor(249, 250, 251);
        pdf.setDrawColor(226, 228, 232);
        pdf.roundedRect(margin, cursorY, contentWidth, 14, 3, 3, "FD");
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8);
        pdf.setTextColor(160, 160, 160);
        pdf.text("No crew-caused damage.", margin + 5, cursorY + 8.5);
        cursorY += 17;
      } else {
        for (const issue of crewIssues) {
          const sourcePhotos = normalizePhotoList(
            issue.photo_data_list,
            issue.photo_data,
          );
          const issuePhotos = sourcePhotos
            .map((source) => imageBySource.get(source))
            .filter((image): image is PdfImageAsset => Boolean(image));

          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(7.2);
          const noteLines = issue.note
            ? (pdf.splitTextToSize(`Note: ${issue.note}`, 71) as string[])
            : [];
          const visibleNoteLines = noteLines.slice(0, 18);
          if (noteLines.length > visibleNoteLines.length) {
            const last = visibleNoteLines.length - 1;
            visibleNoteLines[last] = fitPdfText(
              pdf,
              `${visibleNoteLines[last]}...`,
              71,
            );
          }

          pdf.setFontSize(6.4);
          const savedLines = (
            pdf.splitTextToSize(
              `Saved: ${new Date(issue.created_at).toLocaleString()} - added by ${
                issue.created_by || "-"
              }`,
              71,
            ) as string[]
          ).slice(0, 2);

          const detailsHeight =
            11 + 4 * 4 + visibleNoteLines.length * 3.5 + savedLines.length * 3.2 + 4;
          const photoAreaWidth = 98;
          const photoGap = 3;
          const maxPhotoWidth = issuePhotos.length
            ? Math.min(
                46,
                (photoAreaWidth - photoGap * (issuePhotos.length - 1)) /
                  issuePhotos.length,
              )
            : 0;
          const photoSizes = issuePhotos.map((image) =>
            pdfImageSize(image, maxPhotoWidth, 36),
          );
          const photoHeight = photoSizes.reduce(
            (maximum, size) => Math.max(maximum, size.height),
            0,
          );
          const damageCardHeight = Math.max(
            34,
            detailsHeight,
            photoHeight > 0 ? photoHeight + 12 : 0,
          );

          ensureSpace(damageCardHeight + 3);
          const damageCardY = cursorY;
          pdf.setFillColor(249, 250, 251);
          pdf.setDrawColor(226, 228, 232);
          pdf.roundedRect(
            margin,
            damageCardY,
            contentWidth,
            damageCardHeight,
            3,
            3,
            "FD",
          );

          const textX = margin + 5;
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(9);
          pdf.setTextColor(30, 30, 30);
          pdf.text(getIssueLabel(issue.problem_type), textX, damageCardY + 7);

          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(7.2);
          pdf.setTextColor(65, 65, 65);
          let lineY = damageCardY + 13;
          const damageDetails = [
            `Qty by Cabinet: ${issue.qty}`,
            `Team: ${issue.team_name || "-"}`,
            `Event: ${issue.event_name || "-"}`,
            `Date: ${issue.event_date || "-"}`,
          ];
          for (const detail of damageDetails) {
            pdf.text(fitPdfText(pdf, detail, 71), textX, lineY);
            lineY += 4;
          }

          if (visibleNoteLines.length > 0) {
            pdf.text(visibleNoteLines, textX, lineY);
            lineY += visibleNoteLines.length * 3.5 + 1;
          }

          pdf.setFontSize(6.4);
          pdf.setTextColor(120, 120, 120);
          pdf.text(savedLines, textX, lineY);

          if (issuePhotos.length > 0) {
            const totalPhotoWidth =
              photoSizes.reduce((sum, size) => sum + size.width, 0) +
              photoGap * (photoSizes.length - 1);
            let photoX = pageWidth - margin - 5 - totalPhotoWidth;

            issuePhotos.forEach((image, index) => {
              const size = photoSizes[index];
              const photoY = damageCardY + 6;

              // The border follows the real photo ratio. A 16:9 photo therefore
              // stays 16:9 instead of being cropped into a square.
              pdf.setFillColor(255, 255, 255);
              pdf.setDrawColor(210, 210, 210);
              pdf.roundedRect(
                photoX - 0.7,
                photoY - 0.7,
                size.width + 1.4,
                size.height + 1.4,
                1.2,
                1.2,
                "FD",
              );
              pdf.addImage(
                image.dataUrl,
                "JPEG",
                photoX,
                photoY,
                size.width,
                size.height,
              );
              photoX += size.width + photoGap;
            });
          }

          cursorY += damageCardHeight + 3;
        }
      }

      const pageCount = pdf.getNumberOfPages();
      for (let page = 1; page <= pageCount; page += 1) {
        pdf.setPage(page);
        pdf.setDrawColor(225, 225, 225);
        pdf.line(margin, pageHeight - 10.5, pageWidth - margin, pageHeight - 10.5);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(6.5);
        pdf.setTextColor(120, 120, 120);
        pdf.text(
          "Hilights Group - Equipment Management System",
          margin,
          pageHeight - 6.5,
        );
        pdf.text(`Page ${page} of ${pageCount}`, pageWidth - margin, pageHeight - 6.5, {
          align: "right",
        });
      }

      const fileLabel = cleanPdfFileName(
        [
          "LED Report",
          parsedName.brand,
          parsedName.model,
          row.cabinet_model || row.size,
        ]
          .filter(Boolean)
          .join(" - "),
      );
      pdf.save(`${fileLabel}.pdf`);
    } catch (error) {
      console.error("download LED report PDF error", error);
      alert("Failed to create the LED report PDF.");
    } finally {
      setPdfExporting(false);
    }
  }

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
                  ref={resizeNoteField}
                  value={editNote}
                  onChange={(event) => setEditNote(event.target.value)}
                  onInput={(event) => resizeNoteField(event.currentTarget)}
                  className="min-h-[76px] w-full resize-none overflow-hidden whitespace-pre-wrap break-words rounded-xl border border-gray-300 bg-white px-3 py-2 text-[12px] text-gray-900 outline-none focus:border-black [field-sizing:content]"
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
                          className="aspect-video w-full rounded-lg border border-gray-200 bg-white object-contain"
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
                  ref={resizeNoteField}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  onInput={(event) => resizeNoteField(event.currentTarget)}
                  className="min-h-[76px] w-full resize-none overflow-hidden whitespace-pre-wrap break-words rounded-xl border border-gray-300 bg-white px-3 py-2 text-[12px] text-gray-900 outline-none focus:border-black [field-sizing:content]"
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
                        className="aspect-video w-full rounded-lg border border-gray-200 bg-white object-contain"
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
      <div className="min-h-screen min-w-0 overflow-x-hidden bg-gray-50 p-3">
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
      <div className="min-h-screen min-w-0 overflow-x-hidden bg-gray-50 p-3">
        <div className="w-full mx-auto space-y-3">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
            LED screen cabinet not found.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen min-w-0 overflow-x-hidden bg-gray-50 p-2 sm:p-3">
      <input
        ref={editPhotoInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onPickEditPhotos}
      />

      <div className="mx-auto w-full min-w-0 space-y-3">
        <div className="rounded-xl border border-gray-200 bg-white px-3 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)] sm:px-5 sm:py-6">
          <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-start sm:justify-between">
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

            <div
              data-pdf-ignore="true"
              className="flex w-full shrink-0 flex-row flex-wrap items-center justify-end gap-2 pb-1 pt-1 sm:w-auto sm:flex-col sm:items-end"
            >
              <button
                type="button"
                onClick={() => void downloadReportPdf()}
                disabled={pdfExporting}
                className="flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[10px] font-medium text-gray-700 transition-all duration-150 ease-out hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-sm active:scale-[0.98] disabled:cursor-wait disabled:opacity-50"
              >
                <Download size={11} />
                {pdfExporting ? "Preparing..." : "Download PDF"}
              </button>

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
                            <div className="whitespace-pre-wrap break-words text-[12px] text-gray-700">
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
                          <div className="flex w-full flex-wrap items-start gap-2 sm:w-auto sm:justify-end">
                            {photos.map((src, index) => (
                              <div
                                key={`${log.id}-${index}`}
                                className="w-full max-w-full overflow-hidden rounded-md border border-gray-300 bg-white sm:w-auto sm:max-w-[240px]"
                              >
                                <img
                                  src={src}
                                  alt={`Issue ${index + 1}`}
                                  loading="lazy"
                                  decoding="async"
                                  className="block h-auto max-h-[180px] w-full object-contain sm:w-auto sm:max-w-[240px]"
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

"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  canEditInventory,
  canEditReportForRoute,
  canManageEquipmentLists,
  canReorderInventory,
  getUserId,
} from "@/lib/authStore";
import { logActivity } from "@/lib/activityStore";
import { ChevronDown, Trash2 } from "lucide-react";
import EquipmentListQuantityPicker from "@/components/EquipmentListQuantityPicker";
import {
  ACTIVE_EQUIPMENT_LIST_EVENT,
  ACTIVE_EQUIPMENT_LIST_KEY,
  EQUIPMENT_LIST_ITEMS_EVENT,
  EQUIPMENT_LISTS_EVENT,
  equipmentListSummary,
  equipmentListTypeLabel,
  type EquipmentList,
} from "@/lib/equipmentLists";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

type MatrixRow = {
  id: string;
  model_id: string;
  size: string;
  cabinet_model?: string | null;
  qty: number;
  available_qty: number;
  in_use_qty: number;
  maintenance_qty: number;
  in_ksa_qty: number;
  photo_data?: string | null;
  sort_order?: number | null;
};

type MatrixModel = {
  id: string;
  category_id: string;
  subcategory_id: string;
  name: string;
  matrix_rows?: MatrixRow[];
  created_at?: string;
  sort_order?: number | null;
};

type ParsedLedName = {
  brand: string;
  model: string;
};

type OnlineImage = {
  title?: string;
  image?: string;
  original?: string;
  thumbnail?: string;
};

type PhotoTarget =
  | { type: "new" }
  | { type: "addCabinet" }
  | { type: "row"; rowId: string };

type ActiveAllocation = {
  listId: string;
  reference: string;
  label: string;
  quantity: number;
  status: "active" | "partially_returned";
  listType: EquipmentList["list_type"];
};

type ListPickerTarget = {
  model: MatrixModel;
  row: MatrixRow;
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
  created_by,
  created_by_name,
  created_at,
  updated_at
`;

function clampQty(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function normalizeText(v: string) {
  return v.trim().replace(/\s+/g, " ");
}

async function compressImageFile(
  file: File,
  maxSize = 260,
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

async function uploadPhotoBlob(blob: Blob): Promise<string> {
  const supabase = useMemo(() => createClient(), []);

  const fileName = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.webp`;

  const filePath = `led-screen/thumbs/${fileName}`;

  const { error } = await supabase.storage
    .from("equipment-photos")
    .upload(filePath, blob, {
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

async function uploadPhoto(file: File): Promise<string> {
  const compressed = await compressImageFile(file);
  return uploadPhotoBlob(compressed);
}

function parseLedName(name: string): ParsedLedName {
  const clean = normalizeText(name);
  const parts = clean.split(" - ");

  if (parts.length >= 2) {
    return {
      brand: normalizeText(parts[0]),
      model: normalizeText(parts.slice(1).join(" - ")),
    };
  }

  const firstSpace = clean.indexOf(" ");
  if (firstSpace === -1) return { brand: clean, model: "" };

  return {
    brand: normalizeText(clean.slice(0, firstSpace)),
    model: normalizeText(clean.slice(firstSpace + 1)),
  };
}

function buildLedName(brand: string, model: string) {
  const b = normalizeText(brand);
  const m = normalizeText(model);

  if (!b && !m) return "";
  if (!m) return b;
  if (!b) return m;

  return `${b} - ${m}`;
}

function rowAvailableFromTotal(
  total: number,
  allocated: number,
  maintenance: number,
) {
  return Math.max(0, total - allocated - maintenance);
}

function existingMovementQuantity(row: MatrixRow, activeAllocated: number) {
  return Math.max(
    0,
    clampQty(row.in_use_qty) + clampQty(row.in_ksa_qty) - activeAllocated,
  );
}

function allocationLabel(list: EquipmentList) {
  const type = equipmentListTypeLabel(list.list_type);
  const summary = equipmentListSummary(list);
  return summary ? `${type} · ${summary}` : type;
}

function movementAllocationQuantity(allocations: ActiveAllocation[]) {
  return allocations.reduce(
    (total, allocation) =>
      allocation.listType === "maintenance"
        ? total
        : total + clampQty(allocation.quantity),
    0,
  );
}

function maintenanceAllocationQuantity(allocations: ActiveAllocation[]) {
  return allocations.reduce(
    (total, allocation) =>
      allocation.listType === "maintenance"
        ? total + clampQty(allocation.quantity)
        : total,
    0,
  );
}

function parseCabinetArea(size: string): number {
  const clean = size.toLowerCase().replace(/,/g, ".");
  const nums = clean.match(/(\d+(\.\d+)?)/g);

  if (!nums || nums.length < 2) return 1;

  const a = Number(nums[0]);
  const b = Number(nums[1]);

  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 1;

  const sideA = a > 20 ? a / 1000 : a;
  const sideB = b > 20 ? b / 1000 : b;

  const sqm = sideA * sideB;
  if (!Number.isFinite(sqm) || sqm <= 0) return 1;

  return sqm;
}

function toSqm(cabinets: number, size: string) {
  return cabinets * parseCabinetArea(size);
}

function formatSqm(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}
function sortRows(rows?: MatrixRow[]) {
  return [...(rows ?? [])].sort((a, b) => {
    const ao = typeof a.sort_order === "number" ? a.sort_order : 999999;
    const bo = typeof b.sort_order === "number" ? b.sort_order : 999999;
    return ao - bo;
  });
}

function sortModels(models?: MatrixModel[]) {
  return [...(models ?? [])].sort((a, b) => {
    const ao = typeof a.sort_order === "number" ? a.sort_order : 999999;
    const bo = typeof b.sort_order === "number" ? b.sort_order : 999999;
    if (ao !== bo) return ao - bo;
    return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
  });
}


function SmallStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "gray" | "green" | "blue" | "yellow" | "purple";
}) {
  const cls =
    tone === "gray"
      ? "bg-gray-100"
      : tone === "green"
      ? "bg-green-100"
      : tone === "blue"
      ? "bg-blue-100"
      : tone === "yellow"
      ? "bg-yellow-100"
      : "bg-purple-100";

  return (
    <span
      className={`rounded-lg px-2 py-1 text-[8px] font-semibold text-black whitespace-nowrap ${cls}`}
    >
      {label}: {formatSqm(value)} SQM
    </span>
  );
}

function MobileStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "gray" | "green" | "blue" | "yellow" | "purple";
}) {
  const cls =
    tone === "gray"
      ? "bg-gray-100"
      : tone === "green"
      ? "bg-green-100"
      : tone === "blue"
      ? "bg-blue-100"
      : tone === "yellow"
      ? "bg-yellow-100"
      : "bg-purple-100";

  return (
    <div className="text-center">
      <div className="mb-1 truncate text-[8px] font-semibold text-gray-500">
        {label}
      </div>
      <div className={`rounded-md px-[1px] py-0.5 text-[6px] font-semibold text-black whitespace-nowrap ${cls}`}>
        {formatSqm(value)} SQM
      </div>
    </div>
  );
}

function ModelMobileStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "gray" | "green" | "blue" | "yellow" | "purple";
}) {
  const cls =
    tone === "gray"
      ? "border-gray-200 bg-gray-50 text-gray-900"
      : tone === "green"
      ? "border-green-200 bg-green-50 text-green-950"
      : tone === "blue"
      ? "border-blue-200 bg-blue-50 text-blue-950"
      : tone === "yellow"
      ? "border-yellow-200 bg-yellow-50 text-yellow-950"
      : "border-purple-200 bg-purple-50 text-purple-950";

  return (
    <div className={`rounded-xl border px-2 py-1.5 text-center ${cls}`}>
      <div className="truncate text-[8px] font-bold uppercase tracking-wide opacity-70">
        {label}
      </div>
      <div className="mt-0.5 whitespace-nowrap text-[9px] font-black leading-none">
        {formatSqm(value)} SQM
      </div>
    </div>
  );
}

function PhotoBox({
  photo,
  name,
  editable,
  menuOpen,
  onToggleMenu,
  onUploadPhoto,
  onSearchPhoto,
}: {
  photo?: string | null;
  name: string;
  editable?: boolean;
  menuOpen?: boolean;
  onToggleMenu?: () => void;
  onUploadPhoto?: () => void;
  onSearchPhoto?: () => void;
}) {
  return (
    <div className="relative flex h-11 w-11 min-w-[44px] items-center justify-center rounded-xl bg-white">
      {photo ? (
        <img
          src={photo}
          alt={name}
          loading="lazy"
          decoding="async"
          className="h-full w-full rounded-xl object-cover bg-white"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-xl bg-white text-[10px] text-gray-400">
          No photo
        </div>
      )}

      {editable ? (
        <div className="absolute right-0 top-0 z-[9999]" data-led-photo-menu="true">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onToggleMenu?.();
            }}
            className="flex h-4 w-4 items-center justify-center rounded-full bg-white/90 text-[10px] text-red-500 shadow hover:text-black"
            title="Photo options"
          >
            ✎
          </button>

          {menuOpen ? (
            <div className="absolute right-0 top-full z-[99999] mt-1 ... w-36 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onUploadPhoto?.();
                }}
                className="block w-full px-3 py-2 text-left text-[11px] text-gray-700 hover:bg-gray-50"
              >
                Upload photo
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSearchPhoto?.();
                }}
                className="block w-full px-3 py-2 text-left text-[11px] text-gray-700 hover:bg-gray-50"
              >
                Search photo
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function SubcategoryClientLedScreen({
  categoryId,
  subcategoryId,
}: {
  categoryId: string | null;
  subcategoryId: string | null;
}) {
  const supabase = createClient();
  const editable = canEditInventory();
  const reorderable = canReorderInventory();
  const pathname = usePathname();

  const getReportHref = (rowId: string) => {
    const basePath = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    return `${basePath}/led-report/${encodeURIComponent(rowId)}`;
  };

  const routeSlugs = useMemo(() => {
    const parts = pathname.split("/").filter(Boolean);
    return {
      category: decodeURIComponent(parts[1] || ""),
      subcategory: decodeURIComponent(parts[2] || ""),
    };
  }, [pathname]);

  const newPhotoFileRef = useRef<HTMLInputElement | null>(null);
  const addCabinetPhotoFileRef = useRef<HTMLInputElement | null>(null);
  const rowPhotoFileRef = useRef<HTMLInputElement | null>(null);

  const [models, setModels] = useState<MatrixModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState("");

  const [resolvedCategoryId, setResolvedCategoryId] = useState<string | null>(
    categoryId ?? null
  );

  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [cabinetSize, setCabinetSize] = useState("");
  const [totalQtyInput, setTotalQtyInput] = useState(0);
  const [newPhoto, setNewPhoto] = useState<string | null>(null);

  const [openModelId, setOpenModelId] = useState<string | null>(null);

  const [addingModelId, setAddingModelId] = useState<string | null>(null);
  const [addCabinetSize, setAddCabinetSize] = useState("");
  const [addCabinetModel, setAddCabinetModel] = useState("");
  const [addCabinetQty, setAddCabinetQty] = useState(0);
  const [addCabinetPhoto, setAddCabinetPhoto] = useState<string | null>(null);
  const [savingAddCabinet, setSavingAddCabinet] = useState(false);

  const [addPhotoMenuOpen, setAddPhotoMenuOpen] = useState(false);
  const [addCabinetPhotoMenuOpen, setAddCabinetPhotoMenuOpen] = useState(false);
  const [rowPhotoMenuId, setRowPhotoMenuId] = useState<string | null>(null);
  const [photoTarget, setPhotoTarget] = useState<PhotoTarget | null>(null);

  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [imageSearch, setImageSearch] = useState("");
  const [imageResults, setImageResults] = useState<OnlineImage[]>([]);
  const [searchingImages, setSearchingImages] = useState(false);
  const [sidebarTarget, setSidebarTarget] = useState<HTMLElement | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedModelBrand, setSelectedModelBrand] = useState("");
  const [selectedModelName, setSelectedModelName] = useState("");
  const [mobileAddOpen, setMobileAddOpen] = useState(false);
  const [activeEquipmentList, setActiveEquipmentList] =
    useState<EquipmentList | null>(null);
  const [listPickerTarget, setListPickerTarget] =
    useState<ListPickerTarget | null>(null);
  const [allocationsByRow, setAllocationsByRow] = useState<
    Record<string, ActiveAllocation[]>
  >({});
  const modelSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const selectedCabinetInfo = useMemo(() => {
    for (const currentModel of models) {
      const row = (currentModel.matrix_rows ?? []).find(
        (currentRow) => currentRow.id === selectedRowId
      );
      if (row) return { model: currentModel, row };
    }
    return null;
  }, [models, selectedRowId]);

  const selectedModel =
    models.find((currentModel) => currentModel.id === selectedModelId) ?? null;

  const activeDraftList = activeEquipmentList;

  function rowAllocatedQuantity(rowId: string) {
    return movementAllocationQuantity(allocationsByRow[rowId] ?? []);
  }

  function rowMaintenanceRepairQuantity(rowId: string) {
    return maintenanceAllocationQuantity(allocationsByRow[rowId] ?? []);
  }

  useEffect(() => {
    const parsed = parseLedName(selectedModel?.name ?? "");
    setSelectedModelBrand(parsed.brand);
    setSelectedModelName(parsed.model);
  }, [selectedModelId, selectedModel?.name]);

  useEffect(() => {
    if (selectedModelId || selectedRowId || photoTarget?.type !== "row") return;

    setSearchPanelOpen(false);
    setImageResults([]);
    setImageSearch("");
    setSearchingImages(false);
    setPhotoTarget(null);
  }, [selectedModelId, selectedRowId, photoTarget?.type]);

  async function resolveCategoryId(subId: string) {
    if (categoryId) {
      setResolvedCategoryId(categoryId);
      return categoryId;
    }

    const { data, error } = await supabase
      .from("subcategories")
      .select("category_id")
      .eq("id", subId)
      .single();

    if (error || !data?.category_id) {
      throw new Error("Failed to resolve category for this LED screen subcategory.");
    }

    setResolvedCategoryId(data.category_id as string);
    return data.category_id as string;
  }

  async function loadActiveAllocations(nextModels: MatrixModel[]) {
    const rowIds = nextModels.flatMap((currentModel) =>
      (currentModel.matrix_rows ?? []).map((row) => row.id),
    );
    const emptyAllocations: Record<string, ActiveAllocation[]> = {};
    for (const rowId of rowIds) emptyAllocations[rowId] = [];

    if (rowIds.length === 0) {
      setAllocationsByRow(emptyAllocations);
      return;
    }

    const activeListsResult = await supabase
      .from("equipment_lists")
      .select(ACTIVE_LIST_SELECT)
      .in("status", ["active", "partially_returned"])
      .order("created_at", { ascending: false })
      .limit(200);

    if (activeListsResult.error) {
      console.error(
        "load LED active equipment lists error",
        activeListsResult.error,
      );
      setAllocationsByRow(emptyAllocations);
      return;
    }

    const activeLists = (activeListsResult.data ?? []) as EquipmentList[];
    const activeListIds = activeLists.map((activeList) => activeList.id);
    if (activeListIds.length === 0) {
      setAllocationsByRow(emptyAllocations);
      return;
    }

    const activeListsById = new Map(
      activeLists.map((activeList) => [activeList.id, activeList]),
    );
    let allocationRows: Array<{
      list_id: string;
      inventory_record_id: string;
      requested_quantity: number;
      approved_quantity: number;
      returned_ok_quantity: number;
      returned_maintenance_quantity: number;
    }> = [];
    let from = 0;
    const pageSize = 1000;

    while (true) {
      const allocationResult = await supabase
        .from("equipment_list_items")
        .select(
          "list_id,inventory_record_id,requested_quantity,approved_quantity,returned_ok_quantity,returned_maintenance_quantity",
        )
        .eq("inventory_record_type", "matrix_row")
        .in("list_id", activeListIds)
        .in("inventory_record_id", rowIds)
        .range(from, from + pageSize - 1);

      if (allocationResult.error) {
        console.error(
          "load LED active allocations error",
          allocationResult.error,
        );
        setAllocationsByRow(emptyAllocations);
        return;
      }

      const page = (allocationResult.data ?? []) as typeof allocationRows;
      allocationRows = [...allocationRows, ...page];
      if (page.length < pageSize) break;
      from += pageSize;
    }

    const allocationMap = new Map<string, ActiveAllocation>();

    for (const allocationRow of allocationRows) {
      const activeList = activeListsById.get(allocationRow.list_id);
      const rowId = allocationRow.inventory_record_id;
      if (!activeList || !emptyAllocations[rowId]) continue;

      const approved = clampQty(allocationRow.approved_quantity);
      const requested = clampQty(allocationRow.requested_quantity);
      const returned =
        clampQty(allocationRow.returned_ok_quantity) +
        clampQty(allocationRow.returned_maintenance_quantity);
      const quantity = Math.max(
        0,
        (approved > 0 ? approved : requested) - returned,
      );
      if (quantity === 0) continue;

      const key = `${rowId}:${activeList.id}`;
      const current = allocationMap.get(key);
      if (current) {
        current.quantity += quantity;
      } else {
        allocationMap.set(key, {
          listId: activeList.id,
          reference: activeList.reference,
          label: allocationLabel(activeList),
          quantity,
          status:
            activeList.status === "partially_returned"
              ? "partially_returned"
              : "active",
          listType: activeList.list_type,
        });
      }
    }

    for (const [key, allocation] of allocationMap) {
      const rowId = key.slice(0, key.lastIndexOf(":"));
      emptyAllocations[rowId]?.push(allocation);
    }

    setAllocationsByRow(emptyAllocations);
  }

  async function loadModels(subId: string) {
    setLoading(models.length === 0);
    setErrorMsg(null);

    try {
      const { data, error } = await supabase
        .from("matrix_models")
        .select(
          "id, category_id, subcategory_id, name, created_at, sort_order, matrix_rows(id, model_id, size, cabinet_model, qty, available_qty, in_use_qty, maintenance_qty, in_ksa_qty, photo_data, sort_order)"
        )
        .eq("subcategory_id", subId)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false });

      if (error) {
        const fallback = await supabase
          .from("matrix_models")
          .select("id, category_id, subcategory_id, name, created_at")
          .eq("subcategory_id", subId)
          .order("created_at", { ascending: false });

        if (fallback.error) {
          setModels([]);
          setErrorMsg(fallback.error.message || "Failed to load LED screen models.");
          setLoading(false);
          return;
        }

        const base = (fallback.data ?? []) as MatrixModel[];

        const withRows = await Promise.all(
          base.map(async (m) => {
            const rres = await supabase
              .from("matrix_rows")
              .select(
                "id, model_id, size, cabinet_model, qty, available_qty, in_use_qty, maintenance_qty, in_ksa_qty, photo_data, sort_order"
              )
              .eq("model_id", m.id);

            return { ...m, matrix_rows: sortRows((rres.data ?? []) as MatrixRow[]) };
          })
        );

        const nextModels = sortModels(withRows);
        setModels(nextModels);
        await loadActiveAllocations(nextModels);
        setLoading(false);
        return;
      }

      const nextModels = sortModels(((data ?? []) as MatrixModel[]).map((m) => ({
          ...m,
          matrix_rows: sortRows(m.matrix_rows),
        })));
      setModels(nextModels);
      await loadActiveAllocations(nextModels);
    } catch (e: any) {
      setErrorMsg(e?.message || "Failed to load LED screen models.");
      setModels([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;

    async function boot() {
      if (!subcategoryId) {
        setModels([]);
        setLoading(false);
        setResolvedCategoryId(categoryId ?? null);
        return;
      }

      try {
        const catId = await resolveCategoryId(subcategoryId);
        if (!mounted) return;
        setResolvedCategoryId(catId);
        await loadModels(subcategoryId);
      } catch (e: any) {
        if (!mounted) return;
        setErrorMsg(e?.message || "Failed to prepare LED screen page.");
        setLoading(false);
      }
    }

    void boot();

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subcategoryId, categoryId]);

  useEffect(() => {
    function refreshEquipmentMovements() {
      if (subcategoryId) void loadModels(subcategoryId);
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
  }, [subcategoryId]);

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

      setListPickerTarget(null);

      if (!nextListId) {
        setActiveEquipmentList(null);
        return;
      }

      const listResult = await supabase
        .from("equipment_lists")
        .select(ACTIVE_LIST_SELECT)
        .eq("id", nextListId)
        .maybeSingle();

      const { data, error } = listResult;
      const userId = getUserId();

      if (cancelled || version !== loadVersion) return;

      const manager = canManageEquipmentLists();
      const canUseList = Boolean(
        data &&
          ((data.status === "pending" && manager) ||
            (data.status === "draft" &&
              (data.list_type === "internal_use"
                ? manager
                : data.created_by === userId))),
      );

      const canUseDepartment = Boolean(
        !data ||
          data.list_type !== "maintenance" ||
          manager ||
          canEditReportForRoute(routeSlugs.category, routeSlugs.subcategory),
      );

      if (error || !data || !canUseList || !canUseDepartment) {
        if (error) console.error("load active equipment list error", error);
        setActiveEquipmentList(null);
        return;
      }

      setActiveEquipmentList(data as EquipmentList);
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

  useEffect(() => {
    function syncSidebarTarget() {
      const nextTarget = document.getElementById("right-sidebar-actions");
      setSidebarTarget((current) =>
        current === nextTarget ? current : nextTarget
      );
    }

    syncSidebarTarget();
    const observer = new MutationObserver(syncSidebarTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const addMenu = document.getElementById("led-add-photo-menu");
      const addCabinetMenu = document.getElementById("led-add-cabinet-photo-menu");
      const rowMenu = target.closest("[data-led-photo-menu='true']");
      const keepsSelection = target.closest(
        "[data-led-model-select='true'], [data-led-cabinet-row='true'], [data-led-sidebar-tools='true'], [data-mobile-led-tools='true']"
      );

      if (addMenu && !addMenu.contains(target)) setAddPhotoMenuOpen(false);
      if (addCabinetMenu && !addCabinetMenu.contains(target)) {
        setAddCabinetPhotoMenuOpen(false);
      }
      if (!rowMenu) setRowPhotoMenuId(null);

      if (!keepsSelection) {
        window.setTimeout(() => {
          setSelectedModelId(null);
          setSelectedRowId(null);
        }, 0);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const parsedModels = useMemo(() => {
    return models.map((m) => ({ ...m, parsed: parseLedName(m.name) }));
  }, [models]);

  const brandSuggestions = useMemo(() => {
    const list = Array.from(
      new Set(parsedModels.map((m) => m.parsed.brand).filter(Boolean))
    ).sort() as string[];
    const q = normalizeText(brand).toLowerCase();
    if (!q) return list;
    return list.filter((x) => x.toLowerCase().includes(q));
  }, [parsedModels, brand]);

  const modelSuggestions = useMemo(() => {
    const currentBrand = normalizeText(brand).toLowerCase();
    const source = parsedModels.filter(
      (m) => !currentBrand || m.parsed.brand.toLowerCase() === currentBrand
    );
    const list = Array.from(new Set(source.map((m) => m.parsed.model).filter(Boolean))).sort() as string[];
    const q = normalizeText(model).toLowerCase();
    if (!q) return list;
    return list.filter((x) => x.toLowerCase().includes(q));
  }, [parsedModels, brand, model]);

  const cabinetSuggestions = useMemo(() => {
    const currentBrand = normalizeText(brand).toLowerCase();
    const currentModel = normalizeText(model).toLowerCase();

    const matchedModels = parsedModels.filter((m) => {
      const brandOk = !currentBrand || m.parsed.brand.toLowerCase() === currentBrand;
      const modelOk = !currentModel || m.parsed.model.toLowerCase() === currentModel;
      return brandOk && modelOk;
    });

    const list = Array.from(
      new Set(
        matchedModels.flatMap((m) =>
          (m.matrix_rows ?? []).map((r) => normalizeText(r.size)).filter(Boolean)
        )
      )
    ).sort() as string[];

    const q = normalizeText(cabinetSize).toLowerCase();
    if (!q) return list;
    return list.filter((x) => x.toLowerCase().includes(q));
  }, [parsedModels, brand, model, cabinetSize]);

  const ledSearchName = useMemo(() => {
    return `${brand} ${model} ${cabinetSize}`.trim();
  }, [brand, model, cabinetSize]);

  async function applyPhotoToTarget(target: PhotoTarget, imageUrl: string) {
    if (target.type === "new") {
      setNewPhoto(imageUrl);
      setSaveMsg("Photo selected");
      setTimeout(() => setSaveMsg(""), 1500);
      return;
    }

    if (target.type === "addCabinet") {
      setAddCabinetPhoto(imageUrl);
      return;
    }

    const rowId = target.rowId;
    const targetModel = models.find((model) =>
      (model.matrix_rows ?? []).some((row) => row.id === rowId)
    );
    const targetRow = targetModel?.matrix_rows?.find((row) => row.id === rowId);

    const { error } = await supabase
      .from("matrix_rows")
      .update({ photo_data: imageUrl })
      .eq("id", rowId);

    if (error) {
      alert(error.message || "Failed to update photo");
      return;
    }

    setModels((prev) =>
      prev.map((m) => ({
        ...m,
        matrix_rows: (m.matrix_rows ?? []).map((r) =>
          r.id === rowId ? { ...r, photo_data: imageUrl } : r
        ),
      }))
    );
    setSaveMsg("Photo updated");
    setTimeout(() => setSaveMsg(""), 1500);

    await logActivity({
      title: `updated an LED cabinet photo`,
      message: `${targetModel?.name || "LED Screen"} — ${targetRow?.size || "cabinet"}`,
      link: getReportHref(rowId),
    });
  }

  async function onPickPhotoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    const target = photoTarget;
    e.target.value = "";

    if (!f || !target) return;

    try {
      setSaveMsg("Uploading photo...");
      const imageUrl = await uploadPhoto(f);
      await applyPhotoToTarget(target, imageUrl);
    } catch (e: any) {
      alert(e?.message || "Photo upload failed");
      setSaveMsg("");
    } finally {
      setPhotoTarget(null);
      setRowPhotoMenuId(null);
      setAddPhotoMenuOpen(false);
      setAddCabinetPhotoMenuOpen(false);
    }
  }

  async function searchOnlineImages(customQuery?: string) {
    const q = (customQuery || imageSearch || ledSearchName).trim();

    if (!q) {
      alert("Write item name first");
      return;
    }

    setSearchPanelOpen(true);
    setSearchingImages(true);
    setImageResults([]);

    try {
      const res = await fetch(`/api/google-image?q=${encodeURIComponent(q)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error || "Image search failed. Please try again.");
        return;
      }
      const data = await res.json();

      const results = Array.isArray(data)
        ? data
        : Array.isArray(data?.images_results)
        ? data.images_results
        : Array.isArray(data?.items)
        ? data.items
        : [];

      setImageResults(results);
      if (results.length === 0) {
        alert("No images found. Try the brand and model only, or upload a photo.");
      }
    } catch (e) {
      console.error(e);
      alert("Failed to search images");
    } finally {
      setSearchingImages(false);
    }
  }

  async function selectOnlinePhoto(img: OnlineImage) {
    const fallbackUrl = img.thumbnail || img.image || img.original;
    const sourceUrl = img.image || img.original || img.thumbnail;

    if (!fallbackUrl || !sourceUrl || !photoTarget) return;

    setSaveMsg("Preparing photo...");

    let finalImageUrl = fallbackUrl;

    try {
      const res = await fetch("/api/optimize-image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          imageUrl: sourceUrl,
        }),
      });

      if (!res.ok) {
        throw new Error("Optimization failed");
      }

      const data = await res.json();

      if (data?.url) {
        finalImageUrl = data.url;
      }
    } catch (error) {
      console.warn("Could not optimize online image, using thumbnail URL:", error);
      finalImageUrl = fallbackUrl;
    }

    await applyPhotoToTarget(photoTarget, finalImageUrl);

    setPhotoTarget(null);
    setRowPhotoMenuId(null);
    setSearchPanelOpen(false);
    setImageResults([]);
    setSaveMsg("Online photo selected");
    setTimeout(() => setSaveMsg(""), 1500);
  }

  function startSearchForNewPhoto() {
    setPhotoTarget({ type: "new" });
    setAddPhotoMenuOpen(false);
    setImageSearch(ledSearchName);
    setSearchPanelOpen(true);
    setTimeout(() => void searchOnlineImages(ledSearchName), 50);
  }

  function startSearchForAddCabinetPhoto() {
    const currentModel = models.find((m) => m.id === addingModelId);
    const parsed = currentModel ? parseLedName(currentModel.name) : { brand, model };
    const rowSearch = `${parsed.brand} ${parsed.model} ${addCabinetSize} ${addCabinetModel} LED cabinet`.trim();

    setPhotoTarget({ type: "addCabinet" });
    setAddCabinetPhotoMenuOpen(false);
    setImageSearch(rowSearch);
    setSearchPanelOpen(true);
    setTimeout(() => void searchOnlineImages(rowSearch), 50);
  }

  function startSearchForRowPhoto(row: MatrixRow) {
    const rowSearch = `${row.size} ${row.cabinet_model || ""} LED cabinet`.trim();
    setPhotoTarget({ type: "row", rowId: row.id });
    setRowPhotoMenuId(null);
    setImageSearch(rowSearch);
    setSearchPanelOpen(true);
    setTimeout(() => void searchOnlineImages(rowSearch), 50);
  }

  async function addLedScreen() {
    if (!editable) {
      setErrorMsg("You do not have permission to edit inventory.");
      return;
    }

    setErrorMsg(null);

    if (!subcategoryId) {
      setErrorMsg("Subcategory is not ready yet.");
      return;
    }

    const cleanBrand = normalizeText(brand);
    const cleanModel = normalizeText(model);

    if (!cleanBrand) return setErrorMsg("Please enter brand name.");
    if (!cleanModel) return setErrorMsg("Please enter model / pixel pitch.");

    const fullName = buildLedName(cleanBrand, cleanModel);
    const existingModel = parsedModels.find(
      (m) =>
        normalizeText(m.parsed.brand).toLowerCase() === cleanBrand.toLowerCase() &&
        normalizeText(m.parsed.model).toLowerCase() === cleanModel.toLowerCase()
    );

    if (existingModel) {
      setSaveMsg("LED screen model already exists");
      setOpenModelId(existingModel.id);
      setTimeout(
        () => setSaveMsg((prev) => (prev === "LED screen model already exists" ? "" : prev)),
        1500
      );
      return;
    }

    setSubmitting(true);

    try {
      const catId = resolvedCategoryId ?? (await resolveCategoryId(subcategoryId));

      const { data: created, error } = await supabase
        .from("matrix_models")
        .insert({
          category_id: catId,
          subcategory_id: subcategoryId,
          name: fullName,
        })
        .select("id, category_id, subcategory_id, name, created_at")
        .single();

      if (error || !created) {
        setErrorMsg(error?.message || "Failed to add LED screen model.");
        return;
      }

      const newModel = { ...(created as MatrixModel), matrix_rows: [] };

      setModels((prev) => [newModel, ...prev]);
      setOpenModelId(created.id);
      setBrand("");
      setModel("");
      setSaveMsg("LED screen model added");
      setTimeout(
        () => setSaveMsg((prev) => (prev === "LED screen model added" ? "" : prev)),
        1500
      );

      await logActivity({
        title: `added LED model ${fullName}`,
        message: "A new LED screen model was added",
        link: pathname,
      });

      void loadModels(subcategoryId);
    } catch (e: any) {
      setErrorMsg(e?.message || "Failed to add LED screen model.");
    } finally {
      setSubmitting(false);
    }
  }

  function openAddCabinetPopup(modelId: string) {
    setAddingModelId(modelId);
    setAddCabinetSize("");
    setAddCabinetModel("");
    setAddCabinetQty(0);
    setAddCabinetPhoto(null);
    setSavingAddCabinet(false);
  }

  function closeAddCabinetPopup() {
    setAddingModelId(null);
    setAddCabinetSize("");
    setAddCabinetModel("");
    setAddCabinetQty(0);
    setAddCabinetPhoto(null);
    setSavingAddCabinet(false);
    setAddCabinetPhotoMenuOpen(false);
  }

  async function saveAddCabinetPopup() {
    if (!editable || !addingModelId) return;

    const size = normalizeText(addCabinetSize);
    const cabinetModel = normalizeText(addCabinetModel);
    const total = clampQty(addCabinetQty);

    if (!size) return alert("Please enter cabinet size");
    if (!cabinetModel) return alert("Please enter cabinet model");
    if (total <= 0) return alert("Please enter qty");

    setSavingAddCabinet(true);

    const { data, error } = await supabase
      .from("matrix_rows")
      .insert({
        model_id: addingModelId,
        size,
        cabinet_model: cabinetModel,
        qty: total,
        available_qty: total,
        in_use_qty: 0,
        maintenance_qty: 0,
        in_ksa_qty: 0,
        photo_data: addCabinetPhoto || null,
        sort_order:
          models.find((m) => m.id === addingModelId)?.matrix_rows?.length ?? 0,
      })
      .select("id, model_id, size, cabinet_model, qty, available_qty, in_use_qty, maintenance_qty, in_ksa_qty, photo_data, sort_order")
      .single();

    if (error || !data) {
      alert(error?.message || "Failed to add cabinet");
      setSavingAddCabinet(false);
      return;
    }

    const newRow = data as MatrixRow;

    setModels((prev) =>
      prev.map((m) =>
        m.id === addingModelId
          ? { ...m, matrix_rows: [...(m.matrix_rows ?? []), newRow] }
          : m
      )
    );

    const parentModel = models.find((model) => model.id === addingModelId);

    await logActivity({
      title: `added a cabinet to ${parentModel?.name || "LED Screen"}`,
      message: `${cabinetModel} — ${size} — Qty ${total}`,
      link: getReportHref(newRow.id),
    });

    if (subcategoryId) {
      setSaveMsg("Cabinet added");
      setTimeout(
        () => setSaveMsg((prev) => (prev === "Cabinet added" ? "" : prev)),
        1500
      );
      void loadModels(subcategoryId);
    }

    setOpenModelId(addingModelId);
    closeAddCabinetPopup();
  }

  async function renameModel(
    modelId: string,
    current: string,
    nextBrand: string,
    nextModel: string
  ) {
    if (!editable) return;

    const cleanName = buildLedName(nextBrand, nextModel);
    if (!cleanName || cleanName === current) return;

    const { error } = await supabase
      .from("matrix_models")
      .update({ name: cleanName })
      .eq("id", modelId);

    if (error) {
      alert("Rename failed");
      return;
    }

    setModels((prev) =>
      prev.map((item) =>
        item.id === modelId ? { ...item, name: cleanName } : item
      )
    );
    setSaveMsg("Model renamed");
    setTimeout(
      () => setSaveMsg((prev) => (prev === "Model renamed" ? "" : prev)),
      1500
    );

    await logActivity({
      title: `renamed LED model ${current}`,
      message: `New name: ${cleanName}`,
      link: pathname,
    });
  }

  async function saveRowDirect(row: MatrixRow, patch: Partial<MatrixRow>) {
    if (!editable) return;

    const nextSize = normalizeText(String(patch.size ?? row.size));
    const nextCabinetModel = normalizeText(String(patch.cabinet_model ?? row.cabinet_model ?? ""));
    const nextTotal = clampQty(patch.qty ?? row.qty);
    const nextMaintenance = clampQty(row.maintenance_qty);
    const activeAllocated = rowAllocatedQuantity(row.id);
    const legacyMovement = existingMovementQuantity(row, activeAllocated);
    const nextAllocated = activeAllocated + legacyMovement;

    const changed =
      nextSize !== normalizeText(row.size) ||
      nextCabinetModel !== normalizeText(row.cabinet_model ?? "") ||
      nextTotal !== clampQty(row.qty);

    if (!changed) return;

    if (!nextSize) {
      alert("Cabinet size cannot be empty");
      return;
    }

    if (nextAllocated + nextMaintenance > nextTotal) {
      alert(
        `Total Qty cannot be lower than ${nextAllocated + nextMaintenance} (${nextAllocated} movement + ${nextMaintenance} maintenance)`,
      );
      return;
    }

    const nextAvailable = rowAvailableFromTotal(
      nextTotal,
      nextAllocated,
      nextMaintenance,
    );

    setModels((prev) =>
      prev.map((m) => ({
        ...m,
        matrix_rows: (m.matrix_rows ?? []).map((r) =>
          r.id === row.id
            ? {
                ...r,
                size: nextSize,
                cabinet_model: nextCabinetModel,
                qty: nextTotal,
                available_qty: nextAvailable,
                in_use_qty: nextAllocated,
                in_ksa_qty: 0,
              }
            : r
        ),
      }))
    );

    const { error } = await supabase
      .from("matrix_rows")
      .update({
        size: nextSize,
        cabinet_model: nextCabinetModel,
        qty: nextTotal,
        available_qty: nextAvailable,
        in_use_qty: nextAllocated,
        in_ksa_qty: 0,
      })
      .eq("id", row.id);

    if (error) {
      alert("Failed to save row");
      if (subcategoryId) await loadModels(subcategoryId);
      return;
    }

    const parentModel = models.find((model) => model.id === row.model_id);
    await logActivity({
      title: `edited ${parentModel?.name || "LED Screen"}`,
      message: `${nextCabinetModel || "Cabinet"} — ${nextSize} was updated`,
      link: getReportHref(row.id),
    });
  }

  async function reorderRows(modelId: string, activeId: string, overId: string) {
    if (!reorderable) return;
    if (!editable || activeId === overId) return;

    let nextRows: MatrixRow[] = [];

    setModels((prev) =>
      prev.map((m) => {
        if (m.id !== modelId) return m;

        const rows = m.matrix_rows ?? [];
        const oldIndex = rows.findIndex((r) => r.id === activeId);
        const newIndex = rows.findIndex((r) => r.id === overId);

        if (oldIndex < 0 || newIndex < 0) return m;

        nextRows = arrayMove(rows, oldIndex, newIndex).map((r, index) => ({
          ...r,
          sort_order: index,
        }));

        return { ...m, matrix_rows: nextRows };
      })
    );

    if (nextRows.length === 0) return;

    const results = await Promise.all(
      nextRows.map((row, index) =>
        supabase.from("matrix_rows").update({ sort_order: index }).eq("id", row.id)
      )
    );

    const failed = results.find((res) => res.error);
    if (failed?.error) {
      alert("Failed to save row order");
      if (subcategoryId) void loadModels(subcategoryId);
      return;
    }

    const reorderedModel = models.find((model) => model.id === modelId);
    await logActivity({
      title: `reordered cabinets for ${reorderedModel?.name || "LED Screen"}`,
      message: "Cabinet order was updated",
      link: pathname,
    });
  }

  async function reorderModels(activeId: string, overId: string) {
    if (!reorderable) return;
    if (!editable || activeId === overId) return;

    const oldIndex = models.findIndex((model) => model.id === activeId);
    const newIndex = models.findIndex((model) => model.id === overId);
    if (oldIndex < 0 || newIndex < 0) return;

    const previousModels = models;
    const nextModels = arrayMove(models, oldIndex, newIndex).map(
      (currentModel, index) => ({
        ...currentModel,
        sort_order: index,
      })
    );

    setModels(nextModels);

    const results = await Promise.all(
      nextModels.map((currentModel, index) =>
        supabase
          .from("matrix_models")
          .update({ sort_order: index })
          .eq("id", currentModel.id)
      )
    );

    const failed = results.find((result) => result.error);
    if (failed?.error) {
      console.error("Failed to save LED model order", failed.error);
      setModels(previousModels);
      alert(
        "Failed to save model order. Add the sort_order column to matrix_models first."
      );
      return;
    }

    await logActivity({
      title: "reordered LED screen models",
      message: "LED screen model order was updated",
      link: pathname,
    });
  }

  async function deleteModel(modelId: string) {
    if (!editable) return;
    const modelHasActiveMovement = models
      .find((model) => model.id === modelId)
      ?.matrix_rows?.some(
        (row) =>
          (allocationsByRow[row.id] ?? []).length > 0 ||
          clampQty(row.in_use_qty) + clampQty(row.in_ksa_qty) > 0,
      );
    if (modelHasActiveMovement) {
      alert("This LED model has cabinets in an active list and cannot be deleted.");
      return;
    }
    if (!confirm("Delete this LED model?")) return;

    const deletedModel = models.find((model) => model.id === modelId);

    await supabase.from("matrix_rows").delete().eq("model_id", modelId);

    const { error } = await supabase.from("matrix_models").delete().eq("id", modelId);

    if (error) {
      alert("Delete failed");
      return;
    }

    setSelectedModelId((current) => (current === modelId ? null : current));

    if (subcategoryId) {
      setSaveMsg("Model deleted");
      setTimeout(
        () => setSaveMsg((prev) => (prev === "Model deleted" ? "" : prev)),
        1500
      );
      await loadModels(subcategoryId);
    }

    await logActivity({
      title: `deleted LED model ${deletedModel?.name || "LED Screen"}`,
      message: "The model and all its cabinets were deleted",
      link: pathname,
    });
  }

  async function deleteRow(rowId: string) {
    if (!editable) return;
    const rowToDelete = models
      .flatMap((model) => model.matrix_rows ?? [])
      .find((row) => row.id === rowId);
    if (
      (allocationsByRow[rowId] ?? []).length > 0 ||
      (rowToDelete
        ? clampQty(rowToDelete.in_use_qty) + clampQty(rowToDelete.in_ksa_qty) >
          0
        : false)
    ) {
      alert("This cabinet is in an active list and cannot be deleted.");
      return;
    }
    if (!confirm("Delete this cabinet row?")) return;

    const parentModel = models.find((model) =>
      (model.matrix_rows ?? []).some((row) => row.id === rowId)
    );
    const deletedRow = parentModel?.matrix_rows?.find((row) => row.id === rowId);

    const { error } = await supabase.from("matrix_rows").delete().eq("id", rowId);

    if (error) {
      alert("Delete row failed");
      return;
    }

    setModels((prev) =>
      prev.map((m) => ({
        ...m,
        matrix_rows: (m.matrix_rows ?? []).filter((r) => r.id !== rowId),
      }))
    );
    setSelectedRowId((current) => (current === rowId ? null : current));

    await logActivity({
      title: `deleted a cabinet from ${parentModel?.name || "LED Screen"}`,
      message: `${deletedRow?.cabinet_model || "Cabinet"} — ${deletedRow?.size || ""}`,
      link: pathname,
    });
  }

  async function saveSelectedModelName() {
    if (!selectedModel) return;
    await renameModel(
      selectedModel.id,
      selectedModel.name,
      selectedModelBrand,
      selectedModelName
    );
  }

  const selectedModelPanel = selectedModel ? (
    <div
      key={selectedModel.id}
      data-led-sidebar-tools="true"
      className="mb-4 rounded-2xl border-2 border-black bg-white p-3 shadow-sm"
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
        Selected LED Model
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2">
        <input
          value={selectedModelBrand}
          onChange={(event) => setSelectedModelBrand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          onBlur={() => void saveSelectedModelName()}
          placeholder="Brand"
          disabled={!editable}
          className="h-9 w-full rounded-xl border border-gray-300 bg-white px-3 text-[10px] font-semibold text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
        />
        <input
          value={selectedModelName}
          onChange={(event) => setSelectedModelName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          onBlur={() => void saveSelectedModelName()}
          placeholder="Model / Pixel Pitch"
          disabled={!editable}
          className="h-9 w-full rounded-xl border border-gray-300 bg-white px-3 text-[10px] text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
        />
      </div>

      {editable ? (
        <div className="mt-3 grid grid-cols-1 gap-2">
          <button
            type="button"
            onClick={() => openAddCabinetPopup(selectedModel.id)}
            className="rounded-xl bg-black px-3 py-2.5 text-[11px] font-medium text-white hover:opacity-90"
          >
            + Add Cabinet
          </button>
          <button
            type="button"
            onClick={() => void deleteModel(selectedModel.id)}
            className="flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[11px] font-medium text-red-700 hover:bg-red-100"
          >
            <Trash2 size={14} /> Delete Model
          </button>
        </div>
      ) : null}
    </div>
  ) : null;

  const selectedCabinetAllocations = selectedCabinetInfo
    ? allocationsByRow[selectedCabinetInfo.row.id] ?? []
    : [];
  const selectedCabinetAllocatedQty = movementAllocationQuantity(
    selectedCabinetAllocations,
  );
  const selectedCabinetExistingMovementQty = selectedCabinetInfo
    ? existingMovementQuantity(
        selectedCabinetInfo.row,
        selectedCabinetAllocatedQty,
      )
    : 0;
  const selectedCabinetTrackedQty =
    selectedCabinetAllocatedQty + selectedCabinetExistingMovementQty;
  const selectedCabinetAvailableQty = selectedCabinetInfo
    ? rowAvailableFromTotal(
        clampQty(selectedCabinetInfo.row.qty),
        selectedCabinetTrackedQty,
        clampQty(selectedCabinetInfo.row.maintenance_qty),
      )
    : 0;

  const selectedCabinetPanel = selectedCabinetInfo ? (
    <div
      key={selectedCabinetInfo.row.id}
      data-led-sidebar-tools="true"
      className="mb-4 rounded-2xl border-2 border-black bg-white p-3 shadow-sm"
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
        Selected Cabinet
      </div>
      <div className="mt-1 text-[10px] font-semibold text-gray-900">
        {selectedCabinetInfo.model.name}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2">
        <input
          defaultValue={selectedCabinetInfo.row.cabinet_model || ""}
          placeholder="Cabinet Model"
          disabled={!editable}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={(event) => {
            const clean = normalizeText(event.currentTarget.value);
            if (
              clean &&
              clean !== (selectedCabinetInfo.row.cabinet_model || "")
            ) {
              void saveRowDirect(selectedCabinetInfo.row, {
                cabinet_model: clean,
              });
            }
          }}
          className="h-9 w-full rounded-xl border border-gray-300 bg-white px-3 text-[10px] font-semibold text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
        />
        <input
          defaultValue={selectedCabinetInfo.row.size}
          placeholder="Cabinet Size"
          disabled={!editable}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={(event) => {
            const clean = normalizeText(event.currentTarget.value);
            if (clean && clean !== selectedCabinetInfo.row.size) {
              void saveRowDirect(selectedCabinetInfo.row, { size: clean });
            }
          }}
          className="h-9 w-full rounded-xl border border-gray-300 bg-white px-3 text-[10px] text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
        />

        <div className="grid grid-cols-3 gap-2">
          <label className="text-[8px] font-semibold text-gray-500">
            Total
            <input
              type="number"
              min={
                selectedCabinetTrackedQty +
                clampQty(selectedCabinetInfo.row.maintenance_qty)
              }
              defaultValue={selectedCabinetInfo.row.qty}
              disabled={!editable}
              onBlur={(event) =>
                void saveRowDirect(selectedCabinetInfo.row, {
                  qty: clampQty(event.currentTarget.value),
                })
              }
              className="mt-1 h-8 w-full rounded-lg border border-gray-300 px-2 text-[9px] text-gray-900 outline-none focus:border-black"
            />
          </label>
          <div className="text-[8px] font-semibold text-gray-500">
            Available
            <div className="mt-1 flex h-8 w-full items-center rounded-lg bg-green-100 px-2 text-[9px] font-bold text-green-800">
              {selectedCabinetAvailableQty}
            </div>
          </div>
          <div className="text-[8px] font-semibold text-gray-500">
            Maintenance
            <div className="mt-1 flex h-8 w-full items-center rounded-lg bg-yellow-100 px-2 text-[9px] font-bold text-yellow-800">
              {clampQty(selectedCabinetInfo.row.maintenance_qty)}
            </div>
          </div>
        </div>

        {selectedCabinetAllocations.length > 0 ? (
          <div className="rounded-xl border border-blue-100 bg-blue-50 p-2.5">
            <div className="text-[8px] font-bold uppercase tracking-wider text-blue-500">
              Active Movements
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {selectedCabinetAllocations.map((allocation) => (
                <Link
                  key={allocation.listId}
                  href={`/inventory/lists/${allocation.listId}`}
                  title={`${allocation.reference} · ${allocation.label}`}
                  className={`max-w-full truncate rounded-lg px-2 py-1 text-[9px] font-semibold transition hover:opacity-80 ${
                    allocation.listType === "maintenance"
                      ? "bg-amber-100 text-amber-800"
                      : allocation.status === "partially_returned"
                      ? "bg-purple-100 text-purple-800"
                      : "bg-blue-100 text-blue-800"
                  }`}
                >
                  {allocation.quantity} pcs · {allocation.label}
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        {selectedCabinetExistingMovementQty > 0 ? (
          <div className="rounded-xl bg-gray-100 px-2.5 py-2 text-[9px] font-semibold text-gray-600">
            {selectedCabinetExistingMovementQty} pcs · Existing movement
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex items-center gap-3 rounded-xl bg-gray-50 p-2">
        {selectedCabinetInfo.row.photo_data ? (
          <img
            src={selectedCabinetInfo.row.photo_data}
            alt={selectedCabinetInfo.row.cabinet_model || "LED cabinet"}
            className="h-14 w-14 rounded-lg bg-white object-cover"
          />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-white text-[8px] text-gray-400">
            No photo
          </div>
        )}
        <div className="text-[9px] text-gray-500">
          Changes save when you leave a field.
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2">
        {editable && activeDraftList ? (
          <button
            type="button"
            onClick={() => setListPickerTarget(selectedCabinetInfo)}
            className="rounded-xl bg-red-600 px-3 py-2.5 text-center text-[11px] font-semibold text-white transition hover:bg-red-700"
          >
            Add Cabinets to {activeDraftList.reference}
          </button>
        ) : null}
        <Link
          href={getReportHref(selectedCabinetInfo.row.id)}
          className="rounded-xl bg-black px-3 py-2.5 text-center text-[11px] font-medium text-white hover:opacity-90"
        >
          Open Cabinet / Report
        </Link>
        {editable ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setPhotoTarget({
                    type: "row",
                    rowId: selectedCabinetInfo.row.id,
                  });
                  rowPhotoFileRef.current?.click();
                }}
                className="rounded-xl border border-gray-300 bg-white px-2 py-2.5 text-[10px] font-medium text-gray-700 hover:bg-red-50"
              >
                Upload Photo
              </button>
              <button
                type="button"
                onClick={() => startSearchForRowPhoto(selectedCabinetInfo.row)}
                className="rounded-xl border border-gray-300 bg-white px-2 py-2.5 text-[10px] font-medium text-gray-700 hover:bg-red-50"
              >
                Search Photo
              </button>
            </div>
            <button
              type="button"
              onClick={() => openAddCabinetPopup(selectedCabinetInfo.model.id)}
              className="rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-[10px] font-medium text-gray-700 hover:bg-gray-50"
            >
              + Add Cabinet to this Model
            </button>
            <button
              type="button"
              onClick={() => void deleteRow(selectedCabinetInfo.row.id)}
              className="flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[11px] font-medium text-red-700 hover:bg-red-100"
            >
              <Trash2 size={14} /> Delete Cabinet
            </button>
          </>
        ) : null}
      </div>
    </div>
  ) : null;

  async function closeMobileLedTools() {
    await saveSelectedModelName();
    setSelectedModelId(null);
    setSelectedRowId(null);
    setSearchPanelOpen(false);
    setPhotoTarget(null);
    setImageResults([]);
  }

  const addLedScreenPanel = editable ? (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-4">
        <h2 className="text-[13px] font-semibold text-gray-900">
          Add LED Screen
        </h2>
        <p className="mt-1 text-[10px] text-gray-500">
          Add model once, then add cabinet sizes inside it.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <input
          list="led-brand-list"
          value={brand}
          onChange={(event) => setBrand(event.target.value)}
          placeholder="Brand"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none focus:border-black"
        />
        <datalist id="led-brand-list">
          {brandSuggestions.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
        <input
          list="led-model-list"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="Model / PH"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none focus:border-black"
        />
        <datalist id="led-model-list">
          {modelSuggestions.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
        <button
          type="button"
          onClick={addLedScreen}
          disabled={submitting}
          className="h-11 w-full rounded-2xl bg-black px-4 text-[12px] font-medium text-white disabled:opacity-40"
        >
          {submitting ? "Adding..." : "+ Add LED Screen"}
        </button>
      </div>

      {(errorMsg || saveMsg) && (
        <div
          className={`mt-3 text-[10px] ${
            errorMsg ? "text-red-600" : "text-gray-500"
          }`}
        >
          {errorMsg || saveMsg}
        </div>
      )}
    </div>
  ) : null;

  const sidebarPhotoSearchPanel =
    searchPanelOpen && photoTarget?.type !== "addCabinet" ? (
      <div
        data-led-sidebar-tools="true"
        className="mb-4 hidden rounded-2xl border border-gray-200 bg-white p-3 shadow-sm xl:block"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="text-[12px] font-semibold text-gray-900">
            Search Photo Online
          </div>
          <button
            type="button"
            onClick={() => {
              setSearchPanelOpen(false);
              setImageResults([]);
              setPhotoTarget(null);
            }}
            className="text-[10px] text-red-500 hover:text-black"
          >
            Close
          </button>
        </div>

        <div className="flex gap-2">
          <input
            value={imageSearch}
            onChange={(event) => setImageSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void searchOnlineImages();
              }
            }}
            placeholder="Search image..."
            className="h-10 min-w-0 flex-1 rounded-xl border border-gray-300 px-3 text-[11px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
          />
          <button
            type="button"
            onClick={() => void searchOnlineImages()}
            disabled={searchingImages}
            className="h-10 rounded-xl bg-black px-3 text-[10px] font-medium text-white disabled:opacity-40"
          >
            {searchingImages ? "..." : "Search"}
          </button>
        </div>

        {searchingImages ? (
          <div className="mt-3 text-[10px] text-gray-500">
            Searching images...
          </div>
        ) : null}

        {imageResults.length > 0 ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {imageResults.map((image, index) => {
              const imageUrl =
                image.original || image.image || image.thumbnail;
              const thumb = image.thumbnail || imageUrl;
              if (!imageUrl || !thumb) return null;

              return (
                <button
                  key={`${imageUrl}-${index}`}
                  type="button"
                  onClick={() => void selectOnlinePhoto(image)}
                  className="overflow-hidden rounded-xl border border-gray-200 hover:border-red-300"
                  title={image.title || "Select photo"}
                >
                  <img
                    src={thumb}
                    alt={image.title || "Online image"}
                    loading="lazy"
                    decoding="async"
                    className="aspect-square w-full object-cover"
                  />
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    ) : null;

  if (loading) {
    return (
      <div className="mx-auto w-full">
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-6 text-gray-900">
          Loading LED screen models...
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full space-y-3 text-black">
      <input
        ref={newPhotoFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPickPhotoFile}
      />

      <input
        ref={addCabinetPhotoFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPickPhotoFile}
      />

      <input
        ref={rowPhotoFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPickPhotoFile}
      />

      {activeDraftList && listPickerTarget ? (
        <EquipmentListQuantityPicker
          list={activeDraftList}
          row={listPickerTarget.row}
          modelName={listPickerTarget.model.name}
          category={routeSlugs.category}
          subcategory={routeSlugs.subcategory}
          activeAllocatedQuantity={rowAllocatedQuantity(
            listPickerTarget.row.id,
          ) + existingMovementQuantity(
            listPickerTarget.row,
            rowAllocatedQuantity(listPickerTarget.row.id),
          )}
          activeMaintenanceQuantity={rowMaintenanceRepairQuantity(
            listPickerTarget.row.id,
          )}
          allowPendingReview={
            activeDraftList.status === "pending" &&
            canManageEquipmentLists()
          }
          onClose={() => setListPickerTarget(null)}
          onAdded={(quantity) => {
            const message = `${quantity} cabinet${quantity === 1 ? "" : "s"} added to ${activeDraftList.reference}`;
            setSaveMsg(message);
            setTimeout(() => {
              setSaveMsg((current) => (current === message ? "" : current));
            }, 1800);
            if (subcategoryId) void loadModels(subcategoryId);
          }}
        />
      ) : null}

      {(selectedModel || selectedCabinetInfo) ? (
        <div
          data-mobile-led-tools="true"
          className="fixed inset-0 z-[9998] sm:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="LED screen tools"
        >
          <button
            type="button"
            aria-label="Close LED screen tools"
            onClick={() => void closeMobileLedTools()}
            className="absolute inset-0 bg-black/45"
          />

          <div className="absolute inset-x-0 bottom-0 flex h-[75dvh] flex-col rounded-t-3xl bg-gray-50 shadow-2xl">
            <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
              <div className="h-1 w-10 rounded-full bg-gray-300" />
              <div className="text-[11px] font-semibold text-gray-700">
                LED Screen Tools
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => void closeMobileLedTools()}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-lg leading-none text-gray-700"
              >
                ×
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+16px)]">
              {selectedModelPanel}
              {selectedCabinetPanel}

              {searchPanelOpen && photoTarget?.type === "row" ? (
                <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="text-[12px] font-semibold text-gray-900">
                      Search Photo Online
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSearchPanelOpen(false);
                        setImageResults([]);
                        setPhotoTarget(null);
                      }}
                      className="text-[10px] text-red-500 hover:text-black"
                    >
                      Close
                    </button>
                  </div>

                  <div className="flex gap-2">
                    <input
                      value={imageSearch}
                      onChange={(event) => setImageSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void searchOnlineImages();
                        }
                      }}
                      placeholder="Search image..."
                      className="h-10 min-w-0 flex-1 rounded-xl border border-gray-300 px-3 text-[12px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
                    />
                    <button
                      type="button"
                      onClick={() => void searchOnlineImages()}
                      disabled={searchingImages}
                      className="h-10 rounded-xl bg-black px-3 text-[11px] font-medium text-white disabled:opacity-40"
                    >
                      {searchingImages ? "..." : "Search"}
                    </button>
                  </div>

                  {imageResults.length > 0 ? (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {imageResults.map((img, index) => {
                        const imageUrl =
                          img.original || img.image || img.thumbnail;
                        const thumb = img.thumbnail || imageUrl;
                        if (!imageUrl || !thumb) return null;

                        return (
                          <button
                            key={`${imageUrl}-${index}`}
                            type="button"
                            onClick={() => void selectOnlinePhoto(img)}
                            className="overflow-hidden rounded-xl border border-gray-200"
                            title={img.title || "Select photo"}
                          >
                            <img
                              src={thumb}
                              alt={img.title || "Online image"}
                              loading="lazy"
                              decoding="async"
                              className="aspect-square w-full object-cover"
                            />
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {editable && !selectedModelId && !selectedRowId ? (
        <>
          <button
            type="button"
            aria-label="Add LED screen"
            onClick={() => setMobileAddOpen(true)}
            className="fixed bottom-5 right-4 z-[90] flex h-14 w-14 items-center justify-center rounded-full bg-black text-[30px] font-light leading-none text-white shadow-xl active:scale-95 sm:hidden"
          >
            +
          </button>

          {mobileAddOpen ? (
            <div className="fixed inset-0 z-[9998] sm:hidden">
              <button
                type="button"
                aria-label="Close add LED screen form"
                onClick={() => setMobileAddOpen(false)}
                className="absolute inset-0 bg-black/45"
              />
              <div className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-3xl bg-gray-50 p-3 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-2xl">
                <div className="mb-2 flex items-center justify-between px-1">
                  <div className="h-1 w-10 rounded-full bg-gray-300" />
                  <button
                    type="button"
                    onClick={() => setMobileAddOpen(false)}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-lg text-gray-700"
                    aria-label="Close"
                  >
                    ×
                  </button>
                </div>
                {addLedScreenPanel}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {sidebarTarget
        ? createPortal(
            <div>
              {selectedModelPanel}
              {selectedCabinetPanel}
              {sidebarPhotoSearchPanel}
              {!selectedModelId && !selectedRowId
                ? addLedScreenPanel
                : null}
            </div>,
            sidebarTarget
          )
        : null}

      <div className="hidden sm:block xl:hidden">{selectedModelPanel}</div>
      <div className="hidden sm:block xl:hidden">{selectedCabinetPanel}</div>
      {!selectedModelId && !selectedRowId ? (
        <div className="hidden sm:block xl:hidden">{addLedScreenPanel}</div>
      ) : null}

      {searchPanelOpen && photoTarget?.type !== "addCabinet" ? (
        <div className="relative z-50 hidden rounded-2xl border border-gray-200 bg-white p-3 sm:block xl:hidden">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-[12px] font-semibold text-gray-900">
              Search photo online
            </div>

            <button
              type="button"
              onClick={() => {
                setSearchPanelOpen(false);
                setImageResults([]);
                setPhotoTarget(null);
              }}
              className="text-[10px] text-red-500 hover:text-black"
            >
              Close
            </button>
          </div>

          <div className="flex gap-2">
            <input
              value={imageSearch}
              onChange={(e) => setImageSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void searchOnlineImages();
                }
              }}
              placeholder="Search image..."
              className="h-10 flex-1 rounded-xl border border-gray-300 px-3 text-[12px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
            />

            <button
              type="button"
              onClick={() => void searchOnlineImages()}
              disabled={searchingImages}
              className="h-10 rounded-xl bg-black px-3 text-[11px] font-medium text-white disabled:opacity-40"
            >
              {searchingImages ? "Searching..." : "Search"}
            </button>
          </div>

          {searchingImages ? (
            <div className="mt-3 text-xs text-gray-500">Searching images...</div>
          ) : null}

          {imageResults.length > 0 ? (
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6">
              {imageResults.map((img, index) => {
                const imageUrl = img.original || img.image || img.thumbnail;
                const thumb = img.thumbnail || imageUrl;

                if (!imageUrl || !thumb) return null;

                return (
                  <button
                    key={`${imageUrl}-${index}`}
                    type="button"
                    onClick={() => void selectOnlinePhoto(img)}
                    className="overflow-hidden rounded-lg border border-gray-200 hover:border-blue-400"
                    title={img.title || "Select photo"}
                  >
                    <img
                      src={thumb}
                      alt={img.title || "Online image"}
                      loading="lazy"
                      decoding="async"
                      className="aspect-square w-full object-cover"
                    />
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {models.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-6 text-gray-900">
          No LED screen models yet.
        </div>
      ) : (
        <DndContext
          sensors={modelSensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => {
            if (!reorderable) return;
            const { active, over } = event;
            if (!over || active.id === over.id) return;
            void reorderModels(String(active.id), String(over.id));
          }}
        >
          <SortableContext
            items={parsedModels.map((currentModel) => currentModel.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-3">
              {parsedModels.map((currentModel) => (
                <SortableLedModel
                  key={currentModel.id}
                  id={currentModel.id}
                  disabled={!reorderable}
                >
                  <LedModelCard
                    model={currentModel}
                    brand={currentModel.parsed.brand}
                    modelName={currentModel.parsed.model}
                    editable={editable}
                    reorderable={reorderable}
                    selectedModel={selectedModelId === currentModel.id}
                    onSelectModel={() => {
                      setSelectedModelId(currentModel.id);
                      setSelectedRowId(null);
                    }}
                    selectedRowId={selectedRowId}
                    onSelectRow={(rowId) => {
                      setSelectedRowId(rowId);
                      setSelectedModelId(null);
                    }}
                    onRowsReorder={reorderRows}
                    getReportHref={getReportHref}
                    allocationsByRow={allocationsByRow}
                    activeDraftList={activeDraftList}
                    onAddToList={(row) =>
                      setListPickerTarget({ model: currentModel, row })
                    }
                  />
                </SortableLedModel>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {addingModelId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-[18px] font-semibold text-gray-900">Add Cabinet</h3>

            <div className="mt-4 grid grid-cols-1 gap-3">
              <input
                value={addCabinetSize}
                onChange={(e) => setAddCabinetSize(e.target.value)}
                placeholder="Cabinet Size (e.g. 500mm X 500mm)"
                className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
              />

              <input
                value={addCabinetModel}
                onChange={(e) => setAddCabinetModel(e.target.value)}
                placeholder="Cabinet Model (e.g. Flexible / 90 Degree)"
                className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
              />

              <input
                type="number"
                min={0}
                value={String(addCabinetQty)}
                onChange={(e) => setAddCabinetQty(clampQty(e.target.value))}
                placeholder="Qty by Panel"
                className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
              />

              <div id="led-add-cabinet-photo-menu" className="relative">
                <button
                  type="button"
                  onClick={() => setAddCabinetPhotoMenuOpen((v) => !v)}
                  className="flex h-11 w-full items-center justify-center gap-1 rounded-2xl border border-gray-300 bg-white px-4 text-[12px] font-medium text-gray-700 shadow-sm transition hover:bg-red-50 hover:border-red-200 hover:text-red-700"
                >
                  {addCabinetPhoto ? "Photo ✔" : "Add photo"}
                  <ChevronDown size={13} />
                </button>

                {addCabinetPhotoMenuOpen ? (
                  <div className="absolute right-0 top-full z-[9999] mt-2 w-40 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
                    <button
                      type="button"
                      onClick={() => {
                        setPhotoTarget({ type: "addCabinet" });
                        setAddCabinetPhotoMenuOpen(false);
                        addCabinetPhotoFileRef.current?.click();
                      }}
                      className="block w-full px-3 py-2 text-left text-[11px] text-gray-700 hover:bg-gray-50"
                    >
                      Upload photo
                    </button>

                    <button
                      type="button"
                      onClick={startSearchForAddCabinetPhoto}
                      className="block w-full px-3 py-2 text-left text-[11px] text-gray-700 hover:bg-gray-50"
                    >
                      Search photo
                    </button>
                  </div>
                ) : null}
              </div>

              {searchPanelOpen && photoTarget?.type === "addCabinet" ? (
                <div className="rounded-2xl border border-gray-200 p-3 relative z-[9999] bg-white">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="text-[12px] font-semibold text-gray-900">
                      Search photo online
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setSearchPanelOpen(false);
                        setImageResults([]);
                        setPhotoTarget(null);
                      }}
                      className="text-[10px] text-red-500 hover:text-black"
                    >
                      Close
                    </button>
                  </div>

                  <div className="flex gap-2">
                    <input
                      value={imageSearch}
                      onChange={(e) => setImageSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void searchOnlineImages();
                        }
                      }}
                      placeholder="Search image..."
                      className="h-10 flex-1 rounded-xl border border-gray-300 px-3 text-[12px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
                    />

                    <button
                      type="button"
                      onClick={() => void searchOnlineImages()}
                      disabled={searchingImages}
                      className="h-10 rounded-xl bg-black px-3 text-[11px] font-medium text-white disabled:opacity-40"
                    >
                      {searchingImages ? "Searching..." : "Search"}
                    </button>
                  </div>

                  {searchingImages ? (
                    <div className="mt-3 text-xs text-gray-500">Searching images...</div>
                  ) : null}

                  {imageResults.length > 0 ? (
                    <div className="mt-3 grid max-h-[260px] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
                      {imageResults.map((img, index) => {
                        const imageUrl = img.original || img.image || img.thumbnail;
                        const thumb = img.thumbnail || imageUrl;

                        if (!imageUrl || !thumb) return null;

                        return (
                          <button
                            key={`${imageUrl}-${index}`}
                            type="button"
                            onClick={() => void selectOnlinePhoto(img)}
                            className="overflow-hidden rounded-lg border border-gray-200 hover:border-blue-400"
                            title={img.title || "Select photo"}
                          >
                            <img
                              src={thumb}
                              alt={img.title || "Online image"}
                              className="aspect-square w-full object-cover"
                            />
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {addCabinetPhoto ? (
                <div className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-gray-50 p-2">
                  <img
                    src={addCabinetPhoto}
                    alt="Selected"
                    loading="lazy"
                    decoding="async"
                    className="h-12 w-12 rounded-xl object-cover border border-gray-200 bg-white"
                  />

                  <button
                    type="button"
                    onClick={() => setAddCabinetPhoto(null)}
                    className="text-[10px] font-medium text-red-500 hover:text-black"
                  >
                    Remove photo
                  </button>
                </div>
              ) : null}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={closeAddCabinetPopup}
                className="rounded-full border px-4 py-1 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={saveAddCabinetPopup}
                disabled={savingAddCabinet}
                className="rounded-full bg-black px-4 py-1 text-xs text-white disabled:opacity-50"
              >
                {savingAddCabinet ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SortableLedModel({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.65 : 1,
    zIndex: isDragging ? 9999 : "auto",
    position: "relative",
  };

  return (
    <div ref={setNodeRef} style={style} className="relative pl-2 sm:pl-3">
      {!disabled ? (
        <button
          type="button"
          data-led-model-select="true"
          {...attributes}
          {...listeners}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          className="absolute left-0 top-5 z-30 flex h-11 w-4 cursor-grab touch-none items-center justify-center rounded-r-md bg-white/95 text-gray-400 shadow-sm ring-1 ring-gray-200 hover:bg-gray-50 hover:text-red-500 active:cursor-grabbing"
          aria-label="Drag to reorder LED model"
          title="Drag to reorder model"
        >
          <span className="h-7 w-1 rounded-full bg-current" />
        </button>
      ) : null}
      {children}
    </div>
  );
}

function LedModelCard({
  model,
  brand,
  modelName,
  editable,
  reorderable,
  selectedModel,
  onSelectModel,
  selectedRowId,
  onSelectRow,
  onRowsReorder,
  getReportHref,
  allocationsByRow,
  activeDraftList,
  onAddToList,
}: {
  model: MatrixModel;
  brand: string;
  modelName: string;
  editable: boolean;
  reorderable: boolean;
  selectedModel: boolean;
  onSelectModel: () => void;
  selectedRowId: string | null;
  onSelectRow: (rowId: string) => void;
  onRowsReorder: (modelId: string, activeId: string, overId: string) => Promise<void>;
  getReportHref: (rowId: string) => string;
  allocationsByRow: Record<string, ActiveAllocation[]>;
  activeDraftList: EquipmentList | null;
  onAddToList: (row: MatrixRow) => void;
}) {
  const rows = sortRows(model.matrix_rows);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const totalDisplay = rows.reduce(
    (sum, row) => sum + toSqm(clampQty(row.qty), row.size),
    0
  );
  const availableDisplay = rows.reduce(
    (sum, row) => {
      const activeAllocated = movementAllocationQuantity(
        allocationsByRow[row.id] ?? [],
      );
      const allocated =
        activeAllocated + existingMovementQuantity(row, activeAllocated);
      return (
        sum +
        toSqm(
          rowAvailableFromTotal(
            clampQty(row.qty),
            allocated,
            clampQty(row.maintenance_qty),
          ),
          row.size,
        )
      );
    },
    0
  );
  const maintenanceDisplay = rows.reduce(
    (sum, row) => sum + toSqm(clampQty(row.maintenance_qty), row.size),
    0
  );
  const modelMovementMap = new Map<string, ActiveAllocation>();
  for (const row of rows) {
    for (const allocation of allocationsByRow[row.id] ?? []) {
      const current = modelMovementMap.get(allocation.listId);
      if (current) current.quantity += allocation.quantity;
      else modelMovementMap.set(allocation.listId, { ...allocation });
    }
  }
  const modelMovements = Array.from(modelMovementMap.values());
  const modelExistingMovement = rows.reduce((total, row) => {
    const activeAllocated = movementAllocationQuantity(
      allocationsByRow[row.id] ?? [],
    );
    return total + existingMovementQuantity(row, activeAllocated);
  }, 0);

  function handleDragEnd(event: any) {
    if (!reorderable) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    void onRowsReorder(model.id, String(active.id), String(over.id));
  }

  return (
    <div
      data-led-model-card="true"
      className={`rounded-2xl border bg-white p-3 transition sm:p-4 ${
        selectedModel
          ? "border-black ring-2 ring-black"
          : "border-gray-200"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
  <div className="flex items-start gap-3 min-w-0 flex-[1.45]">
    <div className="min-w-0 flex-1">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <button
          type="button"
          data-led-model-select="true"
          onClick={onSelectModel}
          className="relative min-w-0 flex-1 cursor-pointer text-left"
        >
          <h2
            className="truncate text-[13px] sm:text-[15px] text-gray-900"
            style={{ lineHeight: 1.1 }}
          >
            <span className="font-bold">{brand}</span>
            {modelName ? <span>{` ${modelName}`}</span> : null}
          </h2>
        </button>

        {editable ? (
          <button
            type="button"
            data-led-model-select="true"
            aria-label={`Open ${model.name} tools`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelectModel();
            }}
            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border border-gray-300 bg-white text-base font-bold text-gray-700 shadow-sm sm:hidden"
          >
            ⋮
          </button>
        ) : null}
      </div>

      <div className="mt-2 sm:hidden">
        <div className={`grid gap-x-1.5 gap-y-1 text-center ${
          maintenanceDisplay > 0 ? "grid-cols-3" : "grid-cols-2"
        }`}>
          <ModelMobileStat label="Total" value={totalDisplay} tone="gray" />
          <ModelMobileStat label="Available" value={availableDisplay} tone="green" />
          {maintenanceDisplay > 0 ? (
            <ModelMobileStat label="Maintenance" value={maintenanceDisplay} tone="yellow" />
          ) : null}
        </div>
      </div>

      <div className="mt-1 hidden sm:block">
        <div className="flex flex-wrap gap-2">
          <SmallStat label="Total" value={totalDisplay} tone="gray" />
          <SmallStat label="Available" value={availableDisplay} tone="green" />
          {maintenanceDisplay > 0 ? (
            <SmallStat label="Maintenance" value={maintenanceDisplay} tone="yellow" />
          ) : null}
        </div>
      </div>

      {modelMovements.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {modelMovements.map((allocation) => (
            <Link
              key={allocation.listId}
              href={`/inventory/lists/${allocation.listId}`}
              onClick={(event) => event.stopPropagation()}
              title={`${allocation.reference} · ${allocation.label}`}
              className={`max-w-full truncate rounded-lg px-2 py-1 text-[9px] font-semibold transition hover:opacity-80 ${
                allocation.listType === "maintenance"
                  ? "bg-amber-100 text-amber-800"
                  : allocation.status === "partially_returned"
                  ? "bg-purple-100 text-purple-800"
                  : "bg-blue-100 text-blue-800"
              }`}
            >
              {allocation.quantity} pcs · {allocation.label}
            </Link>
          ))}
        </div>
      ) : null}
      {modelExistingMovement > 0 ? (
        <div className="mt-2">
          <span className="rounded-lg bg-gray-100 px-2 py-1 text-[9px] font-semibold text-gray-600">
            {modelExistingMovement} pcs · Existing movement
          </span>
        </div>
      ) : null}
    </div>
  </div>
</div>

      <div className="mt-4 overflow-visible rounded-2xl border border-gray-200 bg-white">
        <div className="hidden sm:block">
          <div className="grid grid-cols-[64px_1.1fr_1.1fr_90px_90px_90px_minmax(150px,1fr)_52px_28px] bg-gray-100 px-3 py-2 text-[10px] font-bold text-gray-600 items-center gap-1">
            <div>Photo</div>
            <div>Cabinet Model</div>
            <div>Cabinet Size</div>
            <div className="text-center">Total</div>
            <div className="text-center">Available</div>
            <div className="text-center">Maintenance</div>
            <div>Active Movement</div>
            <div className="text-center">Report</div>
            <div />
          </div>

          {rows.length === 0 ? (
            <div className="px-3 py-3 text-[10px] text-gray-400">
              No cabinet sizes yet.
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={rows.map((r) => r.id)}
                strategy={verticalListSortingStrategy}
              >
                {rows.map((r) => (
                  <SortableCabinetRow key={r.id} id={r.id} disabled={!reorderable}>
                    <DesktopEditableCabinetRow
                      row={r}
                      selected={selectedRowId === r.id}
                      onSelect={() => onSelectRow(r.id)}
                      reportHref={getReportHref(r.id)}
                      allocations={allocationsByRow[r.id] ?? []}
                      activeDraftList={activeDraftList}
                      onAddToList={() => onAddToList(r)}
                    />
                  </SortableCabinetRow>
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>

        <div className="space-y-2 p-2 sm:hidden">
          {rows.length === 0 ? (
            <div className="px-2 py-3 text-[10px] text-gray-400">
              No cabinet sizes yet.
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={rows.map((r) => r.id)}
                strategy={verticalListSortingStrategy}
              >
                {rows.map((r) => (
                  <SortableCabinetRow key={r.id} id={r.id} disabled={!reorderable}>
                    <div
                      onClick={() => {
                        window.location.href = getReportHref(r.id);
                      }}
                      className="relative cursor-pointer rounded-2xl border border-gray-100 bg-white px-2 py-2 pr-10"
                    >
                      {editable ? (
                        <button
                          type="button"
                          data-led-cabinet-row="true"
                          aria-label={`Open ${r.cabinet_model || r.size} tools`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onSelectRow(r.id);
                          }}
                          className="absolute right-2 top-2 z-30 flex h-[26px] w-[26px] items-center justify-center rounded-full border border-gray-300 bg-white text-base font-bold text-gray-700 shadow-sm"
                        >
                          ⋮
                        </button>
                      ) : null}

                      {activeDraftList ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onAddToList(r);
                          }}
                          title={`Add cabinets to ${activeDraftList.reference}`}
                          className={`absolute top-2 z-20 inline-flex h-[26px] min-w-[26px] items-center justify-center rounded-full bg-black px-2 text-[9px] font-semibold text-white shadow-sm ${
                            editable ? "right-10" : "right-2"
                          }`}
                        >
                          + List
                        </button>
                      ) : null}

                      <div className="flex items-start gap-3">
                        <PhotoBox
                          photo={r.photo_data}
                          name={r.size}
                        />

                        <div className="min-w-0 flex-1">
                          <div className="mb-2 flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-baseline gap-1.5">
                                <div
                                  className="min-w-0 truncate text-left text-[10px] font-bold text-gray-900"
                                  title={r.cabinet_model || "No model"}
                                >
                                  {r.cabinet_model || "No model"}
                                </div>

                                <div
                                  className="min-w-0 truncate text-left text-[9px] font-medium text-gray-500"
                                  title={r.size}
                                >
                                  {r.size}
                                </div>
                              </div>
                            </div>

                            <div />
                          </div>

                          <div
                            className={`grid gap-x-1 gap-y-1 text-center ${
                              clampQty(r.maintenance_qty) > 0
                                ? "grid-cols-3"
                                : "grid-cols-2"
                            }`}
                          >
                            <MobileStat
                              label="Total"
                              value={toSqm(r.qty, r.size)}
                              tone="gray"
                            />

                            <MobileStat
                              label="Available"
                              value={toSqm(
                                rowAvailableFromTotal(
                                  clampQty(r.qty),
                                  movementAllocationQuantity(
                                    allocationsByRow[r.id] ?? [],
                                  ) +
                                    existingMovementQuantity(
                                      r,
                                      movementAllocationQuantity(
                                        allocationsByRow[r.id] ?? [],
                                      ),
                                    ),
                                  clampQty(r.maintenance_qty),
                                ),
                                r.size,
                              )}
                              tone="green"
                            />

                            {clampQty(r.maintenance_qty) > 0 ? (
                              <MobileStat
                                label="Maintenance"
                                value={toSqm(r.maintenance_qty, r.size)}
                                tone="yellow"
                              />
                            ) : null}
                          </div>

                          {(allocationsByRow[r.id] ?? []).length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {(allocationsByRow[r.id] ?? []).map(
                                (allocation) => (
                                  <span
                                    key={allocation.listId}
                                    className={`max-w-full truncate rounded-md px-1.5 py-1 text-[8px] font-semibold ${
                                      allocation.listType === "maintenance"
                                        ? "bg-amber-100 text-amber-800"
                                        : allocation.status ===
                                      "partially_returned"
                                        ? "bg-purple-100 text-purple-800"
                                        : "bg-blue-100 text-blue-800"
                                    }`}
                                  >
                                    {allocation.quantity} pcs · {allocation.label}
                                  </span>
                                ),
                              )}
                            </div>
                          ) : null}
                          {existingMovementQuantity(
                            r,
                            movementAllocationQuantity(
                              allocationsByRow[r.id] ?? [],
                            ),
                          ) > 0 ? (
                            <div className="mt-1">
                              <span className="rounded-md bg-gray-100 px-1.5 py-1 text-[8px] font-semibold text-gray-600">
                                {existingMovementQuantity(
                                  r,
                                  movementAllocationQuantity(
                                    allocationsByRow[r.id] ?? [],
                                  ),
                                )}{" "}
                                pcs · Existing movement
                              </span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </SortableCabinetRow>
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

    </div>
  );
}

function SortableCabinetRow({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.65 : 1,
    zIndex: isDragging ? 9999 : "auto",
    position: "relative",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative"
    >
      {!disabled ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          className="absolute -left-1 top-1/2 z-20 flex h-9 w-4 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-r-md bg-white/90 text-gray-400 shadow-sm ring-1 ring-gray-200 hover:bg-gray-50 hover:text-red-500 active:cursor-grabbing"
          aria-label="Drag to reorder cabinet"
          title="Drag to reorder"
        >
          <span className="h-5 w-1 rounded-full bg-current" />
        </button>
      ) : null}

      {children}
    </div>
  );
}

function DesktopEditableCabinetRow({
  row,
  selected,
  onSelect,
  reportHref,
  allocations,
  activeDraftList,
  onAddToList,
}: {
  row: MatrixRow;
  selected: boolean;
  onSelect: () => void;
  reportHref: string;
  allocations: ActiveAllocation[];
  activeDraftList: EquipmentList | null;
  onAddToList: () => void;
}) {
  const activeAllocated = movementAllocationQuantity(allocations);
  const legacyMovement = existingMovementQuantity(row, activeAllocated);
  const allocated = activeAllocated + legacyMovement;
  const available = rowAvailableFromTotal(
    clampQty(row.qty),
    allocated,
    clampQty(row.maintenance_qty),
  );

  return (
    <div
      data-led-cabinet-row="true"
      onClick={onSelect}
      className={`grid cursor-pointer grid-cols-[64px_1.1fr_1.1fr_90px_90px_90px_minmax(150px,1fr)_52px_28px] items-center gap-1 border-t border-gray-100 px-3 py-[2px] text-[9px] text-gray-900 transition ${
        selected ? "bg-gray-50 ring-2 ring-inset ring-black" : "hover:bg-gray-50"
      }`}
    >
      <PhotoBox
        photo={row.photo_data}
        name={row.size}
      />

      <div
        className="truncate text-left font-bold"
        title={row.cabinet_model || "No model"}
      >
        {row.cabinet_model || "No model"}
      </div>

      <div
        className="truncate text-left font-medium text-gray-600"
        title={row.size}
      >
        {row.size}
      </div>

      <div className="text-center">
        {formatSqm(toSqm(row.qty, row.size))} SQM
      </div>

      <div className="text-center">
        <span className="inline-flex min-w-7 justify-center rounded-lg bg-green-100 px-2 py-1 font-bold">
  {formatSqm(toSqm(available, row.size))} SQM
</span>
      </div>

      <div className="text-center">
        {clampQty(row.maintenance_qty) > 0 ? (
          <span className="inline-flex min-w-7 justify-center rounded-lg bg-yellow-100 px-2 py-1 font-bold">
            {formatSqm(toSqm(row.maintenance_qty, row.size))} SQM
          </span>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </div>

      <div className="flex min-w-0 flex-wrap gap-1">
        {allocations.length > 0 ? (
          allocations.map((allocation) => (
            <Link
              key={allocation.listId}
              href={`/inventory/lists/${allocation.listId}`}
              onClick={(event) => event.stopPropagation()}
              title={`${allocation.reference} · ${allocation.label}`}
              className={`max-w-full truncate rounded-md px-1.5 py-1 text-[8px] font-semibold transition hover:opacity-80 ${
                allocation.listType === "maintenance"
                  ? "bg-amber-100 text-amber-800"
                  : allocation.status === "partially_returned"
                  ? "bg-purple-100 text-purple-800"
                  : "bg-blue-100 text-blue-800"
              }`}
            >
              {allocation.quantity} pcs · {allocation.label}
            </Link>
          ))
        ) : (
          legacyMovement === 0 ? <span className="text-gray-300">—</span> : null
        )}
        {legacyMovement > 0 ? (
          <span className="max-w-full truncate rounded-md bg-gray-100 px-1.5 py-1 text-[8px] font-semibold text-gray-600">
            {legacyMovement} pcs · Existing movement
          </span>
        ) : null}
      </div>

      <div className="text-center">
        <Link
          href={reportHref}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[8px] font-medium text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
        >
          Report
        </Link>
      </div>

      <div className="text-center">
        {activeDraftList ? (
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onAddToList();
            }}
            title={`Add cabinets to ${activeDraftList.reference}`}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-black text-xs font-bold text-white hover:bg-gray-800"
          >
            +
          </button>
        ) : null}
      </div>
    </div>
  );
}

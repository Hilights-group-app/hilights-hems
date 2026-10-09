"use client";

import {
  ArrowLeft,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Download,
  FilePlus2,
  Loader2,
  PackageCheck,
  Plus,
  RotateCcw,
  Send,
  Share2,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import {
  canManageEquipmentLists,
  getUserDepartment,
  getUserId,
  getUserName,
  getUserRole,
} from "@/lib/authStore";
import { createClient } from "@/lib/supabase/client";
import {
  EQUIPMENT_LIST_ITEMS_EVENT,
  EQUIPMENT_LISTS_EVENT,
  ACTIVE_EQUIPMENT_LIST_EVENT,
  ACTIVE_EQUIPMENT_LIST_KEY,
  equipmentListStatusLabel,
  equipmentListSummary,
  equipmentListTypeLabel,
  type EquipmentList,
  type EquipmentListItem,
  type EquipmentListStatus,
} from "@/lib/equipmentLists";
import EquipmentListUnitPicker from "@/components/EquipmentListUnitPicker";

type DetailedEquipmentList = EquipmentList & {
  submitted_by?: string | null;
  approved_by?: string | null;
  submitted_at?: string | null;
  approved_at?: string | null;
  closed_at?: string | null;
  cancelled_at?: string | null;
};

type ItemGroup = {
  key: string;
  displayName: string;
  blockName: string | null;
  items: EquipmentListItem[];
};

type RackContentRow = {
  id: string;
  item_id: string;
  cable_length: string;
  total_qty: number | null;
};

type ReviewPickerState = {
  item: {
    id: string;
    name: string;
    photo_url: string | null;
    fixture_type: string | null;
  };
  category: string;
  subcategory: string;
};

type ReturnDialogState = {
  item: EquipmentListItem;
  remaining: number;
};

type MaintenanceWorkflowRequest = {
  id: string;
  list_id: string;
  list_item_id: string;
  display_name: string;
  serial_number: string | null;
  quantity: number;
  received_quantity: number;
  tested_quantity: number;
  department: string;
  report_href: string | null;
  status: "sent" | "received" | "resolved";
};

type ListDetailsCache = {
  list: DetailedEquipmentList;
  items: EquipmentListItem[];
  savedAt: number;
};

const listDetailsCache = new Map<string, ListDetailsCache>();
const LIST_DETAILS_CACHE_PREFIX = "hems:list-details:v1";
const LIST_DETAILS_CACHE_MAX_AGE = 30 * 60 * 1000;
const HIDDEN_UNIT_GROUPS_PREFIX = "hems:equipment-list:hidden-unit-groups";
const useClientLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function listDetailsCacheKey(listId: string) {
  const userScope =
    getUserId() ||
    (getUserName() || "signed-in-user").trim().toLowerCase();
  return `${LIST_DETAILS_CACHE_PREFIX}:${encodeURIComponent(userScope)}:${listId}`;
}

function removeListDetailsStorage(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in a private browser session.
  }
}

function readListDetailsCache(listId: string) {
  if (typeof window === "undefined") return null;

  const key = listDetailsCacheKey(listId);
  let cached = listDetailsCache.get(key) ?? null;

  if (!cached) {
    try {
      const raw = sessionStorage.getItem(key);
      cached = raw ? (JSON.parse(raw) as ListDetailsCache) : null;
      if (cached) listDetailsCache.set(key, cached);
    } catch {
      removeListDetailsStorage(key);
      cached = null;
    }
  }

  if (
    cached &&
    (cached.list?.id !== listId ||
      !Array.isArray(cached.items) ||
      Date.now() - Number(cached.savedAt || 0) > LIST_DETAILS_CACHE_MAX_AGE)
  ) {
    listDetailsCache.delete(key);
    removeListDetailsStorage(key);
    return null;
  }

  return cached;
}

function writeListDetailsCache(
  listId: string,
  list: DetailedEquipmentList,
  items: EquipmentListItem[],
) {
  if (typeof window === "undefined") return;

  const key = listDetailsCacheKey(listId);
  const cached: ListDetailsCache = {
    list,
    items,
    savedAt: Date.now(),
  };
  listDetailsCache.set(key, cached);

  try {
    sessionStorage.setItem(key, JSON.stringify(cached));
  } catch {
    // The in-memory cache still keeps browser back/forward navigation instant.
  }

  if (listDetailsCache.size > 20) {
    const oldestKey = listDetailsCache.keys().next().value;
    if (oldestKey) {
      listDetailsCache.delete(oldestKey);
      removeListDetailsStorage(oldestKey);
    }
  }
}

function clearListDetailsCache(listId: string) {
  if (typeof window === "undefined") return;
  const key = listDetailsCacheKey(listId);
  listDetailsCache.delete(key);
  removeListDetailsStorage(key);
}

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
  repair_company,
  maintenance_sent_date,
  notes,
  created_by,
  created_by_name,
  created_at,
  updated_at,
  submitted_by,
  approved_by,
  submitted_at,
  approved_at,
  closed_at,
  cancelled_at
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

function statusClass(status: EquipmentListStatus) {
  if (status === "draft") return "bg-gray-100 text-gray-700";
  if (status === "pending") return "bg-amber-100 text-amber-800";
  if (status === "active") return "bg-blue-100 text-blue-800";
  if (status === "partially_returned") return "bg-purple-100 text-purple-800";
  if (status === "closed") return "bg-green-100 text-green-800";
  return "bg-red-100 text-red-800";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function metadataText(item: EquipmentListItem, key: string) {
  const value = item.metadata?.[key];
  return typeof value === "string" ? value : "";
}

type EquipmentDisplayParts = {
  brand: string;
  model: string;
  primaryName: string;
  cabinetDetail: string;
};

function equipmentDisplayParts(
  item: EquipmentListItem,
  displayName: string,
): EquipmentDisplayParts {
  const cleanName = displayName.trim();
  const isGenericMatrix =
    item.inventory_record_type === "matrix_model" ||
    (item.inventory_record_type === "matrix_row" &&
      item.metadata?.matrix_source === "generic");
  const isLedCabinet =
    item.inventory_record_type === "matrix_row" && !isGenericMatrix;
  const displaySegments = isLedCabinet
    ? cleanName
        .split(/\s*·\s*/)
        .map((part) => part.trim())
        .filter(Boolean)
    : [cleanName];
  const primaryName = displaySegments[0] || cleanName;
  const cabinetModel = isLedCabinet
    ? metadataText(item, "cabinet_model").trim() || displaySegments[1] || ""
    : "";
  const cabinetSize = isLedCabinet
    ? metadataText(item, "cabinet_size").trim() || displaySegments[2] || ""
    : "";
  const cabinetDetail = [
    cabinetModel ? `Cabinet: ${cabinetModel}` : "",
    cabinetSize,
  ]
    .filter(Boolean)
    .join(" · ");

  if (isLedCabinet && !primaryName.includes(" - ")) {
    const firstSpace = primaryName.indexOf(" ");
    if (firstSpace > 0) {
      return {
        brand: primaryName.slice(0, firstSpace).trim(),
        model: primaryName.slice(firstSpace + 1).trim(),
        primaryName,
        cabinetDetail,
      };
    }
  }

  if (
    item.inventory_record_type === "item" ||
    isGenericMatrix ||
    !primaryName.includes(" - ")
  ) {
    return {
      brand: "",
      model: primaryName,
      primaryName,
      cabinetDetail,
    };
  }

  const [brand, ...modelParts] = primaryName
    .split(" - ")
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    brand: brand || "",
    model: modelParts.join(" - "),
    primaryName,
    cabinetDetail,
  };
}

function formatSquareMetres(value: number) {
  return `${Number(value.toFixed(3))} SQM`;
}

function formatUnitQuantity(value: number) {
  return `${value} ${value === 1 ? "Unit" : "Units"}`;
}

function unitLabel(item: EquipmentListItem) {
  if (item.inventory_record_type === "item") {
    return "Not in Inventory";
  }

  if (
    item.inventory_record_type === "matrix_model" ||
    (item.inventory_record_type === "matrix_row" &&
      item.metadata?.matrix_source === "generic")
  ) {
    const rowLabel = metadataText(item, "row_label");
    return rowLabel
      ? `${rowLabel} · ${formatUnitQuantity(item.requested_quantity)}`
      : formatUnitQuantity(item.requested_quantity);
  }

  if (item.inventory_record_type === "matrix_row") {
    const actualSquareMetres = Number(item.metadata?.actual_sqm);
    if (Number.isFinite(actualSquareMetres) && actualSquareMetres > 0) {
      return formatSquareMetres(actualSquareMetres);
    }
    return formatUnitQuantity(item.requested_quantity);
  }

  const unitNo = item.metadata?.unit_no;
  const hasUnitNo =
    typeof unitNo === "number" ||
    (typeof unitNo === "string" && unitNo.trim().length > 0);
  const idLabel =
    hasUnitNo
      ? String(unitNo).trim()
      : item.inventory_record_id.slice(0, 8).toUpperCase();
  const serial = item.serial_number?.trim();

  return serial
    ? `ID: ${idLabel} - Serial: ${serial}`
    : `ID: ${idLabel}`;
}

function pdfUnitLabel(item: EquipmentListItem) {
  return unitLabel(item)
    .replace(/^ID:\s*/, "ID ")
    .replace(/\s+-\s+Serial:\s*/, " / SN ");
}

function groupItems(items: EquipmentListItem[]) {
  const groups = new Map<string, ItemGroup>();

  for (const item of items) {
    const isGenericMatrixChild =
      item.inventory_record_type === "matrix_row" &&
      item.metadata?.matrix_source === "generic" &&
      Boolean(item.parent_record_id);
    const key =
      isGenericMatrixChild
        ? `matrix_parent:${item.parent_record_id}`
        : item.inventory_record_type === "matrix_row" ||
      item.inventory_record_type === "matrix_model" ||
      item.inventory_record_type === "item"
        ? `${item.inventory_record_type}:${item.inventory_record_id}`
        : item.parent_record_id
          ? `${item.inventory_record_type}:${item.parent_record_id}`
          : `${item.inventory_record_type}:${item.display_name}`;
    const current = groups.get(key);

    if (current) {
      current.items.push(item);
    } else {
      groups.set(key, {
        key,
        displayName: item.display_name,
        blockName: item.block_name,
        items: [item],
      });
    }
  }

  return Array.from(groups.values());
}

function categoryLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "Equipment";
  if (normalized.includes("lighting")) return "Lighting";
  if (
    normalized.includes("truss") ||
    normalized.includes("rigging") ||
    normalized.includes("hoist")
  ) {
    return "Rigging";
  }
  if (
    normalized.includes("video") ||
    normalized.includes("led") ||
    normalized.includes("projector")
  ) {
    return "Video";
  }

  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function categoryRank(label: string) {
  const order = ["Lighting", "Video", "Rigging", "Audio", "Power", "Other"];
  const index = order.indexOf(label);
  return index === -1 ? order.length : index;
}

function scheduleRows(list: EquipmentList) {
  if (list.list_type === "dry_hire") {
    return [
      { label: "Pickup Date", value: formatDate(list.pickup_date) },
      { label: "Return Date", value: formatDate(list.return_date) },
    ];
  }

  if (list.list_type === "local_event") {
    return [
      { label: "Setup Date", value: formatDate(list.setup_date) },
      { label: "Dismantling Date", value: formatDate(list.dismantling_date) },
    ];
  }

  if (list.list_type === "transfer_out") {
    return [{ label: "Loading Date", value: formatDate(list.loading_date) }];
  }

  if (list.list_type === "transfer_in") {
    return [{ label: "Receiving Date", value: formatDate(list.receiving_date) }];
  }

  if (list.list_type === "maintenance") {
    return [
      { label: "Send Date", value: formatDate(list.maintenance_sent_date) },
    ];
  }

  return [];
}

type PdfLogo = {
  dataUrl: string;
  width: number;
  height: number;
};

type PdfItemPhoto = PdfLogo;

async function loadPdfLogo(): Promise<PdfLogo | null> {
  try {
    const response = await fetch("/logo.png", { cache: "force-cache" });
    if (!response.ok) return null;

    const blob = await response.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read the logo."));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsDataURL(blob);
    });

    const dimensions = await new Promise<{ width: number; height: number }>(
      (resolve, reject) => {
        const image = new Image();
        image.onerror = () => reject(new Error("Failed to load the logo."));
        image.onload = () =>
          resolve({
            width: image.naturalWidth || image.width,
            height: image.naturalHeight || image.height,
          });
        image.src = dataUrl;
      },
    );

    return { dataUrl, ...dimensions };
  } catch (error) {
    console.warn("PDF logo could not be loaded", error);
    return null;
  }
}

async function loadPdfItemPhoto(source: string): Promise<PdfItemPhoto | null> {
  if (!source.trim()) return null;

  try {
    let sourceDataUrl = source;

    if (!source.startsWith("data:image/")) {
      const response = await fetch(source, { cache: "force-cache" });
      if (!response.ok) return null;

      const blob = await response.blob();
      sourceDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Failed to read item photo."));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(blob);
      });
    }

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onerror = () => reject(new Error("Failed to load item photo."));
      nextImage.onload = () => resolve(nextImage);
      nextImage.src = sourceDataUrl;
    });

    const originalWidth = image.naturalWidth || image.width;
    const originalHeight = image.naturalHeight || image.height;
    if (!originalWidth || !originalHeight) return null;

    const maxSide = 240;
    const scale = Math.min(1, maxSide / Math.max(originalWidth, originalHeight));
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
      dataUrl: canvas.toDataURL("image/jpeg", 0.82),
      width,
      height,
    };
  } catch {
    return null;
  }
}

function pdfFileName(list: EquipmentList) {
  const type = equipmentListTypeLabel(list.list_type).trim();
  const summary = equipmentListSummary(list).trim();
  const parts = [
    type,
    summary && summary.toLowerCase() !== type.toLowerCase() ? summary : "",
    list.reference,
  ].filter(Boolean);

  const safeName = parts
    .join(" ")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return `${safeName || list.reference}.pdf`;
}

function displayedStatusLabel(list: EquipmentList) {
  if (list.list_type === "internal_use") return "Internal Use";
  return equipmentListStatusLabel(list.status);
}

export default function EquipmentListDetailsClient({
  listId,
}: {
  listId: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [isManager, setIsManager] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentRole, setCurrentRole] = useState("");
  const [currentDepartment, setCurrentDepartment] = useState("");
  const [list, setList] = useState<DetailedEquipmentList | null>(null);
  const [items, setItems] = useState<EquipmentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [returningItemId, setReturningItemId] = useState<string | null>(null);
  const [returnDialog, setReturnDialog] = useState<ReturnDialogState | null>(
    null,
  );
  const [returnOkQuantity, setReturnOkQuantity] = useState(0);
  const [removingItemId, setRemovingItemId] = useState<string | null>(null);
  const [reviewPicker, setReviewPicker] = useState<ReviewPickerState | null>(
    null,
  );
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [deletingList, setDeletingList] = useState(false);
  const [pdfAction, setPdfAction] = useState<"download" | "share" | null>(
    null,
  );
  const [customItemOpen, setCustomItemOpen] = useState(false);
  const [addingCustomItem, setAddingCustomItem] = useState(false);
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null);
  const [hiddenUnitGroups, setHiddenUnitGroups] = useState<string[]>([]);
  const [rackRowsByModel, setRackRowsByModel] = useState<
    Record<string, RackContentRow[]>
  >({});
  const [rackRowsLoading, setRackRowsLoading] = useState(false);
  const [maintenanceRequests, setMaintenanceRequests] = useState<
    MaintenanceWorkflowRequest[]
  >([]);
  const [maintenanceActionId, setMaintenanceActionId] = useState<string | null>(
    null,
  );

  useClientLayoutEffect(() => {
    try {
      const saved = localStorage.getItem(
        `${HIDDEN_UNIT_GROUPS_PREFIX}:${listId}`,
      );
      const parsed = saved ? JSON.parse(saved) : [];
      setHiddenUnitGroups(
        Array.isArray(parsed)
          ? parsed.filter((value): value is string => typeof value === "string")
          : [],
      );
    } catch {
      setHiddenUnitGroups([]);
    }
  }, [listId]);

  useClientLayoutEffect(() => {
    const cached = readListDetailsCache(listId);

    if (cached) {
      setList(cached.list);
      setItems(cached.items);
      setLoading(false);
      return;
    }

    setList(null);
    setItems([]);
    setLoading(true);
  }, [listId]);

  useEffect(() => {
    setIsManager(canManageEquipmentLists());
    setCurrentUserId(getUserId());
    setCurrentRole(getUserRole() || "");
    setCurrentDepartment((getUserDepartment() || "").toLowerCase());

    let cancelled = false;

    async function loadManagerAccess() {
      const managerResult = await supabase.rpc("is_equipment_list_manager");

      if (cancelled) return;

      if (managerResult.error) {
        console.error(
          "equipment list manager access error",
          managerResult.error,
        );
        return;
      }

      setIsManager(managerResult.data === true);
    }

    void loadManagerAccess();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const cached = readListDetailsCache(listId);

      if (cached) {
        setList(cached.list);
        setItems(cached.items);
        setLoading(false);
      } else {
        setLoading(true);
      }

      setError("");

      const [listResult, itemsResult] = await Promise.all([
        supabase
          .from("equipment_lists")
          .select(LIST_SELECT)
          .eq("id", listId)
          .single(),
        supabase
          .from("equipment_list_items")
          .select(LIST_ITEM_SELECT)
          .eq("list_id", listId)
          .order("created_at", { ascending: true }),
      ]);

      if (cancelled) return;

      if (listResult.error || !listResult.data) {
        console.error("equipment list details load error", listResult.error);

        if (cached) {
          setError("The latest list changes could not be refreshed.");
          setLoading(false);
          return;
        }

        setList(null);
        setItems([]);
        setError("Equipment list not found.");
        setLoading(false);
        return;
      }

      const nextList = listResult.data as DetailedEquipmentList;
      let nextItems: EquipmentListItem[];

      if (itemsResult.error) {
        console.error("equipment list items load error", itemsResult.error);
        setError("The list opened, but its equipment could not be loaded.");
        nextItems = cached?.items ?? [];
      } else {
        nextItems = (itemsResult.data ?? []) as EquipmentListItem[];
      }

      setList(nextList);
      setItems(nextItems);
      writeListDetailsCache(listId, nextList, nextItems);
      setLoading(false);
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [listId, supabase]);

  async function refreshMaintenanceRequests() {
    if (list?.list_type !== "maintenance") {
      setMaintenanceRequests([]);
      return;
    }

    const { data, error: requestsError } = await supabase
      .from("maintenance_requests")
      .select(
        "id,list_id,list_item_id,display_name,serial_number,quantity,received_quantity,tested_quantity,department,report_href,status",
      )
      .eq("list_id", list.id)
      .eq("source_type", "maintenance")
      .order("created_at", { ascending: true });

    if (requestsError) {
      console.error("load maintenance workflow requests error", requestsError);
      setError(
        "The repair workflow could not be loaded. Run the maintenance SQL migration.",
      );
      return;
    }

    setMaintenanceRequests(
      (data ?? []) as MaintenanceWorkflowRequest[],
    );
  }

  useEffect(() => {
    if (!list || list.list_type !== "maintenance") {
      setMaintenanceRequests([]);
      return;
    }

    void refreshMaintenanceRequests();
    // The list ID and status are sufficient; refresh actions call this directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list?.id, list?.list_type, list?.status]);

  useEffect(() => {
    let cancelled = false;
    const rackModelIds = Array.from(
      new Set(
        items
          .filter(
            (item) =>
              item.inventory_record_type === "matrix_model" &&
              metadataText(item, "item_type") === "rack",
          )
          .map((item) => item.inventory_record_id),
      ),
    );

    if (rackModelIds.length === 0) {
      setRackRowsByModel({});
      setRackRowsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    async function loadRackRows() {
      setRackRowsLoading(true);

      const { data, error: rackRowsError } = await supabase
        .from("matrix_rows")
        .select("id,item_id,cable_length,total_qty")
        .in("item_id", rackModelIds);

      if (cancelled) return;

      if (rackRowsError) {
        console.error("load rack contents error", rackRowsError);
        setRackRowsByModel({});
        setRackRowsLoading(false);
        return;
      }

      const grouped: Record<string, RackContentRow[]> = {};
      for (const row of (data ?? []) as RackContentRow[]) {
        if (!grouped[row.item_id]) grouped[row.item_id] = [];
        grouped[row.item_id].push(row);
      }

      for (const modelId of Object.keys(grouped)) {
        grouped[modelId].sort((left, right) =>
          left.cable_length.localeCompare(right.cable_length, undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        );
      }

      setRackRowsByModel(grouped);
      setRackRowsLoading(false);
    }

    void loadRackRows();

    return () => {
      cancelled = true;
    };
  }, [items, supabase]);

  useEffect(() => {
    if (!loading && list && list.id === listId) {
      writeListDetailsCache(listId, list, items);
    }
  }, [items, list, listId, loading]);

  const groups = useMemo(() => groupItems(items), [items]);
  const sortedGroups = useMemo(
    () =>
      [...groups].sort((left, right) => {
        const leftCategory = categoryLabel(
          metadataText(left.items[0], "category"),
        );
        const rightCategory = categoryLabel(
          metadataText(right.items[0], "category"),
        );
        const categoryOrder =
          categoryRank(leftCategory) - categoryRank(rightCategory) ||
          leftCategory.localeCompare(rightCategory);
        if (categoryOrder !== 0) return categoryOrder;
        return left.displayName.localeCompare(right.displayName);
      }),
    [groups],
  );
  const requestedQuantity = useMemo(
    () =>
      items.reduce(
        (total, item) => total + (item.requested_quantity || 0),
        0,
      ),
    [items],
  );
  const hiddenUnitGroupKeys = useMemo(
    () => new Set(hiddenUnitGroups),
    [hiddenUnitGroups],
  );

  function toggleUnitGroupVisibility(groupKey: string) {
    setHiddenUnitGroups((current) => {
      const next = current.includes(groupKey)
        ? current.filter((key) => key !== groupKey)
        : [...current, groupKey];

      try {
        localStorage.setItem(
          `${HIDDEN_UNIT_GROUPS_PREFIX}:${listId}`,
          JSON.stringify(next),
        );
      } catch {
        // The per-item switch still works for this page session.
      }

      return next;
    });
  }

  const isDraft = list?.status === "draft";
  const isInternalUse = list?.list_type === "internal_use";
  const isMaintenanceList = list?.list_type === "maintenance";
  const isOwner = Boolean(
    list && currentUserId && list.created_by === currentUserId,
  );
  const canEditDraft = Boolean(
    isDraft && (isInternalUse ? isManager : isOwner),
  );
  const canSubmitDraft = Boolean(canEditDraft && !isInternalUse && isOwner);
  const canReview = Boolean(
    isManager && !isInternalUse && list?.status === "pending",
  );
  const canReceiveReturns = Boolean(
    isManager &&
      !isMaintenanceList &&
      (list?.status === "active" || list?.status === "partially_returned"),
  );
  const canReceiveMaintenance = Boolean(
    isManager && isMaintenanceList && list?.status === "active",
  );
  const canChangeItems = Boolean(canEditDraft || canReview);

  function canTestMaintenance(request: MaintenanceWorkflowRequest) {
    return Boolean(
      isMaintenanceList &&
        list?.status === "active" &&
        (currentRole === "admin" ||
          (currentRole === "head" &&
            currentDepartment === request.department.toLowerCase())),
    );
  }

  async function refreshItems() {
    if (!list) return;

    const { data, error: itemsError } = await supabase
      .from("equipment_list_items")
      .select(LIST_ITEM_SELECT)
      .eq("list_id", list.id)
      .order("created_at", { ascending: true });

    if (itemsError) {
      console.error("refresh equipment list items error", itemsError);
      setError("The equipment list could not be refreshed.");
      return;
    }

    setItems((data ?? []) as EquipmentListItem[]);
  }

  async function refreshListAndItems() {
    const [listResult, itemsResult] = await Promise.all([
      supabase
        .from("equipment_lists")
        .select(LIST_SELECT)
        .eq("id", listId)
        .single(),
      supabase
        .from("equipment_list_items")
        .select(LIST_ITEM_SELECT)
        .eq("list_id", listId)
        .order("created_at", { ascending: true }),
    ]);

    if (listResult.error || !listResult.data) {
      throw listResult.error || new Error("The equipment list could not be refreshed.");
    }

    if (itemsResult.error) throw itemsResult.error;

    setList(listResult.data as DetailedEquipmentList);
    setItems((itemsResult.data ?? []) as EquipmentListItem[]);
  }

  function remainingQuantity(item: EquipmentListItem) {
    return Math.max(
      0,
      (Number(item.approved_quantity) || 0) -
        (Number(item.returned_ok_quantity) || 0) -
        (Number(item.returned_maintenance_quantity) || 0),
    );
  }

  async function receiveReturn(
    item: EquipmentListItem,
    okQuantity: number,
  ) {
    if (!list || !canReceiveReturns || returningItemId) return;

    const ok = Math.max(0, Math.floor(Number(okQuantity) || 0));
    const total = ok;
    const remaining = remainingQuantity(item);

    if (total < 1) {
      setError("Enter at least one returned item.");
      return;
    }

    if (total > remaining) {
      setError(`Only ${remaining} item${remaining === 1 ? "" : "s"} remain outside.`);
      return;
    }

    const confirmed = window.confirm(
      `Receive ${item.display_name}: ${ok} item${ok === 1 ? "" : "s"}? Inventory will update immediately.`,
    );
    if (!confirmed) return;

    setReturningItemId(item.id);
    setError("");
    setMessage("");

    try {
      const { error: returnError } = await supabase.rpc(
        "return_equipment_list_item",
        {
          p_list_item_id: item.id,
          p_return_ok_quantity: ok,
          p_return_maintenance_quantity: 0,
        },
      );

      if (returnError) throw returnError;

      await refreshListAndItems();
      setReturnDialog(null);
      setReturnOkQuantity(0);
      setMessage("Return received. The equipment is Available again.");

      window.dispatchEvent(
        new CustomEvent(EQUIPMENT_LISTS_EVENT, {
          detail: { listId: list.id, action: "returned" },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, {
          detail: { listId: list.id },
        }),
      );
    } catch (returnError: any) {
      console.error("receive equipment return error", returnError);
      setError(returnError?.message || "The return could not be saved.");
    } finally {
      setReturningItemId(null);
    }
  }

  async function receiveMaintenanceItem(request: MaintenanceWorkflowRequest) {
    if (!canReceiveMaintenance || maintenanceActionId) return;

    const remaining = Math.max(
      0,
      (Number(request.quantity) || 0) -
        (Number(request.received_quantity) || 0),
    );
    if (remaining === 0) return;

    const confirmed = window.confirm(
      `Mark ${request.display_name} (${remaining} unit${remaining === 1 ? "" : "s"}) as received from repair? It will stay unavailable until it is tested.`,
    );
    if (!confirmed) return;

    setMaintenanceActionId(request.id);
    setError("");
    setMessage("");

    try {
      const { error: receiveError } = await supabase.rpc(
        "receive_maintenance_list_item",
        { p_request_id: request.id },
      );
      if (receiveError) throw receiveError;

      await refreshMaintenanceRequests();
      setMessage("Item received. It is still unavailable and awaiting test.");
      window.dispatchEvent(new CustomEvent("hems:maintenance-requests-change"));
    } catch (receiveError: any) {
      console.error("receive maintenance item error", receiveError);
      setError(
        receiveError?.message || "The repaired item could not be received.",
      );
    } finally {
      setMaintenanceActionId(null);
    }
  }

  async function testMaintenanceItem(request: MaintenanceWorkflowRequest) {
    if (!canTestMaintenance(request) || maintenanceActionId) return;

    const testable = Math.max(
      0,
      (Number(request.received_quantity) || 0) -
        (Number(request.tested_quantity) || 0),
    );
    if (testable === 0) return;

    const confirmed = window.confirm(
      `Confirm ${request.display_name} passed testing? ${testable} unit${testable === 1 ? "" : "s"} will become Available.`,
    );
    if (!confirmed) return;

    setMaintenanceActionId(request.id);
    setError("");
    setMessage("");

    try {
      const { error: testError } = await supabase.rpc(
        "test_maintenance_list_item",
        { p_request_id: request.id },
      );
      if (testError) throw testError;

      await Promise.all([
        refreshListAndItems(),
        refreshMaintenanceRequests(),
      ]);
      setMessage(
        "Test completed. The equipment is Available again; the list closes automatically after every item passes.",
      );
      window.dispatchEvent(new CustomEvent("hems:maintenance-requests-change"));
      window.dispatchEvent(
        new CustomEvent(EQUIPMENT_LISTS_EVENT, {
          detail: { listId: list?.id, action: "maintenance-tested" },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, {
          detail: { listId: list?.id },
        }),
      );
    } catch (testError: any) {
      console.error("test maintenance item error", testError);
      setError(testError?.message || "The test result could not be saved.");
    } finally {
      setMaintenanceActionId(null);
    }
  }

  function openQuantityReturn(item: EquipmentListItem) {
    const remaining = remainingQuantity(item);
    if (remaining < 1) return;

    setReturnDialog({ item, remaining });
    setReturnOkQuantity(remaining);
    setError("");
  }

  async function removeItem(itemId: string) {
    if (!list || !canChangeItems || removingItemId) return;

    setRemovingItemId(itemId);
    setError("");

    const { error: deleteError } = await supabase
      .from("equipment_list_items")
      .delete()
      .eq("id", itemId)
      .eq("list_id", list.id);

    if (deleteError) {
      console.error("remove equipment list item error", deleteError);
      setError(deleteError.message || "Failed to remove the unit.");
      setRemovingItemId(null);
      return;
    }

    setItems((current) => current.filter((item) => item.id !== itemId));
    setRemovingItemId(null);

    window.dispatchEvent(
      new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, {
        detail: { listId: list.id },
      }),
    );
  }

  async function updateItemQuantity(
    item: EquipmentListItem,
    nextValue: number,
    quantityUnit: "units" | "sqm" = "units",
  ) {
    if (!list || !canChangeItems || updatingItemId) return;
    if (item.inventory_record_type === "unit") return;

    const metadata = { ...(item.metadata || {}) };
    const cabinetArea = Number(metadata.cabinet_area_sqm);
    const isSquareMetreQuantity =
      quantityUnit === "sqm" &&
      item.inventory_record_type === "matrix_row" &&
      metadata.matrix_source !== "generic" &&
      Number.isFinite(cabinetArea) &&
      cabinetArea > 0;
    const requestedSquareMetres = isSquareMetreQuantity
      ? Math.max(cabinetArea, Number(nextValue) || cabinetArea)
      : 0;
    const nextQuantity = isSquareMetreQuantity
      ? Math.max(
          1,
          Math.ceil(requestedSquareMetres / cabinetArea - 0.0000001),
        )
      : Math.max(1, Math.floor(Number(nextValue) || 1));
    const nextActualSquareMetres = isSquareMetreQuantity
      ? nextQuantity * cabinetArea
      : 0;
    const currentActualSquareMetres = Number(metadata.actual_sqm);

    if (
      nextQuantity === item.requested_quantity &&
      (!isSquareMetreQuantity ||
        (Number.isFinite(currentActualSquareMetres) &&
          Math.abs(currentActualSquareMetres - nextActualSquareMetres) <
            0.000001))
    ) {
      return;
    }

    setUpdatingItemId(item.id);
    setError("");

    if (
      item.inventory_record_type === "matrix_row" &&
      metadata.matrix_source !== "generic" &&
      Number.isFinite(cabinetArea) &&
      cabinetArea > 0
    ) {
      metadata.requested_sqm = isSquareMetreQuantity
        ? requestedSquareMetres
        : nextQuantity * cabinetArea;
      metadata.actual_sqm = nextQuantity * cabinetArea;
    }

    const { data, error: updateError } = await supabase
      .from("equipment_list_items")
      .update({ requested_quantity: nextQuantity, metadata })
      .eq("id", item.id)
      .eq("list_id", list.id)
      .select(LIST_ITEM_SELECT)
      .single();

    if (updateError || !data) {
      console.error("update equipment list quantity error", updateError);
      setError(updateError?.message || "Failed to update the quantity.");
      setUpdatingItemId(null);
      return;
    }

    setItems((current) =>
      current.map((currentItem) =>
        currentItem.id === item.id
          ? (data as EquipmentListItem)
          : currentItem,
      ),
    );
    window.dispatchEvent(
      new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, {
        detail: { listId: list.id },
      }),
    );
    setUpdatingItemId(null);
  }

  async function addCustomItem(input: {
    name: string;
    category: string;
    quantity: number;
    notes: string;
  }) {
    if (!list || !canChangeItems || addingCustomItem) return;

    const name = input.name.trim();
    const category = input.category.trim().toLowerCase() || "other";
    const quantity = Math.max(1, Math.floor(Number(input.quantity) || 1));
    if (!name) return;

    setAddingCustomItem(true);
    setError("");

    const { data, error: insertError } = await supabase
      .from("equipment_list_items")
      .insert({
        list_id: list.id,
        inventory_record_type: "item",
        inventory_record_id: globalThis.crypto.randomUUID(),
        parent_record_id: null,
        display_name: name,
        serial_number: null,
        block_name: null,
        requested_quantity: quantity,
        approved_quantity: 0,
        metadata: {
          category,
          custom_item: true,
          notes: input.notes.trim() || null,
        },
      })
      .select(LIST_ITEM_SELECT)
      .single();

    if (insertError || !data) {
      console.error("add custom equipment list item error", insertError);
      setError(insertError?.message || "Failed to add the custom item.");
      setAddingCustomItem(false);
      return;
    }

    setItems((current) => [...current, data as EquipmentListItem]);
    setCustomItemOpen(false);
    setMessage(`${name} added to ${list.reference}.`);
    window.dispatchEvent(
      new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, {
        detail: { listId: list.id },
      }),
    );
    setAddingCustomItem(false);
  }

  async function deleteDraftList() {
    if (!list || !canEditDraft || deletingList) return;

    const confirmed = window.confirm(
      `Delete draft ${list.reference}? This cannot be undone.`,
    );
    if (!confirmed) return;

    setDeletingList(true);
    setError("");

    const { data: deletedList, error: deleteError } = await supabase
      .from("equipment_lists")
      .delete()
      .eq("id", list.id)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();

    if (deleteError || !deletedList) {
      console.error("delete draft equipment list error", deleteError);
      setError(
        deleteError?.message ||
          "Failed to delete the Draft. Run the updated SQL migration first.",
      );
      setDeletingList(false);
      return;
    }

    try {
      if (localStorage.getItem(ACTIVE_EQUIPMENT_LIST_KEY) === list.id) {
        localStorage.removeItem(ACTIVE_EQUIPMENT_LIST_KEY);
        window.dispatchEvent(
          new CustomEvent(ACTIVE_EQUIPMENT_LIST_EVENT, {
            detail: { listId: null },
          }),
        );
      }
    } catch {
      // The list is already deleted; local storage cleanup is best effort.
    }

    window.dispatchEvent(
      new CustomEvent(EQUIPMENT_LISTS_EVENT, {
        detail: { listId: list.id, action: "deleted" },
      }),
    );
    clearListDetailsCache(list.id);
    router.push("/inventory");
    router.refresh();
  }

  async function createListPdf() {
    if (!list) throw new Error("Equipment list is unavailable.");

    const [{ jsPDF }, { autoTable }, logo] = await Promise.all([
      import("jspdf"),
      import("jspdf-autotable"),
      loadPdfLogo(),
    ]);
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const itemPhotoUrls = Array.from(
      new Set(
        sortedGroups
          .map((group) => metadataText(group.items[0], "photo_url").trim())
          .filter(Boolean),
      ),
    );
    const itemPhotoEntries = await Promise.all(
      itemPhotoUrls.map(async (photoUrl) => {
        const photo = await loadPdfItemPhoto(photoUrl);
        return [photoUrl, photo] as const;
      }),
    );
    const itemPhotos = new Map(
      itemPhotoEntries.filter(
        (entry): entry is readonly [string, PdfItemPhoto] => entry[1] !== null,
      ),
    );

    if (logo?.dataUrl && logo.width > 0 && logo.height > 0) {
      const maxWidth = 44;
      const maxHeight = 12;
      const scale = Math.min(maxWidth / logo.width, maxHeight / logo.height);
      pdf.addImage(
        logo.dataUrl,
        "PNG",
        14,
        9,
        logo.width * scale,
        logo.height * scale,
      );
    } else {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(13);
      pdf.setTextColor(20, 20, 20);
      pdf.text("HILIGHTS GROUP", 14, 17);
    }

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(12);
    pdf.setTextColor(20, 20, 20);
    pdf.text(list.reference, 196, 14, { align: "right" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(105, 105, 105);
    pdf.text(displayedStatusLabel(list), 196, 20, {
      align: "right",
    });

    pdf.setDrawColor(220, 220, 220);
    pdf.line(14, 26, 196, 26);

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(17);
    pdf.setTextColor(20, 20, 20);
    pdf.text(equipmentListTypeLabel(list.list_type), 14, 36);
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(95, 95, 95);
    pdf.text(equipmentListSummary(list) || "Equipment List", 14, 43);

    const pdfDates = scheduleRows(list);
    const details = [
      ...pdfDates.map((row) => `${row.label}: ${row.value}`),
      `Created by: ${list.created_by_name || "Unknown"}`,
    ];
    pdf.setFontSize(8);
    pdf.setTextColor(75, 75, 75);
    pdf.text(details.join("   |   "), 14, 50);

    let tableStartY = 57;
    if (list.notes?.trim()) {
      const noteLines = pdf.splitTextToSize(list.notes.trim(), 174);
      const noteHeight = Math.max(14, noteLines.length * 4 + 8);
      pdf.setFillColor(248, 248, 248);
      pdf.setDrawColor(230, 230, 230);
      pdf.roundedRect(14, 54, 182, noteHeight, 2, 2, "FD");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(7);
      pdf.setTextColor(125, 125, 125);
      pdf.text("NOTES", 18, 60);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.setTextColor(65, 65, 65);
      pdf.text(noteLines, 18, 65);
      tableStartY = 54 + noteHeight + 5;
    }

    const body: any[] = [];
    let previousCategory = "";

    for (const group of sortedGroups) {
      const firstItem = group.items[0];
      const category = categoryLabel(metadataText(firstItem, "category"));
      const quantity = group.items.reduce(
        (total, item) => total + (item.requested_quantity || 0),
        0,
      );
      const squareMetres = group.items.reduce((total, item) => {
        const value = Number(item.metadata?.actual_sqm);
        return total + (Number.isFinite(value) ? value : 0);
      }, 0);
      const isGenericMatrix =
        firstItem.inventory_record_type === "matrix_model" ||
        (firstItem.inventory_record_type === "matrix_row" &&
          firstItem.metadata?.matrix_source === "generic");
      const isRackModel =
        firstItem.inventory_record_type === "matrix_model" &&
        metadataText(firstItem, "item_type") === "rack";
      const rackRows = isRackModel
        ? rackRowsByModel[firstItem.inventory_record_id] || []
        : [];
      const isMatrixChildCollection =
        firstItem.inventory_record_type === "matrix_row" &&
        firstItem.metadata?.matrix_source === "generic" &&
        Boolean(firstItem.parent_record_id);
      const displayParts = equipmentDisplayParts(
        firstItem,
        group.displayName,
      );

      if (category !== previousCategory) {
        body.push([
          {
            content: category.toUpperCase(),
            colSpan: 6,
            rowKind: "category",
            styles: {
              fillColor: [230, 232, 235],
              textColor: [30, 32, 36],
              fontStyle: "bold",
              fontSize: 9.2,
              cellPadding: { top: 1.45, right: 3, bottom: 1.45, left: 4.5 },
              lineColor: [205, 208, 213],
              lineWidth: { top: 0.12, bottom: 0.12 },
            },
          },
        ]);
        previousCategory = category;
      }

      const blockDetail =
        group.blockName && !isGenericMatrix
          ? `Block: ${group.blockName}`
          : "";
      const customDetail =
        firstItem.inventory_record_type === "item"
          ? metadataText(firstItem, "notes") || "Custom / Non-inventory"
          : "";
      const isSerializedGroup =
        firstItem.inventory_record_type === "unit";
      const showUnitDetails =
        !hiddenUnitGroupKeys.has(group.key);
      const serialDetails =
        isSerializedGroup && showUnitDetails
          ? group.items.map((item) => pdfUnitLabel(item))
          : [];
      const rackDetails =
        isRackModel && showUnitDetails
          ? rackRows.map((row) => {
              const rowQuantity = Math.max(0, Number(row.total_qty) || 0);
              return `${rowQuantity} × ${row.cable_length}`;
            })
          : [];
      const hasAreaDetail = squareMetres > 0 && !isGenericMatrix;
      const hasDetailRows = Boolean(
        blockDetail ||
          customDetail ||
          isMatrixChildCollection ||
          rackDetails.length > 0 ||
          serialDetails.length > 0,
      );
      const itemPhotoUrl = metadataText(firstItem, "photo_url").trim();
      const hasItemPhoto = itemPhotos.has(itemPhotoUrl);
      const itemRowHeight = hasItemPhoto
        ? 12.5
        : displayParts.cabinetDetail
          ? 10.5
          : 8.5;

      body.push([
        {
          content: "",
          colSpan: 5,
          rowKind: "item",
          photoUrl: hasItemPhoto ? itemPhotoUrl : "",
          brandText: displayParts.brand,
          modelText: displayParts.model,
          primaryText: displayParts.primaryName,
          cabinetText: displayParts.cabinetDetail,
          primaryBold:
            isGenericMatrix || firstItem.inventory_record_type === "item",
          styles: {
            fontStyle: "normal",
            fontSize: 8.7,
            textColor: [22, 24, 28],
            minCellHeight: itemRowHeight,
            cellPadding: {
              top: hasItemPhoto ? 3.3 : 2.8,
              right: 3,
              bottom: hasItemPhoto ? 3.3 : 2.8,
              left: hasItemPhoto ? 15 : 3,
            },
            lineWidth: hasDetailRows ? 0 : { bottom: 0.15 },
          },
        },
        {
          content: isMatrixChildCollection
            ? ""
            : hasAreaDetail
              ? formatSquareMetres(squareMetres)
              : formatUnitQuantity(quantity),
          styles: {
            halign: "right",
            valign: "middle",
            fontStyle: "bold",
            fontSize: hasAreaDetail ? 7.2 : 7.6,
            textColor: [22, 24, 28],
            minCellHeight: itemRowHeight,
            cellPadding: {
              top: hasItemPhoto ? 3.3 : 2.8,
              right: hasAreaDetail ? 1.8 : 3,
              bottom: hasItemPhoto ? 3.3 : 2.8,
              left: hasAreaDetail ? 1.2 : 3,
            },
            lineWidth: hasDetailRows ? 0 : { bottom: 0.15 },
          },
        },
      ]);

      for (const detail of [blockDetail, customDetail].filter(Boolean)) {
        body.push([
          {
            content: detail,
            colSpan: 5,
            styles: {
              fillColor: [252, 252, 252],
              textColor: [80, 80, 80],
              fontStyle: "normal",
              fontSize: 6.5,
              cellPadding: { top: 1.5, right: 4, bottom: 1.5, left: 6 },
              lineColor: [236, 236, 236],
              lineWidth: { bottom: 0.08 },
            },
          },
          { content: "", styles: { lineWidth: 0 } },
        ]);
      }

      for (let index = 0; index < rackDetails.length; index += 3) {
        const rackCell = (content: string) => ({
          content,
          styles: {
            fillColor: [250, 250, 250],
            textColor: [82, 82, 82],
            fontStyle: "normal",
            fontSize: 5.8,
            minCellHeight: 3.6,
            cellPadding: { top: 0.5, right: 1.5, bottom: 0.5, left: 1.5 },
            lineColor: [228, 230, 233],
            lineWidth: 0.08,
          },
        });
        const emptyRackCell = () => ({
          content: "",
          styles: {
            lineWidth: 0,
            cellPadding: 0,
            minCellHeight: 3.6,
            fontSize: 5.8,
          },
        });

        body.push([
          rackCell(rackDetails[index]),
          emptyRackCell(),
          rackDetails[index + 1]
            ? rackCell(rackDetails[index + 1])
            : emptyRackCell(),
          emptyRackCell(),
          rackDetails[index + 2]
            ? rackCell(rackDetails[index + 2])
            : emptyRackCell(),
          emptyRackCell(),
        ]);
      }

      if (isMatrixChildCollection) {
        for (const item of group.items) {
          const rowLabel = metadataText(item, "row_label") || "Item";
          body.push([
            {
              content: rowLabel,
              colSpan: 5,
              styles: {
                fillColor: [255, 255, 255],
                textColor: [45, 45, 45],
                fontStyle: "normal",
                fontSize: 7,
                cellPadding: { top: 1.8, right: 3, bottom: 1.8, left: 6 },
                lineColor: [235, 235, 235],
                lineWidth: { bottom: 0.1 },
              },
            },
            {
              content: formatUnitQuantity(item.requested_quantity),
              styles: {
                fillColor: [255, 255, 255],
                textColor: [35, 35, 35],
                halign: "right",
                fontStyle: "bold",
                fontSize: 8.2,
                cellPadding: { top: 1.8, right: 3, bottom: 1.8, left: 3 },
                lineColor: [235, 235, 235],
                lineWidth: { bottom: 0.1 },
              },
            },
          ]);
        }
      }

      for (let index = 0; index < serialDetails.length; index += 3) {
        const firstSerial = serialDetails[index];
        const secondSerial = serialDetails[index + 1];
        const thirdSerial = serialDetails[index + 2];
        const serialCell = (content: string) => ({
          content,
          rowKind: "serial",
          styles: {
            fillColor: [250, 250, 250],
            textColor: [82, 82, 82],
            fontStyle: "normal",
            fontSize: 5.4,
            minCellHeight: 3.8,
            cellPadding: { top: 0.55, right: 1.6, bottom: 0.55, left: 1.6 },
            lineColor: [218, 220, 223],
            lineWidth: 0.12,
          },
        });
        const emptyCell = () => ({
          content: "",
          styles: {
            lineWidth: 0,
            cellPadding: 0,
            minCellHeight: 3.8,
            fontSize: 5.4,
          },
        });

        body.push([
          serialCell(firstSerial),
          emptyCell(),
          secondSerial
            ? serialCell(secondSerial)
            : emptyCell(),
          emptyCell(),
          thirdSerial ? serialCell(thirdSerial) : emptyCell(),
          emptyCell(),
        ]);
      }

    }

    autoTable(pdf, {
      startY: tableStartY,
      body,
      theme: "plain",
      styles: {
        font: "helvetica",
        fontSize: 7.2,
        textColor: [55, 55, 55],
        cellPadding: { top: 2.5, right: 3, bottom: 2.5, left: 3 },
        lineColor: [232, 232, 232],
        lineWidth: { bottom: 0.15 },
        overflow: "linebreak",
      },
      columnStyles: {
        0: { cellWidth: 50 },
        1: { cellWidth: 3 },
        2: { cellWidth: 50 },
        3: { cellWidth: 3 },
        4: { cellWidth: 50 },
        5: { cellWidth: 26, halign: "right" },
      },
      rowPageBreak: "avoid",
      showHead: "never",
      margin: { left: 14, right: 14, bottom: 12 },
      didDrawCell: (hookData: any) => {
        const raw = hookData.cell.raw as {
          rowKind?: string;
          photoUrl?: string;
          brandText?: string;
          modelText?: string;
          primaryText?: string;
          cabinetText?: string;
          primaryBold?: boolean;
        };

        if (raw?.rowKind === "category") {
          pdf.setFillColor(205, 32, 42);
          pdf.rect(
            hookData.cell.x,
            hookData.cell.y,
            1.2,
            hookData.cell.height,
            "F",
          );
        }

        if (raw?.rowKind === "item") {
          const textX = hookData.cell.x + (raw.photoUrl ? 15 : 3);
          const textWidth = Math.max(
            10,
            hookData.cell.width - (raw.photoUrl ? 18 : 6),
          );
          const hasCabinetText = Boolean(raw.cabinetText);
          const mainY = hasCabinetText
            ? hookData.cell.y + 4.15
            : hookData.cell.y + hookData.cell.height / 2 + 1.05;
          const fitText = (value: string, maxWidth: number) => {
            const clean = value.trim();
            if (!clean || pdf.getTextWidth(clean) <= maxWidth) return clean;

            let shortened = clean;
            while (
              shortened.length > 1 &&
              pdf.getTextWidth(`${shortened}…`) > maxWidth
            ) {
              shortened = shortened.slice(0, -1).trimEnd();
            }
            return `${shortened}…`;
          };

          pdf.setFontSize(8.7);
          pdf.setTextColor(22, 24, 28);

          if (raw.brandText) {
            pdf.setFont("helvetica", "bold");
            const brandText = fitText(raw.brandText, textWidth);
            pdf.text(brandText, textX, mainY);

            if (raw.modelText && brandText === raw.brandText.trim()) {
              const brandWidth = pdf.getTextWidth(brandText);
              pdf.setFont("helvetica", "normal");
              const gapWidth = pdf.getTextWidth(" ");
              const modelText = fitText(
                raw.modelText,
                Math.max(0, textWidth - brandWidth - gapWidth),
              );
              if (modelText) {
                pdf.text(modelText, textX + brandWidth + gapWidth, mainY);
              }
            }
          } else {
            pdf.setFont(
              "helvetica",
              raw.primaryBold ? "bold" : "normal",
            );
            pdf.text(
              fitText(raw.primaryText || raw.modelText || "", textWidth),
              textX,
              mainY,
            );
          }

          if (raw.cabinetText) {
            pdf.setFont("helvetica", "normal");
            pdf.setFontSize(6.3);
            pdf.setTextColor(76, 88, 105);
            pdf.text(
              fitText(raw.cabinetText, textWidth),
              textX,
              mainY + 3.35,
            );
          }

          if (!raw.photoUrl) return;
          const photo = itemPhotos.get(raw.photoUrl);
          if (!photo) return;

          const boxSize = 9;
          const boxX = hookData.cell.x + 3;
          const boxY =
            hookData.cell.y + Math.max(1, (hookData.cell.height - boxSize) / 2);
          const imagePadding = 0.6;
          const availableSize = boxSize - imagePadding * 2;
          const scale = Math.min(
            availableSize / photo.width,
            availableSize / photo.height,
          );
          const imageWidth = photo.width * scale;
          const imageHeight = photo.height * scale;
          const imageX = boxX + (boxSize - imageWidth) / 2;
          const imageY = boxY + (boxSize - imageHeight) / 2;

          pdf.setFillColor(255, 255, 255);
          pdf.setDrawColor(226, 228, 232);
          pdf.roundedRect(boxX, boxY, boxSize, boxSize, 1, 1, "FD");
          pdf.addImage(
            photo.dataUrl,
            "JPEG",
            imageX,
            imageY,
            imageWidth,
            imageHeight,
            undefined,
            "FAST",
          );
        }
      },
    });

    const pageCount = pdf.getNumberOfPages();
    for (let page = 1; page <= pageCount; page += 1) {
      pdf.setPage(page);
      pdf.setDrawColor(225, 225, 225);
      pdf.line(14, 286.5, 196, 286.5);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(6.5);
      pdf.setTextColor(118, 118, 118);
      pdf.text(
        `${list.reference} | Page ${page} of ${pageCount}`,
        14,
        291,
      );
      pdf.text("Hilights Group · Equipment Management System", 196, 291, {
        align: "right",
      });
    }

    const fileName = pdfFileName(list);
    return { pdf, fileName };
  }

  async function downloadPdf() {
    if (!list || pdfAction) return;
    setPdfAction("download");
    setError("");
    try {
      const { pdf, fileName } = await createListPdf();
      pdf.save(fileName);
    } catch (pdfError: any) {
      console.error("download equipment list PDF error", pdfError);
      setError(pdfError?.message || "Failed to create the PDF.");
    } finally {
      setPdfAction(null);
    }
  }

  async function shareList() {
    if (!list || pdfAction) return;
    setPdfAction("share");
    setError("");

    try {
      const { pdf, fileName } = await createListPdf();
      const pdfFile = new File([pdf.output("blob")], fileName, {
        type: "application/pdf",
      });
      const shareData = {
        title: list.reference,
        text: `${equipmentListTypeLabel(list.list_type)} · ${equipmentListSummary(list)}`,
        files: [pdfFile],
      };

      if (navigator.share && navigator.canShare?.({ files: [pdfFile] })) {
        await navigator.share(shareData);
        setMessage("List shared as PDF.");
      } else if (navigator.share) {
        await navigator.share({
          title: list.reference,
          text: shareData.text,
          url: window.location.href,
        });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(window.location.href);
        setMessage("List link copied.");
      } else {
        window.prompt("Copy this list link:", window.location.href);
      }
    } catch (shareError: any) {
      if (shareError?.name !== "AbortError") {
        console.error("share equipment list error", shareError);
        setError(shareError?.message || "Failed to share the list.");
      }
    } finally {
      setPdfAction(null);
    }
  }

  async function submitForApproval() {
    if (
      !list ||
      !canSubmitDraft ||
      submitting
    ) {
      return;
    }

    if (items.length === 0) {
      setError("Add at least one equipment item before submitting the list.");
      return;
    }

    const confirmed = window.confirm(
      `Submit ${list.reference} for warehouse approval? You will not be able to add or remove equipment while it is pending.`,
    );
    if (!confirmed) return;

    setSubmitting(true);
    setError("");
    setMessage("");

    try {
      const userId = getUserId();
      const submittedAt = new Date().toISOString();

      const { data, error: updateError } = await supabase
        .from("equipment_lists")
        .update({
          status: "pending",
          submitted_by: userId,
          submitted_at: submittedAt,
          updated_at: submittedAt,
        })
        .eq("id", list.id)
        .eq("status", "draft")
        .select(LIST_SELECT)
        .single();

      if (updateError || !data) {
        throw updateError || new Error("The list could not be submitted.");
      }

      const actorName = getUserName() || "A team member";
      const { error: activityError } = await supabase
        .from("equipment_list_activity")
        .insert({
          list_id: list.id,
          action: "submitted",
          message: `${list.reference} submitted for warehouse approval`,
          actor_id: userId,
          actor_name: actorName,
          details: {
            item_lines: items.length,
            requested_quantity: requestedQuantity,
          },
        });

      if (activityError) {
        console.error("equipment list activity insert error", activityError);
      }

      setList(data as DetailedEquipmentList);
      setMessage("List submitted. It is now waiting for warehouse approval.");

      window.dispatchEvent(
        new CustomEvent(EQUIPMENT_LISTS_EVENT, {
          detail: { listId: list.id, status: "pending" },
        }),
      );
    } catch (submitError: any) {
      console.error("submit equipment list error", submitError);
      setError(submitError?.message || "Failed to submit the list.");
    } finally {
      setSubmitting(false);
    }
  }

  async function approveAndDispatch() {
    if (!list || !canReview || approving || items.length === 0) return;

    const confirmed = window.confirm(
      list.list_type === "maintenance"
        ? `Approve and send ${list.reference} to ${list.repair_company || "the repair company"}? The selected items are already in Maintenance and will remain unavailable.`
        : `Approve and dispatch ${list.reference}? The selected equipment will become unavailable immediately.`,
    );
    if (!confirmed) return;

    setApproving(true);
    setError("");
    setMessage("");

    try {
      const { data, error: approvalError } = await supabase.rpc(
        "approve_and_dispatch_equipment_list",
        { p_list_id: list.id },
      );

      if (approvalError) throw approvalError;

      const result = (data ?? {}) as {
        approved_at?: string;
        approved_by?: string;
      };

      setList((current) =>
        current
          ? {
              ...current,
              status: "active",
              approved_at: result.approved_at || new Date().toISOString(),
              approved_by: result.approved_by || null,
            }
          : current,
      );
      setItems((current) =>
        current.map((item) => ({
          ...item,
          approved_quantity: item.requested_quantity,
        })),
      );
      setReviewPicker(null);
      setMessage(
        list.list_type === "maintenance"
          ? "Approved and sent for repair. The list is now in Maintenance Active."
          : "Approved and dispatched. Inventory availability has been updated.",
      );
      if (list.list_type === "maintenance") {
        await refreshMaintenanceRequests();
        window.dispatchEvent(
          new CustomEvent("hems:maintenance-requests-change"),
        );
      }

      window.dispatchEvent(
        new CustomEvent(EQUIPMENT_LISTS_EVENT, {
          detail: { listId: list.id, status: "active" },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(EQUIPMENT_LIST_ITEMS_EVENT, {
          detail: { listId: list.id },
        }),
      );
    } catch (approvalError: any) {
      console.error("approve equipment list error", approvalError);
      setError(
        approvalError?.message ||
          "Approval failed. Refresh the list and check equipment availability.",
      );
    } finally {
      setApproving(false);
    }
  }

  if (loading) {
    return (
      <div className="w-full rounded-2xl border border-gray-200 bg-white px-5 py-8 text-sm text-gray-500">
        <div className="flex items-center gap-2">
          <Loader2 size={16} className="animate-spin" />
          Loading equipment list...
        </div>
      </div>
    );
  }

  if (!list) {
    return (
      <div className="w-full rounded-2xl border border-gray-200 bg-white p-6">
        <div className="text-base font-bold text-gray-900">List not found</div>
        <div className="mt-1 text-sm text-red-600">
          {error || "This equipment list is unavailable."}
        </div>
        <Link
          href="/inventory"
          className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-gray-300 px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
        >
          <ArrowLeft size={12} />
          Inventory
        </Link>
      </div>
    );
  }

  const dates = scheduleRows(list);

  return (
    <div className="w-full space-y-3">
      {reviewPicker ? (
        <EquipmentListUnitPicker
          list={list}
          item={reviewPicker.item}
          category={reviewPicker.category}
          subcategory={reviewPicker.subcategory}
          allowPendingReview
          onClose={() => setReviewPicker(null)}
          onAdded={(count) => {
            setReviewPicker(null);
            setMessage(
              `${count} unit${count === 1 ? "" : "s"} added to the list.`,
            );
            void refreshItems();
          }}
        />
      ) : null}

      {returnDialog ? (
        <ReturnQuantityDialog
          item={returnDialog.item}
          remaining={returnDialog.remaining}
          okQuantity={returnOkQuantity}
          saving={returningItemId === returnDialog.item.id}
          onOkQuantityChange={setReturnOkQuantity}
          onClose={() => {
            if (!returningItemId) setReturnDialog(null);
          }}
          onConfirm={() =>
            void receiveReturn(
              returnDialog.item,
              returnOkQuantity,
            )
          }
        />
      ) : null}

      {customItemOpen && !isMaintenanceList ? (
        <CustomItemDialog
          saving={addingCustomItem}
          onClose={() => {
            if (!addingCustomItem) setCustomItemOpen(false);
          }}
          onAdd={(input) => void addCustomItem(input)}
        />
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              href="/inventory"
              className="mb-3 inline-flex items-center gap-1 text-[10px] font-medium text-gray-500 hover:text-red-600"
            >
              <ArrowLeft size={11} />
              Inventory
            </Link>

            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">
                {list.reference}
              </h1>
              <span
                className={`rounded-full px-2.5 py-1 text-[9px] font-bold ${statusClass(
                  list.status,
                )}`}
              >
                {displayedStatusLabel(list)}
              </span>
            </div>

            <div className="mt-1 text-xs font-medium text-gray-500">
              {equipmentListTypeLabel(list.list_type)} · {equipmentListSummary(list)}
            </div>
          </div>

          <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void shareList()}
              disabled={Boolean(pdfAction) || rackRowsLoading}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-[10px] font-semibold text-gray-700 transition hover:border-black hover:text-black disabled:opacity-40"
            >
              {pdfAction === "share" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Share2 size={12} />
              )}
              Share
            </button>

            <button
              type="button"
              onClick={() => void downloadPdf()}
              disabled={Boolean(pdfAction) || rackRowsLoading}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-[10px] font-semibold text-gray-700 transition hover:border-black hover:text-black disabled:opacity-40"
            >
              {pdfAction === "download" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Download size={12} />
              )}
              PDF
            </button>

            {canEditDraft ? (
              <>
                <button
                  type="button"
                  onClick={() => void deleteDraftList()}
                  disabled={deletingList}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 py-2.5 text-[10px] font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-40"
                >
                  {deletingList ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  Delete
                </button>

                {canSubmitDraft ? (
                  <button
                    type="button"
                    onClick={() => void submitForApproval()}
                    disabled={submitting || items.length === 0}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-black px-4 py-2.5 text-[10px] font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {submitting ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Send size={13} />
                    )}
                    {submitting ? "Submitting..." : "Submit"}
                  </button>
                ) : null}
              </>
            ) : null}

            {canReview ? (
              <button
                type="button"
                onClick={() => void approveAndDispatch()}
                disabled={approving || items.length === 0}
                className="flex items-center justify-center gap-2 rounded-xl bg-green-600 px-4 py-2.5 text-[11px] font-semibold text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {approving ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <ShieldCheck size={14} />
                )}
                {approving
                  ? "Approving..."
                  : isMaintenanceList
                    ? "Approve & Send"
                    : "Approve & Dispatch"}
              </button>
            ) : null}
          </div>
        </div>

        </div>

        <div className="grid grid-cols-2 gap-px border-t border-gray-200 bg-gray-200 lg:grid-cols-4">
          <InfoCard label="Type" value={equipmentListTypeLabel(list.list_type)} />
          <InfoCard label="Details" value={equipmentListSummary(list)} />
          {dates.map((row) => (
            <InfoCard key={row.label} label={row.label} value={row.value} />
          ))}
        </div>

        {list.notes ? (
          <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 sm:px-5">
            <div className="text-[9px] font-bold uppercase tracking-wider text-gray-400">
              Notes
            </div>
            <div className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-gray-700">
              {list.notes}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-gray-200 px-4 py-2.5 text-[9px] text-gray-400 sm:px-5">
          <span>Created by {list.created_by_name || "Unknown"}</span>
          <span>{formatDateTime(list.created_at)}</span>
          {list.submitted_at ? (
            <span>Submitted {formatDateTime(list.submitted_at)}</span>
          ) : null}
        </div>
      </div>

      {list.status === "pending" ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
          <Clock3 size={17} className="mt-0.5 shrink-0" />
          <div>
            <div className="text-[11px] font-bold">
              {canReview
                ? "Warehouse review"
                : "Waiting for warehouse approval"}
            </div>
            <div className="mt-0.5 text-[10px] leading-4 text-amber-700">
              {canReview
                ? "Check the equipment quantities and serial numbers, make any needed changes, then approve and dispatch."
                : "Equipment is locked for editing, but inventory availability has not changed yet."}
            </div>
          </div>
        </div>
      ) : null}

      {isInternalUse ? (
        <div className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-blue-900">
          <BriefcaseBusiness size={17} className="mt-0.5 shrink-0" />
          <div>
            <div className="text-[11px] font-bold">Internal Use</div>
            <div className="mt-0.5 text-[10px] leading-4 text-blue-700">
              Everyone can view this list. Only Warehouse and Admin users can
              edit its equipment.
            </div>
          </div>
        </div>
      ) : null}

      {list.status === "active" || list.status === "partially_returned" ? (
        <div
          className={`flex items-start gap-3 rounded-2xl border px-4 py-3 ${
            isMaintenanceList
              ? "border-amber-200 bg-amber-50 text-amber-900"
              : "border-blue-200 bg-blue-50 text-blue-900"
          }`}
        >
          {isMaintenanceList ? (
            <Wrench size={17} className="mt-0.5 shrink-0" />
          ) : (
            <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
          )}
          <div>
            <div className="text-[11px] font-bold">
              {isMaintenanceList
                ? "Maintenance Active"
                : "Approved equipment list"}
            </div>
            <div
              className={`mt-0.5 text-[10px] leading-4 ${
                isMaintenanceList ? "text-amber-700" : "text-blue-700"
              }`}
            >
              {isMaintenanceList
                ? `Equipment is at ${list.repair_company || "the repair company"}. Warehouse marks it Received, then Admin or the department Head confirms Tested.`
                : "This list is active and its equipment movement is being tracked."}
            </div>
          </div>
        </div>
      ) : null}

      {isMaintenanceList && maintenanceRequests.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-amber-200 bg-white">
          <div className="flex items-start gap-3 border-b border-amber-100 bg-amber-50 px-4 py-3 sm:px-5">
            <Wrench size={16} className="mt-0.5 shrink-0 text-amber-700" />
            <div>
              <div className="text-[11px] font-bold text-amber-950">
                Repair Progress
              </div>
              <div className="mt-0.5 text-[9px] leading-4 text-amber-700">
                Received items stay unavailable until Admin or the relevant
                department Head confirms testing.
              </div>
            </div>
          </div>

          <div className="divide-y divide-gray-100">
            {maintenanceRequests.map((request) => {
              const received = Number(request.received_quantity) || 0;
              const tested = Number(request.tested_quantity) || 0;
              const total = Number(request.quantity) || 0;
              const busy = maintenanceActionId === request.id;
              const awaitingTest = Math.max(0, received - tested);

              return (
                <div
                  key={request.id}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[10px] font-bold text-gray-900 sm:text-[11px]">
                      {request.display_name}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[8px] font-medium text-gray-500 sm:text-[9px]">
                      {request.serial_number ? (
                        <span className="rounded-md bg-gray-100 px-1.5 py-0.5">
                          {request.serial_number}
                        </span>
                      ) : null}
                      <span>{total} unit{total === 1 ? "" : "s"}</span>
                      <span>·</span>
                      <span>{received}/{total} Received</span>
                      <span>·</span>
                      <span>{tested}/{total} Tested</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {request.report_href ? (
                      <Link
                        href={`${request.report_href}${
                          request.report_href.includes("?") ? "&" : "?"
                        }maintenanceRequest=${encodeURIComponent(request.id)}`}
                        className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-[9px] font-semibold text-gray-700 hover:border-black"
                      >
                        Open Report
                      </Link>
                    ) : null}

                    {request.status === "sent" && canReceiveMaintenance ? (
                      <button
                        type="button"
                        onClick={() => void receiveMaintenanceItem(request)}
                        disabled={Boolean(maintenanceActionId)}
                        className="inline-flex items-center gap-1 rounded-lg bg-black px-2.5 py-1.5 text-[9px] font-bold text-white hover:bg-gray-800 disabled:opacity-50"
                      >
                        {busy ? <Loader2 size={10} className="animate-spin" /> : null}
                        Received
                      </button>
                    ) : null}

                    {awaitingTest > 0 && canTestMaintenance(request) ? (
                      <button
                        type="button"
                        onClick={() => void testMaintenanceItem(request)}
                        disabled={Boolean(maintenanceActionId)}
                        className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-2.5 py-1.5 text-[9px] font-bold text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <CheckCircle2 size={10} />
                        )}
                        Tested
                      </button>
                    ) : null}

                    {request.status === "received" &&
                    !canTestMaintenance(request) ? (
                      <span className="rounded-lg bg-violet-100 px-2.5 py-1.5 text-[9px] font-semibold text-violet-800">
                        Received · Awaiting Test
                      </span>
                    ) : null}

                    {request.status === "resolved" ? (
                      <span className="rounded-lg bg-green-100 px-2.5 py-1.5 text-[9px] font-semibold text-green-800">
                        Tested · Available
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {message ? (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-[11px] font-medium text-green-800">
          {message}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[11px] font-medium text-red-700">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-gray-900">
              <PackageCheck size={16} />
              Equipment
            </div>
            <div className="mt-1 text-[10px] text-gray-500">
              Selected equipment, quantities and serial numbers in this list.
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {canChangeItems && !isMaintenanceList ? (
              <button
                type="button"
                onClick={() => setCustomItemOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3 py-2 text-[10px] font-semibold text-gray-700 transition hover:border-black hover:text-black"
              >
                <FilePlus2 size={12} />
                Add Custom Item
              </button>
            ) : null}
          </div>
        </div>

        {groups.length === 0 ? (
          <div className="m-4 rounded-xl border border-dashed border-gray-300 px-4 py-12 text-center">
            <div className="text-sm font-semibold text-gray-700">List is empty</div>
            <div className="mt-1 text-[11px] text-gray-500">
              Select this Draft in the left sidebar, then add equipment from inventory.
            </div>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 border-t border-gray-100">
            {sortedGroups.map((group, groupIndex) => {
              const quantity = group.items.reduce(
                (total, item) => total + (item.requested_quantity || 0),
                0,
              );
              const firstItem = group.items[0];
              const isMatrixRow =
                firstItem.inventory_record_type === "matrix_row";
              const isGenericMatrixModel =
                firstItem.inventory_record_type === "matrix_model";
              const isGenericMatrixRow =
                isMatrixRow && firstItem.metadata?.matrix_source === "generic";
              const isGenericMatrix =
                isGenericMatrixModel || isGenericMatrixRow;
              const isMatrixChildCollection =
                isGenericMatrixRow && Boolean(firstItem.parent_record_id);
              const isCustomItem =
                firstItem.inventory_record_type === "item";
              const isSerializedGroup =
                firstItem.inventory_record_type === "unit";
              const showUnitDetails =
                !hiddenUnitGroupKeys.has(group.key);
              const isRackModel =
                isGenericMatrixModel &&
                metadataText(firstItem, "item_type") === "rack";
              const rackRows = isRackModel
                ? rackRowsByModel[firstItem.inventory_record_id] || []
                : [];
              const isQuantityRecord =
                isMatrixRow || isGenericMatrix || isCustomItem;
              const canEditQuantity = Boolean(
                canChangeItems &&
                  isQuantityRecord &&
                  !isMatrixChildCollection,
              );
              const groupSquareMetres = group.items.reduce((total, item) => {
                const value = Number(item.metadata?.actual_sqm);
                return total + (Number.isFinite(value) ? value : 0);
              }, 0);
              const hasSquareMetreQuantity =
                isMatrixRow && !isGenericMatrix && groupSquareMetres > 0;
              const displayParts = equipmentDisplayParts(
                firstItem,
                group.displayName,
              );
              const cabinetArea = Number(
                firstItem.metadata?.cabinet_area_sqm,
              );
              const hasCabinetArea =
                Number.isFinite(cabinetArea) && cabinetArea > 0;
              const quantityText = hasSquareMetreQuantity
                ? formatSquareMetres(groupSquareMetres)
                : formatUnitQuantity(quantity);
              const category = metadataText(firstItem, "category");
              const subcategory = metadataText(firstItem, "subcategory");
              const currentCategoryLabel = categoryLabel(category);
              const previousCategoryLabel =
                groupIndex > 0
                  ? categoryLabel(
                      metadataText(
                        sortedGroups[groupIndex - 1].items[0],
                        "category",
                      ),
                    )
                  : "";
              const sourceItemId =
                metadataText(firstItem, "item_id") || firstItem.parent_record_id || "";
              const photoUrl = metadataText(firstItem, "photo_url");
              const canPickUnits = Boolean(
                canChangeItems &&
                  firstItem.inventory_record_type === "unit" &&
                  category &&
                  subcategory &&
                  sourceItemId,
              );

              return (
                <Fragment key={group.key}>
                {currentCategoryLabel !== previousCategoryLabel ? (
                  <div className="bg-gray-50 px-4 py-2 text-[9px] font-bold uppercase tracking-wide text-gray-600 sm:px-5">
                    {currentCategoryLabel}
                  </div>
                ) : null}
                <div
                  className="px-3 py-2.5 transition hover:bg-gray-50 sm:px-5"
                >
                  <div className="flex items-start gap-3">
                    {photoUrl ? (
                      <img
                        src={photoUrl}
                        alt={group.displayName}
                        className="h-10 w-10 shrink-0 rounded-lg border border-gray-100 bg-white object-cover"
                      />
                    ) : (
                      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-gray-100 text-gray-400">
                        <PackageCheck size={16} />
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div
                            className="truncate text-[12px] text-gray-900 sm:text-[13px]"
                            title={displayParts.primaryName}
                          >
                            {displayParts.brand ? (
                              <>
                                <span className="font-bold">
                                  {displayParts.brand}
                                </span>
                                {displayParts.model ? (
                                  <span className="font-normal text-gray-800">
                                    {` ${displayParts.model}`}
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <span
                                className={
                                  isGenericMatrix || isCustomItem
                                    ? "font-semibold"
                                    : "font-normal"
                                }
                              >
                                {displayParts.primaryName}
                              </span>
                            )}
                          </div>
                          {displayParts.cabinetDetail ? (
                            <div className="mt-0.5 truncate text-[8px] font-normal text-slate-600 sm:text-[9px]">
                              {displayParts.cabinetDetail}
                            </div>
                          ) : null}
                          {group.blockName && !isGenericMatrix ? (
                            <div className="mt-0.5 text-[9px] text-gray-500">
                              Block: {group.blockName}
                            </div>
                          ) : null}
                          {isCustomItem && metadataText(firstItem, "notes") ? (
                            <div className="mt-0.5 text-[9px] text-gray-500">
                              {metadataText(firstItem, "notes")}
                            </div>
                          ) : null}
                          {isRackModel && showUnitDetails && rackRows.length > 0 ? (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {rackRows.map((row) => {
                                const rowQuantity = Math.max(
                                  0,
                                  Number(row.total_qty) || 0,
                                );

                                return (
                                  <span
                                    key={row.id}
                                    className="max-w-full truncate rounded-md bg-gray-100 px-1.5 py-0.5 text-[7px] font-medium text-gray-600 sm:text-[8px]"
                                    title={`${rowQuantity} × ${row.cable_length}`}
                                  >
                                    {rowQuantity} × {row.cable_length}
                                  </span>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                          {!isMatrixChildCollection ? (
                          <div className="flex min-w-[72px] items-center justify-end">
                            {canEditQuantity ? (
                              <div className="flex items-center justify-end gap-1">
                                <input
                                  key={`${firstItem.id}:${firstItem.requested_quantity}:${groupSquareMetres}`}
                                  type="number"
                                  min={
                                    hasSquareMetreQuantity && hasCabinetArea
                                      ? cabinetArea
                                      : 1
                                  }
                                  step={
                                    hasSquareMetreQuantity && hasCabinetArea
                                      ? cabinetArea
                                      : 1
                                  }
                                  defaultValue={
                                    hasSquareMetreQuantity
                                      ? Number(groupSquareMetres.toFixed(3))
                                      : firstItem.requested_quantity
                                  }
                                  disabled={updatingItemId === firstItem.id}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      event.currentTarget.blur();
                                    }
                                  }}
                                  onBlur={(event) =>
                                    void updateItemQuantity(
                                      firstItem,
                                      Number(event.currentTarget.value),
                                      hasSquareMetreQuantity ? "sqm" : "units",
                                    )
                                  }
                                  aria-label={`Quantity for ${group.displayName}`}
                                  className="h-7 w-16 rounded-lg border border-gray-300 bg-white px-2 text-right text-[10px] font-bold text-gray-900 outline-none focus:border-black disabled:bg-gray-100"
                                />
                                <span className="whitespace-nowrap text-[8px] font-semibold text-gray-600">
                                  {hasSquareMetreQuantity
                                    ? "SQM"
                                    : firstItem.requested_quantity === 1
                                      ? "Unit"
                                      : "Units"}
                                </span>
                                {updatingItemId === firstItem.id ? (
                                  <Loader2
                                    size={11}
                                    className="animate-spin text-gray-400"
                                  />
                                ) : null}
                              </div>
                            ) : canPickUnits ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setReviewPicker({
                                    item: {
                                      id: sourceItemId,
                                      name: group.displayName,
                                      photo_url: photoUrl || null,
                                      fixture_type:
                                        metadataText(firstItem, "fixture_type") ||
                                        null,
                                    },
                                    category,
                                    subcategory,
                                  })
                                }
                                title="Choose units and serial numbers"
                                aria-label={`Choose units for ${group.displayName}`}
                                className="h-7 min-w-20 rounded-lg border border-gray-300 bg-white px-2 text-right text-[10px] font-bold tabular-nums text-gray-900 transition hover:border-black hover:bg-gray-50"
                              >
                                {formatUnitQuantity(quantity)}
                              </button>
                            ) : (
                              <span className="whitespace-nowrap text-[11px] font-bold tabular-nums text-gray-900 sm:text-[12px]">
                                {quantityText}
                              </span>
                            )}
                          </div>
                          ) : null}

                          {isSerializedGroup ? (
                            <button
                              type="button"
                              role="switch"
                              aria-checked={showUnitDetails}
                              onClick={() => toggleUnitGroupVisibility(group.key)}
                              title={
                                showUnitDetails
                                  ? "Hide this item's IDs and serial numbers from the list and PDF"
                                  : "Show this item's IDs and serial numbers in the list and PDF"
                              }
                              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 text-[8px] font-semibold text-gray-600 transition hover:border-black"
                            >
                              <span>ID / Serial</span>
                              <span
                                className={`relative h-3.5 w-6 rounded-full transition ${
                                  showUnitDetails ? "bg-black" : "bg-gray-300"
                                }`}
                              >
                                <span
                                  className={`absolute left-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-transform ${
                                    showUnitDetails
                                      ? "translate-x-2.5"
                                      : "translate-x-0"
                                  }`}
                                />
                              </span>
                            </button>
                          ) : null}

                          {isRackModel && rackRows.length > 0 ? (
                            <button
                              type="button"
                              role="switch"
                              aria-checked={showUnitDetails}
                              onClick={() => toggleUnitGroupVisibility(group.key)}
                              title={
                                showUnitDetails
                                  ? "Hide rack items from the list and PDF"
                                  : "Show rack items in the list and PDF"
                              }
                              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 text-[8px] font-semibold text-gray-600 transition hover:border-black"
                            >
                              <span>Rack Items</span>
                              <span
                                className={`relative h-3.5 w-6 rounded-full transition ${
                                  showUnitDetails ? "bg-black" : "bg-gray-300"
                                }`}
                              >
                                <span
                                  className={`absolute left-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-transform ${
                                    showUnitDetails
                                      ? "translate-x-2.5"
                                      : "translate-x-0"
                                  }`}
                                />
                              </span>
                            </button>
                          ) : null}

                          {isGenericMatrixModel && canChangeItems ? (
                            <button
                              type="button"
                              onClick={() => void removeItem(firstItem.id)}
                              disabled={Boolean(removingItemId)}
                              title={`Remove ${group.displayName}`}
                              aria-label={`Remove ${group.displayName} from list`}
                              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-gray-200 text-gray-400 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                            >
                              {removingItemId === firstItem.id ? (
                                <Loader2 size={10} className="animate-spin" />
                              ) : (
                                <X size={10} />
                              )}
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {!isGenericMatrix &&
                      !isMatrixRow &&
                      (!isSerializedGroup || showUnitDetails) ? (
                      <div className="mt-1.5 flex items-center gap-1 text-[8px] font-bold uppercase tracking-wider text-gray-400">
                        <CalendarDays size={9} />
                        {isCustomItem
                          ? "Custom / Non-inventory"
                          : "Serial / Unit ID"}
                      </div>
                      ) : null}

                      {isMatrixChildCollection ? (
                        <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white">
                          {group.items.map((item) => {
                            const rowLabel =
                              metadataText(item, "row_label") || "Item";
                            const remaining = remainingQuantity(item);
                            const returnedOk =
                              Number(item.returned_ok_quantity) || 0;
                            const returnedMaintenance =
                              Number(item.returned_maintenance_quantity) || 0;
                            const childCanEdit = canChangeItems;

                            return (
                              <div
                                key={item.id}
                                className="flex min-h-9 items-center justify-between gap-3 border-t border-gray-100 px-2.5 py-1.5 first:border-t-0"
                              >
                                <span
                                  className="min-w-0 flex-1 truncate text-[9px] font-semibold text-gray-900 sm:text-[10px]"
                                  title={rowLabel}
                                >
                                  {rowLabel}
                                </span>

                                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                                  {childCanEdit ? (
                                    <div className="flex items-center gap-1">
                                      <input
                                        key={`${item.id}:${item.requested_quantity}`}
                                        type="number"
                                        min={1}
                                        step={1}
                                        defaultValue={item.requested_quantity}
                                        disabled={updatingItemId === item.id}
                                        onKeyDown={(event) => {
                                          if (event.key === "Enter") {
                                            event.preventDefault();
                                            event.currentTarget.blur();
                                          }
                                        }}
                                        onBlur={(event) =>
                                          void updateItemQuantity(
                                            item,
                                            Number(event.currentTarget.value),
                                          )
                                        }
                                        aria-label={`Quantity for ${rowLabel}`}
                                        className="h-7 w-14 rounded-lg border border-gray-300 bg-white px-2 text-right text-[10px] font-bold text-gray-900 outline-none focus:border-black disabled:bg-gray-100"
                                      />
                                      <span className="text-[8px] font-semibold text-gray-600">
                                        {item.requested_quantity === 1
                                          ? "Unit"
                                          : "Units"}
                                      </span>
                                    </div>
                                  ) : (
                                    <span className="whitespace-nowrap text-[9px] font-bold text-gray-900">
                                      {formatUnitQuantity(
                                        item.requested_quantity,
                                      )}
                                    </span>
                                  )}

                                  {updatingItemId === item.id ? (
                                    <Loader2
                                      size={10}
                                      className="animate-spin text-gray-400"
                                    />
                                  ) : null}

                                  {canChangeItems ? (
                                    <button
                                      type="button"
                                      onClick={() => void removeItem(item.id)}
                                      disabled={Boolean(removingItemId)}
                                      title={`Remove ${rowLabel}`}
                                      aria-label={`Remove ${rowLabel} from list`}
                                      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-gray-200 text-gray-400 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                                    >
                                      {removingItemId === item.id ? (
                                        <Loader2 size={10} className="animate-spin" />
                                      ) : (
                                        <X size={10} />
                                      )}
                                    </button>
                                  ) : canReceiveReturns && remaining > 0 ? (
                                    <button
                                      type="button"
                                      onClick={() => openQuantityReturn(item)}
                                      disabled={Boolean(returningItemId)}
                                      className="inline-flex items-center gap-1 rounded-lg bg-black px-2 py-1.5 text-[8px] font-bold text-white hover:bg-gray-800 disabled:opacity-50"
                                    >
                                      <RotateCcw size={9} />
                                      Received
                                    </button>
                                  ) : returnedOk > 0 || returnedMaintenance > 0 ? (
                                    <span
                                      className={`rounded-md px-2 py-1 text-[8px] font-medium ${
                                        returnedMaintenance > 0
                                          ? "bg-amber-100 text-amber-800"
                                          : "bg-green-100 text-green-800"
                                      }`}
                                    >
                                      {returnedOk > 0 ? `${returnedOk} OK` : ""}
                                      {returnedOk > 0 && returnedMaintenance > 0
                                        ? " · "
                                        : ""}
                                      {returnedMaintenance > 0
                                        ? `${returnedMaintenance} Maintenance`
                                        : ""}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : isGenericMatrix && !canReceiveReturns ? null : isSerializedGroup && !showUnitDetails ? null : (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {group.items.map((item) => {
                          const remaining = remainingQuantity(item);
                          const returnedOk =
                            Number(item.returned_ok_quantity) || 0;
                          const returnedMaintenance =
                            Number(item.returned_maintenance_quantity) || 0;

                          if (canChangeItems) {
                            return (
                              <div
                                key={item.id}
                                className="flex max-w-full items-center overflow-hidden rounded-md bg-gray-100 text-[8px] font-medium text-gray-700"
                              >
                                <span className="truncate px-2 py-1">
                                  {unitLabel(item)}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => void removeItem(item.id)}
                                  disabled={Boolean(removingItemId)}
                                  title={`Remove ${unitLabel(item)}`}
                                  aria-label={`Remove ${unitLabel(item)} from list`}
                                  className="grid h-6 w-6 shrink-0 place-items-center border-l border-gray-200 text-gray-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                                >
                                  {removingItemId === item.id ? (
                                    <Loader2 size={10} className="animate-spin" />
                                  ) : (
                                    <X size={10} />
                                  )}
                                </button>
                              </div>
                            );
                          }

                          if (canReceiveReturns && remaining > 0) {
                            return (
                              <div
                                key={item.id}
                                className="flex max-w-full flex-wrap items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1"
                              >
                                <span className="max-w-[180px] truncate px-1.5 text-[9px] font-semibold text-gray-700">
                                  {unitLabel(item)}
                                  {isQuantityRecord ? ` · ${remaining} outside` : ""}
                                  {returnedOk > 0 ? ` · ${returnedOk} OK` : ""}
                                  {returnedMaintenance > 0
                                    ? ` · ${returnedMaintenance} Maint.`
                                    : ""}
                                </span>

                                {isQuantityRecord ? (
                                  <button
                                    type="button"
                                    onClick={() => openQuantityReturn(item)}
                                    disabled={Boolean(returningItemId)}
                                    className="inline-flex items-center gap-1 rounded-lg bg-black px-2 py-1.5 text-[8px] font-bold text-white hover:bg-gray-800 disabled:opacity-50"
                                  >
                                    <RotateCcw size={9} />
                                    Received
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => void receiveReturn(item, 1)}
                                    disabled={Boolean(returningItemId)}
                                    className="inline-flex items-center gap-1 rounded-lg bg-green-600 px-2 py-1.5 text-[8px] font-bold text-white hover:bg-green-700 disabled:opacity-50"
                                  >
                                    {returningItemId === item.id ? (
                                      <Loader2 size={9} className="animate-spin" />
                                    ) : (
                                      <RotateCcw size={9} />
                                    )}
                                    Received
                                  </button>
                                )}
                              </div>
                            );
                          }

                          return (
                            <span
                              key={item.id}
                              className={`max-w-full truncate rounded-md px-2 py-1 text-[8px] font-medium ${
                                returnedMaintenance > 0
                                  ? "bg-amber-100 text-amber-800"
                                  : returnedOk > 0
                                    ? "bg-green-100 text-green-800"
                                    : "bg-gray-100 text-gray-700"
                              }`}
                            >
                              {unitLabel(item)}
                              {returnedOk > 0
                                ? ` · ${returnedOk} Returned OK`
                                : ""}
                              {returnedMaintenance > 0
                                ? ` · ${returnedMaintenance} Maintenance`
                                : ""}
                            </span>
                          );
                        })}
                      </div>
                      )}
                    </div>
                  </div>
                </div>
                </Fragment>
              );
            })}
          </div>
        )}

        {canSubmitDraft ? (
          <div className="border-t border-gray-200 px-4 py-4 sm:px-5">
            <button
              type="button"
              onClick={() => void submitForApproval()}
              disabled={submitting || items.length === 0}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-black px-4 py-3 text-[11px] font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
              {submitting ? "Submitting..." : "Submit for Approval"}
            </button>
            <div className="mt-2 text-center text-[9px] text-gray-400">
              Submitting locks equipment changes until warehouse review.
            </div>
          </div>
        ) : null}

        {canReview ? (
          <div className="border-t border-gray-200 px-4 py-4 sm:px-5">
            <button
              type="button"
              onClick={() => void approveAndDispatch()}
              disabled={approving || items.length === 0}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-4 py-3 text-[11px] font-semibold text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {approving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ShieldCheck size={15} />
              )}
              {approving
                ? "Approving..."
                : isMaintenanceList
                  ? "Approve & Send"
                  : "Approve & Dispatch"}
            </button>
            <div className="mt-2 text-center text-[9px] text-gray-400">
              {isMaintenanceList
                ? "Selected equipment must already be in Maintenance. Approval starts external repair tracking."
                : "Availability changes only after this approval succeeds."}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CustomItemDialog({
  saving,
  onClose,
  onAdd,
}: {
  saving: boolean;
  onClose: () => void;
  onAdd: (input: {
    name: string;
    category: string;
    quantity: number;
    notes: string;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("lighting");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const valid = name.trim().length > 0 && quantity > 0;

  return (
    <div
      className="fixed inset-0 z-[10030] flex items-end justify-center sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label="Add an item not in inventory"
    >
      <button
        type="button"
        aria-label="Close custom item form"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || saving) return;
          onAdd({ name, category, quantity, notes });
        }}
        className="relative w-full rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-base font-bold text-gray-900">
              <FilePlus2 size={17} />
              Add Custom Item
            </div>
            <div className="mt-1 text-[11px] leading-4 text-gray-500">
              Add equipment that is not registered in Inventory.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-600 disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </div>

        <div className="mt-5 space-y-3">
          <label className="block">
            <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider text-gray-500">
              Item Name
            </span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Rental power cable"
              disabled={saving}
              className="h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-[12px] text-gray-900 outline-none focus:border-black disabled:bg-gray-100"
            />
          </label>

          <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-3">
            <label className="block">
              <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider text-gray-500">
                Category
              </span>
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                disabled={saving}
                className="h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-[12px] text-gray-900 outline-none focus:border-black disabled:bg-gray-100"
              >
                <option value="lighting">Lighting</option>
                <option value="video">Video</option>
                <option value="rigging">Rigging</option>
                <option value="audio">Audio</option>
                <option value="power">Power</option>
                <option value="other">Other</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider text-gray-500">
                Qty
              </span>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(event) =>
                  setQuantity(
                    Math.max(1, Math.floor(Number(event.target.value) || 1)),
                  )
                }
                disabled={saving}
                className="h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-right text-[12px] font-bold text-gray-900 outline-none focus:border-black disabled:bg-gray-100"
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-[9px] font-bold uppercase tracking-wider text-gray-500">
              Notes (optional)
            </span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Supplier, description or any details..."
              disabled={saving}
              rows={3}
              className="w-full resize-none rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-[12px] text-gray-900 outline-none focus:border-black disabled:bg-gray-100"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={!valid || saving}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-black px-4 py-3 text-[11px] font-bold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Plus size={14} />
          )}
          {saving ? "Adding..." : "Add to List"}
        </button>
      </form>
    </div>
  );
}

function ReturnQuantityDialog({
  item,
  remaining,
  okQuantity,
  saving,
  onOkQuantityChange,
  onClose,
  onConfirm,
}: {
  item: EquipmentListItem;
  remaining: number;
  okQuantity: number;
  saving: boolean;
  onOkQuantityChange: (value: number) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const total = okQuantity;
  const valid = total > 0 && total <= remaining;
  const genericMatrix =
    item.inventory_record_type === "matrix_model" ||
    item.metadata?.matrix_source === "generic";
  const quantityName =
    item.inventory_record_type === "item"
      ? "item"
      : genericMatrix
        ? "unit"
        : "cabinet";

  function clamp(value: string) {
    return Math.max(0, Math.min(remaining, Math.floor(Number(value) || 0)));
  }

  return (
    <div
      className="fixed inset-0 z-[10030] flex items-end justify-center sm:items-center sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-label={`Receive returned ${item.display_name}`}
    >
      <button
        type="button"
        aria-label="Close return form"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />

      <div className="relative w-full rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-3xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-base font-bold text-gray-900">
              Receive Returned {quantityName === "cabinet" ? "Cabinets" : "Items"}
            </div>
            <div className="mt-1 text-[11px] text-gray-500">
              {item.display_name} · {remaining} currently outside
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-600 disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3">
          <label className="rounded-2xl border border-green-200 bg-green-50 p-3">
            <span className="flex items-center gap-1.5 text-[10px] font-bold text-green-800">
              <RotateCcw size={12} /> Received
            </span>
            <input
              type="number"
              min={0}
              max={remaining}
              value={okQuantity}
              disabled={saving}
              onChange={(event) => onOkQuantityChange(clamp(event.target.value))}
              className="mt-2 w-full rounded-xl border border-green-200 bg-white px-3 py-2.5 text-sm font-bold text-gray-900 outline-none focus:border-green-500"
            />
          </label>
        </div>

        <div
          className={`mt-3 rounded-xl px-3 py-2 text-[10px] font-medium ${
            valid
              ? "bg-gray-50 text-gray-600"
              : "bg-red-50 text-red-700"
          }`}
        >
          {total > remaining
            ? `Total cannot exceed ${remaining}.`
            : total < 1
              ? `Enter at least one returned ${quantityName}.`
              : `${total} of ${remaining} ${quantityName}${remaining === 1 ? "" : "s"} will be received.`}
        </div>

        <button
          type="button"
          onClick={onConfirm}
          disabled={!valid || saving}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-black px-4 py-3 text-[11px] font-bold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <PackageCheck size={14} />
          )}
          {saving ? "Saving..." : "Confirm Received"}
        </button>
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-3 py-3 sm:px-4">
      <div className="text-[9px] font-bold uppercase tracking-wider text-gray-400">
        {label}
      </div>
      <div className="mt-1 truncate text-[11px] font-semibold text-gray-800">
        {value || "—"}
      </div>
    </div>
  );
}

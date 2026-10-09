"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  canEditInventory,
  canManageEquipmentLists,
  getUserId,
} from "@/lib/authStore";
import { Trash2, ChevronDown } from "lucide-react";
import EquipmentListUnitPicker from "@/components/EquipmentListUnitPicker";
import OnlineImageSearchPanel from "@/components/OnlineImageSearchPanel";
import {
  ACTIVE_EQUIPMENT_LIST_EVENT,
  ACTIVE_EQUIPMENT_LIST_KEY,
  EQUIPMENT_LIST_ITEMS_EVENT,
  EQUIPMENT_LISTS_EVENT,
  equipmentListSummary,
  equipmentListTypeLabel,
  type EquipmentList,
} from "@/lib/equipmentLists";

type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

const FIXTURE_TYPES = [
  "Moving Head profile",
  "Moving Head Spot",
  "Moving Head Beam",
  "Moving Head Wash",
  "Lamp Profile & Fresnel",
  "LED Washer & Pars",
  "LED Pixel line",
  "Followspot",
] as const;

type FixtureType = (typeof FIXTURE_TYPES)[number];

type ItemRow = {
  id: string;
  name: string;
  photo_url: string | null;
  subcategory_id: string;
  fixture_type: string | null;
};

type ItemStats = {
  total: number;
  available: number;
  inUse: number;
  maintenance: number;
  inKsa: number;
};

type ActiveAllocation = {
  listId: string;
  reference: string;
  label: string;
  quantity: number;
  listType: EquipmentList["list_type"];
  status: "active" | "partially_returned";
};

type OnlineImage = {
  title?: string;
  image?: string;
  original?: string;
  thumbnail?: string;
};

type FixturesCache = {
  subId: string | null;
  items: ItemRow[];
  statsByItem: Record<string, ItemStats>;
  allocationsByItem: Record<string, ActiveAllocation[]>;
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

async function compressImageFile(
  file: File,
  maxSize = 260,
  quality = 0.72,
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
  const supabase = createClient();

  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;

  const filePath = `items/thumbs/${fileName}`;

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

function splitBrandModel(name: string) {
  const parts = name.split(" - ");
  return {
    brand: (parts[0] || "").trim(),
    model: parts.slice(1).join(" - ").trim(),
  };
}

function renderFixtureName(name: string) {
  const parts = splitBrandModel(name);

  return (
    <>
      <span className="font-bold">{parts.brand}</span>
      {parts.model ? <span>{` ${parts.model}`}</span> : null}
    </>
  );
}

function sortItemsByBrand(items: ItemRow[]) {
  return [...items].sort((a, b) => {
    const aParts = splitBrandModel(a.name);
    const bParts = splitBrandModel(b.name);

    const brandCompare = aParts.brand.localeCompare(bParts.brand, undefined, {
      sensitivity: "base",
    });

    if (brandCompare !== 0) return brandCompare;

    return (aParts.model || a.name).localeCompare(
      bParts.model || b.name,
      undefined,
      { sensitivity: "base", numeric: true },
    );
  });
}

function countByStatus(statuses: UnitStatus[]): ItemStats {
  let available = 0;
  let inUse = 0;
  let maintenance = 0;
  let inKsa = 0;

  for (const s of statuses) {
    if (s === "available") available++;
    else if (s === "in_use") inUse++;
    else if (s === "maintenance") maintenance++;
    else if (s === "in_ksa") inKsa++;
  }

  return { total: statuses.length, available, inUse, maintenance, inKsa };
}

function cacheKeyFor(category: string, subcategory: string) {
  return `hems:${category}:${subcategory}:fixtures:v4`;
}

function allocationLabel(list: EquipmentList) {
  const type = equipmentListTypeLabel(list.list_type);
  const summary = equipmentListSummary(list);
  return summary ? `${type} · ${summary}` : type;
}

function readFixturesCache(
  category: string,
  subcategory: string,
): FixturesCache | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = sessionStorage.getItem(cacheKeyFor(category, subcategory));
    return raw ? (JSON.parse(raw) as FixturesCache) : null;
  } catch {
    return null;
  }
}

function writeFixturesCache(
  category: string,
  subcategory: string,
  data: FixturesCache,
) {
  if (typeof window === "undefined") return;

  try {
    sessionStorage.setItem(
      cacheKeyFor(category, subcategory),
      JSON.stringify(data),
    );
  } catch {}
}

function StatPill({
  label,
  value,
  tone = "gray",
}: {
  label: string;
  value: string | number;
  tone?: "gray" | "green" | "blue" | "yellow" | "purple";
}) {
  const cls =
    tone === "green"
      ? "bg-green-100 text-black"
      : tone === "blue"
        ? "bg-blue-100 text-black"
        : tone === "yellow"
          ? "bg-yellow-100 text-black"
          : tone === "purple"
            ? "bg-purple-100 text-black"
            : "bg-gray-100 text-black";

  return (
    <span
      className={`px-2 py-1 rounded-lg text-[8px] font-semibold whitespace-nowrap ${cls}`}
    >
      {label}: {value}
    </span>
  );
}

function ItemPhoto({
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
    <div className="relative flex h-14 w-14 min-w-[56px] items-center justify-center">
      {photo ? (
        <img
          src={photo}
          alt={name}
          loading="lazy"
          decoding="async"
          className="h-full w-full rounded-lg object-cover bg-white"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-lg bg-white text-[10px] text-gray-400">
          No photo
        </div>
      )}

      {editable ? (
        <div
          className="absolute right-0 top-0 z-30"
          data-list-photo-menu="true"
        >
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
            <div className="absolute left-0 top-full z-[9999] mt-1 w-36 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
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

export default function SubcategoryClientLighting({
  category,
  subcategory,
}: {
  category: string;
  subcategory: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listPhotoFileRef = useRef<HTMLInputElement | null>(null);
  const editable = canEditInventory();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [subId, setSubId] = useState<string | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [statsByItem, setStatsByItem] = useState<Record<string, ItemStats>>({});
  const [allocationsByItem, setAllocationsByItem] = useState<
    Record<string, ActiveAllocation[]>
  >({});

  const [fixtureType, setFixtureType] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [qty, setQty] = useState<number>(1);
  const [photo, setPhoto] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState("");
  const [sidebarTarget, setSidebarTarget] = useState<HTMLElement | null>(null);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(
    null,
  );
  const [selectedBrandDraft, setSelectedBrandDraft] = useState("");
  const [selectedModelDraft, setSelectedModelDraft] = useState("");
  const [mobileMenuItemId, setMobileMenuItemId] = useState<string | null>(null);
  const [mobileAddFixtureOpen, setMobileAddFixtureOpen] = useState(false);
  const [activeEquipmentList, setActiveEquipmentList] =
    useState<EquipmentList | null>(null);
  const [listPickerItem, setListPickerItem] = useState<ItemRow | null>(null);

  const [photoMenuOpen, setPhotoMenuOpen] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [imageSearch, setImageSearch] = useState("");
  const [imageResults, setImageResults] = useState<OnlineImage[]>([]);
  const [searchingImages, setSearchingImages] = useState(false);

  const [editingPhotoItemId, setEditingPhotoItemId] = useState<string | null>(
    null,
  );

  const fixtureName = useMemo(() => {
    const b = brand.trim();
    const m = model.trim();

    if (b && m) return `${b} - ${m}`;
    if (b) return b;
    return m;
  }, [brand, model]);

  const fixtureSearchName = useMemo(() => {
    const b = brand.trim();
    const m = model.trim();

    if (b && m) return `${b} ${m}`;
    if (b) return b;
    return m;
  }, [brand, model]);

  const canAdd = useMemo(
    () =>
      editable &&
      fixtureType.trim().length > 0 &&
      fixtureName.trim().length > 0 &&
      qty >= 1,
    [editable, fixtureType, fixtureName, qty],
  );

  const groupedItems = useMemo(() => {
    return FIXTURE_TYPES.map((type) => ({
      type,
      items: sortItemsByBrand(items.filter((it) => it.fixture_type === type)),
    })).filter((group) => group.items.length > 0);
  }, [items]);

  const uncategorizedItems = useMemo(() => {
    return sortItemsByBrand(
      items.filter(
        (it) =>
          !it.fixture_type ||
          !FIXTURE_TYPES.includes(it.fixture_type as FixtureType),
      ),
    );
  }, [items]);

  const navigableItems = useMemo(
    () => [
      ...groupedItems.flatMap((group) => group.items),
      ...uncategorizedItems,
    ],
    [groupedItems, uncategorizedItems],
  );

  const selectedFixture = useMemo(
    () => items.find((item) => item.id === selectedFixtureId) ?? null,
    [items, selectedFixtureId],
  );

  const activeDraftList = activeEquipmentList;

  useEffect(() => {
    const parsed = splitBrandModel(selectedFixture?.name ?? "");
    setSelectedBrandDraft(parsed.brand);
    setSelectedModelDraft(parsed.model);
  }, [selectedFixtureId, selectedFixture?.name]);

  useEffect(() => {
    if (selectedFixtureId !== null) return;

    setSearchPanelOpen(false);
    setImageResults([]);
    setImageSearch("");
    setSearchingImages(false);
    setEditingPhotoItemId(null);
  }, [selectedFixtureId]);

  async function resolveSubcategoryId() {
    const catRes = await supabase
      .from("categories")
      .select("id")
      .eq("slug", category)
      .single();

    if (catRes.error || !catRes.data?.id) {
      throw new Error(`Category not found in DB for slug: ${category}`);
    }

    const subRes = await supabase
      .from("subcategories")
      .select("id")
      .eq("category_id", catRes.data.id)
      .eq("slug", subcategory)
      .single();

    if (subRes.error || !subRes.data?.id) {
      throw new Error(`Subcategory not found in DB for slug: ${subcategory}`);
    }

    return subRes.data.id as string;
  }

  async function load(forceRefresh = false) {
    setErr(null);

    const cacheKey = cacheKeyFor(category, subcategory);

    if (!forceRefresh && typeof window !== "undefined") {
      const cached = readFixturesCache(category, subcategory);

      if (cached) {
        setSubId(cached.subId);
        setItems(cached.items || []);
        setStatsByItem(cached.statsByItem || {});
        setAllocationsByItem(cached.allocationsByItem || {});
        setLoading(false);

        void refreshData(cacheKey);
        return;
      }
    }

    setLoading(items.length === 0);
    await refreshData(cacheKey);
  }

  async function refreshData(cacheKey: string) {
    try {
      const sid = await resolveSubcategoryId();
      setSubId(sid);

      const itemsRes = await supabase
        .from("items")
        .select("id,name,photo_url,subcategory_id,fixture_type")
        .eq("subcategory_id", sid);

      if (itemsRes.error) throw itemsRes.error;

      const list = sortItemsByBrand((itemsRes.data || []) as ItemRow[]);
      const ids = list.map((x) => x.id);

      let stats: Record<string, ItemStats> = {};
      const allocations: Record<string, ActiveAllocation[]> = {};

      for (const itemId of ids) allocations[itemId] = [];

      if (ids.length > 0) {
        let allUnits: any[] = [];
        let from = 0;
        const pageSize = 1000;

        while (true) {
          const unitsRes = await supabase
            .from("units")
            .select("item_id,status")
            .in("item_id", ids)
            .range(from, from + pageSize - 1);

          if (unitsRes.error) throw unitsRes.error;

          allUnits = [...allUnits, ...(unitsRes.data || [])];

          if (!unitsRes.data || unitsRes.data.length < pageSize) break;

          from += pageSize;
        }

        const by: Record<string, UnitStatus[]> = {};
        for (const itId of ids) by[itId] = [];

        for (const u of allUnits) {
          const itemId = String((u as any).item_id || "");
          const status = String((u as any).status || "available") as UnitStatus;

          if (!by[itemId]) by[itemId] = [];
          by[itemId].push(status);
        }

        for (const itId of ids) {
          stats[itId] = countByStatus(by[itId] || []);
        }

        const activeListsResult = await supabase
          .from("equipment_lists")
          .select(ACTIVE_LIST_SELECT)
          .in("status", ["active", "partially_returned"])
          .order("created_at", { ascending: false })
          .limit(200);

        if (activeListsResult.error) {
          console.error(
            "load lighting active equipment lists error",
            activeListsResult.error,
          );
        } else {
          const activeLists = (activeListsResult.data ?? []) as EquipmentList[];
          const activeListIds = activeLists.map((activeList) => activeList.id);
          const activeListsById = new Map(
            activeLists.map((activeList) => [activeList.id, activeList]),
          );

          if (activeListIds.length > 0) {
            let allocationRows: Array<{
              list_id: string;
              parent_record_id: string | null;
              requested_quantity: number;
              approved_quantity: number;
              returned_ok_quantity: number;
              returned_maintenance_quantity: number;
            }> = [];
            let allocationFrom = 0;
            const allocationPageSize = 1000;

            while (true) {
              const allocationResult = await supabase
                .from("equipment_list_items")
                .select(
                  "list_id,parent_record_id,requested_quantity,approved_quantity,returned_ok_quantity,returned_maintenance_quantity",
                )
                .eq("inventory_record_type", "unit")
                .in("list_id", activeListIds)
                .in("parent_record_id", ids)
                .range(
                  allocationFrom,
                  allocationFrom + allocationPageSize - 1,
                );

              if (allocationResult.error) {
                console.error(
                  "load lighting active allocations error",
                  allocationResult.error,
                );
                break;
              }

              const page = (allocationResult.data ?? []) as typeof allocationRows;
              allocationRows = [...allocationRows, ...page];

              if (page.length < allocationPageSize) break;
              allocationFrom += allocationPageSize;
            }

            const allocationMap = new Map<string, ActiveAllocation>();

            for (const row of allocationRows) {
              const itemId = row.parent_record_id;
              const activeList = activeListsById.get(row.list_id);
              if (!itemId || !activeList) continue;

              const approved = Number(row.approved_quantity) || 0;
              const requested = Number(row.requested_quantity) || 0;
              const returned =
                (Number(row.returned_ok_quantity) || 0) +
                (Number(row.returned_maintenance_quantity) || 0);
              const quantity = Math.max(
                0,
                (approved > 0 ? approved : requested) - returned,
              );

              if (quantity === 0) continue;

              const key = `${itemId}:${activeList.id}`;
              const current = allocationMap.get(key);

              if (current) {
                current.quantity += quantity;
              } else {
                allocationMap.set(key, {
                  listId: activeList.id,
                  reference: activeList.reference,
                  label: allocationLabel(activeList),
                  quantity,
                  listType: activeList.list_type,
                  status:
                    activeList.status === "partially_returned"
                      ? "partially_returned"
                      : "active",
                });
              }
            }

            for (const [key, allocation] of allocationMap) {
              const itemId = key.split(":", 1)[0];
              if (!allocations[itemId]) allocations[itemId] = [];
              allocations[itemId].push(allocation);
            }
          }
        }
      }

      setItems(list);
      setStatsByItem(stats);
      setAllocationsByItem(allocations);

      sessionStorage.setItem(
        cacheKey,
        JSON.stringify({
          subId: sid,
          items: list,
          statsByItem: stats,
          allocationsByItem: allocations,
        }),
      );
    } catch (e: any) {
      setErr(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, subcategory]);

  useEffect(() => {
    function refreshEquipmentMovements() {
      void load(true);
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
  }, [category, subcategory]);

  useEffect(() => {
    function syncSidebarTarget() {
      const nextTarget = document.getElementById("right-sidebar-actions");
      setSidebarTarget((current) =>
        current === nextTarget ? current : nextTarget,
      );
    }

    syncSidebarTarget();

    const observer = new MutationObserver(syncSidebarTarget);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

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

      setListPickerItem(null);

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

      if (error || !data || !canUseList) {
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
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const addMenu = target.closest("[data-add-photo-menu='true']");
      const mobileFixtureMenu = target.closest(
        "[data-mobile-fixture-menu='true']",
      );
      const mobileFixtureTools = target.closest(
        "[data-mobile-lighting-tools='true']",
      );

      if (!addMenu) {
        setPhotoMenuOpen(false);
      }

      if (!mobileFixtureMenu && !mobileFixtureTools) {
        setMobileMenuItemId(null);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editable) return;

    const f = e.target.files?.[0];
    if (!f) return;

    try {
      setSaveMsg("Uploading photo...");
      const imageUrl = await uploadPhoto(f);
      setPhoto(imageUrl);
      setSaveMsg("Photo selected");
      setTimeout(() => setSaveMsg(""), 1500);
    } catch (e: any) {
      alert(e?.message || "Photo failed");
    } finally {
      e.target.value = "";
    }
  }

  async function searchOnlineImages(customQuery?: string) {
    const q = (customQuery || imageSearch || fixtureSearchName).trim();

    if (!q) {
      alert("Write brand/model first");
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
      const results: OnlineImage[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.images_results)
          ? data.images_results
          : [];
      setImageSearch(q);
      setImageResults(results);

      if (results.length === 0) {
        alert("No images found. Try the brand and model only, or upload a photo.");
      }
    } catch (e) {
      console.error("Image search error:", e);
      alert("Failed to search images");
    } finally {
      setSearchingImages(false);
    }
  }

  async function updateItemPhoto(itemId: string, imageUrl: string) {
    if (!editable) return;

    const { error } = await supabase
      .from("items")
      .update({ photo_url: imageUrl })
      .eq("id", itemId);

    if (error) {
      alert("Failed to update photo");
      return;
    }

    const nextItems = items.map((it) =>
      it.id === itemId ? { ...it, photo_url: imageUrl } : it,
    );

    setItems(nextItems);

    writeFixturesCache(category, subcategory, {
      subId,
      items: nextItems,
      statsByItem,
      allocationsByItem,
    });

    setSaveMsg("Photo updated");
    setTimeout(() => setSaveMsg(""), 1500);
  }

  async function onPickListItemPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editable || !editingPhotoItemId) return;

    const f = e.target.files?.[0];
    if (!f) return;

    try {
      setSaveMsg("Uploading photo...");

      const imageUrl = await uploadPhoto(f);
      await updateItemPhoto(editingPhotoItemId, imageUrl);
    } catch (error: any) {
      console.error("Upload list item photo error:", error);
      alert(error?.message || "Failed to upload photo");
      setSaveMsg("");
    } finally {
      e.target.value = "";
      setEditingPhotoItemId(null);
    }
  }

  async function searchPhotoForItem(item: ItemRow) {
    setEditingPhotoItemId(item.id);

    const parts = splitBrandModel(item.name);
    const searchName = `${parts.brand} ${parts.model}`.trim();

    setImageSearch(searchName);
    setSearchPanelOpen(true);
    setImageResults([]);

    void searchOnlineImages(searchName);
  }

  async function selectOnlinePhoto(img: OnlineImage) {
    const fallbackUrl = img.thumbnail || img.image || img.original;
    const sourceUrl = img.image || img.original || img.thumbnail;

    if (!fallbackUrl || !sourceUrl) return;

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
      console.warn(
        "Could not optimize online image, using thumbnail URL:",
        error,
      );
      finalImageUrl = fallbackUrl;
    }

    if (editingPhotoItemId) {
      await updateItemPhoto(editingPhotoItemId, finalImageUrl);
      setEditingPhotoItemId(null);
    } else {
      setPhoto(finalImageUrl);
    }

    setSearchPanelOpen(false);
    setImageResults([]);
    setSaveMsg("Online photo selected");
    setTimeout(() => setSaveMsg(""), 1500);
  }

  async function onAdd() {
    if (!editable || !subId) return;

    const nm = fixtureName.trim();
    const ft = fixtureType.trim();

    if (!nm || !ft) return;

    const q = Math.max(1, Number(qty) || 1);
    setErr(null);

    try {
      const insItem = await supabase
        .from("items")
        .insert({
          subcategory_id: subId,
          fixture_type: ft,
          name: nm,
          photo_url: photo || null,
        })
        .select("id,name,photo_url,subcategory_id,fixture_type")
        .single();

      if (insItem.error) throw insItem.error;

      const newItem = insItem.data as ItemRow;

      const unitsPayload = Array.from({ length: q }, (_, i) => ({
        item_id: newItem.id,
        unit_no: i + 1,
        serial: null,
        status: "available",
      }));

      const insUnits = await supabase.from("units").insert(unitsPayload);
      if (insUnits.error) throw insUnits.error;

      const nextItems = sortItemsByBrand([...items, newItem]);
      const nextStats = {
        ...statsByItem,
        [newItem.id]: {
          total: q,
          available: q,
          inUse: 0,
          maintenance: 0,
          inKsa: 0,
        },
      };

      setItems(nextItems);
      setStatsByItem(nextStats);

      writeFixturesCache(category, subcategory, {
        subId,
        items: nextItems,
        statsByItem: nextStats,
        allocationsByItem,
      });

      setFixtureType("");
      setBrand("");
      setModel("");
      setQty(1);
      setPhoto(null);
      setImageSearch("");
      setImageResults([]);
      setSearchPanelOpen(false);
      setPhotoMenuOpen(false);
      setMobileAddFixtureOpen(false);
      setSaveMsg("Item added");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item added" ? "" : prev));
      }, 1500);
    } catch (e: any) {
      setErr(e?.message || "Add failed");
    }
  }

  async function onRename(
    itemId: string,
    current: string,
    nextNameOverride?: string,
  ) {
    if (!editable) return;

    const nextName = nextNameOverride ?? prompt("Rename fixture:", current);
    if (!nextName) return;

    const clean = nextName.trim();
    if (!clean) return;

    try {
      const upd = await supabase
        .from("items")
        .update({ name: clean })
        .eq("id", itemId);

      if (upd.error) throw upd.error;

      const nextItems = sortItemsByBrand(
        items.map((it) => (it.id === itemId ? { ...it, name: clean } : it)),
      );

      setItems(nextItems);

      writeFixturesCache(category, subcategory, {
        subId,
        items: nextItems,
        statsByItem,
        allocationsByItem,
      });

      setSaveMsg("Item renamed");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item renamed" ? "" : prev));
      }, 1500);
    } catch (e: any) {
      alert(e?.message || "Rename failed");
    }
  }

  async function updateSelectedFixtureType(nextType: string) {
    if (!editable || !selectedFixture) return;

    const clean = nextType.trim();
    if (!clean || clean === (selectedFixture.fixture_type || "")) return;

    try {
      const { error } = await supabase
        .from("items")
        .update({ fixture_type: clean })
        .eq("id", selectedFixture.id);

      if (error) throw error;

      const nextItems = sortItemsByBrand(
        items.map((item) =>
          item.id === selectedFixture.id
            ? { ...item, fixture_type: clean }
            : item,
        ),
      );

      setItems(nextItems);

      writeFixturesCache(category, subcategory, {
        subId,
        items: nextItems,
        statsByItem,
        allocationsByItem,
      });

      setSaveMsg("Fixture type updated");
      setTimeout(() => {
        setSaveMsg((previous) =>
          previous === "Fixture type updated" ? "" : previous,
        );
      }, 1500);
    } catch (error: any) {
      alert(error?.message || "Failed to update fixture type");
    }
  }

  async function saveSelectedFixtureName() {
    if (!selectedFixture) return;

    const clean = [selectedBrandDraft, selectedModelDraft]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" - ");

    if (!clean) {
      const parsed = splitBrandModel(selectedFixture.name);
      setSelectedBrandDraft(parsed.brand);
      setSelectedModelDraft(parsed.model);
      return;
    }

    if (clean === selectedFixture.name) return;

    await onRename(selectedFixture.id, selectedFixture.name, clean);
  }

  useEffect(() => {
    function handleSelectionClickOutside(event: MouseEvent) {
      if (!selectedFixtureId) return;

      const target = event.target as HTMLElement;
      const insideFixture = target.closest(
        "[data-lighting-fixture-row='true']",
      );
      const insideSidebar = target.closest("#right-sidebar-actions");
      const insideMobileTools = target.closest(
        "[data-mobile-lighting-tools='true']",
      );

      if (insideFixture || insideSidebar || insideMobileTools) return;

      void saveSelectedFixtureName();
      setSelectedFixtureId(null);
    }

    document.addEventListener("mousedown", handleSelectionClickOutside);
    return () =>
      document.removeEventListener("mousedown", handleSelectionClickOutside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedFixtureId,
    selectedBrandDraft,
    selectedModelDraft,
    selectedFixture?.name,
  ]);

  useEffect(() => {
    function handleArrowNavigation(event: KeyboardEvent) {
      if (
        !selectedFixtureId ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
      ) {
        return;
      }

      const target = event.target as HTMLElement;
      const isFormField = target.matches("input, textarea, select");
      const isSelectedNameField = Boolean(
        target.closest("[data-selected-fixture-name='true']"),
      );

      if (isFormField && !isSelectedNameField) return;

      // Stop the browser from scrolling the page while a fixture is selected.
      // Capture mode makes this run before inputs and other page handlers.
      event.preventDefault();

      const currentIndex = navigableItems.findIndex(
        (item) => item.id === selectedFixtureId,
      );
      if (currentIndex < 0) return;

      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = Math.min(
        navigableItems.length - 1,
        Math.max(0, currentIndex + direction),
      );

      if (nextIndex === currentIndex) return;

      void saveSelectedFixtureName();
      const nextItemId = navigableItems[nextIndex].id;
      setSelectedFixtureId(nextItemId);

      requestAnimationFrame(() => {
        document
          .querySelector(`[data-lighting-fixture-id="${nextItemId}"]`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }

    document.addEventListener("keydown", handleArrowNavigation, true);
    return () =>
      document.removeEventListener("keydown", handleArrowNavigation, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedFixtureId,
    selectedBrandDraft,
    selectedModelDraft,
    navigableItems,
  ]);

  async function onDelete(itemId: string) {
    if (!editable) return;
    if (!confirm("Delete this fixture?")) return;

    try {
      const delUnits = await supabase
        .from("units")
        .delete()
        .eq("item_id", itemId);

      if (delUnits.error) throw delUnits.error;

      const delItem = await supabase.from("items").delete().eq("id", itemId);

      if (delItem.error) throw delItem.error;

      const nextItems = items.filter((it) => it.id !== itemId);
      const nextStats = { ...statsByItem };
      delete nextStats[itemId];

      setItems(nextItems);
      setStatsByItem(nextStats);
      setSelectedFixtureId((current) => (current === itemId ? null : current));
      setMobileMenuItemId((current) => (current === itemId ? null : current));

      writeFixturesCache(category, subcategory, {
        subId,
        items: nextItems,
        statsByItem: nextStats,
        allocationsByItem,
      });

      setSaveMsg("Item deleted");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item deleted" ? "" : prev));
      }, 1500);
    } catch (e: any) {
      alert(e?.message || "Delete failed");
    }
  }

  async function closeMobileFixtureTools() {
    await saveSelectedFixtureName();
    setMobileMenuItemId(null);
    setSelectedFixtureId(null);
    setSearchPanelOpen(false);
    setImageResults([]);
    setEditingPhotoItemId(null);
  }

  function renderFixtureRow(it: ItemRow, isLast: boolean) {
    const stats = statsByItem[it.id] || {
      total: 0,
      available: 0,
      inUse: 0,
      maintenance: 0,
      inKsa: 0,
    };
    const allocations = allocationsByItem[it.id] || [];
    const allocatedQuantity = allocations.reduce(
      (total, allocation) =>
        allocation.listType === "maintenance"
          ? total
          : total + allocation.quantity,
      0,
    );
    const existingMovementQuantity = Math.max(
      0,
      stats.inUse + stats.inKsa - allocatedQuantity,
    );

    const detailsHref = `/inventory/${category}/${subcategory}/${it.id}`;

    return (
      <div
        key={it.id}
        className={!isLast ? "border-b border-gray-100 pb-4 mb-4" : ""}
      >
        <div
          data-lighting-fixture-row="true"
          data-lighting-fixture-id={it.id}
          className={`relative rounded-xl transition ${
            selectedFixtureId === it.id
              ? "bg-gray-50 ring-2 ring-black"
              : "hover:bg-gray-50"
          }`}
        >
          <button
            type="button"
            onClick={async () => {
              if (window.matchMedia("(min-width: 640px)").matches) {
                if (selectedFixtureId === it.id) {
                  await saveSelectedFixtureName();
                  setSelectedFixtureId(null);
                  return;
                }

                await saveSelectedFixtureName();
                setSelectedFixtureId(it.id);
              } else {
                window.location.href = detailsHref;
              }
            }}
            className={`flex w-full flex-col gap-3 p-2 pr-10 text-left sm:flex-row sm:items-start ${
              editable && activeDraftList ? "sm:pr-36" : "sm:pr-20"
            }`}
          >
            <div className="flex items-start gap-3 min-w-0 flex-[1.45]">
              <div className="flex items-start gap-3 min-w-0 flex-1 group">
                <ItemPhoto
                  photo={it.photo_url}
                  name={it.name}
                  editable={false}
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <h2
                      className="truncate text-[10px] sm:text-[11px] text-gray-900"
                      style={{ lineHeight: 1.1 }}
                    >
                      {renderFixtureName(it.name)}
                    </h2>
                  </div>

                  <div className="mt-2 sm:hidden">
                    <div
                      className={`grid gap-x-2 gap-y-1 text-center ${
                        stats.maintenance > 0
                          ? "grid-cols-3"
                          : "grid-cols-2"
                      }`}
                    >
                      <div className="text-[8px] font-semibold text-gray-500">
                        Total
                      </div>
                      <div className="text-[8px] font-semibold text-gray-500">
                        Available
                      </div>
                      {stats.maintenance > 0 ? (
                        <div className="text-[8px] font-semibold text-gray-500">
                          Maintenance
                        </div>
                      ) : null}

                      <div className="rounded-md bg-gray-100 px-1 py-0.5 text-[9px] font-semibold">
                        {stats.total}
                      </div>
                      <div className="rounded-md bg-green-100 px-1 py-0.5 text-[9px] font-semibold">
                        {stats.available}
                      </div>
                      {stats.maintenance > 0 ? (
                        <div className="rounded-md bg-yellow-100 px-1 py-0.5 text-[9px] font-semibold">
                          {stats.maintenance}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-1 hidden sm:block">
                    <div className="flex flex-wrap gap-2">
                      <StatPill label="Total Qty" value={stats.total} />
                      <StatPill
                        label="Available Qty"
                        value={stats.available}
                        tone="green"
                      />
                      {stats.maintenance > 0 ? (
                        <StatPill
                          label="Maintenance"
                          value={stats.maintenance}
                          tone="yellow"
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </button>

          {allocations.length > 0 || existingMovementQuantity > 0 ? (
            <div
              data-lighting-active-allocations="true"
              className={`px-2 pb-2 sm:pl-[76px] ${
                editable && activeDraftList ? "sm:pr-36" : "sm:pr-20"
              }`}
            >
              <div className="mb-1 text-[8px] font-bold uppercase tracking-wider text-gray-400">
                Active Movements / Repair
              </div>

              <div className="flex flex-wrap gap-1.5">
                {allocations.map((allocation) => (
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

                {existingMovementQuantity > 0 ? (
                  <span className="rounded-lg bg-gray-100 px-2 py-1 text-[9px] font-semibold text-gray-600">
                    {existingMovementQuantity} pcs · Existing movement
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeDraftList ? (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setListPickerItem(it);
              }}
              title={`Add units to ${activeDraftList.reference}`}
              className={`absolute top-2 z-20 rounded-full bg-black px-2.5 py-1 text-[9px] font-semibold text-white shadow-sm sm:hidden ${
                editable ? "right-10" : "right-2"
              }`}
            >
              + List
            </button>
          ) : null}

          <div className="absolute right-2 top-2 hidden items-center gap-1.5 sm:flex">
            {activeDraftList ? (
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setListPickerItem(it);
                }}
                title={`Add units to ${activeDraftList.reference}`}
                className="rounded-full bg-black px-2.5 py-1 text-[9px] font-semibold text-white shadow-sm transition hover:bg-gray-800"
              >
                + List
              </button>
            ) : null}

            <Link
              href={detailsHref}
              onClick={(event) => event.stopPropagation()}
              className="rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[9px] font-medium text-gray-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
            >
              Report
            </Link>
          </div>

          {editable ? (
            <div
              data-mobile-fixture-menu="true"
              className="absolute right-2 top-2 z-30 sm:hidden"
            >
              <button
                type="button"
                aria-label={`Edit ${it.name}`}
                aria-expanded={mobileMenuItemId === it.id}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();

                  if (mobileMenuItemId === it.id) {
                    void closeMobileFixtureTools();
                    return;
                  }

                  void saveSelectedFixtureName();
                  setSearchPanelOpen(false);
                  setImageResults([]);
                  setEditingPhotoItemId(null);
                  setSelectedFixtureId(it.id);
                  setMobileMenuItemId(it.id);
                }}
                className="flex h-[26px] w-[26px] items-center justify-center rounded-full border border-gray-300 bg-white text-base font-bold leading-none text-gray-700 shadow-sm hover:bg-gray-50"
              >
                ⋮
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="w-full">
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
          Loading fixtures...
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="w-full">
        <div className="bg-white border border-gray-200 rounded-2xl p-6 text-gray-900">
          <div className="font-semibold">Error</div>

          <div className="text-sm text-red-600 mt-1">{err}</div>

          <button
            onClick={() => void load(true)}
            className="mt-4 px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white hover:bg-red-50 hover:border-red-200 hover:text-red-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const addFixturePanel = editable ? (
    <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
      <div className="mb-4">
        <h1 className="text-[13px] font-semibold leading-tight text-gray-900">
          Add Fixtures
        </h1>
        <p className="mt-1 text-[10px] text-gray-500">
          Select type, brand, model, quantity and optional photo.
        </p>
      </div>

      <div className="add-fixture-grid grid grid-cols-1 gap-2 md:grid-cols-[210px_1fr_1fr_76px_116px_76px] md:items-center">
        <select
          value={fixtureType}
          onChange={(e) => setFixtureType(e.target.value)}
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        >
          <option value="">Select Type</option>
          {FIXTURE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>

        <input
          value={brand}
          onChange={(e) => {
            setBrand(e.target.value);
            if (!imageSearch)
              setImageSearch(`${e.target.value} ${model}`.trim());
          }}
          placeholder="Brand (e.g. Ayrton)"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />

        <input
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            if (!imageSearch)
              setImageSearch(`${brand} ${e.target.value}`.trim());
          }}
          placeholder="Model (e.g. Cobra)"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />

        <input
          value={qty}
          onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          type="number"
          min={1}
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickPhoto}
        />

        <div data-add-photo-menu="true" className="relative">
          <button
            type="button"
            onClick={() => setPhotoMenuOpen((v) => !v)}
            className="flex h-11 w-full items-center justify-center gap-1 rounded-2xl border border-gray-300 bg-white px-4 text-[12px] font-medium text-gray-700 shadow-sm transition hover:bg-red-50 hover:border-red-200 hover:text-red-700"
          >
            {photo ? "Photo ✔" : "Add photo"}
            <ChevronDown size={13} />
          </button>

          {photoMenuOpen ? (
            <div className="absolute right-0 top-full z-[9999] mt-2 w-40 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
              <button
                type="button"
                onClick={() => {
                  setPhotoMenuOpen(false);
                  fileRef.current?.click();
                }}
                className="block w-full px-3 py-2 text-left text-[11px] text-gray-700 hover:bg-gray-50"
              >
                Upload photo
              </button>

              <button
                type="button"
                onClick={async () => {
                  setPhotoMenuOpen(false);
                  setSearchPanelOpen(true);
                  const query = fixtureSearchName.trim();
                  setImageSearch(query);
                  await searchOnlineImages(query);
                }}
                className="block w-full px-3 py-2 text-left text-[11px] text-gray-700 hover:bg-gray-50"
              >
                Search photo
              </button>
            </div>
          ) : null}
        </div>

        <button
          onClick={onAdd}
          disabled={!canAdd}
          className="h-11 w-full rounded-2xl border border-black bg-black px-4 text-[12px] font-medium text-white shadow-sm transition hover:opacity-90 disabled:opacity-40"
        >
          + Add
        </button>
      </div>

      {photo ? (
        <div className="mt-3 flex items-center gap-3 rounded-2xl border border-gray-100 bg-gray-50 p-2">
          <img
            src={photo}
            alt="Selected"
            loading="lazy"
            decoding="async"
            className="h-12 w-12 rounded-xl object-cover border border-gray-200 bg-white"
          />

          <button
            type="button"
            onClick={() => setPhoto(null)}
            className="text-[10px] font-medium text-red-500 hover:text-black"
          >
            Remove photo
          </button>
        </div>
      ) : null}

      {searchPanelOpen ? (
        <div className="mt-4 rounded-2xl border border-gray-200 p-3 relative z-50 bg-white">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-[12px] font-semibold text-gray-900">
              Search photo online
            </div>

            <button
              type="button"
              onClick={() => {
                setSearchPanelOpen(false);
                setImageResults([]);
                setEditingPhotoItemId(null);
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
            <div className="mt-3 text-xs text-gray-500">
              Searching images...
            </div>
          ) : null}

          {imageResults.length > 0 ? (
            <div className="fixture-image-grid mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6">
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

      {saveMsg ? (
        <div className="mt-3 text-xs text-gray-500">{saveMsg}</div>
      ) : null}
    </div>
  ) : null;

  const editFixturePanel = selectedFixture ? (
    <div
      data-lighting-tools="true"
      className="mb-4 rounded-2xl border-2 border-black bg-white p-3 shadow-sm"
    >
      <div className="mb-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Selected Fixture
          </div>
          <select
            value={selectedFixture.fixture_type || ""}
            onChange={(event) =>
              void updateSelectedFixtureType(event.target.value)
            }
            disabled={!editable}
            className="mt-2 h-8 w-full rounded-lg border border-gray-300 bg-white px-2.5 text-[9px] font-semibold text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
          >
            <option value="" disabled>
              Select Fixture Type
            </option>
            {FIXTURE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <div
            data-selected-fixture-name="true"
            className="mt-1 grid grid-cols-1 gap-1.5"
          >
            <input
              value={selectedBrandDraft}
              onChange={(event) => setSelectedBrandDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveSelectedFixtureName();
                }
              }}
              placeholder="Brand"
              disabled={!editable}
              className="h-8 w-full rounded-lg border border-gray-300 bg-white px-2.5 text-[9px] font-semibold text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
            />
            <input
              value={selectedModelDraft}
              onChange={(event) => setSelectedModelDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveSelectedFixtureName();
                }
              }}
              placeholder="Model"
              disabled={!editable}
              className="h-8 w-full rounded-lg border border-gray-300 bg-white px-2.5 text-[9px] font-medium text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
            />
          </div>
        </div>
      </div>

      <div className="mb-3 flex items-center gap-3 rounded-xl bg-gray-50 p-2">
        {selectedFixture.photo_url ? (
          <img
            src={selectedFixture.photo_url}
            alt={selectedFixture.name}
            className="h-16 w-16 rounded-xl bg-white object-cover"
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-white text-[9px] text-gray-400">
            No photo
          </div>
        )}

        <div className="min-w-0 text-[10px] text-gray-500">
          Select an action below to edit this fixture.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <Link
          href={`/inventory/${category}/${subcategory}/${selectedFixture.id}`}
          className="rounded-xl bg-black px-3 py-2.5 text-center text-[11px] font-medium text-white hover:opacity-90"
        >
          Open Fixture / Report
        </Link>

        {editable ? (
          <>
            <button
              type="button"
              onClick={() => {
                setEditingPhotoItemId(selectedFixture.id);
                listPhotoFileRef.current?.click();
              }}
              className="rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-left text-[11px] font-medium text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
            >
              Upload New Photo
            </button>

            <button
              type="button"
              onClick={() => void searchPhotoForItem(selectedFixture)}
              className="rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-left text-[11px] font-medium text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
            >
              Search Photo Online
            </button>

            <button
              type="button"
              onClick={() => void onDelete(selectedFixture.id)}
              className="flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[11px] font-medium text-red-700 hover:bg-red-100"
            >
              <Trash2 size={14} />
              Delete Fixture
            </button>
          </>
        ) : null}
      </div>
    </div>
  ) : null;

  const selectedPhotoSearchPanel =
    selectedFixture &&
    searchPanelOpen &&
    editingPhotoItemId === selectedFixture.id ? (
      <OnlineImageSearchPanel
        initialQuery={imageSearch}
        results={imageResults}
        searching={searchingImages}
        onSearch={(query) => searchOnlineImages(query)}
        onSelect={(image) => selectOnlinePhoto(image)}
        onClose={() => {
          setSearchPanelOpen(false);
          setImageResults([]);
          setEditingPhotoItemId(null);
        }}
        className="mt-3"
      />
    ) : null;

  return (
    <div className="w-full space-y-3">
      <input
        ref={listPhotoFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPickListItemPhoto}
      />

      {activeDraftList && listPickerItem ? (
        <EquipmentListUnitPicker
          list={activeDraftList}
          item={listPickerItem}
          category={category}
          subcategory={subcategory}
          allowPendingReview={
            activeDraftList.status === "pending" &&
            canManageEquipmentLists()
          }
          onClose={() => setListPickerItem(null)}
          onAdded={(count) => {
            const message = `${count} unit${count === 1 ? "" : "s"} added to ${activeDraftList.reference}`;
            setSaveMsg(message);
            setTimeout(() => {
              setSaveMsg((current) => (current === message ? "" : current));
            }, 1800);
          }}
        />
      ) : null}

      {editable && mobileMenuItemId && selectedFixture ? (
        <div
          data-mobile-lighting-tools="true"
          className="fixed inset-0 z-[9998] sm:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={`${selectedFixture.name} tools`}
        >
          <button
            type="button"
            aria-label="Close fixture tools"
            onClick={() => void closeMobileFixtureTools()}
            className="absolute inset-0 bg-black/45"
          />

          <div className="absolute inset-x-0 bottom-0 flex h-[75dvh] flex-col rounded-t-3xl bg-gray-50 shadow-2xl">
            <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
              <div className="h-1 w-10 rounded-full bg-gray-300" />

              <div className="text-[11px] font-semibold text-gray-700">
                Fixture Tools
              </div>

              <button
                type="button"
                aria-label="Close"
                onClick={() => void closeMobileFixtureTools()}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-lg leading-none text-gray-700"
              >
                ×
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+16px)]">
              {editFixturePanel}

              {searchPanelOpen &&
              editingPhotoItemId === selectedFixture.id ? (
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
                        setEditingPhotoItemId(null);
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

                  {searchingImages ? (
                    <div className="mt-3 text-[11px] text-gray-500">
                      Searching images...
                    </div>
                  ) : null}

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

      <div className="hidden sm:block xl:hidden">
        {editFixturePanel}
        {selectedPhotoSearchPanel}
        {!selectedFixtureId ? addFixturePanel : null}
      </div>

      {editable && !selectedFixtureId ? (
        <>
          <button
            type="button"
            aria-label="Add fixture"
            aria-expanded={mobileAddFixtureOpen}
            onClick={() => setMobileAddFixtureOpen(true)}
            className="fixed bottom-5 right-4 z-[90] flex h-14 w-14 items-center justify-center rounded-full bg-black text-[30px] font-light leading-none text-white shadow-xl transition active:scale-95 sm:hidden"
          >
            +
          </button>

          {mobileAddFixtureOpen ? (
            <div className="fixed inset-0 z-[9998] sm:hidden">
              <button
                type="button"
                aria-label="Close add fixture form"
                onClick={() => {
                  setMobileAddFixtureOpen(false);
                  setPhotoMenuOpen(false);
                }}
                className="absolute inset-0 bg-black/45"
              />

              <div className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-3xl bg-gray-50 p-3 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-2xl">
                <div className="mb-2 flex items-center justify-between px-1">
                  <div className="h-1 w-10 rounded-full bg-gray-300" />

                  <button
                    type="button"
                    onClick={() => {
                      setMobileAddFixtureOpen(false);
                      setPhotoMenuOpen(false);
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-lg leading-none text-gray-700"
                    aria-label="Close"
                  >
                    ×
                  </button>
                </div>

                {addFixturePanel}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {sidebarTarget
        ? createPortal(
            <div className="[&_.add-fixture-grid]:!grid-cols-1 [&_.fixture-image-grid]:!grid-cols-2 [&>div]:rounded-xl [&>div]:p-3">
              {editFixturePanel}
              {selectedPhotoSearchPanel}
              {!selectedFixtureId ? addFixturePanel : null}
            </div>,
            sidebarTarget,
          )
        : null}

      {groupedItems.map((group) => (
        <div
          key={group.type}
          className="bg-white border border-gray-200 rounded-2xl p-6"
        >
          <div className="mb-3 flex items-center gap-2 border-b border-gray-100 pb-2">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
            <h2 className="text-[8px] font-semibold uppercase tracking-wide text-gray-500">
              {group.type}
            </h2>
          </div>

          {group.items.map((it, index) =>
            renderFixtureRow(it, index === group.items.length - 1),
          )}
        </div>
      ))}

      {uncategorizedItems.length > 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          <div className="mb-5">
            <h2 className="text-[13px] font-semibold text-gray-900">
              Other Fixtures
            </h2>
          </div>

          {uncategorizedItems.map((it, index) =>
            renderFixtureRow(it, index === uncategorizedItems.length - 1),
          )}
        </div>
      ) : null}
    </div>
  );
}

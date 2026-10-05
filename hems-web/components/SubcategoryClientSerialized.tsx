"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { Trash2 } from "lucide-react";
import EquipmentListAddUnitsAction from "@/components/EquipmentListAddUnitsAction";
import OnlineImageSearchPanel from "@/components/OnlineImageSearchPanel";

type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

type ItemRow = {
  id: string;
  name: string;
  fixture_type?: string | null;
  photo_url: string | null;
  subcategory_id: string;
};

type ItemStats = {
  total: number;
  available: number;
  inUse: number;
  maintenance: number;
  inKsa: number;
};

type OnlineImage = {
  title?: string;
  image?: string;
  original?: string;
  thumbnail?: string;
};

type ItemsCache = {
  subId: string | null;
  items: ItemRow[];
  statsByItem: Record<string, ItemStats>;
};

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
  const clean = name.trim();

  if (clean.includes(" - ")) {
    const parts = clean.split(" - ");
    return {
      brand: (parts[0] || "").trim(),
      model: parts.slice(1).join(" - ").trim(),
    };
  }

  const parts = clean.split(/\s+/);
  return {
    brand: parts[0] || "",
    model: parts.slice(1).join(" "),
  };
}

function renderItemName(name: string) {
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

function groupItemsByBlock(items: ItemRow[]) {
  const groups = new Map<string, ItemRow[]>();

  for (const item of items) {
    const block = item.fixture_type?.trim() || "Unassigned";
    const current = groups.get(block);

    if (current) current.push(item);
    else groups.set(block, [item]);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) =>
      a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
    )
    .map(([block, groupItems]) => ({
      block,
      items: sortItemsByBrand(groupItems),
    }));
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
  return `hems:${category}:${subcategory}:serialized-items-v4`;
}

function readItemsCache(
  category: string,
  subcategory: string,
): ItemsCache | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = sessionStorage.getItem(cacheKeyFor(category, subcategory));
    return raw ? (JSON.parse(raw) as ItemsCache) : null;
  } catch {
    return null;
  }
}

function writeItemsCache(
  category: string,
  subcategory: string,
  data: ItemsCache,
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
}: {
  photo?: string | null;
  name: string;
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

    </div>
  );
}

export default function SubcategoryClientSerialized({
  category,
  subcategory,
}: {
  category: string;
  subcategory: string;
}) {
  const supabase = createClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listPhotoFileRef = useRef<HTMLInputElement | null>(null);
  const editable = canEditInventory();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [subId, setSubId] = useState<string | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [statsByItem, setStatsByItem] = useState<Record<string, ItemStats>>({});

  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [blockName, setBlockName] = useState("");
  const [qty, setQty] = useState<number>(1);
  const [photo, setPhoto] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState("");

  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [imageSearch, setImageSearch] = useState("");
  const [imageResults, setImageResults] = useState<OnlineImage[]>([]);
  const [searchingImages, setSearchingImages] = useState(false);

  const [editingPhotoItemId, setEditingPhotoItemId] = useState<string | null>(
    null,
  );
  const [sidebarTarget, setSidebarTarget] = useState<HTMLElement | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedBrandDraft, setSelectedBrandDraft] = useState("");
  const [selectedModelDraft, setSelectedModelDraft] = useState("");
  const [selectedBlockDraft, setSelectedBlockDraft] = useState("");
  const [blockSuggestionsOpen, setBlockSuggestionsOpen] = useState(false);
  const [mobileMenuItemId, setMobileMenuItemId] = useState<string | null>(null);
  const [mobileAddOpen, setMobileAddOpen] = useState(false);

  const itemName = useMemo(() => {
    const b = brand.trim();
    const m = model.trim();

    if (b && m) return `${b} - ${m}`;
    if (b) return b;
    return m;
  }, [brand, model]);

  const itemSearchName = useMemo(() => {
    const b = brand.trim();
    const m = model.trim();

    if (b && m) return `${b} ${m}`;
    if (b) return b;
    return m;
  }, [brand, model]);

  const canAdd = useMemo(
    () => editable && itemName.trim().length > 0 && qty >= 1,
    [editable, itemName, qty],
  );

  const blockGroups = useMemo(() => groupItemsByBlock(items), [items]);
  const navigableItems = useMemo(
    () => blockGroups.flatMap((group) => group.items),
    [blockGroups],
  );
  const selectedItem =
    items.find((item) => item.id === selectedItemId) ?? null;

  const blockOptions = useMemo(
    () =>
      Array.from(
        new Set(
          items
            .map((item) => item.fixture_type?.trim())
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
      ),
    [items],
  );

  const filteredBlockOptions = useMemo(() => {
    const query = selectedBlockDraft.trim().toLowerCase();
    const currentBlock =
      selectedItem?.fixture_type?.trim().toLowerCase() || "";

    if (!query || query === currentBlock) return blockOptions;

    return blockOptions.filter((option) =>
      option.toLowerCase().startsWith(query),
    );
  }, [blockOptions, selectedBlockDraft, selectedItem?.fixture_type]);

  useEffect(() => {
    const parsed = splitBrandModel(selectedItem?.name ?? "");
    setSelectedBrandDraft(parsed.brand);
    setSelectedModelDraft(parsed.model);
    setSelectedBlockDraft(selectedItem?.fixture_type?.trim() || "");
    setBlockSuggestionsOpen(false);
  }, [selectedItemId, selectedItem?.name, selectedItem?.fixture_type]);

  useEffect(() => {
    if (selectedItemId !== null) return;

    setSearchPanelOpen(false);
    setImageResults([]);
    setImageSearch("");
    setSearchingImages(false);
    setEditingPhotoItemId(null);
  }, [selectedItemId]);

  useEffect(() => {
    async function handleArrowNavigation(event: KeyboardEvent) {
      if (
        !selectedItemId ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
      ) {
        return;
      }

      const target = event.target as HTMLElement;
      const isFormField = target.matches("input, textarea, select");
      const isSelectedNameField = Boolean(
        target.closest("[data-selected-serialized-name='true']"),
      );
      if (isFormField && !isSelectedNameField) return;

      event.preventDefault();

      const currentIndex = navigableItems.findIndex(
        (item) => item.id === selectedItemId,
      );
      if (currentIndex < 0) return;

      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = Math.min(
        navigableItems.length - 1,
        Math.max(0, currentIndex + direction),
      );

      if (nextIndex === currentIndex) return;

      await saveSelectedItemName();
      await saveSelectedBlockName();

      const nextItemId = navigableItems[nextIndex].id;
      setSelectedItemId(nextItemId);

      requestAnimationFrame(() => {
        document
          .querySelector(`[data-serialized-item-id="${nextItemId}"]`)
          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }

    document.addEventListener("keydown", handleArrowNavigation, true);
    return () =>
      document.removeEventListener("keydown", handleArrowNavigation, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedItemId,
    selectedBrandDraft,
    selectedModelDraft,
    selectedBlockDraft,
    selectedItem?.name,
    selectedItem?.fixture_type,
    navigableItems,
  ]);

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
      const cached = readItemsCache(category, subcategory);

      if (cached) {
        setSubId(cached.subId);
        setItems(cached.items || []);
        setStatsByItem(cached.statsByItem || {});
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
        .select("id,name,fixture_type,photo_url,subcategory_id")
        .eq("subcategory_id", sid);

      if (itemsRes.error) throw itemsRes.error;

      const list = sortItemsByBrand((itemsRes.data || []) as ItemRow[]);
      const ids = list.map((x) => x.id);

      let stats: Record<string, ItemStats> = {};

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
      }

      setItems(list);
      setStatsByItem(stats);

      sessionStorage.setItem(
        cacheKey,
        JSON.stringify({ subId: sid, items: list, statsByItem: stats }),
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
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const insideMenu = target.closest(
        "[data-mobile-serialized-menu='true']",
      );
      const insideMobileTools = target.closest(
        "[data-mobile-serialized-tools='true']",
      );

      if (!insideMenu && !insideMobileTools) {
        setMobileMenuItemId(null);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    async function handleSelectionClickOutside(e: MouseEvent) {
      if (!selectedItemId) return;

      const target = e.target as HTMLElement;
      const insideItem = target.closest("[data-serialized-item-row='true']");
      const insideSidebar = target.closest("#right-sidebar-actions");
      const insideTools = target.closest("[data-serialized-tools='true']");
      const insideSearch = target.closest("[data-serialized-search='true']");
      const insideMobileTools = target.closest(
        "[data-mobile-serialized-tools='true']",
      );

      if (
        insideItem ||
        insideSidebar ||
        insideTools ||
        insideSearch ||
        insideMobileTools
      )
        return;

      await saveSelectedItemName();
      await saveSelectedBlockName();
      setSelectedItemId(null);
    }

    document.addEventListener("mousedown", handleSelectionClickOutside);
    return () =>
      document.removeEventListener("mousedown", handleSelectionClickOutside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedItemId,
    selectedBrandDraft,
    selectedModelDraft,
    selectedBlockDraft,
    selectedItem?.name,
    selectedItem?.fixture_type,
  ]);

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
      setSaveMsg("");
    } finally {
      e.target.value = "";
    }
  }

  async function searchOnlineImages(customQuery?: string) {
    const q = (customQuery || imageSearch || itemSearchName).trim();

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
        setSaveMsg("No images found. Try simpler keywords.");
        setTimeout(() => setSaveMsg(""), 2500);
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

    writeItemsCache(category, subcategory, {
      subId,
      items: nextItems,
      statsByItem,
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

    const nm = itemName.trim();
    if (!nm) return;

    const q = Math.max(1, Number(qty) || 1);
    setErr(null);

    try {
      const insItem = await supabase
        .from("items")
        .insert({
          subcategory_id: subId,
          name: nm,
          fixture_type: blockName.trim() || null,
          photo_url: photo || null,
        })
        .select("id,name,fixture_type,photo_url,subcategory_id")
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

      writeItemsCache(category, subcategory, {
        subId,
        items: nextItems,
        statsByItem: nextStats,
      });

      setBrand("");
      setModel("");
      setBlockName("");
      setQty(1);
      setPhoto(null);
      setImageSearch("");
      setImageResults([]);
      setSearchPanelOpen(false);
      setSaveMsg("Item added");
      setMobileAddOpen(false);

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item added" ? "" : prev));
      }, 1500);
    } catch (e: any) {
      setErr(e?.message || "Add failed");
    }
  }

  async function renameItem(itemId: string, nextName: string) {
    if (!editable) return;

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

      writeItemsCache(category, subcategory, {
        subId,
        items: nextItems,
        statsByItem,
      });

      setSaveMsg("Item renamed");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item renamed" ? "" : prev));
      }, 1500);
    } catch (e: any) {
      alert(e?.message || "Rename failed");
    }
  }

  async function saveSelectedItemName() {
    if (!selectedItem) return;

    const cleanBrand = selectedBrandDraft.trim();
    const cleanModel = selectedModelDraft.trim();
    const nextName =
      cleanBrand && cleanModel
        ? `${cleanBrand} - ${cleanModel}`
        : cleanBrand || cleanModel;

    if (!nextName || nextName === selectedItem.name) return;
    await renameItem(selectedItem.id, nextName);
  }

  async function saveSelectedBlockName(nextValue = selectedBlockDraft) {
    if (!editable || !selectedItem) return;

    const clean = nextValue.trim();
    const current = selectedItem.fixture_type?.trim() || "";

    if (!clean) {
      setSelectedBlockDraft(current);
      return;
    }

    if (clean.toLowerCase() === current.toLowerCase()) return;

    const { data, error } = await supabase
      .from("items")
      .update({ fixture_type: clean })
      .eq("id", selectedItem.id)
      .select("fixture_type")
      .single();

    if (error) {
      console.error("update serialized block error", error);
      alert("Block name update failed");
      setSelectedBlockDraft(current);
      return;
    }

    const savedBlockName = data?.fixture_type?.trim() || clean;

    setItems((previous) => {
      const nextItems = previous.map((item) =>
        item.id === selectedItem.id
          ? { ...item, fixture_type: savedBlockName }
          : item,
      );

      writeItemsCache(category, subcategory, {
        subId,
        items: nextItems,
        statsByItem,
      });

      return nextItems;
    });
    setSelectedBlockDraft(savedBlockName);

    setSaveMsg("Block name updated");
    setTimeout(() => {
      setSaveMsg((previous) =>
        previous === "Block name updated" ? "" : previous,
      );
    }, 1500);
  }

  async function onDelete(itemId: string) {
    if (!editable) return;
    if (!confirm("Delete this item?")) return;

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
      setSelectedItemId((current) => (current === itemId ? null : current));

      writeItemsCache(category, subcategory, {
        subId,
        items: nextItems,
        statsByItem: nextStats,
      });

      setSaveMsg("Item deleted");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item deleted" ? "" : prev));
      }, 1500);
    } catch (e: any) {
      alert(e?.message || "Delete failed");
    }
  }

  function renderItemRow(it: ItemRow, isLast: boolean) {
    const stats = statsByItem[it.id] || {
      total: 0,
      available: 0,
      inUse: 0,
      maintenance: 0,
      inKsa: 0,
    };

    const detailsHref = `/inventory/${category}/${subcategory}/${it.id}`;

    return (
      <div
        key={it.id}
        className={!isLast ? "border-b border-gray-100 pb-4 mb-4" : ""}
      >
        <div
          data-serialized-item-row="true"
          data-serialized-item-id={it.id}
          className={`relative flex flex-col gap-3 rounded-xl transition sm:flex-row sm:items-start sm:justify-between ${
            selectedItemId === it.id
              ? "bg-gray-50 ring-2 ring-black"
              : "hover:bg-gray-50"
          }`}
        >
          <div className="flex items-start gap-3 min-w-0 flex-[1.45]">
            <Link
              href={detailsHref}
              onClick={async (event) => {
                if (window.matchMedia("(min-width: 640px)").matches) {
                  event.preventDefault();
                  if (selectedItemId === it.id) {
                    await saveSelectedItemName();
                    await saveSelectedBlockName();
                    setSelectedItemId(null);
                  } else {
                    await saveSelectedItemName();
                    await saveSelectedBlockName();
                    setSelectedItemId(it.id);
                  }
                }
              }}
              className="flex items-start gap-3 min-w-0 flex-1 group"
            >
              <ItemPhoto photo={it.photo_url} name={it.name} />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <h2
                    className="truncate text-[10px] sm:text-[11px] text-gray-900"
                    style={{ lineHeight: 1.1 }}
                  >
                    {renderItemName(it.name)}
                  </h2>

                </div>

                <div className="mt-2 sm:hidden">
                  <div className={`grid gap-x-2 gap-y-1 text-center ${
                    stats.maintenance > 0 ? "grid-cols-3" : "grid-cols-2"
                  }`}>
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
            </Link>
          </div>

          <div className="absolute right-2 top-2 hidden items-center gap-1.5 sm:flex">
            <EquipmentListAddUnitsAction
              item={it}
              category={category}
              subcategory={subcategory}
              compact
            />
            <Link
              href={detailsHref}
              onClick={(event) => event.stopPropagation()}
              className="rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[9px] font-medium text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
            >
              Report
            </Link>
          </div>

          {editable ? (
            <div
              data-mobile-serialized-menu="true"
              className="absolute right-2 top-2 z-30 sm:hidden"
            >
              <button
                type="button"
                aria-label={`Edit ${it.name}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();

                  if (mobileMenuItemId === it.id) {
                    void closeMobileSerializedTools();
                    return;
                  }

                  void saveSelectedItemName();
                  void saveSelectedBlockName();
                  setSearchPanelOpen(false);
                  setEditingPhotoItemId(null);
                  setImageResults([]);
                  setSelectedItemId(it.id);
                  setMobileMenuItemId(it.id);
                }}
                className="flex h-[26px] w-[26px] items-center justify-center rounded-full border border-gray-300 bg-white text-base font-bold text-gray-700 shadow-sm"
              >
                ⋮
              </button>

            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const searchPhotoPanel = searchPanelOpen ? (
    <div
      data-serialized-search="true"
      className="mt-4 rounded-2xl border border-gray-200 bg-white p-3"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold text-gray-900">
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
          className="h-9 min-w-0 flex-1 rounded-xl border border-gray-300 px-3 text-[11px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
        />
        <button
          type="button"
          onClick={() => void searchOnlineImages()}
          disabled={searchingImages}
          className="h-9 rounded-xl bg-black px-3 text-[10px] font-medium text-white disabled:opacity-40"
        >
          {searchingImages ? "..." : "Search"}
        </button>
      </div>

      {imageResults.length > 0 ? (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {imageResults.map((img, index) => {
            const imageUrl = img.original || img.image || img.thumbnail;
            const thumb = img.thumbnail || imageUrl;
            if (!imageUrl || !thumb) return null;

            return (
              <button
                key={`${imageUrl}-${index}`}
                type="button"
                onClick={() => void selectOnlinePhoto(img)}
                className="overflow-hidden rounded-lg border border-gray-200 hover:border-black"
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
      ) : searchingImages ? (
        <div className="mt-3 text-[10px] text-gray-500">
          Searching images...
        </div>
      ) : null}
    </div>
  ) : null;

  const editItemPanel = selectedItem ? (
    <div
      data-serialized-tools="true"
      className="mb-4 rounded-2xl border-2 border-black bg-white p-3 shadow-sm"
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
        Selected Item
      </div>
      <div
        data-selected-serialized-name="true"
        className="mt-2 grid grid-cols-1 gap-1.5"
      >
        <input
          value={selectedBrandDraft}
          onChange={(event) => setSelectedBrandDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveSelectedItemName();
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
              void saveSelectedItemName();
            }
          }}
          placeholder="Model"
          disabled={!editable}
          className="h-8 w-full rounded-lg border border-gray-300 bg-white px-2.5 text-[9px] text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
        />
      </div>

      <div className="relative mt-1.5">
        <input
          value={selectedBlockDraft}
          onFocus={() => setBlockSuggestionsOpen(true)}
          onChange={(event) => {
            setSelectedBlockDraft(event.target.value);
            setBlockSuggestionsOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setBlockSuggestionsOpen(false);
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setBlockSuggestionsOpen(false);
            }
          }}
          onBlur={(event) => {
            setBlockSuggestionsOpen(false);
            void saveSelectedBlockName(event.currentTarget.value);
          }}
          placeholder="Block Name"
          disabled={!editable}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={blockSuggestionsOpen}
          aria-controls="serialized-block-suggestions"
          className="h-8 w-full rounded-lg border border-gray-300 bg-white px-2.5 pr-7 text-[9px] font-medium text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
        />

        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[8px] text-gray-400">
          ▼
        </span>

        {blockSuggestionsOpen && filteredBlockOptions.length > 0 ? (
          <div
            id="serialized-block-suggestions"
            role="listbox"
            className="absolute left-0 right-0 top-[calc(100%+4px)] z-[100] max-h-40 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-lg"
          >
            {filteredBlockOptions.map((option) => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={
                  option.toLowerCase() === selectedBlockDraft.toLowerCase()
                }
                onMouseDown={(event) => {
                  event.preventDefault();
                  setSelectedBlockDraft(option);
                  setBlockSuggestionsOpen(false);
                  void saveSelectedBlockName(option);
                }}
                className="block w-full rounded-md px-2.5 py-2 text-left text-[9px] font-medium text-gray-700 hover:bg-gray-100"
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="my-3 flex items-center gap-3 rounded-xl bg-gray-50 p-2">
        <ItemPhoto photo={selectedItem.photo_url} name={selectedItem.name} />
        <div className="min-w-0 text-[10px] text-gray-500">
          Use the fields above to rename. Changes save automatically.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <Link
          href={`/inventory/${category}/${subcategory}/${selectedItem.id}`}
          className="rounded-xl bg-black px-3 py-2.5 text-center text-[11px] font-medium text-white hover:opacity-90"
        >
          Open Item / Report
        </Link>
        {editable ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditingPhotoItemId(selectedItem.id);
                  listPhotoFileRef.current?.click();
                }}
                className="rounded-xl border border-gray-300 bg-white px-2 py-2.5 text-[10px] font-medium text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
              >
                Upload Photo
              </button>
              <button
                type="button"
                onClick={() => void searchPhotoForItem(selectedItem)}
                className="rounded-xl border border-gray-300 bg-white px-2 py-2.5 text-[10px] font-medium text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
              >
                Search Photo
              </button>
            </div>
            <button
              type="button"
              onClick={() => void onDelete(selectedItem.id)}
              className="flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[11px] font-medium text-red-700 hover:bg-red-100"
            >
              <Trash2 size={14} />
              Delete Item
            </button>
          </>
        ) : null}
      </div>
    </div>
  ) : null;

  const selectedPhotoSearchPanel =
    selectedItem &&
    searchPanelOpen &&
    editingPhotoItemId === selectedItem.id ? (
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

  const sidebarAddPanel = editable && !selectedItem ? (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-4">
        <h2 className="text-[13px] font-semibold text-gray-900">Add Item</h2>
        <p className="mt-1 text-[10px] text-gray-500">
          Enter brand, model, block name, quantity and optional photo.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <input
          value={brand}
          onChange={(e) => {
            setBrand(e.target.value);
            if (!imageSearch) {
              setImageSearch(`${e.target.value} ${model}`.trim());
            }
          }}
          placeholder="Brand"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none focus:border-black"
        />
        <input
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            if (!imageSearch) {
              setImageSearch(`${brand} ${e.target.value}`.trim());
            }
          }}
          placeholder="Model"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none focus:border-black"
        />
        <input
          value={blockName}
          onChange={(event) => setBlockName(event.target.value)}
          list="serialized-add-block-options"
          placeholder="Block Name"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none focus:border-black"
        />
        <input
          value={qty}
          onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          type="number"
          min={1}
          placeholder="Qty"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none focus:border-black"
        />
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="h-11 rounded-2xl border border-gray-300 bg-white px-2 text-[11px] font-medium text-gray-700 hover:bg-red-50"
          >
            {photo ? "Photo ✔" : "Upload Photo"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditingPhotoItemId(null);
              setImageSearch(itemSearchName);
              void searchOnlineImages(itemSearchName);
            }}
            className="h-11 rounded-2xl border border-gray-300 bg-white px-2 text-[11px] font-medium text-gray-700 hover:bg-red-50"
          >
            Search Photo
          </button>
        </div>
        <button
          type="button"
          onClick={onAdd}
          disabled={!canAdd}
          className="h-11 w-full rounded-2xl bg-black px-4 text-[12px] font-medium text-white disabled:opacity-40"
        >
          + Add
        </button>
      </div>

      {photo ? (
        <div className="mt-3 flex items-center gap-3 rounded-xl bg-gray-50 p-2">
          <img
            src={photo}
            alt="Selected"
            className="h-12 w-12 rounded-lg object-cover"
          />
          <button
            type="button"
            onClick={() => setPhoto(null)}
            className="text-[10px] font-medium text-red-500"
          >
            Remove photo
          </button>
        </div>
      ) : null}
      {searchPhotoPanel}
      {saveMsg ? (
        <div className="mt-3 text-[10px] text-gray-500">{saveMsg}</div>
      ) : null}
    </div>
  ) : null;

  async function closeMobileSerializedTools() {
    await saveSelectedItemName();
    await saveSelectedBlockName();
    setMobileMenuItemId(null);
    setSelectedItemId(null);
    setSearchPanelOpen(false);
    setEditingPhotoItemId(null);
    setImageResults([]);
  }

  if (loading) {
    return (
      <div className="w-full">
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-gray-900">
          Loading items...
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

  return (
    <div className="w-full space-y-3">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPickPhoto}
      />
      <input
        ref={listPhotoFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPickListItemPhoto}
      />

      <datalist id="serialized-add-block-options">
        {blockOptions.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>

      {editable && mobileMenuItemId && selectedItem ? (
        <div
          data-mobile-serialized-tools="true"
          className="fixed inset-0 z-[9998] sm:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={`${selectedItem.name} tools`}
        >
          <button
            type="button"
            aria-label="Close item tools"
            onClick={() => void closeMobileSerializedTools()}
            className="absolute inset-0 bg-black/45"
          />

          <div className="absolute inset-x-0 bottom-0 flex h-[75dvh] flex-col rounded-t-3xl bg-gray-50 shadow-2xl">
            <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
              <div className="h-1 w-10 rounded-full bg-gray-300" />
              <div className="text-[11px] font-semibold text-gray-700">
                Item Tools
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => void closeMobileSerializedTools()}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-lg leading-none text-gray-700"
              >
                ×
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+16px)]">
              {editItemPanel}
              {searchPhotoPanel}
            </div>
          </div>
        </div>
      ) : null}

      {editable && !selectedItem ? (
        <>
          <button
            type="button"
            aria-label="Add item"
            onClick={() => setMobileAddOpen(true)}
            className="fixed bottom-5 right-4 z-[90] flex h-14 w-14 items-center justify-center rounded-full bg-black text-[30px] font-light leading-none text-white shadow-xl active:scale-95 sm:hidden"
          >
            +
          </button>

          {mobileAddOpen ? (
            <div className="fixed inset-0 z-[9998] sm:hidden">
              <button
                type="button"
                aria-label="Close add item form"
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
                {sidebarAddPanel}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {sidebarTarget
        ? createPortal(
            <div>
              {editItemPanel}
              {selectedPhotoSearchPanel}
              {sidebarAddPanel}
            </div>,
            sidebarTarget,
          )
        : null}

      <div className="hidden sm:block xl:hidden">
        {editItemPanel}
        {selectedPhotoSearchPanel}
      </div>
      <div className="hidden sm:block xl:hidden">{sidebarAddPanel}</div>

      {items.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-gray-900">
          No items yet.
        </div>
      ) : (
        blockGroups.map((group) => (
          <div
            key={group.block}
            className="bg-white border border-gray-200 rounded-2xl p-6"
          >
            <div className="mb-3 flex items-center gap-2 border-b border-gray-100 pb-2">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
              <h2 className="text-[8px] font-semibold uppercase tracking-wide text-gray-500">
                {group.block}
              </h2>
            </div>

            {group.items.map((it, index) =>
              renderItemRow(it, index === group.items.length - 1),
            )}
          </div>
        ))
      )}
    </div>
  );
}

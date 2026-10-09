// components/SubcategoryClientChainHoist.tsx
"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { readCatalog } from "@/lib/catalogStore";
import { Trash2 } from "lucide-react";
import EquipmentListAddUnitsAction from "@/components/EquipmentListAddUnitsAction";
import OnlineImageSearchPanel from "@/components/OnlineImageSearchPanel";

type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

type DbItem = {
  id: string;
  subcategory_id: string;
  name: string;
  fixture_type?: string | null;
  photo_url: string | null;
  created_at?: string;
};

function getHoistBlockName(item: DbItem): string | null {
  const storedBlock = item.fixture_type?.trim();
  if (storedBlock) return storedBlock;

  const legacyParts = item.name.split(" - ").map((part) => part.trim());
  return legacyParts.length >= 4 ? legacyParts.at(-1) || null : null;
}

function getHoistDisplayName(item: DbItem): string {
  if (item.fixture_type?.trim()) return item.name;

  const legacyParts = item.name.split(" - ").map((part) => part.trim());
  return legacyParts.length >= 4
    ? legacyParts.slice(0, -1).join(" - ")
    : item.name;
}

function getHoistListDetails(item: DbItem) {
  const parts = getHoistDisplayName(item)
    .split(" - ")
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    brand: parts[0] || "",
    model: parts[1] || "",
    mainName: parts.slice(0, 2).join(" - ") || item.name,
    capacity: parts[2] || "",
    chainLength: parts.slice(3).join(" - "),
  };
}

type ItemStats = {
  total: number;
  available: number;
  inUse: number;
  maintenance: number;
  inKsa: number;
  expired: number;
};

type OnlineImage = {
  title?: string;
  image?: string;
  original?: string;
  thumbnail?: string;
};

function toStatus(v: any): UnitStatus {
  if (
    v === "available" ||
    v === "in_use" ||
    v === "maintenance" ||
    v === "in_ksa"
  ) {
    return v;
  }
  return "available";
}

function isExpired(expiry?: string | null) {
  const s = (expiry ?? "").trim();
  if (!s) return false;

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const ed = new Date(d);
  ed.setHours(0, 0, 0, 0);

  return ed.getTime() < today.getTime();
}

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

async function uploadPhoto(file: File): Promise<string> {
  const supabase = createClient();
  const compressed = await compressImageFile(file);

  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;

  const filePath = `chain-hoist/thumbs/${fileName}`;

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

function StatPill({
  label,
  value,
  tone = "gray",
}: {
  label: string;
  value: string | number;
  tone?: "gray" | "green" | "blue" | "yellow" | "purple" | "red";
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
            : tone === "red"
              ? "bg-red-100 text-black"
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
  onEditPhoto,
}: {
  photo?: string | null;
  name: string;
  editable?: boolean;
  onEditPhoto?: () => void;
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
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onEditPhoto?.();
          }}
          className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-full bg-white/90 text-[10px] text-red-500 shadow hover:text-black"
          title="Change photo"
        >
          ✎
        </button>
      ) : null}
    </div>
  );
}

export default function SubcategoryClientChainHoist({
  category,
  subcategory,
}: {
  category: string;
  subcategory: string;
}) {
  const supabase = createClient();
  const editable = canEditInventory();

  const [subcategoryId, setSubcategoryId] = useState<string | null>(null);
  const [items, setItems] = useState<DbItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [capacity, setCapacity] = useState("");
  const [chainLength, setChainLength] = useState("");
  const [blockName, setBlockName] = useState("");
  const [qty, setQty] = useState<number>(1);
  const [photo, setPhoto] = useState<string | null>(null);
  const addPhotoRef = useRef<HTMLInputElement | null>(null);
  const listPhotoRef = useRef<HTMLInputElement | null>(null);
  const [editingPhotoItemId, setEditingPhotoItemId] = useState<string | null>(
    null,
  );

  const [stats, setStats] = useState<Record<string, ItemStats>>({});
  const [saveMsg, setSaveMsg] = useState("");
  const [sidebarTarget, setSidebarTarget] = useState<HTMLElement | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedBrandDraft, setSelectedBrandDraft] = useState("");
  const [selectedModelDraft, setSelectedModelDraft] = useState("");
  const [selectedCapacityDraft, setSelectedCapacityDraft] = useState("");
  const [selectedChainLengthDraft, setSelectedChainLengthDraft] = useState("");
  const [selectedBlockDraft, setSelectedBlockDraft] = useState("");
  const [blockSuggestionsOpen, setBlockSuggestionsOpen] = useState(false);
  const [mobileMenuItemId, setMobileMenuItemId] = useState<string | null>(null);
  const [mobileAddOpen, setMobileAddOpen] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [photoSearchItemId, setPhotoSearchItemId] = useState<string | null>(
    null,
  );
  const [imageSearch, setImageSearch] = useState("");
  const [imageResults, setImageResults] = useState<OnlineImage[]>([]);
  const [searchingImages, setSearchingImages] = useState(false);

  const displayItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const aBlock = getHoistBlockName(a) || "Unassigned";
      const bBlock = getHoistBlockName(b) || "Unassigned";
      const blockCompare = aBlock.localeCompare(bBlock, undefined, {
        sensitivity: "base",
        numeric: true,
      });

      if (blockCompare !== 0) return blockCompare;

      return getHoistDisplayName(a).localeCompare(
        getHoistDisplayName(b),
        undefined,
        {
          sensitivity: "base",
          numeric: true,
        },
      );
    });
  }, [items]);

  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;

  const blockOptions = useMemo(
    () =>
      Array.from(
        new Set(
          items
            .map((item) => getHoistBlockName(item)?.trim())
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
      ),
    [items],
  );

  const filteredBlockOptions = useMemo(() => {
    const query = selectedBlockDraft.trim().toLowerCase();
    const currentBlock = selectedItem
      ? (getHoistBlockName(selectedItem) || "").trim().toLowerCase()
      : "";

    if (!query || query === currentBlock) return blockOptions;

    return blockOptions.filter((option) =>
      option.toLowerCase().startsWith(query),
    );
  }, [blockOptions, selectedBlockDraft, selectedItem]);

  useEffect(() => {
    const details = selectedItem
      ? getHoistListDetails(selectedItem)
      : { brand: "", model: "", capacity: "", chainLength: "" };

    setSelectedBrandDraft(details.brand);
    setSelectedModelDraft(details.model);
    setSelectedCapacityDraft(details.capacity);
    setSelectedChainLengthDraft(details.chainLength);
    setSelectedBlockDraft(
      selectedItem ? getHoistBlockName(selectedItem) || "" : "",
    );
    setBlockSuggestionsOpen(false);
  }, [selectedItemId, selectedItem?.name, selectedItem?.fixture_type]);

  useEffect(() => {
    if (selectedItemId !== null) return;

    setSearchPanelOpen(false);
    setImageResults([]);
    setImageSearch("");
    setSearchingImages(false);
    setEditingPhotoItemId(null);
    setPhotoSearchItemId(null);
  }, [selectedItemId]);

  useEffect(() => {
    function handleArrowNavigation(event: KeyboardEvent) {
      if (
        !selectedItemId ||
        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
      ) {
        return;
      }

      const target = event.target as HTMLElement;
      const isFormField = target.matches("input, textarea, select");
      const isSelectedNameField = Boolean(
        target.closest("[data-selected-hoist-name='true']"),
      );

      if (isFormField && !isSelectedNameField) return;

      event.preventDefault();

      const currentIndex = displayItems.findIndex(
        (item) => item.id === selectedItemId,
      );
      if (currentIndex < 0) return;

      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = Math.min(
        displayItems.length - 1,
        Math.max(0, currentIndex + direction),
      );

      if (nextIndex === currentIndex) return;

      void saveSelectedHoistName();
      void saveSelectedBlockName();

      const nextItemId = displayItems[nextIndex].id;
      setSelectedItemId(nextItemId);

      requestAnimationFrame(() => {
        document
          .querySelector(`[data-chain-hoist-item-id="${nextItemId}"]`)
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
    selectedCapacityDraft,
    selectedChainLengthDraft,
    selectedBlockDraft,
    selectedItem?.name,
    selectedItem?.fixture_type,
    displayItems,
  ]);
  const hoistName = [brand, model, capacity, chainLength]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" - ");
  const hoistSearchName = [brand, model, capacity, chainLength]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" ");

  async function resolveSubcategoryId() {
    const catalog = await readCatalog();
    const cat = catalog.categories.find((c) => c.slug === category);
    const sub = cat?.subcategories?.find((s) => s.slug === subcategory);
    return sub?.id ?? null;
  }

  async function loadItems(subId: string, showLoading = true) {
    if (showLoading) setLoading(true);

    const { data, error } = await supabase
      .from("items")
      .select("id, subcategory_id, name, fixture_type, photo_url, created_at")
      .eq("subcategory_id", subId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("load chainhoist items error", error);
      setItems([]);
      setStats({});
      setLoading(false);
      return;
    }

    const rows = (data ?? []) as DbItem[];
    setItems(rows);

    if (rows.length === 0) {
      setStats({});
      setLoading(false);
      return;
    }

    const ids = rows.map((x) => x.id);

    let allUnits: any[] = [];
    let from = 0;
    const pageSize = 1000;

    while (true) {
      const { data: udata, error: uerr } = await supabase
        .from("units")
        .select("item_id, status, expiry_date")
        .in("item_id", ids)
        .range(from, from + pageSize - 1);

      if (uerr) {
        console.error("load chainhoist units stats error", uerr);
        setStats({});
        setLoading(false);
        return;
      }

      allUnits = [...allUnits, ...(udata ?? [])];

      if (!udata || udata.length < pageSize) break;

      from += pageSize;
    }

    const map: Record<string, ItemStats> = {};

    for (const itId of ids) {
      map[itId] = {
        total: 0,
        available: 0,
        inUse: 0,
        maintenance: 0,
        inKsa: 0,
        expired: 0,
      };
    }

    for (const u of allUnits) {
      const itemId = String((u as any).item_id || "");
      const st = toStatus((u as any).status);
      const expiryDate = (u as any).expiry_date || null;
      const expired = isExpired(expiryDate);

      if (!map[itemId]) {
        map[itemId] = {
          total: 0,
          available: 0,
          inUse: 0,
          maintenance: 0,
          inKsa: 0,
          expired: 0,
        };
      }

      map[itemId].total += 1;

      if (expired) {
        map[itemId].expired += 1;
      }

      if (st === "available" && !expired) {
        map[itemId].available += 1;
      } else if (st === "in_use") {
        map[itemId].inUse += 1;
      } else if (st === "maintenance") {
        map[itemId].maintenance += 1;
      } else if (st === "in_ksa") {
        map[itemId].inKsa += 1;
      }
    }

    setStats(map);
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const subId = await resolveSubcategoryId();
      if (cancelled) return;

      setSubcategoryId(subId);

      if (!subId) {
        setItems([]);
        setStats({});
        setLoading(false);
        return;
      }

      await loadItems(subId);
    })();

    return () => {
      cancelled = true;
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
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const mobileMenu = target.closest("[data-mobile-hoist-menu='true']");
      const mobileTools = target.closest(
        "[data-mobile-chain-hoist-tools='true']",
      );

      if (!mobileMenu && !mobileTools) setMobileMenuItemId(null);
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function onPickAddPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editable) return;

    const f = e.target.files?.[0];
    if (!f) return;

    try {
      setSaveMsg("Uploading photo...");
      const imageUrl = await uploadPhoto(f);
      setPhoto(imageUrl);
      setSaveMsg("Photo selected");
      setTimeout(() => setSaveMsg(""), 1500);
    } catch (error: any) {
      console.error("chainhoist photo upload error", error);
      alert(error?.message || "Photo upload failed");
      setSaveMsg("");
    } finally {
      e.target.value = "";
    }
  }

  async function searchOnlineImages(
    customQuery?: string,
    targetItemId?: string | null,
  ) {
    const query = (customQuery || imageSearch || hoistSearchName).trim();

    if (!query) {
      alert("Write brand or model first");
      return;
    }

    if (targetItemId !== undefined) {
      setPhotoSearchItemId(targetItemId);
    }

    setImageSearch(query);
    setSearchPanelOpen(true);
    setSearchingImages(true);
    setImageResults([]);

    try {
      const response = await fetch(
        `/api/google-image?q=${encodeURIComponent(query)}`,
      );

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        alert(data?.error || "Image search failed. Please try again.");
        return;
      }

      const data = await response.json();
      const results: OnlineImage[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.images_results)
          ? data.images_results
          : Array.isArray(data?.items)
            ? data.items
            : Array.isArray(data?.results)
              ? data.results
              : Array.isArray(data?.images)
                ? data.images
                : [];

      setImageResults(results);

      if (results.length === 0) {
        alert("No images found. Try another search keyword.");
      }
    } catch (error) {
      console.error("Image search error:", error);
      alert("Failed to search images");
    } finally {
      setSearchingImages(false);
    }
  }

  async function selectOnlinePhoto(image: OnlineImage) {
    const fallbackUrl = image.thumbnail || image.image || image.original;
    const sourceUrl = image.image || image.original || image.thumbnail;

    if (!fallbackUrl || !sourceUrl) return;

    setSaveMsg("Preparing photo...");
    let finalImageUrl = fallbackUrl;

    try {
      const response = await fetch("/api/optimize-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: sourceUrl }),
      });

      if (!response.ok) throw new Error("Optimization failed");

      const data = await response.json();
      if (data?.url) finalImageUrl = data.url;
    } catch (error) {
      console.warn(
        "Could not optimize online image, using thumbnail URL:",
        error,
      );
    }

    if (photoSearchItemId) {
      await updateItemPhoto(photoSearchItemId, finalImageUrl);
    } else {
      setPhoto(finalImageUrl);
      setSaveMsg("Online photo selected");
      setTimeout(() => setSaveMsg(""), 1500);
    }

    setSearchPanelOpen(false);
    setPhotoSearchItemId(null);
    setImageResults([]);
  }

  async function updateItemPhoto(itemId: string, imageUrl: string) {
    if (!editable) return;

    const { error } = await supabase
      .from("items")
      .update({ photo_url: imageUrl })
      .eq("id", itemId);

    if (error) {
      console.error("update chainhoist photo error", error);
      alert("Failed to update photo");
      return;
    }

    setItems((prev) =>
      prev.map((it) =>
        it.id === itemId ? { ...it, photo_url: imageUrl } : it,
      ),
    );

    setSaveMsg("Photo updated");
    setTimeout(() => {
      setSaveMsg((prev) => (prev === "Photo updated" ? "" : prev));
    }, 1500);
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
      console.error("chainhoist list photo upload error", error);
      alert(error?.message || "Photo upload failed");
      setSaveMsg("");
    } finally {
      e.target.value = "";
      setEditingPhotoItemId(null);
    }
  }

  async function addItem() {
    if (!editable || !subcategoryId) return;

    const clean = hoistName.trim();
    if (!clean) return;

    const nQty = Number.isFinite(qty) ? Math.max(1, Math.floor(qty)) : 1;

    const { data: newItem, error } = await supabase
      .from("items")
      .insert({
        subcategory_id: subcategoryId,
        name: clean,
        fixture_type: blockName.trim() || "Unassigned",
        photo_url: photo || null,
      })
      .select("id, subcategory_id, name, fixture_type, photo_url, created_at")
      .single();

    if (error) {
      console.error("add chainhoist item error", error);
      alert("Failed to add item");
      return;
    }

    const unitsPayload = Array.from({ length: nQty }, (_, i) => ({
      item_id: newItem.id,
      unit_no: i + 1,
      serial: "",
      status: "available",
      cert_date: null,
      expiry_date: null,
      notes: "",
      damage_photos: [],
    }));

    const { error: uerr } = await supabase.from("units").insert(unitsPayload);

    if (uerr) {
      console.error("create chainhoist units error", uerr);
      alert("Item added, but failed to create units rows.");
    }

    setBrand("");
    setModel("");
    setCapacity("");
    setChainLength("");
    setBlockName("");
    setQty(1);
    setPhoto(null);
    setImageSearch("");
    setImageResults([]);
    setSearchPanelOpen(false);

    await loadItems(subcategoryId, false);
    setMobileAddOpen(false);
    setSaveMsg("Item added");

    setTimeout(() => {
      setSaveMsg((prev) => (prev === "Item added" ? "" : prev));
    }, 1500);
  }

  async function renameItem(
    itemId: string,
    current: string,
    nextNameOverride?: string,
  ) {
    if (!editable) return;

    const nextName = nextNameOverride ?? prompt("Item name:", current);
    if (!nextName) return;

    const clean = nextName.trim();
    if (!clean) return;

    const currentItem = items.find((item) => item.id === itemId);
    const legacyBlock = currentItem ? getHoistBlockName(currentItem) : null;
    const updatePatch: { name: string; fixture_type?: string } = {
      name: clean,
    };

    if (currentItem && !currentItem.fixture_type?.trim() && legacyBlock) {
      updatePatch.fixture_type = legacyBlock;
    }

    const { error } = await supabase
      .from("items")
      .update(updatePatch)
      .eq("id", itemId);

    if (error) {
      console.error("rename chainhoist item error", error);
      alert("Rename failed");
      return;
    }

    if (subcategoryId) {
      await loadItems(subcategoryId, false);
    }

    setSaveMsg("Item renamed");
    setTimeout(() => {
      setSaveMsg((prev) => (prev === "Item renamed" ? "" : prev));
    }, 1500);
  }

  async function saveSelectedHoistName() {
    if (!editable || !selectedItem) return;

    const cleanName = [
      selectedBrandDraft,
      selectedModelDraft,
      selectedCapacityDraft,
      selectedChainLengthDraft,
    ]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" - ");

    if (!cleanName) {
      const details = getHoistListDetails(selectedItem);
      setSelectedBrandDraft(details.brand);
      setSelectedModelDraft(details.model);
      setSelectedCapacityDraft(details.capacity);
      setSelectedChainLengthDraft(details.chainLength);
      return;
    }

    if (cleanName === getHoistDisplayName(selectedItem)) return;

    await renameItem(selectedItem.id, selectedItem.name, cleanName);
  }

  async function saveSelectedBlockName(nextValue = selectedBlockDraft) {
    if (!editable || !selectedItem) return;

    const clean = nextValue.trim();
    const current = getHoistBlockName(selectedItem) || "";

    if (!clean) {
      setSelectedBlockDraft(current);
      return;
    }

    if (clean.toLowerCase() === current.toLowerCase()) return;

    const { error } = await supabase
      .from("items")
      .update({ fixture_type: clean })
      .eq("id", selectedItem.id);

    if (error) {
      console.error("update chain hoist block error", error);
      alert("Block name update failed");
      setSelectedBlockDraft(current);
      return;
    }

    setItems((previous) =>
      previous.map((item) =>
        item.id === selectedItem.id
          ? { ...item, fixture_type: clean }
          : item,
      ),
    );
    setSelectedBlockDraft(clean);
    setSaveMsg("Block name updated");
    setTimeout(() => {
      setSaveMsg((previous) =>
        previous === "Block name updated" ? "" : previous,
      );
    }, 1500);
  }

  async function deleteItem(itemId: string) {
    if (!editable) return;
    if (!confirm("Delete this item?")) return;

    const { error: uerr } = await supabase
      .from("units")
      .delete()
      .eq("item_id", itemId);
    if (uerr) {
      console.warn("delete units warn", uerr);
    }

    const { error } = await supabase.from("items").delete().eq("id", itemId);
    if (error) {
      console.error("delete chainhoist item error", error);
      alert("Delete failed");
      return;
    }

    if (subcategoryId) {
      await loadItems(subcategoryId, false);
    }

    setSelectedItemId((current) => (current === itemId ? null : current));
    setMobileMenuItemId((current) => (current === itemId ? null : current));

    setSaveMsg("Item deleted");
    setTimeout(() => {
      setSaveMsg((prev) => (prev === "Item deleted" ? "" : prev));
    }, 1500);
  }

  useEffect(() => {
    function handleSelectionClickOutside(event: MouseEvent) {
      if (!selectedItemId) return;

      const target = event.target as HTMLElement;
      const insideHoist = target.closest("[data-chain-hoist-row='true']");
      const insideSidebar = target.closest("#right-sidebar-actions");
      const insideHoistTools = target.closest(
        "[data-chain-hoist-tools='true']",
      );
      const insideMobileTools = target.closest(
        "[data-mobile-chain-hoist-tools='true']",
      );

      if (
        insideHoist ||
        insideSidebar ||
        insideHoistTools ||
        insideMobileTools
      )
        return;

      void saveSelectedHoistName();
      void saveSelectedBlockName();
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
    selectedCapacityDraft,
    selectedChainLengthDraft,
    selectedBlockDraft,
    selectedItem?.name,
    selectedItem?.fixture_type,
  ]);

  if (loading) {
    return (
      <div className="w-full mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
          Loading chain hoist items...
        </div>
      </div>
    );
  }

  const addItemPanel = editable && !selectedItem ? (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4">
        <h1 className="text-[13px] font-semibold leading-tight text-gray-900">
          Add Chain Hoist
        </h1>
        <p className="mt-1 text-[10px] text-gray-500">
          Enter brand, model, capacity, chain length, block name, quantity and
          photo.
        </p>
      </div>

      <div className="add-hoist-grid grid grid-cols-1 gap-2">
        <input
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          placeholder="Brand (e.g. CM)"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />

        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Model (e.g. Lodestar)"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />

        <input
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          placeholder="Capacity (e.g. 1T)"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />

        <input
          value={chainLength}
          onChange={(e) => setChainLength(e.target.value)}
          placeholder="Chain Length (e.g. 20m)"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />

        <input
          value={blockName}
          onChange={(e) => setBlockName(e.target.value)}
          list="chain-hoist-block-options"
          placeholder="Block Name (e.g. Motor A)"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />

        <input
          value={String(qty)}
          onChange={(e) => setQty(Number(e.target.value))}
          type="number"
          min={1}
          inputMode="numeric"
          placeholder="Qty"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />

        {hoistName ? (
          <div className="flex min-h-11 items-center rounded-2xl bg-gray-50 px-4 text-[10px] text-gray-500">
            Saved as: {hoistName}
          </div>
        ) : null}

        <input
          ref={addPhotoRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickAddPhoto}
        />

        <button
          type="button"
          onClick={() => addPhotoRef.current?.click()}
          className="flex h-11 w-full items-center justify-center rounded-2xl border border-gray-300 bg-white px-4 text-[11px] font-medium text-gray-700 shadow-sm transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
        >
          {photo ? "Photo ✔" : "Upload Photo"}
        </button>

        <button
          type="button"
          onClick={() => void searchOnlineImages(hoistSearchName, null)}
          className="flex h-11 w-full items-center justify-center rounded-2xl border border-gray-300 bg-white px-4 text-[11px] font-medium text-gray-700 shadow-sm transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
        >
          Search Photo
        </button>

        <button
          type="button"
          onClick={() => void addItem()}
          disabled={!hoistName || qty < 1}
          className="h-11 w-full rounded-2xl border border-black bg-black px-4 text-[12px] font-medium text-white shadow-sm transition hover:opacity-90 disabled:opacity-40"
        >
          + Add
        </button>
      </div>

      {photo ? (
        <div className="mt-3 flex items-center gap-3 rounded-2xl border border-gray-100 bg-gray-50 p-2">
          <img
            src={photo}
            alt="Selected chain hoist"
            className="h-12 w-12 rounded-xl border border-gray-200 bg-white object-cover"
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
        <div className="relative z-50 mt-4 rounded-2xl border border-gray-200 bg-white p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-[12px] font-semibold text-gray-900">
              Search photo online
            </div>
            <button
              type="button"
              onClick={() => {
                setSearchPanelOpen(false);
                setPhotoSearchItemId(null);
                setImageResults([]);
              }}
              className="text-[10px] text-red-500 hover:text-black"
            >
              Close
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2">
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
              className="h-10 w-full rounded-xl border border-gray-300 px-3 text-[12px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
            />
            <button
              type="button"
              onClick={() => void searchOnlineImages()}
              disabled={searchingImages}
              className="h-10 w-full rounded-xl bg-black px-3 text-[11px] font-medium text-white disabled:opacity-40"
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
            <div className="mt-3 grid grid-cols-3 gap-2">
              {imageResults.map((image, index) => {
                const imageUrl =
                  image.original || image.image || image.thumbnail;
                const thumbnail = image.thumbnail || imageUrl;

                if (!imageUrl || !thumbnail) return null;

                return (
                  <button
                    key={`${imageUrl}-${index}`}
                    type="button"
                    onClick={() => void selectOnlinePhoto(image)}
                    className="overflow-hidden rounded-lg border border-gray-200 hover:border-blue-400"
                    title={image.title || "Select photo"}
                  >
                    <img
                      src={thumbnail}
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
      ) : null}

      {saveMsg ? (
        <div className="mt-3 text-xs text-gray-500">{saveMsg}</div>
      ) : null}
    </div>
  ) : null;

  const editItemPanel = selectedItem ? (
    <div
      data-chain-hoist-tools="true"
      className="mb-4 rounded-2xl border-2 border-black bg-white p-3 shadow-sm"
    >
      <div className="mb-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Selected Chain Hoist
          </div>
          <div
            data-selected-hoist-name="true"
            className="mt-1 grid grid-cols-1 gap-1.5"
          >
            <input
              value={selectedBrandDraft}
              onChange={(event) => setSelectedBrandDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveSelectedHoistName();
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
                  void saveSelectedHoistName();
                }
              }}
              placeholder="Model"
              disabled={!editable}
              className="h-8 w-full rounded-lg border border-gray-300 bg-white px-2.5 text-[9px] font-medium text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
            />
            <input
              value={selectedCapacityDraft}
              onChange={(event) => setSelectedCapacityDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveSelectedHoistName();
                }
              }}
              placeholder="Capacity"
              disabled={!editable}
              className="h-8 w-full rounded-lg border border-gray-300 bg-white px-2.5 text-[9px] font-medium text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
            />
            <input
              value={selectedChainLengthDraft}
              onChange={(event) =>
                setSelectedChainLengthDraft(event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveSelectedHoistName();
                }
              }}
              placeholder="Chain Length"
              disabled={!editable}
              className="h-8 w-full rounded-lg border border-gray-300 bg-white px-2.5 text-[9px] font-medium text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
            />
          </div>
          <div className="relative mt-1">
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
              onBlur={() => {
                setBlockSuggestionsOpen(false);
                void saveSelectedBlockName();
              }}
              placeholder="Block Name"
              disabled={!editable}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={blockSuggestionsOpen}
              aria-controls="chain-hoist-block-suggestions"
              className="h-8 w-full rounded-lg border border-gray-300 bg-white px-2.5 pr-7 text-[9px] font-medium text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
            />

            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[8px] text-gray-400">
              ▼
            </span>

            {blockSuggestionsOpen && filteredBlockOptions.length > 0 ? (
              <div
                id="chain-hoist-block-suggestions"
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
        </div>
      </div>

      <div className="mb-3 flex items-center gap-3 rounded-xl bg-gray-50 p-2">
        {selectedItem.photo_url ? (
          <img
            src={selectedItem.photo_url}
            alt={selectedItem.name}
            className="h-16 w-16 rounded-xl bg-white object-cover"
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-white text-[9px] text-gray-400">
            No photo
          </div>
        )}

        <div className="min-w-0 text-[10px] text-gray-500">
          Select an action below to edit this chain hoist.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <Link
          href={`/inventory/${category}/${subcategory}/${selectedItem.id}`}
          className="rounded-xl bg-black px-3 py-2.5 text-center text-[11px] font-medium text-white hover:opacity-90"
        >
          Open Chain Hoist / Report
        </Link>

        {editable ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditingPhotoItemId(selectedItem.id);
                  listPhotoRef.current?.click();
                }}
                className="rounded-xl border border-gray-300 bg-white px-2 py-2.5 text-center text-[10px] font-medium text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
              >
                Upload Photo
              </button>

              <button
                type="button"
                onClick={() =>
                  void searchOnlineImages(
                    getHoistDisplayName(selectedItem).replaceAll(" - ", " "),
                    selectedItem.id,
                  )
                }
                className="rounded-xl border border-gray-300 bg-white px-2 py-2.5 text-center text-[10px] font-medium text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
              >
                Search Photo
              </button>
            </div>

            <button
              type="button"
              onClick={() => void deleteItem(selectedItem.id)}
              className="flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[11px] font-medium text-red-700 hover:bg-red-100"
            >
              <Trash2 size={14} />
              Delete Chain Hoist
            </button>
          </>
        ) : null}
      </div>
    </div>
  ) : null;

  const selectedPhotoSearchPanel =
    selectedItem &&
    searchPanelOpen &&
    photoSearchItemId === selectedItem.id ? (
      <OnlineImageSearchPanel
        initialQuery={imageSearch}
        results={imageResults}
        searching={searchingImages}
        onSearch={(query) => searchOnlineImages(query, selectedItem.id)}
        onSelect={(image) => selectOnlinePhoto(image)}
        onClose={() => {
          setSearchPanelOpen(false);
          setPhotoSearchItemId(null);
          setImageResults([]);
        }}
        className="mt-3"
      />
    ) : null;

  async function closeMobileHoistTools() {
    await saveSelectedHoistName();
    await saveSelectedBlockName();
    setMobileMenuItemId(null);
    setSelectedItemId(null);
    setSearchPanelOpen(false);
    setPhotoSearchItemId(null);
    setImageResults([]);
  }

  return (
    <div className="w-full mx-auto space-y-3">
      <input
        ref={listPhotoRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPickListItemPhoto}
      />

      <datalist id="chain-hoist-block-options">
        {blockOptions.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>

      {editable && mobileMenuItemId && selectedItem ? (
        <div
          data-mobile-chain-hoist-tools="true"
          className="fixed inset-0 z-[9998] sm:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={`${selectedItem.name} tools`}
        >
          <button
            type="button"
            aria-label="Close chain hoist tools"
            onClick={() => void closeMobileHoistTools()}
            className="absolute inset-0 bg-black/45"
          />

          <div className="absolute inset-x-0 bottom-0 flex h-[75dvh] flex-col rounded-t-3xl bg-gray-50 shadow-2xl">
            <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
              <div className="h-1 w-10 rounded-full bg-gray-300" />
              <div className="text-[11px] font-semibold text-gray-700">
                Chain Hoist Tools
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => void closeMobileHoistTools()}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-lg leading-none text-gray-700"
              >
                ×
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+16px)]">
              {editItemPanel}

              {searchPanelOpen && photoSearchItemId === selectedItem.id ? (
                <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="text-[12px] font-semibold text-gray-900">
                      Search Photo Online
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSearchPanelOpen(false);
                        setPhotoSearchItemId(null);
                        setImageResults([]);
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
                      {imageResults.map((image, index) => {
                        const imageUrl =
                          image.original || image.image || image.thumbnail;
                        const thumbnail = image.thumbnail || imageUrl;
                        if (!imageUrl || !thumbnail) return null;

                        return (
                          <button
                            key={`${imageUrl}-${index}`}
                            type="button"
                            onClick={() => void selectOnlinePhoto(image)}
                            className="overflow-hidden rounded-xl border border-gray-200"
                            title={image.title || "Select photo"}
                          >
                            <img
                              src={thumbnail}
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
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="hidden sm:block xl:hidden">
        {editItemPanel}
        {addItemPanel}
      </div>

      {editable && !selectedItem ? (
        <>
          <button
            type="button"
            aria-label="Add chain hoist"
            aria-expanded={mobileAddOpen}
            onClick={() => setMobileAddOpen(true)}
            className="fixed bottom-5 right-4 z-[90] flex h-14 w-14 items-center justify-center rounded-full bg-black text-[30px] font-light leading-none text-white shadow-xl transition active:scale-95 sm:hidden"
          >
            +
          </button>

          {mobileAddOpen ? (
            <div className="fixed inset-0 z-[9998] sm:hidden">
              <button
                type="button"
                aria-label="Close add chain hoist form"
                onClick={() => setMobileAddOpen(false)}
                className="absolute inset-0 bg-black/45"
              />

              <div className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-3xl bg-gray-50 p-3 pb-[calc(env(safe-area-inset-bottom)+16px)] shadow-2xl">
                <div className="mb-2 flex items-center justify-between px-1">
                  <div className="h-1 w-10 rounded-full bg-gray-300" />
                  <button
                    type="button"
                    onClick={() => setMobileAddOpen(false)}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-lg leading-none text-gray-700"
                    aria-label="Close"
                  >
                    ×
                  </button>
                </div>
                {addItemPanel}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {sidebarTarget
        ? createPortal(
            <div className="[&_.add-hoist-grid]:!grid-cols-1 [&>div]:rounded-xl [&>div]:p-3">
              {editItemPanel}
              {selectedPhotoSearchPanel}
              {addItemPanel}
            </div>,
            sidebarTarget,
          )
        : null}

      <div className="hidden sm:block xl:hidden">
        {editItemPanel}
        {selectedPhotoSearchPanel}
      </div>

      {items.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
          No items yet.
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          {displayItems.map((it, index) => {
            const st = stats[it.id] ?? {
              total: 0,
              available: 0,
              inUse: 0,
              maintenance: 0,
              inKsa: 0,
              expired: 0,
            };

            const blockLabel = getHoistBlockName(it) || "Unassigned";
            const previousBlock =
              index > 0
                ? getHoistBlockName(displayItems[index - 1]) || "Unassigned"
                : null;
            const showBlockHeader = blockLabel !== previousBlock;
            const isLast = index === displayItems.length - 1;
            const detailsHref = `/inventory/${category}/${subcategory}/${it.id}`;
            const hoistDetails = getHoistListDetails(it);

            return (
              <div
                key={it.id}
                className={!isLast ? "border-b border-gray-100 pb-4 mb-4" : ""}
              >
                {showBlockHeader ? (
                  <div className="mb-3 flex items-center gap-2 border-b border-gray-100 pb-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                    <h2 className="text-[9px] font-semibold uppercase tracking-wide text-gray-500">
                      {blockLabel}
                    </h2>
                  </div>
                ) : null}
                <div
                  data-chain-hoist-row="true"
                  data-chain-hoist-item-id={it.id}
                  className={`relative rounded-xl transition ${
                    selectedItemId === it.id
                      ? "bg-gray-50 ring-2 ring-black"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <button
                    type="button"
                    onClick={async () => {
                      if (window.matchMedia("(min-width: 640px)").matches) {
                        if (selectedItemId === it.id) {
                          await saveSelectedHoistName();
                          await saveSelectedBlockName();
                          setSelectedItemId(null);
                          return;
                        }

                        await saveSelectedHoistName();
                        await saveSelectedBlockName();
                        setSelectedItemId(it.id);
                      } else {
                        window.location.href = detailsHref;
                      }
                    }}
                    className="flex w-full items-start gap-3 p-2 pr-10 text-left sm:pr-20"
                  >
                    <ItemPhoto
                      photo={it.photo_url}
                      name={it.name}
                      editable={false}
                    />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <h2
                          className="truncate text-[10px] sm:text-[11px] font-semibold text-gray-900"
                          style={{ lineHeight: 1.1 }}
                        >
                          {hoistDetails.mainName}
                        </h2>
                      </div>

                      {hoistDetails.capacity || hoistDetails.chainLength ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {hoistDetails.capacity ? (
                            <span className="rounded-md border border-gray-300 bg-white px-2 py-0.5 text-[8px] font-medium text-gray-700">
                              Capacity: {hoistDetails.capacity}
                            </span>
                          ) : null}
                          {hoistDetails.chainLength ? (
                            <span className="rounded-md border border-gray-300 bg-white px-2 py-0.5 text-[8px] font-medium text-gray-700">
                              Chain: {hoistDetails.chainLength}
                            </span>
                          ) : null}
                        </div>
                      ) : null}

                      {/* Mobile stats */}
                      <div className="mt-2 sm:hidden">
                        <div className={`grid gap-x-2 gap-y-1 text-center ${
                          st.maintenance > 0 ? "grid-cols-4" : "grid-cols-3"
                        }`}>
                          <div className="text-[8px] font-semibold text-gray-500">
                            Total
                          </div>
                          <div className="text-[8px] font-semibold text-gray-500">
                            Available
                          </div>
                          {st.maintenance > 0 ? (
                            <div className="text-[8px] font-semibold text-gray-500">
                              Maintenance
                            </div>
                          ) : null}
                          <div className="text-[8px] font-semibold text-gray-500">
                            Expired
                          </div>

                          <div className="rounded-md bg-gray-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                            {st.total}
                          </div>
                          <div className="rounded-md bg-green-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                            {st.available}
                          </div>
                          {st.maintenance > 0 ? (
                            <div className="rounded-md bg-yellow-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                              {st.maintenance}
                            </div>
                          ) : null}
                          <div className="rounded-md bg-red-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                            {st.expired}
                          </div>
                        </div>
                      </div>

                      {/* Desktop stats */}
                      <div className="mt-1 hidden sm:block">
                        <div className="flex flex-wrap gap-2">
                          <StatPill label="Total Qty" value={st.total} />
                          <StatPill
                            label="Available Qty"
                            value={st.available}
                            tone="green"
                          />
                          {st.maintenance > 0 ? (
                            <StatPill
                              label="Maintenance"
                              value={st.maintenance}
                              tone="yellow"
                            />
                          ) : null}
                          <StatPill
                            label="Expired"
                            value={st.expired}
                            tone="red"
                          />
                        </div>
                      </div>
                    </div>
                  </button>

                  <div
                    className={`absolute top-2 z-20 sm:hidden ${
                      editable ? "right-10" : "right-2"
                    }`}
                  >
                    <EquipmentListAddUnitsAction
                      item={it}
                      category={category}
                      subcategory={subcategory}
                      compact
                    />
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
                      className="rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[9px] font-medium text-gray-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                    >
                      Report
                    </Link>
                  </div>

                  {editable ? (
                    <div
                      data-mobile-hoist-menu="true"
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
                            void closeMobileHoistTools();
                            return;
                          }

                          void saveSelectedHoistName();
                          void saveSelectedBlockName();
                          setSearchPanelOpen(false);
                          setPhotoSearchItemId(null);
                          setImageResults([]);
                          setSelectedItemId(it.id);
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
          })}
        </div>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { Trash2 } from "lucide-react";
import EquipmentListAddUnitsAction from "@/components/EquipmentListAddUnitsAction";
import OnlineImageSearchPanel from "@/components/OnlineImageSearchPanel";

type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

type DbItem = {
  id: string;
  subcategory_id: string;
  name: string;
  fixture_type?: string | null;
  photo_url?: string | null;
  created_at?: string;
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

function sortProjectorsByBrand(items: DbItem[]) {
  return [...items].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
      numeric: true,
    }),
  );
}

function splitProjectorName(name: string) {
  const clean = name.trim();

  if (clean.includes(" - ")) {
    const parts = clean.split(" - ");
    return {
      brand: (parts[0] || "").trim(),
      model: parts.slice(1).join(" - ").trim(),
    };
  }

  const parts = clean.split(/\s+/).filter(Boolean);
  return {
    brand: parts[0] || "",
    model: parts.slice(1).join(" "),
  };
}

function toStatus(v: any): UnitStatus {
  if (
    v === "available" ||
    v === "in_use" ||
    v === "maintenance" ||
    v === "in_ksa"
  )
    return v;
  return "available";
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

async function uploadPhotoBlob(blob: Blob): Promise<string> {
  const supabase = createClient();

  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;

  const filePath = `projectors/thumbs/${fileName}`;

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

function ProjectorPhoto({
  photo,
  name,
}: {
  photo?: string | null;
  name: string;
}) {
  return (
    <div className="flex h-14 w-14 min-w-[56px] items-center justify-center">
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

export default function SubcategoryClientProjectors({
  category,
  subcategory,
  subcategoryId,
}: {
  category: string;
  subcategory: string;
  subcategoryId: string | null;
}) {
  const supabase = createClient();
  const editable = canEditInventory();

  const [resolvedSubcategoryId, setResolvedSubcategoryId] = useState<
    string | null
  >(subcategoryId ?? null);

  const [items, setItems] = useState<DbItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [blockName, setBlockName] = useState("");
  const [qty, setQty] = useState<number>(1);
  const [photo, setPhoto] = useState<string | null>(null);
  const addPhotoRef = useRef<HTMLInputElement | null>(null);
  const listPhotoRef = useRef<HTMLInputElement | null>(null);
  const [editingPhotoItemId, setEditingPhotoItemId] = useState<string | null>(
    null,
  );

  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [photoSearchItemId, setPhotoSearchItemId] = useState<string | null>(
    null,
  );
  const [imageSearch, setImageSearch] = useState("");
  const [imageResults, setImageResults] = useState<OnlineImage[]>([]);
  const [searchingImages, setSearchingImages] = useState(false);

  const [stats, setStats] = useState<Record<string, ItemStats>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState("");
  const [sidebarTarget, setSidebarTarget] = useState<HTMLElement | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedBrandDraft, setSelectedBrandDraft] = useState("");
  const [selectedModelDraft, setSelectedModelDraft] = useState("");
  const [selectedBlockDraft, setSelectedBlockDraft] = useState("");
  const [blockSuggestionsOpen, setBlockSuggestionsOpen] = useState(false);
  const [mobileMenuItemId, setMobileMenuItemId] = useState<string | null>(null);
  const [mobileAddOpen, setMobileAddOpen] = useState(false);

  const projectorGroups = useMemo(() => {
    const groups = new Map<string, DbItem[]>();

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
        items: sortProjectorsByBrand(groupItems),
      }));
  }, [items]);

  const displayItems = useMemo(
    () => projectorGroups.flatMap((group) => group.items),
    [projectorGroups],
  );

  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;

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
    const parsed = splitProjectorName(selectedItem?.name ?? "");
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
        target.closest("[data-selected-projector-name='true']"),
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

      void saveSelectedProjectorName();
      void saveSelectedBlockName();

      const nextItemId = displayItems[nextIndex].id;
      setSelectedItemId(nextItemId);

      requestAnimationFrame(() => {
        document
          .querySelector(`[data-projector-item-id="${nextItemId}"]`)
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
    displayItems,
  ]);

  const projectorName = useMemo(() => {
    return [brand, model]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" - ");
  }, [brand, model]);

  const projectorSearchName = useMemo(() => {
    return [brand, model]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" ");
  }, [brand, model]);

  const canAdd = useMemo(() => {
    return (
      editable &&
      !!resolvedSubcategoryId &&
      projectorName.trim().length > 0 &&
      Number(qty) >= 1 &&
      !submitting
    );
  }, [editable, resolvedSubcategoryId, projectorName, qty, submitting]);

  async function resolveSubcategoryIdFromDb() {
    const catRes = await supabase
      .from("categories")
      .select("id")
      .eq("slug", category)
      .single();

    if (catRes.error || !catRes.data?.id) {
      throw new Error(`Category not found for slug: ${category}`);
    }

    const subRes = await supabase
      .from("subcategories")
      .select("id")
      .eq("category_id", catRes.data.id)
      .eq("slug", subcategory)
      .single();

    if (subRes.error || !subRes.data?.id) {
      throw new Error(`Subcategory not found for slug: ${subcategory}`);
    }

    return subRes.data.id as string;
  }

  async function loadItems(subId: string) {
    setLoading(true);
    setErrorMsg(null);

    const { data, error } = await supabase
      .from("items")
      .select("id, subcategory_id, name, fixture_type, photo_url, created_at")
      .eq("subcategory_id", subId);

    if (error) {
      console.error("loadItems error", error);
      setItems([]);
      setStats({});
      setErrorMsg(error.message || "Failed to load items.");
      setLoading(false);
      return;
    }

    const rows = sortProjectorsByBrand((data ?? []) as DbItem[]);
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
        .select("item_id,status")
        .in("item_id", ids)
        .range(from, from + pageSize - 1);

      if (uerr) {
        console.error("loadUnits stats error", uerr);
        setStats({});
        setErrorMsg(uerr.message || "Failed to load stats.");
        setLoading(false);
        return;
      }

      allUnits = [...allUnits, ...(udata || [])];

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
      };
    }

    for (const u of allUnits) {
      const itemId = String((u as any).item_id || "");
      const status = toStatus((u as any).status);

      if (!map[itemId]) {
        map[itemId] = {
          total: 0,
          available: 0,
          inUse: 0,
          maintenance: 0,
          inKsa: 0,
        };
      }

      map[itemId].total += 1;
      if (status === "available") map[itemId].available += 1;
      else if (status === "in_use") map[itemId].inUse += 1;
      else if (status === "maintenance") map[itemId].maintenance += 1;
      else if (status === "in_ksa") map[itemId].inKsa += 1;
    }

    setStats(map);
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setErrorMsg(null);

        const finalSubId =
          subcategoryId ?? (await resolveSubcategoryIdFromDb());
        if (cancelled) return;

        setResolvedSubcategoryId(finalSubId);
        await loadItems(finalSubId);
      } catch (error: any) {
        if (cancelled) return;
        setResolvedSubcategoryId(null);
        setItems([]);
        setStats({});
        setLoading(false);
        setErrorMsg(error?.message || "Failed to resolve subcategory.");
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subcategoryId, category, subcategory]);

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
    function closeMobileMenu(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const insideMenu = target.closest(
        "[data-mobile-projector-menu='true']",
      );
      const insideTools = target.closest(
        "[data-mobile-projector-tools='true']",
      );

      if (!insideMenu && !insideTools) {
        setMobileMenuItemId(null);
      }
    }

    document.addEventListener("mousedown", closeMobileMenu);
    return () => document.removeEventListener("mousedown", closeMobileMenu);
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
      alert(error?.message || "Failed to read photo");
    } finally {
      e.target.value = "";
    }
  }

  async function updateItemPhoto(itemId: string, photoUrl: string) {
    if (!editable) return;

    const { error } = await supabase
      .from("items")
      .update({ photo_url: photoUrl })
      .eq("id", itemId);

    if (error) throw error;

    setItems((current) =>
      current.map((item) =>
        item.id === itemId ? { ...item, photo_url: photoUrl } : item,
      ),
    );

    setSaveMsg("Photo updated");
    setTimeout(() => {
      setSaveMsg((current) => (current === "Photo updated" ? "" : current));
    }, 1500);
  }

  async function onPickListItemPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const itemId = editingPhotoItemId;
    e.target.value = "";
    if (!editable || !file || !itemId) return;

    try {
      setSaveMsg("Uploading photo...");
      const photoUrl = await uploadPhoto(file);
      await updateItemPhoto(itemId, photoUrl);
    } catch (error: any) {
      console.error("projector photo update error", error);
      alert(error?.message || "Failed to update photo");
      setSaveMsg("");
    } finally {
      setEditingPhotoItemId(null);
    }
  }

  async function searchOnlineImages(
    customQuery?: string,
    targetItemId?: string | null,
  ) {
    const q = (customQuery || imageSearch || projectorSearchName).trim();

    if (!q) {
      alert("Write brand/model first");
      return;
    }

    if (targetItemId !== undefined) {
      setPhotoSearchItemId(targetItemId);
    }

    setImageSearch(q);
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

  async function selectOnlinePhoto(img: OnlineImage) {
    const fallbackUrl = img.thumbnail || img.image || img.original;
    const sourceUrl = img.image || img.original || img.thumbnail;

    if (!fallbackUrl || !sourceUrl) return;

    setSaveMsg("Preparing photo...");

    let finalImageUrl = fallbackUrl;

    try {
      const res = await fetch("/api/optimize-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: sourceUrl }),
      });

      if (!res.ok) throw new Error("Optimization failed");

      const data = await res.json();
      if (data?.url) finalImageUrl = data.url;
    } catch (error) {
      console.warn("Could not optimize online image:", error);
      finalImageUrl = fallbackUrl;
    }

    if (photoSearchItemId) {
      try {
        await updateItemPhoto(photoSearchItemId, finalImageUrl);
      } catch (error: any) {
        console.error("projector online photo update error", error);
        alert(error?.message || "Failed to update photo");
        setSaveMsg("");
        return;
      }
    } else {
      setPhoto(finalImageUrl);
      setSaveMsg("Online photo selected");
      setTimeout(() => setSaveMsg(""), 1500);
    }

    setSearchPanelOpen(false);
    setPhotoSearchItemId(null);
    setImageResults([]);
  }

  async function addItem() {
    if (!editable) return;

    setErrorMsg(null);

    if (!resolvedSubcategoryId) {
      setErrorMsg("Subcategory is not ready yet.");
      return;
    }

    const clean = projectorName.trim();
    if (!clean) {
      setErrorMsg("Please enter projector brand/model.");
      return;
    }

    const nQty = Number.isFinite(qty) ? Math.max(1, Math.floor(qty)) : 1;

    setSubmitting(true);

    try {
      const { data: newItem, error } = await supabase
        .from("items")
        .insert({
          subcategory_id: resolvedSubcategoryId,
          name: clean,
          fixture_type: blockName.trim() || null,
          photo_url: photo || null,
        })
        .select("id, subcategory_id, name, fixture_type, photo_url, created_at")
        .single();

      if (error) {
        console.error("addItem error", error);
        setErrorMsg(error.message || "Failed to add item.");
        return;
      }

      const unitsPayload = Array.from({ length: nQty }, (_, i) => ({
        item_id: newItem.id,
        unit_no: i + 1,
        serial: "",
        status: "available",
        notes: "",
        lamp_hours: 0,
      }));

      const { error: uerr } = await supabase.from("units").insert(unitsPayload);

      if (uerr) {
        console.error("create projector units error", uerr);
        setErrorMsg(
          uerr.message || "Item added, but failed to create units rows.",
        );
      }

      setItems((prev) => sortProjectorsByBrand([...prev, newItem as DbItem]));

      setStats((prev) => ({
        ...prev,
        [newItem.id]: {
          total: nQty,
          available: nQty,
          inUse: 0,
          maintenance: 0,
          inKsa: 0,
        },
      }));

      setBrand("");
      setModel("");
      setBlockName("");
      setQty(1);
      setPhoto(null);
      setImageSearch("");
      setImageResults([]);
      setSearchPanelOpen(false);
      setPhotoSearchItemId(null);
      setSaveMsg("Item added");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item added" ? "" : prev));
      }, 1500);
    } finally {
      setSubmitting(false);
    }
  }

  async function renameItem(itemId: string, nextNameOverride?: string) {
    if (!editable) return;

    const it = items.find((x) => x.id === itemId);
    if (!it) return;

    const nextName = nextNameOverride ?? prompt("Projector name:", it.name);
    if (!nextName) return;

    const clean = nextName.trim();
    if (!clean) return;

    const { error } = await supabase
      .from("items")
      .update({ name: clean })
      .eq("id", itemId);

    if (error) {
      console.error("rename item error", error);
      alert("Rename failed");
      return;
    }

    setItems((prev) =>
      sortProjectorsByBrand(
        prev.map((item) =>
          item.id === itemId ? { ...item, name: clean } : item,
        ),
      ),
    );

    setSaveMsg("Item renamed");
    setTimeout(() => {
      setSaveMsg((prev) => (prev === "Item renamed" ? "" : prev));
    }, 1500);
  }

  async function saveSelectedProjectorName() {
    if (!editable || !selectedItem) return;

    const brandValue = selectedBrandDraft.trim();
    const modelValue = selectedModelDraft.trim();
    const cleanName = [brandValue, modelValue].filter(Boolean).join(" - ");

    if (!cleanName) {
      const parsed = splitProjectorName(selectedItem.name);
      setSelectedBrandDraft(parsed.brand);
      setSelectedModelDraft(parsed.model);
      return;
    }

    if (cleanName === selectedItem.name) return;
    await renameItem(selectedItem.id, cleanName);
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

    const { error } = await supabase
      .from("items")
      .update({ fixture_type: clean })
      .eq("id", selectedItem.id);

    if (error) {
      console.error("update projector block error", error);
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
    if (uerr) console.warn("delete units warn", uerr);

    const { error } = await supabase.from("items").delete().eq("id", itemId);

    if (error) {
      console.error("delete item error", error);
      alert("Delete failed");
      return;
    }

    setItems((prev) => prev.filter((item) => item.id !== itemId));
    setSelectedItemId((current) => (current === itemId ? null : current));
    setStats((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });

    setSaveMsg("Item deleted");
    setTimeout(() => {
      setSaveMsg((prev) => (prev === "Item deleted" ? "" : prev));
    }, 1500);
  }

  useEffect(() => {
    function handleSelectionClickOutside(event: MouseEvent) {
      if (!selectedItemId) return;

      const target = event.target as HTMLElement;
      const insideProjector = target.closest(
        "[data-projector-item-row='true']",
      );
      const insideSidebar = target.closest("#right-sidebar-actions");
      const insideProjectorTools = target.closest(
        "[data-projector-tools='true']",
      );
      const insideMobileTools = target.closest(
        "[data-mobile-projector-tools='true']",
      );

      if (
        insideProjector ||
        insideSidebar ||
        insideProjectorTools ||
        insideMobileTools
      )
        return;

      void saveSelectedProjectorName();
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
    selectedBlockDraft,
    selectedItem?.name,
    selectedItem?.fixture_type,
  ]);

  const editItemPanel = selectedItem ? (
    <div
      data-projector-tools="true"
      className="mb-4 rounded-2xl border-2 border-black bg-white p-3 shadow-sm"
    >
      <div className="mb-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Selected Projector
          </div>
          <div
            data-selected-projector-name="true"
            className="mt-1 grid grid-cols-1 gap-1.5"
          >
            <input
              value={selectedBrandDraft}
              onChange={(event) => setSelectedBrandDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveSelectedProjectorName();
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
                  void saveSelectedProjectorName();
                }
              }}
              placeholder="Model"
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
              aria-controls="projector-block-suggestions"
              className="h-8 w-full rounded-lg border border-gray-300 bg-white px-2.5 pr-7 text-[9px] font-medium text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
            />

            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[8px] text-gray-400">
              ▼
            </span>

            {blockSuggestionsOpen && filteredBlockOptions.length > 0 ? (
              <div
                id="projector-block-suggestions"
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
        <ProjectorPhoto
          photo={selectedItem.photo_url}
          name={selectedItem.name}
        />
        <div className="min-w-0 text-[10px] text-gray-500">
          Select an action below to edit this projector.
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <Link
          href={`/inventory/${category}/${subcategory}/${selectedItem.id}`}
          className="rounded-xl bg-black px-3 py-2.5 text-center text-[11px] font-medium text-white hover:opacity-90"
        >
          Open Projector / Report
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
                    selectedItem.name.replaceAll(" - ", " "),
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
              Delete Projector
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

  const sidebarAddPanel = editable && !selectedItem ? (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4">
        <h2 className="text-[13px] font-semibold leading-tight text-gray-900">
          Add Projector
        </h2>
        <p className="mt-1 text-[10px] text-gray-500">
          Enter brand, model, block name, quantity and optional photo.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <input
          value={brand}
          onChange={(e) => {
            setBrand(e.target.value);
            if (!imageSearch)
              setImageSearch(`${e.target.value} ${model}`.trim());
          }}
          placeholder="Brand (e.g. Barco)"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />
        <input
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            if (!imageSearch)
              setImageSearch(`${brand} ${e.target.value}`.trim());
          }}
          placeholder="Model (e.g. F80 4K12)"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />
        <input
          value={blockName}
          onChange={(e) => setBlockName(e.target.value)}
          placeholder="Block Name (e.g. Main Projector)"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />
        <input
          value={String(qty)}
          onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          type="number"
          min={1}
          placeholder="Qty"
          className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
        />

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => addPhotoRef.current?.click()}
            className="flex h-11 w-full items-center justify-center rounded-2xl border border-gray-300 bg-white px-2 text-[10px] font-medium text-gray-700 shadow-sm transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
          >
            {photo ? "Photo ✔" : "Upload Photo"}
          </button>

          <button
            type="button"
            onClick={() => void searchOnlineImages(projectorSearchName, null)}
            className="flex h-11 w-full items-center justify-center rounded-2xl border border-gray-300 bg-white px-2 text-[10px] font-medium text-gray-700 shadow-sm transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
          >
            Search Photo
          </button>
        </div>

        {photo ? (
          <div className="flex items-center gap-2 rounded-xl bg-gray-50 p-2">
            <img
              src={photo}
              alt="Selected"
              className="h-12 w-12 rounded-lg object-cover"
            />
            <button
              type="button"
              onClick={() => setPhoto(null)}
              className="text-[10px] font-medium text-red-600"
            >
              Remove photo
            </button>
          </div>
        ) : null}

        {searchPanelOpen ? (
          <div className="rounded-xl border border-gray-200 p-2">
            <div className="flex gap-2">
              <input
                value={imageSearch}
                onChange={(e) => setImageSearch(e.target.value)}
                placeholder="Search image..."
                className="h-9 min-w-0 flex-1 rounded-lg border border-gray-300 px-2 text-[10px]"
              />
              <button
                type="button"
                onClick={() => void searchOnlineImages()}
                disabled={searchingImages}
                className="h-9 rounded-lg bg-black px-2 text-[10px] text-white disabled:opacity-40"
              >
                {searchingImages ? "..." : "Search"}
              </button>
            </div>
            {imageResults.length > 0 ? (
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {imageResults.map((image, index) => {
                  const url = image.thumbnail || image.image || image.original;
                  if (!url) return null;
                  return (
                    <button
                      key={`${url}-${index}`}
                      type="button"
                      onClick={() => void selectOnlinePhoto(image)}
                      className="overflow-hidden rounded-lg border border-gray-200"
                    >
                      <img
                        src={url}
                        alt={image.title || "Projector"}
                        className="aspect-square w-full object-cover"
                      />
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => void addItem()}
          disabled={!canAdd}
          className="h-11 w-full rounded-2xl border border-black bg-black px-4 text-[12px] font-medium text-white shadow-sm transition hover:opacity-90 disabled:opacity-40"
        >
          {submitting ? "Adding..." : "+ Add Projector"}
        </button>
      </div>

      {errorMsg || saveMsg ? (
        <div
          className={`mt-2 text-[10px] ${errorMsg ? "text-red-600" : "text-gray-500"}`}
        >
          {errorMsg || saveMsg}
        </div>
      ) : null}
    </div>
  ) : null;

  async function closeMobileProjectorTools() {
    await saveSelectedProjectorName();
    await saveSelectedBlockName();
    setMobileMenuItemId(null);
    setSelectedItemId(null);
    setSearchPanelOpen(false);
    setPhotoSearchItemId(null);
    setImageResults([]);
  }

  if (loading) {
    return (
      <div className="w-full mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
          Loading projectors...
        </div>
      </div>
    );
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

      {editable && mobileMenuItemId && selectedItem ? (
        <div
          data-mobile-projector-tools="true"
          className="fixed inset-0 z-[9998] sm:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={`${selectedItem.name} tools`}
        >
          <button
            type="button"
            aria-label="Close projector tools"
            onClick={() => void closeMobileProjectorTools()}
            className="absolute inset-0 bg-black/45"
          />

          <div className="absolute inset-x-0 bottom-0 flex h-[75dvh] flex-col rounded-t-3xl bg-gray-50 shadow-2xl">
            <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
              <div className="h-1 w-10 rounded-full bg-gray-300" />
              <div className="text-[11px] font-semibold text-gray-700">
                Projector Tools
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => void closeMobileProjectorTools()}
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

      {editable && !selectedItem ? (
        <>
          <button
            type="button"
            aria-label="Add projector"
            onClick={() => setMobileAddOpen(true)}
            className="fixed bottom-5 right-4 z-[90] flex h-14 w-14 items-center justify-center rounded-full bg-black text-[30px] font-light leading-none text-white shadow-xl active:scale-95 sm:hidden"
          >
            +
          </button>

          {mobileAddOpen ? (
            <div className="fixed inset-0 z-[9998] sm:hidden">
              <button
                type="button"
                aria-label="Close add projector form"
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

      {editable && !selectedItem && (
        <div className="hidden rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:block sm:p-5 xl:hidden">
          <div className="mb-4">
            <h1 className="text-[13px] font-semibold leading-tight text-gray-900">
              Add Projector
            </h1>
            <p className="mt-1 text-[10px] text-gray-500">
              Enter brand, model, block name, quantity and optional photo.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_1fr_76px_116px_76px] md:items-center">
            <input
              value={brand}
              onChange={(e) => {
                setBrand(e.target.value);
                if (!imageSearch)
                  setImageSearch(`${e.target.value} ${model}`.trim());
              }}
              placeholder="Brand (e.g. Barco)"
              className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
            />

            <input
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                if (!imageSearch)
                  setImageSearch(`${brand} ${e.target.value}`.trim());
              }}
              placeholder="Model (e.g. F80 4K12)"
              className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
            />

            <input
              value={blockName}
              onChange={(e) => setBlockName(e.target.value)}
              placeholder="Block Name (e.g. Main Projector)"
              className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
            />

            <input
              value={String(qty)}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              type="number"
              min={1}
              placeholder="Qty"
              className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
            />

            <input
              ref={addPhotoRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onPickAddPhoto}
            />

            <div className="grid grid-cols-2 gap-2 md:col-span-2">
              <button
                type="button"
                onClick={() => addPhotoRef.current?.click()}
                className="flex h-11 w-full items-center justify-center rounded-2xl border border-gray-300 bg-white px-2 text-[10px] font-medium text-gray-700 shadow-sm transition hover:bg-red-50 hover:border-red-200 hover:text-red-700"
              >
                {photo ? "Photo ✔" : "Upload Photo"}
              </button>

              <button
                type="button"
                onClick={() =>
                  void searchOnlineImages(projectorSearchName, null)
                }
                className="flex h-11 w-full items-center justify-center rounded-2xl border border-gray-300 bg-white px-2 text-[10px] font-medium text-gray-700 shadow-sm transition hover:bg-red-50 hover:border-red-200 hover:text-red-700"
              >
                Search Photo
              </button>
            </div>

            <button
              type="button"
              onClick={addItem}
              disabled={!canAdd}
              className="h-11 w-full rounded-2xl border border-black bg-black px-4 text-[12px] font-medium text-white shadow-sm transition hover:opacity-90 disabled:opacity-40"
              title={!resolvedSubcategoryId ? "subcategoryId not resolved" : ""}
            >
              {submitting ? "Adding..." : "+ Add"}
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

          {(errorMsg || saveMsg) && (
            <div
              className={`mt-3 text-xs ${errorMsg ? "text-red-600" : "text-gray-500"}`}
            >
              {errorMsg || saveMsg}
            </div>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
          No items yet.
        </div>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-6">
          {displayItems.map((it, index) => {
            const st = stats[it.id] ?? {
              total: 0,
              available: 0,
              inUse: 0,
              maintenance: 0,
              inKsa: 0,
            };

            const blockLabel = it.fixture_type?.trim() || "Unassigned";
            const previousBlock =
              index > 0
                ? displayItems[index - 1].fixture_type?.trim() || "Unassigned"
                : null;
            const showBlockHeader = blockLabel !== previousBlock;

            return (
              <React.Fragment key={it.id}>
                {showBlockHeader ? (
                  <div className="mb-3 flex items-center gap-2 border-b border-gray-100 pb-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                    <h2 className="text-[9px] font-semibold uppercase tracking-wide text-gray-500">
                      {blockLabel}
                    </h2>
                  </div>
                ) : null}

                <ProjectorItemRow
                  item={it}
                  stats={st}
                  category={category}
                  subcategory={subcategory}
                  editable={editable}
                  isLast={index === displayItems.length - 1}
                  selected={selectedItemId === it.id}
                  mobileMenuOpen={mobileMenuItemId === it.id}
                  onSelect={async () => {
                    if (selectedItemId === it.id) {
                      await saveSelectedProjectorName();
                      await saveSelectedBlockName();
                      setSelectedItemId(null);
                      return;
                    }

                    await saveSelectedProjectorName();
                    await saveSelectedBlockName();
                    setSelectedItemId(it.id);
                  }}
                  onToggleMobileMenu={() => {
                    if (mobileMenuItemId === it.id) {
                      void closeMobileProjectorTools();
                      return;
                    }

                    void saveSelectedProjectorName();
                    void saveSelectedBlockName();
                    setSearchPanelOpen(false);
                    setPhotoSearchItemId(null);
                    setImageResults([]);
                    setSelectedItemId(it.id);
                    setMobileMenuItemId(it.id);
                  }}
                  onDelete={() => deleteItem(it.id)}
                />
              </React.Fragment>
            );
          })}
        </div>
      )}

      {!loading && !resolvedSubcategoryId && (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 text-sm text-red-600">
          Could not resolve this subcategory in database.
        </div>
      )}
    </div>
  );
}

function ProjectorItemRow({
  item,
  stats,
  category,
  subcategory,
  editable,
  isLast,
  selected,
  mobileMenuOpen,
  onSelect,
  onToggleMobileMenu,
  onDelete,
}: {
  item: DbItem;
  stats: ItemStats;
  category: string;
  subcategory: string;
  editable: boolean;
  isLast: boolean;
  selected: boolean;
  mobileMenuOpen: boolean;
  onSelect: () => void | Promise<void>;
  onToggleMobileMenu: () => void;
  onDelete: () => void;
}) {
  const detailsHref = `/inventory/${category}/${subcategory}/${item.id}`;

  return (
    <div className={!isLast ? "border-b border-gray-100 pb-4 mb-4" : ""}>
      <div
        data-projector-item-id={item.id}
        data-projector-item-row="true"
        className={`relative flex flex-col gap-3 rounded-xl transition sm:flex-row sm:items-start sm:justify-between ${
          selected ? "bg-gray-50 ring-2 ring-black" : "hover:bg-gray-50"
        }`}
      >
        <div className="flex items-start gap-2 min-w-0 flex-[1.45]">
          <button
            type="button"
            onClick={() => {
              if (window.matchMedia("(min-width: 640px)").matches) {
                onSelect();
              } else {
                window.location.href = detailsHref;
              }
            }}
            className="flex items-start gap-3 min-w-0 flex-1 text-left group"
          >
            <ProjectorPhoto photo={item.photo_url} name={item.name} />

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <h2
                  className="truncate text-[10px] sm:text-[11px] font-semibold text-gray-900 group-hover:text-black"
                  style={{ lineHeight: 1.1 }}
                >
                  {item.name}
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

                  <div className="rounded-md bg-gray-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                    {stats.total}
                  </div>
                  <div className="rounded-md bg-green-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                    {stats.available}
                  </div>
                  {stats.maintenance > 0 ? (
                    <div className="rounded-md bg-yellow-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
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
          </button>
        </div>

        <div className="flex items-center sm:items-start sm:justify-end gap-2 shrink-0 w-full sm:w-auto">
          {editable && (
            <div className="hidden items-center gap-2">
              <button
                type="button"
                onClick={onDelete}
                className="px-2 py-1 rounded-full border border-gray-300 text-[9px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
              >
                Delete
              </button>
            </div>
          )}
        </div>

        <div className="absolute right-2 top-2 hidden items-center gap-1.5 sm:flex">
          <EquipmentListAddUnitsAction
            item={item}
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
            data-mobile-projector-menu="true"
            className="absolute right-2 top-2 z-30 sm:hidden"
          >
            <button
              type="button"
              aria-label={`Edit ${item.name}`}
              aria-expanded={mobileMenuOpen}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleMobileMenu();
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

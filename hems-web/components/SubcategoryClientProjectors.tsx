"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { Trash2, ChevronDown } from "lucide-react";
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

type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

type DbItem = {
  id: string;
  subcategory_id: string;
  name: string;
  photo_url?: string | null;
  created_at?: string;
  sort_order?: number | null;
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

function sortItemsForOrder(items: DbItem[]) {
  return [...items].sort((a, b) => {
    const ao = typeof a.sort_order === "number" ? a.sort_order : 999999;
    const bo = typeof b.sort_order === "number" ? b.sort_order : 999999;

    if (ao !== bo) return ao - bo;

    const ad = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bd = b.created_at ? new Date(b.created_at).getTime() : 0;

    return bd - ad;
  });
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
  const [qty, setQty] = useState<number>(1);
  const [photo, setPhoto] = useState<string | null>(null);
  const addPhotoRef = useRef<HTMLInputElement | null>(null);

  const [photoMenuOpen, setPhotoMenuOpen] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [imageSearch, setImageSearch] = useState("");
  const [imageResults, setImageResults] = useState<OnlineImage[]>([]);
  const [searchingImages, setSearchingImages] = useState(false);

  const [stats, setStats] = useState<Record<string, ItemStats>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState("");

  const projectorName = useMemo(() => {
    const b = brand.trim();
    const m = model.trim();

    if (b && m) return `${b} - ${m}`;
    if (b) return b;
    return m;
  }, [brand, model]);

  const projectorSearchName = useMemo(() => {
    const b = brand.trim();
    const m = model.trim();

    if (b && m) return `${b} ${m}`;
    if (b) return b;
    return m;
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

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

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
      .select("id, subcategory_id, name, photo_url, created_at, sort_order")
      .eq("subcategory_id", subId)
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("loadItems error", error);
      setItems([]);
      setStats({});
      setErrorMsg(error.message || "Failed to load items.");
      setLoading(false);
      return;
    }

    const rows = sortItemsForOrder((data ?? []) as DbItem[]);
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
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const addMenu = document.getElementById("projector-add-photo-menu");

      if (addMenu && !addMenu.contains(target)) {
        setPhotoMenuOpen(false);
      }
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
      alert(error?.message || "Failed to read photo");
    } finally {
      e.target.value = "";
    }
  }

  async function searchOnlineImages(customQuery?: string) {
    const q = (customQuery || imageSearch || projectorSearchName).trim();

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
        const text = await res.text();
        console.error("Image API error:", text);
        alert("Image search API error");
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

    setPhoto(finalImageUrl);
    setSearchPanelOpen(false);
    setImageResults([]);
    setSaveMsg("Online photo selected");
    setTimeout(() => setSaveMsg(""), 1500);
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
          photo_url: photo || null,
          sort_order: items.length,
        })
        .select("id, subcategory_id, name, photo_url, created_at, sort_order")
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

      setItems((prev) => [
        ...prev,
        { ...(newItem as DbItem), sort_order: prev.length },
      ]);

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
      setQty(1);
      setPhoto(null);
      setImageSearch("");
      setImageResults([]);
      setSearchPanelOpen(false);
      setPhotoMenuOpen(false);
      setSaveMsg("Item added");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item added" ? "" : prev));
      }, 1500);
    } finally {
      setSubmitting(false);
    }
  }

  async function renameItem(itemId: string) {
    if (!editable) return;

    const it = items.find((x) => x.id === itemId);
    if (!it) return;

    const nextName = prompt("Projector name:", it.name);
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
      prev.map((item) =>
        item.id === itemId ? { ...item, name: clean } : item,
      ),
    );

    setSaveMsg("Item renamed");
    setTimeout(() => {
      setSaveMsg((prev) => (prev === "Item renamed" ? "" : prev));
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

  async function reorderItems(activeId: string, overId: string) {
    if (!editable || activeId === overId) return;

    let nextItems: DbItem[] = [];

    setItems((prev) => {
      const oldIndex = prev.findIndex((item) => item.id === activeId);
      const newIndex = prev.findIndex((item) => item.id === overId);

      if (oldIndex < 0 || newIndex < 0) return prev;

      nextItems = arrayMove(prev, oldIndex, newIndex).map((item, index) => ({
        ...item,
        sort_order: index,
      }));

      return nextItems;
    });

    setTimeout(async () => {
      if (nextItems.length === 0) return;

      const results = await Promise.all(
        nextItems.map((item, index) =>
          supabase
            .from("items")
            .update({ sort_order: index })
            .eq("id", item.id),
        ),
      );

      const failed = results.find((res) => res.error);
      if (failed?.error) {
        alert("Failed to save item order");
        if (resolvedSubcategoryId) void loadItems(resolvedSubcategoryId);
      }
    }, 0);
  }

  function handleDragEnd(event: any) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    void reorderItems(String(active.id), String(over.id));
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
      {editable && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h1
              style={{
                fontSize: "14px",
                fontWeight: 600,
                color: "#111827",
                lineHeight: 1.1,
              }}
            >
              Add Projector Item
            </h1>
          </div>

          <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_76px_116px_76px] md:items-center">
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

            <div id="projector-add-photo-menu" className="relative">
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
                      addPhotoRef.current?.click();
                    }}
                    className="block w-full px-3 py-2 text-left text-[11px] text-gray-700 hover:bg-gray-50"
                  >
                    Upload photo
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setPhotoMenuOpen(false);
                      setSearchPanelOpen(true);
                      setImageSearch(projectorSearchName);
                      setTimeout(
                        () => void searchOnlineImages(projectorSearchName),
                        50,
                      );
                    }}
                    className="block w-full px-3 py-2 text-left text-[11px] text-gray-700 hover:bg-gray-50"
                  >
                    Search photo
                  </button>
                </div>
              ) : null}
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
        <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-6">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={items.map((item) => item.id)}
              strategy={verticalListSortingStrategy}
            >
              {items.map((it, index) => {
                const st = stats[it.id] ?? {
                  total: 0,
                  available: 0,
                  inUse: 0,
                  maintenance: 0,
                  inKsa: 0,
                };

                return (
                  <SortableProjectorItem
                    key={it.id}
                    id={it.id}
                    disabled={!editable}
                  >
                    {(dragHandleProps) => (
                      <ProjectorItemRow
                        item={it}
                        stats={st}
                        category={category}
                        subcategory={subcategory}
                        editable={editable}
                        isLast={index === items.length - 1}
                        dragHandleProps={dragHandleProps}
                        onRename={() => renameItem(it.id)}
                        onDelete={() => deleteItem(it.id)}
                      />
                    )}
                  </SortableProjectorItem>
                );
              })}
            </SortableContext>
          </DndContext>
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

function SortableProjectorItem({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled?: boolean;
  children: (dragHandleProps: {
    attributes: ReturnType<typeof useSortable>["attributes"];
    listeners: ReturnType<typeof useSortable>["listeners"];
  }) => React.ReactNode;
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
    <div ref={setNodeRef} style={style}>
      {children({ attributes, listeners })}
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
  dragHandleProps,
  onRename,
  onDelete,
}: {
  item: DbItem;
  stats: ItemStats;
  category: string;
  subcategory: string;
  editable: boolean;
  isLast: boolean;
  dragHandleProps: {
    attributes: ReturnType<typeof useSortable>["attributes"];
    listeners: ReturnType<typeof useSortable>["listeners"];
  };
  onRename: () => void;
  onDelete: () => void;
}) {
  const detailsHref = `/inventory/${category}/${subcategory}/${item.id}`;

  return (
    <div className={!isLast ? "border-b border-gray-100 pb-4 mb-4" : ""}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-2 min-w-0 flex-[1.45]">
          {editable ? (
            <button
              type="button"
              {...dragHandleProps.attributes}
              {...dragHandleProps.listeners}
              className="mt-3 flex h-8 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-gray-300 transition hover:bg-gray-50 hover:text-red-500 active:cursor-grabbing"
              title="Drag to reorder"
              aria-label="Drag to reorder"
            >
              ⋮⋮
            </button>
          ) : null}

          <Link
            href={detailsHref}
            className="flex items-start gap-3 min-w-0 flex-1 group"
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

                {editable && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onRename();
                    }}
                    title="Rename"
                    className="text-red-500 text-[12px] shrink-0 transition-colors hover:text-black"
                  >
                    ✎
                  </button>
                )}

                {editable && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onDelete();
                    }}
                    title="Delete"
                    className="ml-auto text-red-500 shrink-0 transition-colors duration-200 hover:text-black sm:hidden"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>

              <div className="mt-2 sm:hidden">
                <div className="grid grid-cols-5 gap-x-2 gap-y-1 text-center">
                  <div className="text-[8px] font-semibold text-gray-500">
                    Total
                  </div>
                  <div className="text-[8px] font-semibold text-gray-500">
                    Available
                  </div>
                  <div className="text-[8px] font-semibold text-gray-500">
                    In Use
                  </div>
                  <div className="text-[8px] font-semibold text-gray-500">
                    Maintenance
                  </div>
                  <div className="text-[8px] font-semibold text-gray-500">
                    In KSA
                  </div>

                  <div className="rounded-md bg-gray-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                    {stats.total}
                  </div>
                  <div className="rounded-md bg-green-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                    {stats.available}
                  </div>
                  <div className="rounded-md bg-blue-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                    {stats.inUse}
                  </div>
                  <div className="rounded-md bg-yellow-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                    {stats.maintenance}
                  </div>
                  <div className="rounded-md bg-purple-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                    {stats.inKsa}
                  </div>
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
                  <StatPill label="In Use" value={stats.inUse} tone="blue" />
                  <StatPill
                    label="Maintenance"
                    value={stats.maintenance}
                    tone="yellow"
                  />
                  <StatPill label="In KSA" value={stats.inKsa} tone="purple" />
                </div>
              </div>
            </div>
          </Link>
        </div>

        <div className="flex items-center sm:items-start sm:justify-end gap-2 shrink-0 w-full sm:w-auto">
          {editable && (
            <div className="hidden sm:flex items-center gap-2">
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
      </div>
    </div>
  );
}

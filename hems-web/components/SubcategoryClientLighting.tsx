"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { Trash2, ChevronDown } from "lucide-react";

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
};

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
  const supabase = createClient();

  const fileName = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.webp`;

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
      { sensitivity: "base", numeric: true }
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
  return `hems:${category}:${subcategory}:fixtures:v3`;
}

function readFixturesCache(
  category: string,
  subcategory: string
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
  data: FixturesCache
) {
  if (typeof window === "undefined") return;

  try {
    sessionStorage.setItem(
      cacheKeyFor(category, subcategory),
      JSON.stringify(data)
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
        <div className="absolute right-0 top-0 z-30" data-list-photo-menu="true">
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
  const supabase = createClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listPhotoFileRef = useRef<HTMLInputElement | null>(null);
  const editable = canEditInventory();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [subId, setSubId] = useState<string | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [statsByItem, setStatsByItem] = useState<Record<string, ItemStats>>({});

  const [fixtureType, setFixtureType] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [qty, setQty] = useState<number>(1);
  const [photo, setPhoto] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState("");

  const [photoMenuOpen, setPhotoMenuOpen] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [imageSearch, setImageSearch] = useState("");
  const [imageResults, setImageResults] = useState<OnlineImage[]>([]);
  const [searchingImages, setSearchingImages] = useState(false);

  const [listPhotoMenuItemId, setListPhotoMenuItemId] = useState<string | null>(
    null
  );
  const [editingPhotoItemId, setEditingPhotoItemId] = useState<string | null>(
    null
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
    [editable, fixtureType, fixtureName, qty]
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
          !FIXTURE_TYPES.includes(it.fixture_type as FixtureType)
      )
    );
  }, [items]);

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
        JSON.stringify({ subId: sid, items: list, statsByItem: stats })
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
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const addMenu = document.getElementById("add-photo-menu");
      const listMenu = target.closest("[data-list-photo-menu='true']");

      if (addMenu && !addMenu.contains(target)) {
        setPhotoMenuOpen(false);
      }

      if (!listMenu) {
        setListPhotoMenuItemId(null);
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
        const text = await res.text();
        console.error("Image API error:", text);
        alert("Image search API error");
        return;
      }

      const data = await res.json();

      const results =
        Array.isArray(data)
          ? data
          : Array.isArray(data?.images_results)
          ? data.images_results
          : Array.isArray(data?.items)
          ? data.items
          : [];

      setImageResults(results);

      if (results.length === 0) {
        alert("No images found. Try another search keyword.");
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
      it.id === itemId ? { ...it, photo_url: imageUrl } : it
    );

    setItems(nextItems);

    writeFixturesCache(category, subcategory, {
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
      console.warn("Could not optimize online image, using thumbnail URL:", error);
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
      setSaveMsg("Item added");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item added" ? "" : prev));
      }, 1500);
    } catch (e: any) {
      setErr(e?.message || "Add failed");
    }
  }

  async function onRename(itemId: string, current: string) {
    if (!editable) return;

    const nextName = prompt("Rename fixture:", current);
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
        items.map((it) => (it.id === itemId ? { ...it, name: clean } : it))
      );

      setItems(nextItems);

      writeFixturesCache(category, subcategory, {
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

      writeFixturesCache(category, subcategory, {
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

  function renderFixtureRow(it: ItemRow, isLast: boolean) {
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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3 min-w-0 flex-[1.45]">
            <Link
              href={detailsHref}
              className="flex items-start gap-3 min-w-0 flex-1 group"
            >
              <ItemPhoto
                photo={it.photo_url}
                name={it.name}
                editable={editable}
                menuOpen={listPhotoMenuItemId === it.id}
                onToggleMenu={() =>
                  setListPhotoMenuItemId((prev) =>
                    prev === it.id ? null : it.id
                  )
                }
                onUploadPhoto={() => {
                  setListPhotoMenuItemId(null);
                  setEditingPhotoItemId(it.id);
                  listPhotoFileRef.current?.click();
                }}
                onSearchPhoto={() => {
                  setListPhotoMenuItemId(null);
                  void searchPhotoForItem(it);
                }}
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <h2
                    className="truncate text-[10px] sm:text-[11px] text-gray-900"
                    style={{ lineHeight: 1.1 }}
                  >
                    {renderFixtureName(it.name)}
                  </h2>

                  {editable && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onRename(it.id, it.name);
                      }}
                      className="text-red-500 text-[12px] shrink-0 hover:text-black"
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
                        onDelete(it.id);
                      }}
                      className="ml-auto text-red-500 shrink-0 hover:text-black sm:hidden"
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

                    <div className="rounded-md bg-gray-100 px-1 py-0.5 text-[9px] font-semibold">
                      {stats.total}
                    </div>
                    <div className="rounded-md bg-green-100 px-1 py-0.5 text-[9px] font-semibold">
                      {stats.available}
                    </div>
                    <div className="rounded-md bg-blue-100 px-1 py-0.5 text-[9px] font-semibold">
                      {stats.inUse}
                    </div>
                    <div className="rounded-md bg-yellow-100 px-1 py-0.5 text-[9px] font-semibold">
                      {stats.maintenance}
                    </div>
                    <div className="rounded-md bg-purple-100 px-1 py-0.5 text-[9px] font-semibold">
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
                    <StatPill
                      label="In Use"
                      value={stats.inUse}
                      tone="blue"
                    />
                    <StatPill
                      label="Maintenance"
                      value={stats.maintenance}
                      tone="yellow"
                    />
                    <StatPill
                      label="In KSA"
                      value={stats.inKsa}
                      tone="purple"
                    />
                  </div>
                </div>
              </div>
            </Link>
          </div>

          <div className="hidden sm:flex items-center gap-2 shrink-0">
            {editable && (
              <button
                onClick={() => onDelete(it.id)}
                className="px-2 py-1 rounded-full border border-gray-300 text-[9px] font-medium text-gray-700 bg-white hover:bg-red-50 hover:border-red-200 hover:text-red-700"
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-[1100px] mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
          Loading fixtures...
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="max-w-[1100px] mx-auto">
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
    <div className="max-w-[1100px] mx-auto space-y-3">
      {editable && (
  <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
    <div className="mb-4">
      <h1 className="text-[13px] font-semibold leading-tight text-gray-900">
        Add Fixtures
      </h1>
      <p className="mt-1 text-[10px] text-gray-500">
        Select type, brand, model, quantity and optional photo.
      </p>
    </div>

    <div className="grid grid-cols-1 gap-2 md:grid-cols-[210px_1fr_1fr_76px_116px_76px] md:items-center">
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
          if (!imageSearch) setImageSearch(`${e.target.value} ${model}`.trim());
        }}
        placeholder="Brand (e.g. Ayrton)"
        className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
      />

      <input
        value={model}
        onChange={(e) => {
          setModel(e.target.value);
          if (!imageSearch) setImageSearch(`${brand} ${e.target.value}`.trim());
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

      <input
        ref={listPhotoFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPickListItemPhoto}
      />

      <div id="add-photo-menu" className="relative">
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
              onClick={() => {
                setPhotoMenuOpen(false);
                setSearchPanelOpen(true);
                setImageSearch(fixtureSearchName);
                setTimeout(() => void searchOnlineImages(fixtureSearchName), 50);
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

    {saveMsg ? (
      <div className="mt-3 text-xs text-gray-500">{saveMsg}</div>
    ) : null}
  </div>
)}

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
            renderFixtureRow(it, index === group.items.length - 1)
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
            renderFixtureRow(it, index === uncategorizedItems.length - 1)
          )}
        </div>
      ) : null}
    </div>
  );
}
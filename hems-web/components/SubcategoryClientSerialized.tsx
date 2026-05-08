"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { Trash2, ChevronDown } from "lucide-react";

type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

type ItemRow = {
  id: string;
  name: string;
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

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function splitBrandModel(name: string) {
  const parts = name.split(" - ");
  const brand = (parts[0] || "").trim();
  const model = parts.slice(1).join(" - ").trim();

  return {
    brand,
    model,
  };
}

function sortItemsByBrand(items: ItemRow[]) {
  return [...items].sort((a, b) => {
    const aParts = splitBrandModel(a.name);
    const bParts = splitBrandModel(b.name);

    const brandCompare = aParts.brand.localeCompare(bParts.brand, undefined, {
      sensitivity: "base",
    });

    if (brandCompare !== 0) return brandCompare;

    return (aParts.model || a.name).localeCompare(bParts.model || b.name, undefined, {
      sensitivity: "base",
      numeric: true,
    });
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

  return {
    total: statuses.length,
    available,
    inUse,
    maintenance,
    inKsa,
  };
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
    <div className="flex h-14 w-14 min-w-[56px] items-center justify-center">
      {photo ? (
        <img
          src={photo}
          alt={name}
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
  const editable = canEditInventory();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [subId, setSubId] = useState<string | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [statsByItem, setStatsByItem] = useState<Record<string, ItemStats>>({});

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

  const fixtureName = useMemo(() => {
    const b = brand.trim();
    const m = model.trim();

    if (b && m) return `${b} - ${m}`;
    if (b) return b;
    return m;
  }, [brand, model]);

  const canAdd = useMemo(
    () => editable && fixtureName.trim().length > 0 && qty >= 1,
    [editable, fixtureName, qty]
  );

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

  async function load() {
    setLoading(true);
    setErr(null);

    try {
      const sid = await resolveSubcategoryId();
      setSubId(sid);

      const itemsRes = await supabase
        .from("items_with_unit_stats")
        .select(
          "id,name,photo_url,subcategory_id,total,available,in_use,maintenance,in_ksa"
        )
        .eq("subcategory_id", sid)
        .order("name");

      if (itemsRes.error) throw itemsRes.error;

      const list = sortItemsByBrand((itemsRes.data || []) as ItemRow[]);
      setItems(list);

      if (list.length === 0) {
        setStatsByItem({});
        return;
      }

      const ids = list.map((x) => x.id);

      const unitsRes = await supabase
        .from("units")
        .select("item_id,status")
        .in("item_id", ids);

      if (unitsRes.error) throw unitsRes.error;

      const by: Record<string, UnitStatus[]> = {};
      for (const itId of ids) by[itId] = [];

      for (const u of unitsRes.data || []) {
        const itemId = String((u as any).item_id || "");
        const status = String((u as any).status || "available") as UnitStatus;
        if (!by[itemId]) by[itemId] = [];
        by[itemId].push(status);
      }

      const stats: Record<string, ItemStats> = {};
      for (const itId of ids) {
        stats[itId] = countByStatus(by[itId] || []);
      }

      setStatsByItem(stats);
    } catch (e: any) {
      setErr(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, subcategory]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      const menu = document.getElementById("add-photo-menu");

      if (menu && !menu.contains(target)) {
        setPhotoMenuOpen(false);
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
      const dataUrl = await fileToDataUrl(f);
      setPhoto(dataUrl);
      setSaveMsg("Photo selected");
      setTimeout(() => setSaveMsg(""), 1500);
    } catch (e: any) {
      alert(e?.message || "Photo failed");
    } finally {
      e.target.value = "";
    }
  }

  async function searchOnlineImages() {
    const q = (imageSearch || fixtureName).trim();
    if (!q) {
      alert("Write brand/model first");
      return;
    }

    setSearchingImages(true);
    setImageResults([]);

    try {
      const res = await fetch(`/api/google-image?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setImageResults(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Image search error:", e);
      alert("Failed to search images");
    } finally {
      setSearchingImages(false);
    }
  }

  function selectOnlinePhoto(img: OnlineImage) {
    const imageUrl = img.original || img.image || img.thumbnail;
    if (!imageUrl) return;

    setPhoto(imageUrl);
    setSearchPanelOpen(false);
    setImageResults([]);
    setSaveMsg("Online photo selected");
    setTimeout(() => setSaveMsg(""), 1500);
  }

  async function onAdd() {
    if (!editable || !subId) return;

    const nm = fixtureName.trim();
    if (!nm) return;

    const q = Math.max(1, Number(qty) || 1);
    setErr(null);

    try {
      const insItem = await supabase
        .from("items")
        .insert({
          subcategory_id: subId,
          name: nm,
          photo_url: photo || null,
        })
        .select("id,name,photo_url,subcategory_id")
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

      setItems((prev) => sortItemsByBrand([...prev, newItem]));

setStatsByItem((prev) => ({
  ...prev,
  [newItem.id]: {
    total: q,
    available: q,
    inUse: 0,
    maintenance: 0,
    inKsa: 0,
  },
}));
    } catch (e: any) {
      setErr(e?.message || "Add failed");
    }
  }

  async function onRename(itemId: string, current: string) {
    if (!editable) return;

    const nextName = prompt("Rename fixture:", current);
    if (!nextName) return;

    try {
      const upd = await supabase
        .from("items")
        .update({ name: nextName.trim() })
        .eq("id", itemId);

      if (upd.error) throw upd.error;

      setSaveMsg("Item renamed");
      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item renamed" ? "" : prev));
      }, 1500);

      setItems((prev) =>
  sortItemsByBrand(
    prev.map((it) =>
      it.id === itemId ? { ...it, name: nextName.trim() } : it
    )
  )
);
    } catch (e: any) {
      alert(e?.message || "Rename failed");
    }
  }

  async function onDelete(itemId: string) {
    if (!editable) return;
    if (!confirm("Delete this fixture?")) return;

    try {
      const delUnits = await supabase.from("units").delete().eq("item_id", itemId);
      if (delUnits.error) throw delUnits.error;

      const delItem = await supabase.from("items").delete().eq("id", itemId);
      if (delItem.error) throw delItem.error;

      setSaveMsg("Item deleted");
      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item deleted" ? "" : prev));
      }, 1500);

      setItems((prev) => prev.filter((it) => it.id !== itemId));

setStatsByItem((prev) => {
  const next = { ...prev };
  delete next[itemId];
  return next;
});
    } catch (e: any) {
      alert(e?.message || "Delete failed");
    }
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
            onClick={load}
            className="mt-4 px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
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
              Add Fixtures
            </h1>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_96px_auto_auto] gap-3">
            <input
              value={brand}
              onChange={(e) => {
                setBrand(e.target.value);
                if (!imageSearch) {
                  setImageSearch(`${e.target.value} ${model}`.trim());
                }
              }}
              placeholder="Brand (e.g. Ayrton)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-black text-[12px] text-gray-900"
            />

            <input
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                if (!imageSearch) {
                  setImageSearch(`${brand} ${e.target.value}`.trim());
                }
              }}
              placeholder="Model (e.g. Cobra)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-black text-[12px] text-gray-900"
            />

            <input
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
              type="number"
              min={1}
              className="w-full md:w-24 border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-black text-[12px] text-gray-900"
            />

            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onPickPhoto}
            />

            <div id="add-photo-menu" className="relative">
              <button
                type="button"
                onClick={() => setPhotoMenuOpen((v) => !v)}
                className="flex w-full md:w-auto items-center justify-center gap-1 px-2 py-1.5 rounded-full border border-gray-300 text-[9px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
              >
                {photo ? "Photo ✔" : "Add photo"}
                <ChevronDown size={12} />
              </button>

              {photoMenuOpen ? (
                <div className="absolute right-0 z-50 mt-2 w-36 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
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
                      setImageSearch(fixtureName);
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
              className="w-full md:w-auto px-2 py-1.5 rounded-full border border-black text-[9px] font-medium text-white bg-black transition-all duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-40"
            >
              + Add
            </button>
          </div>

          {photo ? (
            <div className="mt-3 flex items-center gap-3">
              <img
                src={photo}
                alt="Selected"
                className="h-14 w-14 rounded-lg object-cover border border-gray-200"
              />
              <button
                type="button"
                onClick={() => setPhoto(null)}
                className="text-[10px] text-red-500 hover:text-black"
              >
                Remove photo
              </button>
            </div>
          ) : null}

          {searchPanelOpen ? (
            <div className="mt-4 rounded-2xl border border-gray-200 p-3">
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
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-[12px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
                />

                <button
                  type="button"
                  onClick={() => void searchOnlineImages()}
                  disabled={searchingImages}
                  className="rounded-lg bg-black px-3 py-2 text-[11px] font-medium text-white disabled:opacity-40"
                >
                  {searchingImages ? "Searching..." : "Search"}
                </button>
              </div>

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
                        onClick={() => selectOnlinePhoto(img)}
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

          {saveMsg ? (
            <div className="mt-3 text-xs text-gray-500">{saveMsg}</div>
          ) : null}
        </div>
      )}

      {items.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
          No fixtures yet.
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          {items.map((it, index) => {
            const stats = statsByItem[it.id] || {
              total: 0,
              available: 0,
              inUse: 0,
              maintenance: 0,
              inKsa: 0,
            };

            const isLast = index === items.length - 1;
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
                      <ItemPhoto photo={it.photo_url} name={it.name} />

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <h2
                            className="truncate text-[10px] sm:text-[11px] font-semibold text-gray-900 group-hover:text-black"
                            style={{ lineHeight: 1.1 }}
                          >
                            {it.name}
                          </h2>

                          {editable && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onRename(it.id, it.name);
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
                                onDelete(it.id);
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
                        className="px-2 py-1 rounded-full border border-gray-300 text-[9px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
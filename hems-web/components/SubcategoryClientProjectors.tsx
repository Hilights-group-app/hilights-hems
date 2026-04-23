"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { Trash2 } from "lucide-react";

type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

type DbItem = {
  id: string;
  subcategory_id: string;
  name: string;
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

function toStatus(v: any): UnitStatus {
  if (v === "available" || v === "in_use" || v === "maintenance" || v === "in_ksa") return v;
  return "available";
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
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
    <span className={`px-2 py-1 rounded-lg text-[8px] font-semibold whitespace-nowrap ${cls}`}>
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

  const [resolvedSubcategoryId, setResolvedSubcategoryId] = useState<string | null>(
    subcategoryId ?? null
  );

  const [items, setItems] = useState<DbItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [qty, setQty] = useState<number>(1);
  const [photo, setPhoto] = useState<string | null>(null);
  const addPhotoRef = useRef<HTMLInputElement | null>(null);

  const [stats, setStats] = useState<Record<string, ItemStats>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState("");

  const canAdd = useMemo(() => {
    return (
      editable &&
      !!resolvedSubcategoryId &&
      name.trim().length > 0 &&
      Number(qty) >= 1 &&
      !submitting
    );
  }, [editable, resolvedSubcategoryId, name, qty, submitting]);

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
      .select("id, subcategory_id, name, photo_url, created_at")
      .eq("subcategory_id", subId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("loadItems error", error);
      setItems([]);
      setStats({});
      setErrorMsg(error.message || "Failed to load items.");
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

    const { data: udata, error: uerr } = await supabase
      .from("units")
      .select("item_id,status")
      .in("item_id", ids);

    if (uerr) {
      console.error("loadUnits stats error", uerr);
      setStats({});
      setErrorMsg(uerr.message || "Failed to load stats.");
      setLoading(false);
      return;
    }

    const map: Record<string, ItemStats> = {};
    for (const itId of ids) {
      map[itId] = { total: 0, available: 0, inUse: 0, maintenance: 0, inKsa: 0 };
    }

    for (const u of udata ?? []) {
      const itemId = String((u as any).item_id || "");
      const status = toStatus((u as any).status);

      if (!map[itemId]) {
        map[itemId] = { total: 0, available: 0, inUse: 0, maintenance: 0, inKsa: 0 };
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

        const finalSubId = subcategoryId ?? (await resolveSubcategoryIdFromDb());
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

  async function onPickAddPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editable) return;

    const f = e.target.files?.[0];
    if (!f) return;

    try {
      const dataUrl = await fileToDataUrl(f);
      setPhoto(dataUrl);
    } catch (error: any) {
      alert(error?.message || "Failed to read photo");
    } finally {
      e.target.value = "";
    }
  }

  async function addItem() {
    if (!editable) return;

    setErrorMsg(null);

    if (!resolvedSubcategoryId) {
      setErrorMsg("Subcategory is not ready yet.");
      return;
    }

    const clean = name.trim();
    if (!clean) {
      setErrorMsg("Please enter projector name.");
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
        })
        .select("id, subcategory_id, name, photo_url, created_at")
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
        setErrorMsg(uerr.message || "Item added, but failed to create units rows.");
      }

      setName("");
      setQty(1);
      setPhoto(null);
      setSaveMsg("Item added");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item added" ? "" : prev));
      }, 1500);

      await loadItems(resolvedSubcategoryId);
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

    const { error } = await supabase.from("items").update({ name: clean }).eq("id", itemId);

    if (error) {
      console.error("rename item error", error);
      alert("Rename failed");
      return;
    }

    if (resolvedSubcategoryId) {
      setSaveMsg("Item renamed");
      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item renamed" ? "" : prev));
      }, 1500);

      await loadItems(resolvedSubcategoryId);
    }
  }

  async function deleteItem(itemId: string) {
    if (!editable) return;
    if (!confirm("Delete this item?")) return;

    const { error: uerr } = await supabase.from("units").delete().eq("item_id", itemId);
    if (uerr) console.warn("delete units warn", uerr);

    const { error } = await supabase.from("items").delete().eq("id", itemId);

    if (error) {
      console.error("delete item error", error);
      alert("Delete failed");
      return;
    }

    if (resolvedSubcategoryId) {
      setSaveMsg("Item deleted");
      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item deleted" ? "" : prev));
      }, 1500);

      await loadItems(resolvedSubcategoryId);
    }
  }

  if (loading) {
    return (
      <div className="max-w-[1100px] mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
          Loading projectors...
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
              Add Projector Item
            </h1>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_96px_auto_auto] gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Projector name (e.g. Barco F80 4K12)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-black text-[12px] text-gray-900"
            />

            <input
              value={String(qty)}
              onChange={(e) => setQty(Number(e.target.value))}
              inputMode="numeric"
              className="w-full md:w-24 border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-black text-[12px] text-gray-900"
            />

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
              className="w-full md:w-auto px-2 py-1.5 rounded-full border border-gray-300 text-[9px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
            >
              {photo ? "Photo ✔" : "Upload Photo"}
            </button>

            <button
              type="button"
              onClick={addItem}
              disabled={!canAdd}
              className="w-full md:w-auto px-2 py-1.5 rounded-full border border-black text-[9px] font-medium text-white bg-black transition-all duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-40"
              title={!resolvedSubcategoryId ? "subcategoryId not resolved" : ""}
            >
              {submitting ? "Adding..." : "+ Add"}
            </button>
          </div>

          {(errorMsg || saveMsg) && (
            <div className={`mt-3 text-xs ${errorMsg ? "text-red-600" : "text-gray-500"}`}>
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
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          {items.map((it, index) => {
            const st = stats[it.id] ?? {
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
                      <ProjectorPhoto photo={it.photo_url} name={it.name} />

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
                                renameItem(it.id);
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
                                deleteItem(it.id);
                              }}
                              title="Delete"
                              className="ml-auto text-red-500 shrink-0 transition-colors duration-200 hover:text-black sm:hidden"
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>

                        {/* Mobile stats */}
                        <div className="mt-2 sm:hidden">
                          <div className="grid grid-cols-5 gap-x-2 gap-y-1 text-center">
                            <div className="text-[8px] font-semibold text-gray-500">Total</div>
                            <div className="text-[8px] font-semibold text-gray-500">Available</div>
                            <div className="text-[8px] font-semibold text-gray-500">In Use</div>
                            <div className="text-[8px] font-semibold text-gray-500">Maintenance</div>
                            <div className="text-[8px] font-semibold text-gray-500">In KSA</div>

                            <div className="rounded-md bg-gray-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                              {st.total}
                            </div>
                            <div className="rounded-md bg-green-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                              {st.available}
                            </div>
                            <div className="rounded-md bg-blue-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                              {st.inUse}
                            </div>
                            <div className="rounded-md bg-yellow-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                              {st.maintenance}
                            </div>
                            <div className="rounded-md bg-purple-100 px-1 py-0.5 text-[9px] font-semibold text-black whitespace-nowrap">
                              {st.inKsa}
                            </div>
                          </div>
                        </div>

                        {/* Desktop stats */}
                        <div className="mt-1 hidden sm:block">
                          <div className="flex flex-wrap gap-2">
                            <StatPill label="Total Qty" value={st.total} />
                            <StatPill label="Available Qty" value={st.available} tone="green" />
                            <StatPill label="In Use" value={st.inUse} tone="blue" />
                            <StatPill label="Maintenance" value={st.maintenance} tone="yellow" />
                            <StatPill label="In KSA" value={st.inKsa} tone="purple" />
                          </div>
                        </div>
                      </div>
                    </Link>
                  </div>

                  <div className="flex items-center sm:items-start sm:justify-end gap-2 shrink-0 w-full sm:w-auto">
                    {editable && (
                      <>
                        <div className="hidden sm:flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => deleteItem(it.id)}
                            className="px-2 py-1 rounded-full border border-gray-300 text-[9px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
                          >
                            Delete
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
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
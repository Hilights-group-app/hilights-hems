"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { ChainHoistRowsBlock } from "@/app/equipment-report/update/chain-hoist/[itemId]/page";

type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

type DbItem = {
  id: string;
  subcategory_id: string;
  name: string;
  photo_url: string | null;
  created_at?: string;
};

type DbUnit = {
  id: string;
  item_id: string;
  unit_no: number | null;
  serial: string | null;
  status: string | null;
  notes: string | null;
  cert_date: string | null;
  expiry_date: string | null;
  damage_photos: string[] | null;
};

function toStatus(v: any): UnitStatus {
  if (v === "available" || v === "in_use" || v === "maintenance" || v === "in_ksa") return v;
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

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function countByStatus(units: DbUnit[]) {
  const total = units.length;

  const available = units.filter(
    (u) => toStatus(u.status) === "available" && !isExpired(u.expiry_date)
  ).length;

  const inUse = units.filter((u) => toStatus(u.status) === "in_use").length;
  const maintenance = units.filter((u) => toStatus(u.status) === "maintenance").length;
  const inKsa = units.filter((u) => toStatus(u.status) === "in_ksa").length;
  const expired = units.filter((u) => isExpired(u.expiry_date)).length;

  return { total, available, inUse, maintenance, inKsa, expired };
}

export default function ItemEditClientChainHoistUnits({
  category,
  subcategory,
  itemId,
}: {
  category: string;
  subcategory: string;
  itemId: string;
}) {
  const supabase = createClient();
  const itemPhotoRef = useRef<HTMLInputElement | null>(null);
  const editable = canEditInventory();

  const backHref = useMemo(() => `/inventory/${category}/${subcategory}`, [category, subcategory]);

  const [item, setItem] = useState<DbItem | null>(null);
  const [units, setUnits] = useState<DbUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveMsg, setSaveMsg] = useState("");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);

      const { data: itemRow, error: itemErr } = await supabase
        .from("items")
        .select("id, subcategory_id, name, photo_url, created_at")
        .eq("id", itemId)
        .single();

      if (cancelled) return;

      if (itemErr || !itemRow) {
        console.error("load chainhoist item error", itemErr);
        setItem(null);
        setUnits([]);
        setLoading(false);
        return;
      }

      setItem(itemRow as DbItem);

      const { data: urows, error: uerr } = await supabase
        .from("units")
        .select("id, item_id, unit_no, serial, status, notes, cert_date, expiry_date, damage_photos")
        .eq("item_id", itemId)
        .order("unit_no", { ascending: true });

      if (cancelled) return;

      if (uerr) {
        console.error("load chainhoist units error", uerr);
        setUnits([]);
        setLoading(false);
        return;
      }

      setUnits((urows ?? []) as DbUnit[]);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [itemId, supabase]);

  async function updateItem(patch: Partial<DbItem>) {
    if (!editable || !item) return;

    const { error } = await supabase.from("items").update(patch).eq("id", item.id);
    if (error) {
      console.error("update item error", error);
      alert("Failed to update item");
      return;
    }

    setItem({ ...item, ...patch });
  }

  async function onPickItemPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editable) return;

    const f = e.target.files?.[0];
    if (!f) return;

    try {
      const dataUrl = await fileToDataUrl(f);
      await updateItem({ photo_url: dataUrl });
      setSaveMsg("Photo updated");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Photo updated" ? "" : prev));
      }, 1500);
    } finally {
      e.target.value = "";
    }
  }

  async function onEditName() {
    if (!editable || !item) return;

    const next = prompt("Item name:", item.name);
    if (!next) return;

    const clean = next.trim();
    if (!clean) return;

    await updateItem({ name: clean });
    setSaveMsg("Item renamed");

    setTimeout(() => {
      setSaveMsg((prev) => (prev === "Item renamed" ? "" : prev));
    }, 1500);
  }

  const counts = useMemo(() => countByStatus(units), [units]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="max-w-[1100px] mx-auto space-y-3">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
            Loading chain hoist report...
          </div>
        </div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="max-w-[1100px] mx-auto space-y-3">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
            <div className="font-semibold">Item not found</div>
            <div className="mt-4">
              <Link
                href={backHref}
                className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
              >
                Back
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-3">
      <div className="max-w-[1100px] mx-auto space-y-3">
        <input
          ref={itemPhotoRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickItemPhoto}
        />

        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          <div className="flex justify-between items-start gap-4">
            <div className="flex items-start gap-4 min-w-0">
              <div
                style={{
                  width: "120px",
                  minWidth: "120px",
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "center",
                  paddingTop: "18px",
                }}
              >
                <div
                  style={{
                    width: "96px",
                    height: "96px",
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {item.photo_url ? (
                    <img
                      src={item.photo_url}
                      alt={item.name}
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        borderRadius: "8px",
                      }}
                    />
                  ) : (
                    <div style={{ fontSize: "10px", color: "#9ca3af" }}>No photo</div>
                  )}

                  {editable && (
                    <button
                      type="button"
                      onClick={() => itemPhotoRef.current?.click()}
                      title="Edit photo"
                      style={{
                        position: "absolute",
                        top: "0px",
                        right: "0px",
                        color: "#ef4444",
                        fontSize: "16px",
                        cursor: "pointer",
                        zIndex: 20,
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "#000000")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
                    >
                      ✎
                    </button>
                  )}
                </div>
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0 mt-2">
                  <h1
                    style={{
                      fontSize: "25px",
                      fontWeight: 700,
                      color: "#111827",
                      lineHeight: 1.1,
                    }}
                    className="truncate"
                  >
                    {item.name}
                  </h1>

                  {editable && (
                    <button
                      type="button"
                      onClick={onEditName}
                      title="Edit name"
                      style={{ color: "#ef4444", fontSize: "16px", cursor: "pointer" }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "#000000")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
                    >
                      ✎
                    </button>
                  )}
                </div>

                <div
                  style={{
                    borderTop: "1px solid #e5e7eb",
                    paddingTop: "16px",
                    marginTop: "16px",
                  }}
                >
                  <div className="flex flex-wrap gap-2 text-[8px] font-semibold">
                    <span className="px-2 py-1 rounded-lg bg-gray-100 text-black">
                      Total Qty: {counts.total}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-green-100 text-black">
                      Available Qty: {counts.available}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-blue-100 text-black">
                      In Use: {counts.inUse}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-yellow-100 text-black">
                      Maintenance: {counts.maintenance}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-purple-100 text-black">
                      In KSA: {counts.inKsa}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-red-100 text-black">
                      Expired: {counts.expired}
                    </span>
                  </div>
                </div>

                {saveMsg ? (
                  <div className="mt-3 text-xs text-gray-500">{saveMsg}</div>
                ) : null}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Link
                href={backHref}
                className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
              >
                ← Back
              </Link>
            </div>
          </div>
        </div>

        <ChainHoistRowsBlock
  itemId={itemId}
  editable={editable}
  allowAdd={editable}
  allowDelete={editable}
  allowUpload={editable}
/>
      </div>
    </div>
  );
}
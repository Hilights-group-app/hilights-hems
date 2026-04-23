"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { SerializedRowsBlock } from "@/app/equipment-report/update/[subcategory]/[itemId]/page";

type DbItem = {
  id: string;
  name: string;
  photo_url: string | null;
};

type Stats = {
  total: number;
  available: number;
  inUse: number;
  maintenance: number;
  inKsa: number;
};

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

export default function ItemEditClientSerializedUnits({
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

  const backHref = useMemo(
    () => `/inventory/${category}/${subcategory}`,
    [category, subcategory]
  );

  const [item, setItem] = useState<DbItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveMsg, setSaveMsg] = useState("");
  const [stats, setStats] = useState<Stats>({
    total: 0,
    available: 0,
    inUse: 0,
    maintenance: 0,
    inKsa: 0,
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);

      const { data, error } = await supabase
        .from("items")
        .select("id, name, photo_url")
        .eq("id", itemId)
        .single();

      if (cancelled) return;

      if (error || !data) {
        console.error("load serialized item error", error);
        setItem(null);
        setLoading(false);
        return;
      }

      setItem(data as DbItem);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [itemId, supabase]);

  async function updateItem(patch: Partial<Pick<DbItem, "name" | "photo_url">>) {
    if (!editable || !item) return;

    const { data, error } = await supabase
      .from("items")
      .update(patch)
      .eq("id", item.id)
      .select("id, name, photo_url")
      .single();

    if (error) {
      console.error("update item error", error);
      alert("Failed to update item");
      return;
    }

    setItem(data as DbItem);
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
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

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="max-w-[1100px] mx-auto space-y-3">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
            Loading...
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
            <div className="text-sm text-gray-600 mt-1">
              This itemId is not found in Supabase table: <b>items</b>.
            </div>

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
          onChange={onPickPhoto}
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

                  {editable ? (
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
                  ) : null}
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

                  {editable ? (
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
                  ) : null}
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
                      Total Qty: {stats.total}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-green-100 text-black">
                      Available Qty: {stats.available}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-blue-100 text-black">
                      In Use: {stats.inUse}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-yellow-100 text-black">
                      Maintenance: {stats.maintenance}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-purple-100 text-black">
                      In KSA: {stats.inKsa}
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

        <SerializedRowsBlock
          itemId={itemId}
          editable={editable}
          onStatsChange={setStats}
        />
      </div>
    </div>
  );
}
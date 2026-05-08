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
  const [photoMenuOpen, setPhotoMenuOpen] = useState(false);
  const photoMenuRef = useRef<HTMLDivElement | null>(null);

  const backHref = useMemo(() => {
    const safeCategory = encodeURIComponent(category);
    const safeSubcategory = encodeURIComponent(subcategory);
    return `/inventory/${safeCategory}/${safeSubcategory}`;
  }, [category, subcategory]);

  const [item, setItem] = useState<DbItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveMsg, setSaveMsg] = useState("");

  const [imageSearch, setImageSearch] = useState("");
  const [imageResults, setImageResults] = useState<OnlineImage[]>([]);
  const [searchingImages, setSearchingImages] = useState(false);

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

  useEffect(() => {
  function handleClickOutside(e: MouseEvent) {
    if (
      photoMenuRef.current &&
      !photoMenuRef.current.contains(e.target as Node)
    ) {
      setPhotoMenuOpen(false);
    }
  }

  document.addEventListener("mousedown", handleClickOutside);

  return () => {
    document.removeEventListener("mousedown", handleClickOutside);
  };
}, []);

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

  async function searchGoogleImages(customQuery?: string) {
    const finalQuery = (customQuery || imageSearch || item?.name || "").trim();
    if (!finalQuery) return;

    setImageSearch(finalQuery);
    setSearchingImages(true);
    setImageResults([]);

    try {
      const res = await fetch(
        `/api/google-image?q=${encodeURIComponent(finalQuery)}`
      );

      const data = await res.json();

      setImageResults(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Image search error:", e);
      alert("Failed to search images");
    } finally {
      setSearchingImages(false);
    }
  }

  async function selectOnlineImage(img: OnlineImage) {
    const imageUrl = img.original || img.image || img.thumbnail;

    if (!imageUrl) return;

    await updateItem({ photo_url: imageUrl });

    setItem((prev) =>
      prev
        ? {
            ...prev,
            photo_url: imageUrl,
          }
        : prev
    );

    setSaveMsg("Photo updated from online search");

    setTimeout(() => {
      setSaveMsg((prev) =>
        prev === "Photo updated from online search" ? "" : prev
      );
    }, 2000);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 px-[2px] py-2 sm:p-3">
        <div className="w-full max-w-none sm:max-w-[1100px] mx-auto space-y-3 px-0">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-gray-900">
            Loading...
          </div>
        </div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="min-h-screen bg-gray-50 px-[2px] py-2 sm:p-3">
        <div className="w-full max-w-none sm:max-w-[1100px] mx-auto space-y-3 px-0">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-gray-900">
            <div className="font-semibold">Item not found</div>
            <div className="text-sm text-gray-600 mt-1">
              This itemId is not found in Supabase table: <b>items</b>.
            </div>

            <div className="mt-4">
              <Link
                href={backHref}
                className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white hover:bg-red-50 hover:border-red-200 hover:text-red-700"
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
    <div className="min-h-screen bg-gray-50 px-[2px] py-2 sm:p-3">
      <div className="w-full max-w-none sm:max-w-[1100px] mx-auto space-y-3 px-0">
        <input
          ref={itemPhotoRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickPhoto}
        />

        <div className="bg-white border border-gray-200 rounded-2xl p-2 sm:p-6">
          <div className="flex justify-between items-center gap-2 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
              <div className="w-[58px] min-w-[58px] sm:w-[120px] sm:min-w-[120px] flex items-center justify-center">
                <div className="relative w-[48px] h-[48px] sm:w-[96px] sm:h-[96px] flex items-center justify-center">
                  {item.photo_url ? (
                    <img
                      src={item.photo_url}
                      alt={item.name}
                      className="w-full h-full object-cover rounded-lg"
                    />
                  ) : (
                    <div className="text-[8px] sm:text-[10px] text-gray-400">
                      No photo
                    </div>
                  )}

                  {editable ? (
  <div
  ref={photoMenuRef}
  className="absolute right-0 top-0 z-30"
>
    <button
      type="button"
      onClick={() =>
        setPhotoMenuOpen((prev) => !prev)
      }
      className="text-[10px] sm:text-[16px] text-red-500 hover:text-black"
      title="Photo options"
    >
      ✎
    </button>

    {photoMenuOpen ? (
      <div className="absolute right-0 mt-1 w-36 rounded-xl border border-gray-200 bg-white shadow-xl overflow-hidden">
        <button
          type="button"
          onClick={() => {
  setPhotoMenuOpen(false);
  void searchGoogleImages(item.name);
}}
          className="block w-full px-3 py-2 text-left text-[11px] text-gray-700 hover:bg-gray-100"
        >
          Upload photo
        </button>

        <button
          type="button"
          onClick={() => {
            setPhotoMenuOpen(false);
            void searchGoogleImages(item.name);
          }}
          className="block w-full px-3 py-2 text-left text-[11px] text-gray-700 hover:bg-gray-100"
        >
          Search photo
        </button>
      </div>
    ) : null}
  </div>
) : null}
                </div>
              </div>

              <div className="min-w-0 flex-1 flex flex-col justify-center">
                <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                  <h1 className="text-[14px] sm:text-[25px] font-bold text-gray-900 leading-tight mt-0 mb-1.5 sm:mb-4 truncate">
                    {item.name}
                  </h1>

                  {editable ? (
                    <button
                      type="button"
                      onClick={onEditName}
                      title="Edit name"
                      className="text-[10px] sm:text-[16px] text-red-500 hover:text-black shrink-0"
                    >
                      ✎
                    </button>
                  ) : null}
                </div>

                <div className="border-t border-gray-200 pt-1.5 sm:pt-4">
                  <div className="flex flex-nowrap items-center gap-[2px] sm:gap-2 text-[5px] sm:text-[8px] font-semibold overflow-hidden">
                    <span className="whitespace-nowrap px-[3px] sm:px-2 py-[2px] sm:py-1 rounded-md sm:rounded-lg bg-gray-100 text-black">
                      Total Qty: {stats.total}
                    </span>
                    <span className="whitespace-nowrap px-[3px] sm:px-2 py-[2px] sm:py-1 rounded-md sm:rounded-lg bg-green-100 text-black">
                      Available Qty: {stats.available}
                    </span>
                    <span className="whitespace-nowrap px-[3px] sm:px-2 py-[2px] sm:py-1 rounded-md sm:rounded-lg bg-blue-100 text-black">
                      In Use: {stats.inUse}
                    </span>
                    <span className="whitespace-nowrap px-[3px] sm:px-2 py-[2px] sm:py-1 rounded-md sm:rounded-lg bg-yellow-100 text-black">
                      Maintenance: {stats.maintenance}
                    </span>
                    <span className="whitespace-nowrap px-[3px] sm:px-2 py-[2px] sm:py-1 rounded-md sm:rounded-lg bg-purple-100 text-black">
                      In KSA: {stats.inKsa}
                    </span>
                  </div>
                </div>

                {saveMsg ? (
                  <div className="mt-2 text-[10px] sm:text-xs text-gray-500">
                    {saveMsg}
                  </div>
                ) : null}
              </div>
            </div>

            <Link
              href={backHref}
              className="px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-full border border-gray-300 text-[9px] sm:text-[10px] font-medium text-gray-700 bg-white hover:bg-red-50 hover:border-red-200 hover:text-red-700 shrink-0"
            >
              ← Back
            </Link>
          </div>
        </div>

        {imageResults.length > 0 ? (
  <div className="bg-white border border-gray-200 rounded-2xl p-3 sm:p-5">
    <div className="flex items-center justify-between mb-3">
      <div className="font-semibold text-sm text-gray-900">
        Select photo
      </div>

      <button
        type="button"
        onClick={() => setImageResults([])}
        className="text-xs text-red-500 hover:text-black"
      >
        Close
      </button>
    </div>

    <div className="mb-3 flex gap-2">
  <input
    value={imageSearch}
    onChange={(e) => setImageSearch(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void searchGoogleImages();
      }
    }}
    placeholder="Search another..."
    className="flex-1 rounded-xl border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-900"
  />

  <button
    type="button"
    onClick={() => void searchGoogleImages()}
    disabled={searchingImages}
    className="rounded-xl bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
  >
    {searchingImages ? "..." : "Search"}
  </button>
</div>
    <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 gap-2">
      {imageResults.map((img, index) => {
        const imageUrl = img.original || img.image || img.thumbnail;
        if (!imageUrl) return null;

        return (
          <button
            key={`${imageUrl}-${index}`}
            type="button"
            onClick={() => void selectOnlineImage(img)}
            className="overflow-hidden rounded-xl border border-gray-200 hover:border-blue-400"
          >
            <img
              src={img.thumbnail || imageUrl}
              alt={img.title || "Online result"}
              className="w-full aspect-square object-cover"
            />
          </button>
        );
      })}
    </div>
  </div>
) : null}
        <SerializedRowsBlock
          itemId={itemId}
          editable={editable}
          onStatsChange={setStats}
        />
      </div>
    </div>
  );
}
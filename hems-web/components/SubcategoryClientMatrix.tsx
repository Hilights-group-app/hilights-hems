"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { Trash2, ChevronDown } from "lucide-react";
import EquipmentListMatrixQuantityAction from "@/components/EquipmentListMatrixQuantityAction";

type MatrixItemRow = {
  id: string;
  category_id: string;
  subcategory_id: string;
  name: string;
  photo_data: string | null;
  item_type: "unit" | "cable" | "rack" | null;
  block_name?: string | null;
  total_qty: number | null;
  in_use_qty: number | null;
  maintenance_qty: number | null;
  in_ksa_qty: number | null;
};

type CableRow = {
  id: string;
  item_id: string;
  cable_length: string;
  total_qty: number | null;
  in_use_qty: number | null;
  maintenance_qty: number | null;
  in_ksa_qty: number | null;
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
  categoryId: string | null;
  subcategoryId: string | null;
  items: MatrixItemRow[];
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

  const filePath = `matrix/thumbs/${fileName}`;

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

async function optimizeOnlinePhoto(imageUrl: string): Promise<string> {
  const res = await fetch("/api/optimize-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ imageUrl }),
  });

  if (!res.ok) {
    throw new Error("Optimization failed");
  }

  const data = await res.json();
  if (!data?.url) {
    throw new Error("Optimization returned no URL");
  }

  return data.url as string;
}

function clampQty(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function statsFromItem(item: MatrixItemRow): ItemStats {
  const total = clampQty(item.total_qty ?? 0);
  const inUse = clampQty(item.in_use_qty ?? 0);
  const maintenance = clampQty(item.maintenance_qty ?? 0);
  const inKsa = clampQty(item.in_ksa_qty ?? 0);
  const available = Math.max(0, total - inUse - maintenance - inKsa);

  return { total, available, inUse, maintenance, inKsa };
}

function cableStats(row: CableRow): ItemStats {
  const total = clampQty(row.total_qty ?? 0);
  const inUse = clampQty(row.in_use_qty ?? 0);
  const maintenance = clampQty(row.maintenance_qty ?? 0);
  const inKsa = clampQty(row.in_ksa_qty ?? 0);
  const available = Math.max(0, total - inUse - maintenance - inKsa);

  return { total, available, inUse, maintenance, inKsa };
}

function cableLengthNumber(value: string) {
  const match = String(value || "").match(/[\d.]+/);
  return match ? Number(match[0]) : 0;
}

function sortCableRows(rows: CableRow[]) {
  return [...rows].sort(
    (a, b) =>
      cableLengthNumber(b.cable_length) - cableLengthNumber(a.cable_length),
  );
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

function renderItemName(
  name: string,
  itemType?: "unit" | "cable" | "rack" | null,
) {
  if (itemType === "cable" || itemType === "rack") {
    return <span className="font-bold">{name}</span>;
  }

  const parts = splitBrandModel(name);

  return (
    <>
      <span className="font-bold">{parts.brand}</span>
      {parts.model ? <span>{` ${parts.model}`}</span> : null}
    </>
  );
}

function fallbackBlockName(item: MatrixItemRow) {
  if (item.item_type === "cable") return "Cables";
  if (item.item_type === "rack") return "Racks";
  return splitBrandModel(item.name).brand || "Other";
}

function itemBlockName(item: MatrixItemRow) {
  return (item.block_name || "").trim() || fallbackBlockName(item);
}

function sortItemsByBrand(items: MatrixItemRow[]) {
  return [...items].sort((a, b) => {
    const aBlock = itemBlockName(a);
    const bBlock = itemBlockName(b);

    const blockCompare = aBlock.localeCompare(bBlock, undefined, {
      sensitivity: "base",
      numeric: true,
    });

    if (blockCompare !== 0) return blockCompare;

    return a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
      numeric: true,
    });
  });
}

function groupItemsByBrand(
  items: MatrixItemRow[],
  blockOrder: string[] = [],
  itemOrderByBlock: Record<string, string[]> = {},
) {
  const map = new Map<string, MatrixItemRow[]>();

  for (const item of items) {
    const brand = itemBlockName(item);
    const existingKey = Array.from(map.keys()).find(
      (key) => key.toLowerCase() === brand.toLowerCase(),
    );
    const key = existingKey || brand;
    map.set(key, [...(map.get(key) || []), item]);
  }

  const blockIndex = (brand: string) => {
    const idx = blockOrder.findIndex(
      (name) => name.toLowerCase() === brand.toLowerCase(),
    );
    return idx === -1 ? 999999 : idx;
  };

  const sortedBlocks = Array.from(map.keys()).sort((a, b) => {
    const ai = blockIndex(a);
    const bi = blockIndex(b);
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b, undefined, {
      sensitivity: "base",
      numeric: true,
    });
  });

  return sortedBlocks.map((brand) => {
    const order = itemOrderByBlock[brand] || [];
    const itemIndex = (id: string) => {
      const idx = order.indexOf(id);
      return idx === -1 ? 999999 : idx;
    };

    const groupItems = [...(map.get(brand) || [])].sort((a, b) => {
      const ai = itemIndex(a.id);
      const bi = itemIndex(b.id);
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name, undefined, {
        sensitivity: "base",
        numeric: true,
      });
    });

    return { brand, items: groupItems };
  });
}

function cacheKeyFor(categoryId: string | null, subcategoryId: string | null) {
  return `hems:${categoryId || "no-cat"}:${subcategoryId || "no-sub"}:matrix-v4`;
}

function readItemsCache(
  categoryId: string | null,
  subcategoryId: string | null,
): ItemsCache | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = sessionStorage.getItem(cacheKeyFor(categoryId, subcategoryId));
    return raw ? (JSON.parse(raw) as ItemsCache) : null;
  } catch {
    return null;
  }
}

function writeItemsCache(
  categoryId: string | null,
  subcategoryId: string | null,
  data: ItemsCache,
) {
  if (typeof window === "undefined") return;

  try {
    sessionStorage.setItem(
      cacheKeyFor(categoryId, subcategoryId),
      JSON.stringify(data),
    );
  } catch {}
}

function matrixOrderKey(
  categoryId: string | null,
  subcategoryId: string | null,
) {
  return `hems:${categoryId || "no-cat"}:${subcategoryId || "no-sub"}:matrix-manual-order-v1`;
}

type MatrixManualOrder = {
  blockOrder: string[];
  itemOrderByBlock: Record<string, string[]>;
};

function readMatrixManualOrder(
  categoryId: string | null,
  subcategoryId: string | null,
): MatrixManualOrder {
  if (typeof window === "undefined") {
    return { blockOrder: [], itemOrderByBlock: {} };
  }

  try {
    const raw = localStorage.getItem(matrixOrderKey(categoryId, subcategoryId));
    if (!raw) return { blockOrder: [], itemOrderByBlock: {} };
    const parsed = JSON.parse(raw) as Partial<MatrixManualOrder>;
    return {
      blockOrder: Array.isArray(parsed.blockOrder) ? parsed.blockOrder : [],
      itemOrderByBlock:
        parsed.itemOrderByBlock && typeof parsed.itemOrderByBlock === "object"
          ? parsed.itemOrderByBlock
          : {},
    };
  } catch {
    return { blockOrder: [], itemOrderByBlock: {} };
  }
}

function writeMatrixManualOrder(
  categoryId: string | null,
  subcategoryId: string | null,
  data: MatrixManualOrder,
) {
  if (typeof window === "undefined") return;

  try {
    localStorage.setItem(
      matrixOrderKey(categoryId, subcategoryId),
      JSON.stringify(data),
    );
  } catch {}
}

function moveArrayItem<T>(list: T[], fromIndex: number, toIndex: number) {
  const next = [...list];
  const [removed] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, removed);
  return next;
}

function StatPill({
  label,
  value,
  tone = "gray",
  onClick,
}: {
  label: string;
  value: string | number;
  tone?: "gray" | "green" | "blue" | "yellow" | "purple";
  onClick?: () => void;
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

  const className = `px-2 py-1 rounded-lg text-[8px] font-semibold whitespace-nowrap ${cls} ${
    onClick ? "hover:ring-1 hover:ring-red-300" : ""
  }`;

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {label}: {value}
      </button>
    );
  }

  return (
    <span className={className}>
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
  big = false,
}: {
  photo?: string | null;
  name: string;
  editable?: boolean;
  menuOpen?: boolean;
  onToggleMenu?: () => void;
  onUploadPhoto?: () => void;
  onSearchPhoto?: () => void;
  big?: boolean;
}) {
  return (
    <div
      className={`relative flex items-center justify-center ${
        big ? "h-14 w-14 min-w-[56px]" : "h-14 w-14 min-w-[56px]"
      }`}
    >
      {photo ? (
        <img
          src={photo}
          alt={name}
          loading="lazy"
          decoding="async"
          className="h-full w-full rounded-xl object-cover bg-white"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-xl bg-white text-[10px] text-gray-400">
          No photo
        </div>
      )}

      {editable ? (
        <div
          className="absolute right-0 top-0 z-30"
          data-list-photo-menu="true"
        >
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

export default function SubcategoryClientMatrix({
  category,
  subcategory,
  categoryId: initialCategoryId = null,
  subcategoryId: initialSubcategoryId = null,
}: {
  category: string;
  subcategory: string;
  categoryId?: string | null;
  subcategoryId?: string | null;
}) {
  const supabase = createClient();
  const editable = canEditInventory();

  const fileRef = useRef<HTMLInputElement | null>(null);
  const listPhotoFileRef = useRef<HTMLInputElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [categoryId, setCategoryId] = useState<string | null>(
    initialCategoryId,
  );
  const [subcategoryId, setSubcategoryId] = useState<string | null>(
    initialSubcategoryId,
  );

  const [items, setItems] = useState<MatrixItemRow[]>([]);
  const [statsByItem, setStatsByItem] = useState<Record<string, ItemStats>>({});
  const [cableRowsByItem, setCableRowsByItem] = useState<
    Record<string, CableRow[]>
  >({});

  const [itemType, setItemType] = useState<"unit" | "cable" | "rack">("unit");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [cableModel, setCableModel] = useState("");
  const [blockName, setBlockName] = useState("");
  const [newBlockName, setNewBlockName] = useState("");
  const [qty, setQty] = useState<number>(1);

  const [photo, setPhoto] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState("");

  const [photoMenuOpen, setPhotoMenuOpen] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [imageSearch, setImageSearch] = useState("");
  const [imageResults, setImageResults] = useState<OnlineImage[]>([]);
  const [searchingImages, setSearchingImages] = useState(false);

  const [listPhotoMenuItemId, setListPhotoMenuItemId] = useState<string | null>(
    null,
  );
  const [editingPhotoItemId, setEditingPhotoItemId] = useState<string | null>(
    null,
  );

  const [blockOrder, setBlockOrder] = useState<string[]>([]);
  const [itemOrderByBlock, setItemOrderByBlock] = useState<
    Record<string, string[]>
  >({});
  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [dragItemBlock, setDragItemBlock] = useState<string | null>(null);
  const [dragBlockName, setDragBlockName] = useState<string | null>(null);
  const [sidebarTarget, setSidebarTarget] = useState<HTMLElement | null>(null);
  const [desktopSidebarActive, setDesktopSidebarActive] = useState(false);
  const [selectedBlockName, setSelectedBlockName] = useState<string | null>(
    null,
  );
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedCableRow, setSelectedCableRow] = useState<{
    itemId: string;
    rowId: string;
  } | null>(null);
  const [selectedBrand, setSelectedBrand] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [selectedBlockDraft, setSelectedBlockDraft] = useState("");
  const [mobileAddOpen, setMobileAddOpen] = useState(false);

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedItemId) ?? null,
    [items, selectedItemId],
  );

  const selectedCableRowInfo = useMemo(() => {
    if (!selectedCableRow) return null;
    const item = items.find((current) => current.id === selectedCableRow.itemId);
    const row = (cableRowsByItem[selectedCableRow.itemId] || []).find(
      (current) => current.id === selectedCableRow.rowId,
    );
    return item && row ? { item, row } : null;
  }, [items, cableRowsByItem, selectedCableRow]);

  useEffect(() => {
    if (!selectedItem) return;
    const parsed = splitBrandModel(selectedItem.name);
    setSelectedBrand(parsed.brand);
    setSelectedModel(parsed.model);
    setSelectedName(selectedItem.name);
    setSelectedBlockDraft(itemBlockName(selectedItem));
    // Drafts are initialized only when a different item is selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemId]);

  const itemName = useMemo(() => {
    if (itemType === "cable" || itemType === "rack") return cableModel.trim();

    const b = brand.trim();
    const m = model.trim();

    if (b && m) return `${b} - ${m}`;
    if (b) return b;
    return m;
  }, [brand, model, cableModel, itemType]);

  const itemSearchName = useMemo(() => {
    if (itemType === "cable" || itemType === "rack") return cableModel.trim();

    const b = brand.trim();
    const m = model.trim();

    if (b && m) return `${b} ${m}`;
    if (b) return b;
    return m;
  }, [brand, model, cableModel, itemType]);

  const canAdd = useMemo(() => {
    if (itemType === "cable") {
      return editable && itemName.trim().length > 0;
    }

    if (itemType === "rack") {
      return editable && itemName.trim().length > 0 && qty >= 1;
    }

    return editable && itemName.trim().length > 0 && qty >= 1;
  }, [editable, itemName, qty, itemType]);

  const brandGroups = useMemo(() => {
    return groupItemsByBrand(items, blockOrder, itemOrderByBlock);
  }, [items, blockOrder, itemOrderByBlock]);

  const blockOptions = useMemo(() => {
    const names = items
      .map((item) => itemBlockName(item))
      .filter((name) => name.trim().length > 0);

    return Array.from(new Set(names)).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
    );
  }, [items]);

  const finalBlockName = useMemo(() => {
    return newBlockName.trim() || blockName.trim();
  }, [newBlockName, blockName]);

  useEffect(() => {
    const order = readMatrixManualOrder(categoryId, subcategoryId);
    setBlockOrder(order.blockOrder);
    setItemOrderByBlock(order.itemOrderByBlock);
  }, [categoryId, subcategoryId]);

  function saveManualOrder(
    nextBlockOrder = blockOrder,
    nextItemOrderByBlock = itemOrderByBlock,
  ) {
    setBlockOrder(nextBlockOrder);
    setItemOrderByBlock(nextItemOrderByBlock);
    writeMatrixManualOrder(categoryId, subcategoryId, {
      blockOrder: nextBlockOrder,
      itemOrderByBlock: nextItemOrderByBlock,
    });
  }

  function ensureBlockOrder(list: MatrixItemRow[]) {
    const names = Array.from(new Set(list.map((item) => itemBlockName(item))));
    setBlockOrder((prev) => {
      const next = [...prev.filter((name) => names.includes(name))];
      for (const name of names) {
        if (!next.some((x) => x.toLowerCase() === name.toLowerCase())) {
          next.push(name);
        }
      }
      writeMatrixManualOrder(categoryId, subcategoryId, {
        blockOrder: next,
        itemOrderByBlock,
      });
      return next;
    });
  }

  async function renameBlock(oldName: string, requestedName?: string) {
    if (!editable) return;

    const nextName = requestedName ?? prompt("Rename block:", oldName);
    if (!nextName) return;

    const clean = nextName.trim();
    if (!clean || clean.toLowerCase() === oldName.toLowerCase()) return;

    const blockItems = items.filter(
      (item) => itemBlockName(item).toLowerCase() === oldName.toLowerCase(),
    );
    const ids = blockItems.map((item) => item.id);
    if (ids.length === 0) return;

    const { error } = await supabase
      .from("matrix_models")
      .update({ block_name: clean })
      .in("id", ids);

    if (error) {
      alert(error.message);
      return;
    }

    const nextItems = items.map((item) =>
      ids.includes(item.id) ? { ...item, block_name: clean } : item,
    );

    const nextBlockOrder = blockOrder.map((name) =>
      name.toLowerCase() === oldName.toLowerCase() ? clean : name,
    );

    const nextItemOrderByBlock = { ...itemOrderByBlock };
    if (nextItemOrderByBlock[oldName]) {
      nextItemOrderByBlock[clean] = nextItemOrderByBlock[oldName];
      delete nextItemOrderByBlock[oldName];
    }

    setItems(sortItemsByBrand(nextItems));
    saveManualOrder(nextBlockOrder, nextItemOrderByBlock);
    setSelectedBlockName(clean);
    setSaveMsg("Block renamed");
    setTimeout(() => setSaveMsg(""), 1500);
  }

  function onBlockDragStart(name: string) {
    if (!editable) return;
    setDragBlockName(name);
    setDragItemId(null);
    setDragItemBlock(null);
  }

  function onItemDragStart(itemId: string, sourceBlock: string) {
    if (!editable) return;
    setDragItemId(itemId);
    setDragItemBlock(sourceBlock);
    setDragBlockName(null);
  }

  function dropBlockOnBlock(targetBlock: string) {
    if (!editable || !dragBlockName || dragBlockName === targetBlock) return;

    const currentBlocks = brandGroups.map((group) => group.brand);
    const base = blockOrder.length > 0 ? blockOrder : currentBlocks;
    const normalized = [...base];

    for (const block of currentBlocks) {
      if (!normalized.includes(block)) normalized.push(block);
    }

    const from = normalized.findIndex(
      (name) => name.toLowerCase() === dragBlockName.toLowerCase(),
    );
    const to = normalized.findIndex(
      (name) => name.toLowerCase() === targetBlock.toLowerCase(),
    );

    if (from === -1 || to === -1) return;

    const nextBlockOrder = moveArrayItem(normalized, from, to);
    saveManualOrder(nextBlockOrder, itemOrderByBlock);
    setDragBlockName(null);
  }

  async function dropItemOnBlock(targetBlock: string) {
    if (!editable || !dragItemId) return;

    const sourceBlock = dragItemBlock || "";
    const dragged = items.find((item) => item.id === dragItemId);
    if (!dragged) return;

    const nextItems = items.map((item) =>
      item.id === dragItemId ? { ...item, block_name: targetBlock } : item,
    );

    const nextOrder = { ...itemOrderByBlock };
    if (sourceBlock) {
      nextOrder[sourceBlock] = (nextOrder[sourceBlock] || []).filter(
        (id) => id !== dragItemId,
      );
    }
    nextOrder[targetBlock] = [
      ...(nextOrder[targetBlock] || []).filter((id) => id !== dragItemId),
      dragItemId,
    ];

    setItems(sortItemsByBrand(nextItems));
    saveManualOrder(blockOrder, nextOrder);

    const { error } = await supabase
      .from("matrix_models")
      .update({ block_name: targetBlock })
      .eq("id", dragItemId);

    if (error) {
      alert(error.message);
      await refreshData();
    }

    setDragItemId(null);
    setDragItemBlock(null);
  }

  async function dropItemOnItem(targetItemId: string, targetBlock: string) {
    if (!editable || !dragItemId || dragItemId === targetItemId) return;

    const sourceBlock = dragItemBlock || "";
    const targetItems = items
      .filter(
        (item) =>
          itemBlockName(item).toLowerCase() === targetBlock.toLowerCase(),
      )
      .map((item) => item.id)
      .filter((id) => id !== dragItemId);

    const oldOrder = (itemOrderByBlock[targetBlock] || targetItems).filter(
      (id) => id !== dragItemId,
    );

    const targetIndex = Math.max(0, oldOrder.indexOf(targetItemId));
    const nextTargetOrder = [...oldOrder];
    nextTargetOrder.splice(targetIndex, 0, dragItemId);

    const nextOrder = { ...itemOrderByBlock, [targetBlock]: nextTargetOrder };
    if (
      sourceBlock &&
      sourceBlock.toLowerCase() !== targetBlock.toLowerCase()
    ) {
      nextOrder[sourceBlock] = (nextOrder[sourceBlock] || []).filter(
        (id) => id !== dragItemId,
      );
    }

    const nextItems = items.map((item) =>
      item.id === dragItemId ? { ...item, block_name: targetBlock } : item,
    );

    setItems(sortItemsByBrand(nextItems));
    saveManualOrder(blockOrder, nextOrder);

    const { error } = await supabase
      .from("matrix_models")
      .update({ block_name: targetBlock })
      .eq("id", dragItemId);

    if (error) {
      alert(error.message);
      await refreshData();
    }

    setDragItemId(null);
    setDragItemBlock(null);
  }

  async function resolveIds() {
    if (initialCategoryId && initialSubcategoryId) {
      return {
        categoryId: initialCategoryId,
        subcategoryId: initialSubcategoryId,
      };
    }

    const catRes = await supabase
      .from("categories")
      .select("id")
      .eq("slug", category)
      .single();

    if (catRes.error || !catRes.data?.id) {
      throw new Error("Category not found");
    }

    const subRes = await supabase
      .from("subcategories")
      .select("id")
      .eq("category_id", catRes.data.id)
      .eq("slug", subcategory)
      .single();

    if (subRes.error || !subRes.data?.id) {
      throw new Error("Subcategory not found");
    }

    return {
      categoryId: catRes.data.id as string,
      subcategoryId: subRes.data.id as string,
    };
  }

  async function refreshData() {
    try {
      const ids = await resolveIds();

      setCategoryId(ids.categoryId);
      setSubcategoryId(ids.subcategoryId);

      const res = await supabase
        .from("matrix_models")
        .select("*")
        .eq("subcategory_id", ids.subcategoryId);

      if (res.error) throw res.error;

      const list = sortItemsByBrand((res.data || []) as MatrixItemRow[]);

      const stats: Record<string, ItemStats> = {};

      for (const item of list) {
        stats[item.id] = statsFromItem(item);
      }

      const cableItems = list.filter(
        (x) => x.item_type === "cable" || x.item_type === "rack",
      );

      if (cableItems.length > 0) {
        const rowsRes = await supabase
          .from("matrix_rows")
          .select("*")
          .in(
            "item_id",
            cableItems.map((x) => x.id),
          );

        if (rowsRes.error) throw rowsRes.error;

        const grouped: Record<string, CableRow[]> = {};

        for (const row of (rowsRes.data || []) as CableRow[]) {
          if (!grouped[row.item_id]) grouped[row.item_id] = [];
          grouped[row.item_id].push(row);
        }

        const sortedGrouped: Record<string, CableRow[]> = {};
        for (const key of Object.keys(grouped)) {
          sortedGrouped[key] = sortCableRows(grouped[key]);
        }

        setCableRowsByItem(sortedGrouped);
      } else {
        setCableRowsByItem({});
      }

      setItems(list);
      setStatsByItem(stats);
      ensureBlockOrder(list);

      writeItemsCache(ids.categoryId, ids.subcategoryId, {
        categoryId: ids.categoryId,
        subcategoryId: ids.subcategoryId,
        items: list,
        statsByItem: stats,
      });
    } catch (e: any) {
      setErr(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function load(force = false) {
    setErr(null);

    if (
      !force &&
      typeof window !== "undefined" &&
      categoryId &&
      subcategoryId
    ) {
      const cached = readItemsCache(categoryId, subcategoryId);

      if (cached) {
        setItems(cached.items || []);
        setStatsByItem(cached.statsByItem || {});
        setLoading(false);

        void refreshData();
        return;
      }
    }

    setLoading(items.length === 0);
    await refreshData();
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
    const media = window.matchMedia("(min-width: 1280px)");
    const sync = () => setDesktopSidebarActive(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      const addMenu = document.getElementById("add-photo-menu");
      const listMenu = target.closest("[data-list-photo-menu='true']");
      const keepsSelection = target.closest(
        "[data-matrix-select='true'], [data-matrix-tools='true'], [data-mobile-matrix-tools='true']",
      );

      if (addMenu && !addMenu.contains(target)) {
        setPhotoMenuOpen(false);
      }

      if (!listMenu) {
        setListPhotoMenuItemId(null);
      }

      if (!keepsSelection) {
        window.setTimeout(() => {
          setSelectedBlockName(null);
          setSelectedItemId(null);
          setSelectedCableRow(null);
        }, 0);
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
      const data = await res.json();

      const results = Array.isArray(data)
        ? data
        : Array.isArray(data?.images_results)
          ? data.images_results
          : [];

      setImageResults(results);
    } catch (e) {
      console.error(e);
      alert("Failed to search images");
    } finally {
      setSearchingImages(false);
    }
  }

  async function updateItemPhoto(itemId: string, imageUrl: string) {
    const { error } = await supabase
      .from("matrix_models")
      .update({ photo_data: imageUrl })
      .eq("id", itemId);

    if (error) {
      alert("Failed to update photo");
      return;
    }

    const nextItems = items.map((it) =>
      it.id === itemId ? { ...it, photo_data: imageUrl } : it,
    );

    setItems(nextItems);
    setSaveMsg("Photo updated");
    setTimeout(() => setSaveMsg(""), 1500);
  }

  async function onPickListItemPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editingPhotoItemId) return;

    const f = e.target.files?.[0];
    if (!f) return;

    try {
      const imageUrl = await uploadPhoto(f);
      await updateItemPhoto(editingPhotoItemId, imageUrl);
    } catch (e: any) {
      alert(e?.message || "Upload failed");
    } finally {
      e.target.value = "";
      setEditingPhotoItemId(null);
    }
  }

  async function searchPhotoForItem(item: MatrixItemRow) {
    setEditingPhotoItemId(item.id);

    const searchName =
      item.item_type === "cable" || item.item_type === "rack"
        ? item.name
        : `${splitBrandModel(item.name).brand} ${
            splitBrandModel(item.name).model
          }`.trim();

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
      finalImageUrl = await optimizeOnlinePhoto(sourceUrl);
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
    setSaveMsg("Photo selected");
    setTimeout(() => setSaveMsg(""), 1500);
  }

  async function onAdd() {
    if (!editable || !categoryId || !subcategoryId) return;

    const nm = itemName.trim();
    if (!nm) return;

    const q = itemType === "cable" ? 0 : Math.max(1, Number(qty) || 1);
    const cleanBlockName =
      finalBlockName ||
      (itemType === "cable"
        ? "Cables"
        : itemType === "rack"
          ? "Racks"
          : splitBrandModel(nm).brand || "Other");

    setErr(null);

    try {
      const ins = await supabase
        .from("matrix_models")
        .insert({
          category_id: categoryId,
          subcategory_id: subcategoryId,
          name: nm,
          item_type: itemType,
          block_name: cleanBlockName,
          photo_data: photo || null,
          total_qty: q,
          in_use_qty: 0,
          maintenance_qty: 0,
          in_ksa_qty: 0,
        })
        .select("*")
        .single();

      if (ins.error) throw ins.error;

      const newItem = ins.data as MatrixItemRow;
      const nextItems = sortItemsByBrand([...items, newItem]);

      const nextStats = {
        ...statsByItem,
        [newItem.id]: statsFromItem(newItem),
      };

      setItems(nextItems);
      setStatsByItem(nextStats);

      if (newItem.item_type === "cable" || newItem.item_type === "rack") {
        setCableRowsByItem((prev) => ({
          ...prev,
          [newItem.id]: [],
        }));
      }

      writeItemsCache(categoryId, subcategoryId, {
        categoryId,
        subcategoryId,
        items: nextItems,
        statsByItem: nextStats,
      });

      setBrand("");
      setModel("");
      setCableModel("");
      setBlockName(cleanBlockName);
      setNewBlockName("");
      setQty(1);
      setPhoto(null);
      setImageSearch("");
      setImageResults([]);
      setSearchPanelOpen(false);
      setPhotoMenuOpen(false);
      setMobileAddOpen(false);
      setSaveMsg("Item added");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item added" ? "" : prev));
      }, 1500);
    } catch (e: any) {
      setErr(e?.message || "Add failed");
    }
  }

  async function addCableLength(itemId: string) {
    if (!editable) return;

    const parentItem = items.find((x) => x.id === itemId);
    const isRack = parentItem?.item_type === "rack";

    const length = prompt(
      isRack
        ? "Rack item name example: MA Lighting 8 PORT NODE"
        : "Cable length example: 5m / 10m / 20m",
    );
    if (!length?.trim()) return;

    const totalValue = prompt("Total Qty");
    const total = clampQty(totalValue);

    const { data, error } = await supabase
      .from("matrix_rows")
      .insert({
        item_id: itemId,
        model_id: itemId,
        cable_length: length.trim(),
        total_qty: total,
        in_use_qty: 0,
        maintenance_qty: 0,
        in_ksa_qty: 0,
      })
      .select("*")
      .single();

    if (error) {
      alert(error.message);
      return;
    }

    setCableRowsByItem((prev) => ({
      ...prev,
      [itemId]: sortCableRows([...(prev[itemId] || []), data as CableRow]),
    }));
  }

  async function updateItemQty(
    itemId: string,
    field: "total_qty" | "in_use_qty" | "maintenance_qty" | "in_ksa_qty",
    current: number | null,
  ) {
    if (!editable) return;

    const nextValue = prompt("Edit quantity:", String(current ?? 0));
    if (nextValue === null) return;

    const clean = clampQty(nextValue);

    const { error } = await supabase
      .from("matrix_models")
      .update({ [field]: clean })
      .eq("id", itemId);

    if (error) {
      alert(error.message);
      return;
    }

    const nextItems = items.map((item) =>
      item.id === itemId ? { ...item, [field]: clean } : item,
    );

    const updatedItem = nextItems.find((item) => item.id === itemId);
    const nextStats = {
      ...statsByItem,
      ...(updatedItem ? { [itemId]: statsFromItem(updatedItem) } : {}),
    };

    setItems(nextItems);
    setStatsByItem(nextStats);

    if (categoryId && subcategoryId) {
      writeItemsCache(categoryId, subcategoryId, {
        categoryId,
        subcategoryId,
        items: nextItems,
        statsByItem: nextStats,
      });
    }
  }

  async function onRename(
    itemId: string,
    current: string,
    requestedName?: string,
  ) {
    if (!editable) return;

    const nextName = requestedName ?? prompt("Rename item:", current);
    if (!nextName) return;

    const clean = nextName.trim();
    if (!clean) return;

    try {
      const upd = await supabase
        .from("matrix_models")
        .update({ name: clean })
        .eq("id", itemId);

      if (upd.error) throw upd.error;

      const nextItems = sortItemsByBrand(
        items.map((it) => (it.id === itemId ? { ...it, name: clean } : it)),
      );

      setItems(nextItems);

      if (categoryId && subcategoryId) {
        writeItemsCache(categoryId, subcategoryId, {
          categoryId,
          subcategoryId,
          items: nextItems,
          statsByItem,
        });
      }

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

    const clean =
      selectedItem.item_type === "unit"
        ? [selectedBrand.trim(), selectedModel.trim()]
            .filter(Boolean)
            .join(" - ")
        : selectedName.trim();

    if (!clean || clean === selectedItem.name) return;
    await onRename(selectedItem.id, selectedItem.name, clean);
  }

  async function updateItemDirect(
    itemId: string,
    patch: Partial<
      Pick<
        MatrixItemRow,
        | "block_name"
        | "total_qty"
        | "in_use_qty"
        | "maintenance_qty"
        | "in_ksa_qty"
      >
    >,
  ) {
    if (!editable) return;

    const { error } = await supabase
      .from("matrix_models")
      .update(patch)
      .eq("id", itemId);

    if (error) {
      alert(error.message);
      return;
    }

    const nextItems = sortItemsByBrand(
      items.map((item) =>
        item.id === itemId ? { ...item, ...patch } : item,
      ),
    );
    const updatedItem = nextItems.find((item) => item.id === itemId);
    const nextStats = {
      ...statsByItem,
      ...(updatedItem ? { [itemId]: statsFromItem(updatedItem) } : {}),
    };

    setItems(nextItems);
    setStatsByItem(nextStats);

    if (categoryId && subcategoryId) {
      writeItemsCache(categoryId, subcategoryId, {
        categoryId,
        subcategoryId,
        items: nextItems,
        statsByItem: nextStats,
      });
    }
  }

  async function updateCableRowDirect(
    itemId: string,
    rowId: string,
    patch: Partial<
      Pick<
        CableRow,
        | "cable_length"
        | "total_qty"
        | "in_use_qty"
        | "maintenance_qty"
        | "in_ksa_qty"
      >
    >,
  ) {
    if (!editable) return;

    const { error } = await supabase
      .from("matrix_rows")
      .update(patch)
      .eq("id", rowId);

    if (error) {
      alert(error.message);
      return;
    }

    setCableRowsByItem((prev) => ({
      ...prev,
      [itemId]: sortCableRows(
        (prev[itemId] || []).map((row) =>
          row.id === rowId ? { ...row, ...patch } : row,
        ),
      ),
    }));
  }

  async function deleteCableRow(itemId: string, rowId: string) {
    if (!editable || !confirm("Delete this row?")) return;

    const { error } = await supabase
      .from("matrix_rows")
      .delete()
      .eq("id", rowId);

    if (error) {
      alert(error.message);
      return;
    }

    setCableRowsByItem((prev) => ({
      ...prev,
      [itemId]: (prev[itemId] || []).filter((row) => row.id !== rowId),
    }));
    setSelectedCableRow(null);
  }

  async function onDelete(itemId: string) {
    if (!editable) return;
    if (!confirm("Delete this item?")) return;

    try {
      const del = await supabase
        .from("matrix_models")
        .delete()
        .eq("id", itemId);

      if (del.error) throw del.error;

      const nextItems = items.filter((it) => it.id !== itemId);
      const nextStats = { ...statsByItem };
      delete nextStats[itemId];

      const nextCableRows = { ...cableRowsByItem };
      delete nextCableRows[itemId];

      setItems(nextItems);
      setStatsByItem(nextStats);
      setCableRowsByItem(nextCableRows);
      setSelectedItemId((current) => (current === itemId ? null : current));

      if (categoryId && subcategoryId) {
        writeItemsCache(categoryId, subcategoryId, {
          categoryId,
          subcategoryId,
          items: nextItems,
          statsByItem: nextStats,
        });
      }

      setSaveMsg("Item deleted");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Item deleted" ? "" : prev));
      }, 1500);
    } catch (e: any) {
      alert(e?.message || "Delete failed");
    }
  }

  const selectedBlockPanel = selectedBlockName ? (
    <div
      data-matrix-tools="true"
      className="mb-4 rounded-2xl border-2 border-black bg-white p-3 shadow-sm"
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
        Selected Block
      </div>
      <input
        key={selectedBlockName}
        defaultValue={selectedBlockName}
        disabled={!editable}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={(event) =>
          void renameBlock(selectedBlockName, event.currentTarget.value)
        }
        className="mt-2 h-9 w-full rounded-xl border border-gray-300 bg-white px-3 text-[10px] font-semibold text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
        placeholder="Block name"
      />
    </div>
  ) : null;

  const selectedItemPanel = selectedItem ? (
    <div
      key={selectedItem.id}
      data-matrix-tools="true"
      className="mb-4 rounded-2xl border-2 border-black bg-white p-3 shadow-sm"
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
        Selected {selectedItem.item_type || "Item"}
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2">
        {selectedItem.item_type !== "cable" &&
        selectedItem.item_type !== "rack" ? (
          <>
            <input
              value={selectedBrand}
              onChange={(event) => setSelectedBrand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              onBlur={() => void saveSelectedItemName()}
              disabled={!editable}
              placeholder="Brand"
              className="h-9 w-full rounded-xl border border-gray-300 bg-white px-3 text-[10px] font-semibold text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
            />
            <input
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              onBlur={() => void saveSelectedItemName()}
              disabled={!editable}
              placeholder="Model"
              className="h-9 w-full rounded-xl border border-gray-300 bg-white px-3 text-[10px] text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
            />
          </>
        ) : (
          <input
            value={selectedName}
            onChange={(event) => setSelectedName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={() => void saveSelectedItemName()}
            disabled={!editable}
            placeholder={
              selectedItem.item_type === "rack" ? "Rack name" : "Cable model"
            }
            className="h-9 w-full rounded-xl border border-gray-300 bg-white px-3 text-[10px] font-semibold text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
          />
        )}

        <input
          value={selectedBlockDraft}
          onChange={(event) => setSelectedBlockDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={(event) => {
            const clean = event.currentTarget.value.trim();
            if (clean && clean !== itemBlockName(selectedItem)) {
              void updateItemDirect(selectedItem.id, { block_name: clean });
            }
          }}
          disabled={!editable}
          placeholder="Block name"
          className="h-9 w-full rounded-xl border border-gray-300 bg-white px-3 text-[10px] text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
        />

        {selectedItem.item_type !== "cable" ? (
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["Total", "total_qty"],
                ["In Use", "in_use_qty"],
                ["Maintenance", "maintenance_qty"],
                ["In KSA", "in_ksa_qty"],
              ] as const
            ).map(([label, field]) => (
              <label key={field} className="text-[8px] font-semibold text-gray-500">
                {label}
                <input
                  type="number"
                  min={0}
                  defaultValue={selectedItem[field] ?? 0}
                  disabled={!editable}
                  onBlur={(event) =>
                    void updateItemDirect(selectedItem.id, {
                      [field]: clampQty(event.currentTarget.value),
                    })
                  }
                  className="mt-1 h-8 w-full rounded-lg border border-gray-300 px-2 text-[9px] text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
                />
              </label>
            ))}
          </div>
        ) : null}
      </div>

      {editable ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => {
              setEditingPhotoItemId(selectedItem.id);
              listPhotoFileRef.current?.click();
            }}
            className="rounded-xl border border-gray-300 bg-white px-2 py-2.5 text-[10px] font-medium text-gray-700 hover:bg-gray-50"
          >
            Upload Photo
          </button>
          <button
            type="button"
            onClick={() => void searchPhotoForItem(selectedItem)}
            className="rounded-xl border border-gray-300 bg-white px-2 py-2.5 text-[10px] font-medium text-gray-700 hover:bg-gray-50"
          >
            Search Photo
          </button>

          {selectedItem.item_type === "cable" ||
          selectedItem.item_type === "rack" ? (
            <button
              type="button"
              onClick={() => void addCableLength(selectedItem.id)}
              className="col-span-2 rounded-xl bg-black px-3 py-2.5 text-[10px] font-medium text-white hover:opacity-90"
            >
              + Add {selectedItem.item_type === "rack" ? "Rack Item" : "Cable Length"}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => void onDelete(selectedItem.id)}
            className="col-span-2 flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[10px] font-medium text-red-700 hover:bg-red-100"
          >
            <Trash2 size={13} /> Delete Item
          </button>
        </div>
      ) : null}
    </div>
  ) : null;

  const selectedCableRowPanel = selectedCableRowInfo ? (
    <div
      key={selectedCableRowInfo.row.id}
      data-matrix-tools="true"
      className="mb-4 rounded-2xl border-2 border-black bg-white p-3 shadow-sm"
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
        Selected {selectedCableRowInfo.item.item_type === "rack" ? "Rack Item" : "Cable Length"}
      </div>
      <div className="mt-1 truncate text-[9px] font-semibold text-gray-700">
        {selectedCableRowInfo.item.name}
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2">
        <input
          defaultValue={selectedCableRowInfo.row.cable_length}
          disabled={!editable}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={(event) => {
            const clean = event.currentTarget.value.trim();
            if (clean && clean !== selectedCableRowInfo.row.cable_length) {
              void updateCableRowDirect(
                selectedCableRowInfo.item.id,
                selectedCableRowInfo.row.id,
                { cable_length: clean },
              );
            }
          }}
          className="h-9 w-full rounded-xl border border-gray-300 bg-white px-3 text-[10px] font-semibold text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
        />

        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["Total", "total_qty"],
              ["In Use", "in_use_qty"],
              ["Maintenance", "maintenance_qty"],
              ["In KSA", "in_ksa_qty"],
            ] as const
          ).map(([label, field]) => (
            <label key={field} className="text-[8px] font-semibold text-gray-500">
              {label}
              <input
                type="number"
                min={0}
                defaultValue={selectedCableRowInfo.row[field] ?? 0}
                disabled={!editable}
                onBlur={(event) =>
                  void updateCableRowDirect(
                    selectedCableRowInfo.item.id,
                    selectedCableRowInfo.row.id,
                    { [field]: clampQty(event.currentTarget.value) },
                  )
                }
                className="mt-1 h-8 w-full rounded-lg border border-gray-300 px-2 text-[9px] text-gray-900 outline-none focus:border-black disabled:bg-gray-50"
              />
            </label>
          ))}
        </div>
      </div>

      {editable ? (
        <div className="mt-3 grid grid-cols-1 gap-2">
          <button
            type="button"
            onClick={() =>
              void deleteCableRow(
                selectedCableRowInfo.item.id,
                selectedCableRowInfo.row.id,
              )
            }
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[10px] font-medium text-red-700 hover:bg-red-100"
          >
            <Trash2 size={13} /> Delete Row
          </button>
        </div>
      ) : null}
    </div>
  ) : null;

  async function closeMobileMatrixTools() {
    await saveSelectedItemName();

    if (
      selectedItem &&
      selectedBlockDraft.trim() &&
      selectedBlockDraft.trim() !== itemBlockName(selectedItem)
    ) {
      await updateItemDirect(selectedItem.id, {
        block_name: selectedBlockDraft.trim(),
      });
    }

    setSelectedBlockName(null);
    setSelectedItemId(null);
    setSelectedCableRow(null);
    setSearchPanelOpen(false);
    setEditingPhotoItemId(null);
    setImageResults([]);
  }

  function closeMobileAddItems() {
    setMobileAddOpen(false);
    setPhotoMenuOpen(false);
    setSearchPanelOpen(false);
    setEditingPhotoItemId(null);
    setImageResults([]);
  }

  function renderItemRow(it: MatrixItemRow, isLast: boolean) {
    const stats = statsByItem[it.id] || statsFromItem(it);

    if (it.item_type === "rack") {
      return (
        <div
          key={it.id}
          data-matrix-select="true"
          onClick={() => {
            setSelectedItemId(it.id);
            setSelectedBlockName(null);
            setSelectedCableRow(null);
          }}
          draggable={editable}
          onDragStart={() => onItemDragStart(it.id, itemBlockName(it))}
          onDragOver={(e) => editable && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void dropItemOnItem(it.id, itemBlockName(it));
          }}
          className={`relative rounded-xl p-2 transition ${
            selectedItemId === it.id ? "ring-2 ring-black" : ""
          } ${!isLast ? "border-b border-gray-100 pb-6 mb-6" : ""} ${
            editable ? "cursor-grab active:cursor-grabbing" : ""
          }`}
        >
          {editable ? (
            <button
              type="button"
              aria-label={`Open ${it.name} tools`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setSelectedItemId(it.id);
                setSelectedBlockName(null);
                setSelectedCableRow(null);
              }}
              className="absolute right-2 top-2 z-30 flex h-[26px] w-[26px] items-center justify-center rounded-full border border-gray-300 bg-white text-base font-bold text-gray-700 shadow-sm sm:hidden"
            >
              ⋮
            </button>
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3 min-w-0 flex-[1.45]">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                <ItemPhoto
                  photo={it.photo_data}
                  name={it.name}
                  editable={false}
                  big
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <h2
                      className="truncate text-[10px] sm:text-[11px] text-gray-900"
                      style={{ lineHeight: 1.1 }}
                    >
                      <span className="font-bold">{it.name}</span>
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
                      <StatPill
                        label="Total Qty"
                        value={stats.total}
                      />
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
              </div>
            </div>

          </div>

          <div className="mt-4 w-full sm:w-[410px] rounded-2xl border border-gray-200 overflow-hidden bg-white">
            {(cableRowsByItem[it.id] || []).length === 0 ? (
              <div className="px-4 py-3 text-[11px] text-gray-400">
                No rack items yet.
              </div>
            ) : (
              sortCableRows(cableRowsByItem[it.id] || []).map((row) => (
                <div
                  key={row.id}
                  data-matrix-select="true"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedCableRow({ itemId: it.id, rowId: row.id });
                    setSelectedItemId(null);
                    setSelectedBlockName(null);
                  }}
                  className={`grid cursor-pointer grid-cols-[1fr_64px_76px] items-center gap-2 border-t border-gray-100 px-4 py-2 text-[6px] first:border-t-0 sm:text-[8px] ${
                    selectedCableRow?.rowId === row.id
                      ? "ring-2 ring-inset ring-black"
                      : "hover:bg-gray-50"
                  }`}
                >
                  <div
                    className="truncate text-left font-semibold text-gray-900"
                    title={row.cable_length}
                  >
                    {row.cable_length}
                  </div>

                  <div
                    className="text-right font-bold text-gray-900 whitespace-nowrap"
                  >
                    Qty: {row.total_qty ?? 0}
                  </div>

                  <div className="text-right">
                    <EquipmentListMatrixQuantityAction
                      target={{
                        id: row.id,
                        parentId: it.id,
                        recordType: "matrix_row",
                        displayName: it.name,
                        blockName: itemBlockName(it),
                        photoUrl: it.photo_data,
                        itemType: it.item_type,
                        rowLabel: row.cable_length,
                        total: row.total_qty ?? 0,
                        inUse: row.in_use_qty ?? 0,
                        maintenance: row.maintenance_qty ?? 0,
                        inKsa: row.in_ksa_qty ?? 0,
                      }}
                      category={category}
                      subcategory={subcategory}
                      compact
                    />
                  </div>
                </div>
              ))
            )}
          </div>

        </div>
      );
    }

    if (it.item_type === "cable") {
      const cableRows = sortCableRows(cableRowsByItem[it.id] || []);
      const showCableMaintenance = cableRows.some(
        (row) => cableStats(row).maintenance > 0,
      );

      return (
        <div
          key={it.id}
          data-matrix-select="true"
          onClick={() => {
            setSelectedItemId(it.id);
            setSelectedBlockName(null);
            setSelectedCableRow(null);
          }}
          draggable={editable}
          onDragStart={() => onItemDragStart(it.id, itemBlockName(it))}
          onDragOver={(e) => editable && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void dropItemOnItem(it.id, itemBlockName(it));
          }}
          className={`relative rounded-xl p-2 transition ${
            selectedItemId === it.id ? "ring-2 ring-black" : ""
          } ${!isLast ? "border-b border-gray-100 pb-8 mb-8" : ""} ${
            editable ? "cursor-grab active:cursor-grabbing" : ""
          }`}
        >
          {editable ? (
            <button
              type="button"
              aria-label={`Open ${it.name} tools`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setSelectedItemId(it.id);
                setSelectedBlockName(null);
                setSelectedCableRow(null);
              }}
              className="absolute right-2 top-2 z-30 flex h-[26px] w-[26px] items-center justify-center rounded-full border border-gray-300 bg-white text-base font-bold text-gray-700 shadow-sm sm:hidden"
            >
              ⋮
            </button>
          ) : null}

          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-7 min-w-0">
              <ItemPhoto
                photo={it.photo_data}
                name={it.name}
                editable={false}
                big
              />

              <div className="relative min-w-0">
                <h2
                  className="truncate text-[12px] sm:text-[18px] font-black uppercase tracking-tight text-gray-900"
                  style={{ lineHeight: 1.05 }}
                >
                  {renderItemName(it.name, it.item_type)}
                </h2>

              </div>
            </div>

          </div>

          <div className="mt-5 overflow-x-auto pr-0">
            <div className="rounded-2xl border border-gray-200 overflow-hidden min-w-0">
              <div className={`grid items-center gap-[1px] bg-gray-100 px-2 py-1 text-[7px] font-bold text-gray-600 lg:px-6 lg:py-2 lg:text-[9px] ${
                showCableMaintenance
                  ? "grid-cols-[74px_45px_45px_45px_76px] md:grid-cols-[160px_130px_130px_130px_76px]"
                  : "grid-cols-[74px_45px_45px_76px] md:grid-cols-[160px_130px_130px_76px]"
              }`}>
                <div className="text-left">Length</div>
                <div className="text-center">Total</div>
                <div className="text-center">Available</div>
                {showCableMaintenance ? (
                  <div className="text-center">Maintenance</div>
                ) : null}
                <div />
              </div>

              {cableRows.length === 0 ? (
                <div className="px-2 lg:px-6 py-3 text-[10px] lg:text-[12px] text-gray-400">
                  No cable lengths yet.
                </div>
              ) : (
                cableRows.map((row) => {
                  const s = cableStats(row);

                  return (
                    <div
                      key={row.id}
                      data-matrix-select="true"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedCableRow({ itemId: it.id, rowId: row.id });
                        setSelectedItemId(null);
                        setSelectedBlockName(null);
                      }}
                      className={`grid cursor-pointer items-center gap-[1px] border-t border-gray-100 px-2 py-[1px] text-[7px] text-gray-900 lg:px-6 lg:py-[2px] lg:text-[9px] ${
                        showCableMaintenance
                          ? "grid-cols-[74px_45px_45px_45px_76px] md:grid-cols-[160px_130px_130px_130px_76px]"
                          : "grid-cols-[74px_45px_45px_76px] md:grid-cols-[160px_130px_130px_76px]"
                      } ${
                        selectedCableRow?.rowId === row.id
                          ? "ring-2 ring-inset ring-black"
                          : "hover:bg-gray-50"
                      }`}
                    >
                      <div className="text-left font-bold">
                        {row.cable_length}
                      </div>

                      <div className="text-center">
                        {s.total}
                      </div>

                      <div className="text-center">
                        <span className="inline-flex min-w-5 lg:min-w-7 justify-center rounded-md lg:rounded-lg bg-green-100 px-1 lg:px-1.5 py-0 lg:py-[2px] font-bold">
                          {s.available}
                        </span>
                      </div>

                      {showCableMaintenance ? (
                        <div className="text-center">
                          {s.maintenance > 0 ? (
                            <span className="inline-flex min-w-5 justify-center rounded-md bg-yellow-100 px-1 py-0 font-bold lg:min-w-7 lg:rounded-lg lg:px-1.5 lg:py-[2px]">
                              {s.maintenance}
                            </span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </div>
                      ) : null}

                      <div className="text-center">
                        <EquipmentListMatrixQuantityAction
                          target={{
                            id: row.id,
                            parentId: it.id,
                            recordType: "matrix_row",
                            displayName: it.name,
                            blockName: itemBlockName(it),
                            photoUrl: it.photo_data,
                            itemType: it.item_type,
                            rowLabel: row.cable_length,
                            total: row.total_qty ?? 0,
                            inUse: row.in_use_qty ?? 0,
                            maintenance: row.maintenance_qty ?? 0,
                            inKsa: row.in_ksa_qty ?? 0,
                          }}
                          category={category}
                          subcategory={subcategory}
                          compact
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

        </div>
      );
    }

    return (
      <div
        key={it.id}
        data-matrix-select="true"
        onClick={() => {
          setSelectedItemId(it.id);
          setSelectedBlockName(null);
          setSelectedCableRow(null);
        }}
        draggable={editable}
        onDragStart={() => onItemDragStart(it.id, itemBlockName(it))}
        onDragOver={(e) => editable && e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void dropItemOnItem(it.id, itemBlockName(it));
        }}
        className={`relative rounded-xl p-2 transition ${
          selectedItemId === it.id ? "ring-2 ring-black" : ""
        } ${!isLast ? "border-b border-gray-100 pb-4 mb-4" : ""} ${
          editable ? "cursor-grab active:cursor-grabbing" : ""
        }`}
      >
        {editable ? (
          <button
            type="button"
            aria-label={`Open ${it.name} tools`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSelectedItemId(it.id);
              setSelectedBlockName(null);
              setSelectedCableRow(null);
            }}
            className="absolute right-2 top-2 z-30 flex h-[26px] w-[26px] items-center justify-center rounded-full border border-gray-300 bg-white text-base font-bold text-gray-700 shadow-sm sm:hidden"
          >
            ⋮
          </button>
        ) : null}

        <div className="absolute right-2 top-2 hidden sm:block">
          <EquipmentListMatrixQuantityAction
            target={{
              id: it.id,
              parentId: null,
              recordType: "matrix_model",
              displayName: it.name,
              blockName: itemBlockName(it),
              photoUrl: it.photo_data,
              itemType: it.item_type,
              total: it.total_qty ?? 0,
              inUse: it.in_use_qty ?? 0,
              maintenance: it.maintenance_qty ?? 0,
              inKsa: it.in_ksa_qty ?? 0,
            }}
            category={category}
            subcategory={subcategory}
            compact
          />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3 min-w-0 flex-[1.45]">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <ItemPhoto
                photo={it.photo_data}
                name={it.name}
                editable={false}
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <h2
                    className="truncate text-[10px] sm:text-[11px] text-gray-900"
                    style={{ lineHeight: 1.1 }}
                  >
                    {renderItemName(it.name, it.item_type)}
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
                    <StatPill
                      label="Total Qty"
                      value={stats.total}
                    />
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
            </div>
          </div>

        </div>
      </div>
    );
  }

  if (loading) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-6 text-gray-900">
      Loading...
    </div>
  );
}

  if (err) {
    return (
      <div className="w-full mx-auto">
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
    <div className="w-full mx-auto space-y-3">
      {(selectedBlockName || selectedItem || selectedCableRowInfo) ? (
        <div
          data-mobile-matrix-tools="true"
          className="fixed inset-0 z-[9998] sm:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Matrix tools"
        >
          <button
            type="button"
            aria-label="Close matrix tools"
            onClick={() => void closeMobileMatrixTools()}
            className="absolute inset-0 bg-black/45"
          />

          <div className="absolute inset-x-0 bottom-0 flex h-[75dvh] flex-col rounded-t-3xl bg-gray-50 shadow-2xl">
            <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
              <div className="h-1 w-10 rounded-full bg-gray-300" />
              <div className="text-[11px] font-semibold text-gray-700">
                Matrix Tools
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => void closeMobileMatrixTools()}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-lg leading-none text-gray-700"
              >
                ×
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+16px)]">
              {selectedBlockPanel}
              {selectedItemPanel}
              {selectedCableRowPanel}

              {searchPanelOpen &&
              editingPhotoItemId === selectedItem?.id ? (
                <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="text-[12px] font-semibold text-gray-900">
                      Search Photo Online
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
                      {imageResults.map((img, index) => {
                        const imageUrl =
                          img.original || img.image || img.thumbnail;
                        const thumb = img.thumbnail || imageUrl;
                        if (!imageUrl || !thumb) return null;

                        return (
                          <button
                            key={`${imageUrl}-${index}`}
                            type="button"
                            onClick={() => void selectOnlinePhoto(img)}
                            className="overflow-hidden rounded-xl border border-gray-200"
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
            </div>
          </div>
        </div>
      ) : null}

      {sidebarTarget
        ? createPortal(
            <div>
              {selectedBlockPanel}
              {selectedItemPanel}
              {selectedCableRowPanel}
            </div>,
            sidebarTarget,
          )
        : null}

      <div className="hidden sm:block xl:hidden">{selectedBlockPanel}</div>
      <div className="hidden sm:block xl:hidden">{selectedItemPanel}</div>
      <div className="hidden sm:block xl:hidden">{selectedCableRowPanel}</div>

      {editable &&
        !selectedBlockName &&
        !selectedItemId &&
        !selectedCableRow &&
        (() => {
          const addItemsPanel = (
        <div
          data-matrix-tools="true"
          className={`bg-white border border-gray-200 rounded-2xl shadow-sm ${
            desktopSidebarActive ? "mb-4 p-3" : "p-4 sm:p-5"
          }`}
        >
          <div className="mb-4">
            <h1 className="text-[13px] font-semibold leading-tight text-gray-900">
              Add Items
            </h1>
            <p className="mt-1 text-[10px] text-gray-500">
              Add units, cables, or racks with optional photo and block name.
            </p>
          </div>

          <div
            className={
              desktopSidebarActive
                ? "grid grid-cols-1 gap-2"
                : itemType === "unit"
                ? "grid grid-cols-1 gap-2 md:grid-cols-[120px_1fr_1fr_76px_1fr_1fr_116px_76px] md:items-center"
                : itemType === "rack"
                  ? "grid grid-cols-1 gap-2 md:grid-cols-[120px_1fr_76px_1fr_1fr_116px_76px] md:items-center"
                  : "grid grid-cols-1 gap-2 md:grid-cols-[120px_1fr_1fr_1fr_116px_76px] md:items-center"
            }
          >
            <select
              value={itemType}
              onChange={(e) =>
                setItemType(e.target.value as "unit" | "cable" | "rack")
              }
              className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
            >
              <option value="unit">Units</option>
              <option value="cable">Cable</option>
              <option value="rack">Rack</option>
            </select>

            {itemType === "unit" ? (
              <>
                <input
                  value={brand}
                  onChange={(e) => {
                    setBrand(e.target.value);
                    if (!imageSearch) {
                      setImageSearch(`${e.target.value} ${model}`.trim());
                    }
                  }}
                  placeholder="Brand"
                  className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
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
                  className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
                />

                <input
                  value={qty}
                  onChange={(e) =>
                    setQty(Math.max(1, Number(e.target.value) || 1))
                  }
                  type="number"
                  min={1}
                  placeholder="Qty"
                  className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
                />
              </>
            ) : (
              <>
                <input
                  value={cableModel}
                  onChange={(e) => {
                    setCableModel(e.target.value);
                    if (!imageSearch) setImageSearch(e.target.value);
                  }}
                  placeholder={
                    itemType === "rack" ? "Rack name" : "Cable model"
                  }
                  className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
                />

                {itemType === "rack" ? (
                  <input
                    value={qty}
                    onChange={(e) =>
                      setQty(Math.max(1, Number(e.target.value) || 1))
                    }
                    type="number"
                    min={1}
                    placeholder="Qty"
                    className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
                  />
                ) : null}
              </>
            )}

            <select
              value={blockName}
              onChange={(e) => {
                setBlockName(e.target.value);
                if (e.target.value) setNewBlockName("");
              }}
              className="h-11 w-full rounded-2xl border border-gray-300 bg-white px-4 text-[12px] text-gray-900 shadow-sm outline-none transition focus:border-black focus:ring-1 focus:ring-black"
            >
              <option value="">Select block</option>
              {blockOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>

            <input
              value={newBlockName}
              onChange={(e) => {
                setNewBlockName(e.target.value);
                if (e.target.value.trim()) setBlockName("");
              }}
              placeholder="New block name"
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
                      setImageSearch(itemSearchName);
                      setTimeout(
                        () => void searchOnlineImages(itemSearchName),
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
                <div className="mt-3 text-xs text-gray-500">
                  Searching images...
                </div>
              ) : null}

              {imageResults.length > 0 ? (
                <div
                  className={
                    desktopSidebarActive
                      ? "mt-3 grid grid-cols-2 gap-2"
                      : "mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6"
                  }
                >
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
          );

          if (sidebarTarget && desktopSidebarActive) {
            return createPortal(addItemsPanel, sidebarTarget);
          }

          return (
            <>
              <button
                type="button"
                aria-label="Add matrix item"
                aria-expanded={mobileAddOpen}
                onClick={() => setMobileAddOpen(true)}
                className="fixed bottom-5 right-4 z-[90] flex h-14 w-14 items-center justify-center rounded-full bg-black text-[30px] font-light leading-none text-white shadow-xl transition active:scale-95 xl:hidden"
              >
                +
              </button>

              {mobileAddOpen ? (
                <div
                  data-mobile-matrix-add="true"
                  className="fixed inset-0 z-[9998] xl:hidden"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Add matrix item"
                >
                  <button
                    type="button"
                    aria-label="Close add item form"
                    onClick={closeMobileAddItems}
                    className="absolute inset-0 bg-black/45"
                  />

                  <div className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-3xl bg-gray-50 shadow-2xl">
                    <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
                      <div className="h-1 w-10 rounded-full bg-gray-300" />
                      <div className="text-[11px] font-semibold text-gray-700">
                        Add Items
                      </div>
                      <button
                        type="button"
                        aria-label="Close"
                        onClick={closeMobileAddItems}
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 text-lg leading-none text-gray-700"
                      >
                        ×
                      </button>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+16px)]">
                      {addItemsPanel}
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          );
        })()}

      {items.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-gray-900">
          No items yet.
        </div>
      ) : (
        brandGroups.map((group) => (
          <div
            key={group.brand}
            onDragOver={(e) => editable && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragItemId) {
                void dropItemOnBlock(group.brand);
              } else if (dragBlockName) {
                dropBlockOnBlock(group.brand);
              }
            }}
            className={`bg-white border rounded-2xl p-2 sm:p-4 ${
              selectedBlockName?.toLowerCase() === group.brand.toLowerCase()
                ? "border-black ring-2 ring-black"
                : dragItemId || dragBlockName
                  ? "border-red-200 bg-red-50/20"
                  : "border-gray-200"
            }`}
          >
            <div className="mb-3 flex items-center gap-2 border-b border-gray-100 pb-2">
              <button
                type="button"
                draggable={editable}
                onDragStart={() => onBlockDragStart(group.brand)}
                className={`h-5 w-5 rounded-full border border-gray-200 bg-white text-[10px] text-gray-500 ${
                  editable
                    ? "cursor-grab hover:text-red-500 active:cursor-grabbing"
                    : "cursor-default"
                }`}
                title="Drag block"
              >
                ⋮⋮
              </button>

              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />

              <button
                type="button"
                data-matrix-select="true"
                onClick={() => {
                  setSelectedBlockName(group.brand);
                  setSelectedItemId(null);
                  setSelectedCableRow(null);
                }}
                className="text-left text-[8px] font-semibold uppercase tracking-wide text-gray-500 hover:text-red-500"
                title="Select block"
              >
                {group.brand}
              </button>
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

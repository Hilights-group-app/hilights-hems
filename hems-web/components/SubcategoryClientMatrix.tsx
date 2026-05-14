"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { Trash2, ChevronDown } from "lucide-react";

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

async function uploadPhoto(file: File) {
  const supabase = createClient();

  const ext = file.name.split(".").pop() || "jpg";
  const fileName = `${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.${ext}`;

  const filePath = `matrix/${fileName}`;

  const { error } = await supabase.storage
    .from("equipment-photos")
    .upload(filePath, file);

  if (error) throw error;

  const { data } = supabase.storage
    .from("equipment-photos")
    .getPublicUrl(filePath);

  return data.publicUrl;
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

function renderItemName(name: string, itemType?: "unit" | "cable" | "rack" | null) {
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

function groupItemsByBrand(items: MatrixItemRow[]) {
  const sorted = sortItemsByBrand(items);
  const groups: { brand: string; items: MatrixItemRow[] }[] = [];

  for (const item of sorted) {
    const brand = itemBlockName(item);
    const last = groups[groups.length - 1];

    if (last && last.brand.toLowerCase() === brand.toLowerCase()) {
      last.items.push(item);
    } else {
      groups.push({ brand, items: [item] });
    }
  }

  return groups;
}

function cacheKeyFor(categoryId: string | null, subcategoryId: string | null) {
  return `hems:${categoryId || "no-cat"}:${subcategoryId || "no-sub"}:matrix-v2`;
}

function readItemsCache(
  categoryId: string | null,
  subcategoryId: string | null
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
  data: ItemsCache
) {
  if (typeof window === "undefined") return;

  try {
    sessionStorage.setItem(
      cacheKeyFor(categoryId, subcategoryId),
      JSON.stringify(data)
    );
  } catch {}
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

  return <span className={className}>{label}: {value}</span>;
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
          className="h-full w-full rounded-xl object-cover bg-white"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-xl bg-white text-[10px] text-gray-400">
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

export default function SubcategoryClientMatrix({
  category,
  subcategory,
}: {
  category: string;
  subcategory: string;
}) {
  const supabase = createClient();
  const editable = canEditInventory();

  const fileRef = useRef<HTMLInputElement | null>(null);
  const listPhotoFileRef = useRef<HTMLInputElement | null>(null);

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [subcategoryId, setSubcategoryId] = useState<string | null>(null);

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

  const [listPhotoMenuItemId, setListPhotoMenuItemId] =
    useState<string | null>(null);
  const [editingPhotoItemId, setEditingPhotoItemId] =
    useState<string | null>(null);

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
    return groupItemsByBrand(items);
  }, [items]);

  const blockOptions = useMemo(() => {
    const names = items
      .map((item) => itemBlockName(item))
      .filter((name) => name.trim().length > 0);

    return Array.from(new Set(names)).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
    );
  }, [items]);

  const finalBlockName = useMemo(() => {
    return newBlockName.trim() || blockName.trim();
  }, [newBlockName, blockName]);

  async function resolveIds() {
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
        (x) => x.item_type === "cable" || x.item_type === "rack"
      );

      if (cableItems.length > 0) {
        const rowsRes = await supabase
          .from("matrix_rows")
          .select("*")
          .in(
            "item_id",
            cableItems.map((x) => x.id)
          );

        if (rowsRes.error) throw rowsRes.error;

        const grouped: Record<string, CableRow[]> = {};

        for (const row of (rowsRes.data || []) as CableRow[]) {
          if (!grouped[row.item_id]) grouped[row.item_id] = [];
          grouped[row.item_id].push(row);
        }

        setCableRowsByItem(grouped);
      } else {
        setCableRowsByItem({});
      }

      setItems(list);
      setStatsByItem(stats);

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

    return () =>
      document.removeEventListener("mousedown", handleClickOutside);
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
      it.id === itemId ? { ...it, photo_data: imageUrl } : it
    );

    setItems(nextItems);
    setSaveMsg("Photo updated");
    setTimeout(() => setSaveMsg(""), 1500);
  }

  async function onPickListItemPhoto(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
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

  function selectOnlinePhoto(img: OnlineImage) {
    const imageUrl = img.original || img.image || img.thumbnail;
    if (!imageUrl) return;

    if (editingPhotoItemId) {
      void updateItemPhoto(editingPhotoItemId, imageUrl);
      setEditingPhotoItemId(null);
    } else {
      setPhoto(imageUrl);
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
    const cleanBlockName = finalBlockName ||
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
      isRack ? "Rack item name example: MA Lighting 8 PORT NODE" : "Cable length example: 5m / 10m / 20m"
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
      [itemId]: [...(prev[itemId] || []), data as CableRow],
    }));
  }
  
  
  
  async function updateCableQty(
  rowId: string,
  itemId: string,
  field: "total_qty" | "in_use_qty" | "maintenance_qty" | "in_ksa_qty",
  current: number | null
) {
  if (!editable) return;

  const nextValue = prompt("Edit quantity:", String(current ?? 0));
  if (nextValue === null) return;

  const clean = clampQty(nextValue);

  const { error } = await supabase
    .from("matrix_rows")
    .update({ [field]: clean })
    .eq("id", rowId);

  if (error) {
    alert(error.message);
    return;
  }

  setCableRowsByItem((prev) => ({
    ...prev,
    [itemId]: (prev[itemId] || []).map((row) =>
      row.id === rowId ? { ...row, [field]: clean } : row
    ),
  }));
}

async function updateCableLength(rowId: string, itemId: string, current: string) {
  if (!editable) return;

  const nextLength = prompt("Edit cable length:", current);
  if (!nextLength) return;

  const clean = nextLength.trim();
  if (!clean) return;

  const { error } = await supabase
    .from("matrix_rows")
    .update({ cable_length: clean })
    .eq("id", rowId);

  if (error) {
    alert(error.message);
    return;
  }

  setCableRowsByItem((prev) => ({
    ...prev,
    [itemId]: (prev[itemId] || []).map((row) =>
      row.id === rowId ? { ...row, cable_length: clean } : row
    ),
  }));
}
  
  async function updateItemQty(
    itemId: string,
    field: "total_qty" | "in_use_qty" | "maintenance_qty" | "in_ksa_qty",
    current: number | null
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
      item.id === itemId ? { ...item, [field]: clean } : item
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

  async function onRename(itemId: string, current: string) {
    if (!editable) return;

    const nextName = prompt("Rename item:", current);
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
        items.map((it) => (it.id === itemId ? { ...it, name: clean } : it))
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

  function renderItemRow(it: MatrixItemRow, isLast: boolean) {
    const stats = statsByItem[it.id] || statsFromItem(it);

    if (it.item_type === "rack") {
      return (
        <div
          key={it.id}
          className={!isLast ? "border-b border-gray-100 pb-6 mb-6" : ""}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
  <div className="flex items-start gap-3 min-w-0 flex-[1.45]">
    <div className="flex items-start gap-3 min-w-0 flex-1">
      <ItemPhoto
        photo={it.photo_data}
        name={it.name}
        editable={editable}
        big
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
            <span className="font-bold">{it.name}</span>
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
              <Trash2 className="h-3.5 w-3.5 sm:h-[15px] sm:w-[15px]" />
            </button>
          )}
        </div>

        <div className="mt-2 sm:hidden">
          <div className="grid grid-cols-5 gap-x-2 gap-y-1 text-center">
            <div className="text-[8px] font-semibold text-gray-500">Total</div>
            <div className="text-[8px] font-semibold text-gray-500">Available</div>
            <div className="text-[8px] font-semibold text-gray-500">In Use</div>
            <div className="text-[8px] font-semibold text-gray-500">Maintenance</div>
            <div className="text-[8px] font-semibold text-gray-500">In KSA</div>

            <button
              type="button"
              onClick={() => updateItemQty(it.id, "total_qty", it.total_qty)}
              className="rounded-md bg-gray-100 px-1 py-0.5 text-[9px] font-semibold hover:ring-1 hover:ring-red-300"
            >
              {stats.total}
            </button>
            <div className="rounded-md bg-green-100 px-1 py-0.5 text-[9px] font-semibold">
              {stats.available}
            </div>
            <button
              type="button"
              onClick={() => updateItemQty(it.id, "in_use_qty", it.in_use_qty)}
              className="rounded-md bg-blue-100 px-1 py-0.5 text-[9px] font-semibold hover:ring-1 hover:ring-red-300"
            >
              {stats.inUse}
            </button>
            <button
              type="button"
              onClick={() =>
                updateItemQty(it.id, "maintenance_qty", it.maintenance_qty)
              }
              className="rounded-md bg-yellow-100 px-1 py-0.5 text-[9px] font-semibold hover:ring-1 hover:ring-red-300"
            >
              {stats.maintenance}
            </button>
            <button
              type="button"
              onClick={() => updateItemQty(it.id, "in_ksa_qty", it.in_ksa_qty)}
              className="rounded-md bg-purple-100 px-1 py-0.5 text-[9px] font-semibold hover:ring-1 hover:ring-red-300"
            >
              {stats.inKsa}
            </button>
          </div>
        </div>

        <div className="mt-1 hidden sm:block">
          <div className="flex flex-wrap gap-2">
            <StatPill
              label="Total Qty"
              value={stats.total}
              onClick={() => updateItemQty(it.id, "total_qty", it.total_qty)}
            />
            <StatPill label="Available Qty" value={stats.available} tone="green" />
            <StatPill
              label="In Use"
              value={stats.inUse}
              tone="blue"
              onClick={() => updateItemQty(it.id, "in_use_qty", it.in_use_qty)}
            />
            <StatPill
              label="Maintenance"
              value={stats.maintenance}
              tone="yellow"
              onClick={() => updateItemQty(it.id, "maintenance_qty", it.maintenance_qty)}
            />
            <StatPill
              label="In KSA"
              value={stats.inKsa}
              tone="purple"
              onClick={() => updateItemQty(it.id, "in_ksa_qty", it.in_ksa_qty)}
            />
          </div>
        </div>
      </div>
    </div>
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

          <div className="mt-4 w-full sm:w-[410px] rounded-2xl border border-gray-200 overflow-hidden bg-white">
            {(cableRowsByItem[it.id] || []).length === 0 ? (
              <div className="px-4 py-3 text-[11px] text-gray-400">
                No rack items yet.
              </div>
            ) : (
              (cableRowsByItem[it.id] || []).map((row) => (
                <div
                  key={row.id}
                  className="grid grid-cols-[1fr_64px_24px] items-center gap-2 px-4 py-2 text-[6px] sm:text-[8px] border-t first:border-t-0 border-gray-100"
                >
                  <button
                    type="button"
                    onClick={() =>
                      updateCableLength(row.id, it.id, row.cable_length)
                    }
                    className="truncate text-left font-semibold text-gray-900 hover:text-red-500"
                    title={row.cable_length}
                  >
                    {row.cable_length}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      updateCableQty(row.id, it.id, "total_qty", row.total_qty)
                    }
                    className="text-right font-bold text-gray-900 hover:text-red-500 whitespace-nowrap"
                  >
                    Qty: {row.total_qty ?? 0}
                  </button>

                  {editable ? (
                    <button
                      type="button"
                      onClick={async () => {
                        if (!confirm("Delete rack item?")) return;

                        const { error } = await supabase
                          .from("matrix_rows")
                          .delete()
                          .eq("id", row.id);

                        if (error) {
                          alert(error.message);
                          return;
                        }

                        setCableRowsByItem((prev) => ({
                          ...prev,
                          [it.id]: (prev[it.id] || []).filter(
                            (x) => x.id !== row.id
                          ),
                        }));
                      }}
                      className="flex h-5 w-5 items-center justify-center rounded-full text-red-500 hover:bg-red-50 hover:text-black"
                    >
                      <Trash2 size={12} />
                    </button>
                  ) : (
                    <div />
                  )}
                </div>
              ))
            )}
          </div>

          {editable ? (
            <button
              type="button"
              onClick={() => addCableLength(it.id)}
              className="mt-2 text-[10px] font-medium text-red-500 hover:text-black"
            >
              + Add rack item
            </button>
          ) : null}
        </div>
      );
    }

    if (it.item_type === "cable") {
      return (
        <div
          key={it.id}
          className={!isLast ? "border-b border-gray-100 pb-8 mb-8" : ""}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-7 min-w-0">
              <ItemPhoto
                photo={it.photo_data}
                name={it.name}
                editable={editable}
                big
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

              <div className="relative min-w-0">
                <h2
                  className="truncate text-[12px] sm:text-[18px] font-black uppercase tracking-tight text-gray-900"
                  style={{ lineHeight: 1.05 }}
                >
                  {renderItemName(it.name, it.item_type)}
                </h2>

                {editable ? (
  <button
    type="button"
    onClick={(e) => {
      e.preventDefault();
      e.stopPropagation();
      onRename(it.id, it.name);
    }}
    className="absolute -top-4 right-0 text-red-500 text-[12px] hover:text-black"
    title="Rename"
  >
    ✎
  </button>
) : null}
              </div>
            </div>

            {editable ? (
              <>
                <button
                  onClick={() => onDelete(it.id)}
                  className="hidden sm:block px-3 py-1.5 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white hover:bg-red-50 hover:border-red-200 hover:text-red-700"
                >
                  Delete
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDelete(it.id);
                  }}
                  className="sm:hidden text-red-500 shrink-0 hover:text-black"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </>
            ) : null}
          </div>

          <div className="mt-5 overflow-x-auto pr-0">
            <div className="rounded-2xl border border-gray-200 overflow-hidden min-w-0">
              <div className="grid grid-cols-[74px_repeat(5,45px)_20px] md:grid-cols-[160px_repeat(5,130px)_32px] bg-gray-100 items-center gap-[2px] px-2 lg:px-6 py-1.5 lg:py-4 text-[7px] lg:text-[10px] font-bold text-gray-600">
                <div className="text-left">Length</div>
                <div className="text-center">Total</div>
                <div className="text-center">Available</div>
                <div className="text-center">In Use</div>
                <div className="text-center">Maintenance</div>
                <div className="text-center">In KSA</div>
                <div />
              </div>

              {(cableRowsByItem[it.id] || []).length === 0 ? (
                <div className="px-2 lg:px-6 py-3 text-[10px] lg:text-[12px] text-gray-400">
                  No cable lengths yet.
                </div>
              ) : (
                (cableRowsByItem[it.id] || []).map((row) => {
                  const s = cableStats(row);

                  return (
                    <div
                      key={row.id}
                      className="grid grid-cols-[74px_repeat(5,45px)_20px] md:grid-cols-[160px_repeat(5,130px)_32px] items-center gap-[2px] px-2 lg:px-6 py-[2px] lg:py-1 text-[7px] lg:text-[10px] text-gray-900 border-t border-gray-100"
                    >
                      <button
                        type="button"
                        onClick={() => updateCableLength(row.id, it.id, row.cable_length)}
                        className="text-left font-bold hover:text-red-500"
                      >
                        {row.cable_length}
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          updateCableQty(row.id, it.id, "total_qty", row.total_qty)
                        }
                        className="text-center hover:text-red-500"
                      >
                        {s.total}
                      </button>

                      <div className="text-center">
                        <span className="inline-flex min-w-5 lg:min-w-7 justify-center rounded-md lg:rounded-lg bg-green-100 px-1 lg:px-2 py-0.5 lg:py-1 font-bold">
                          {s.available}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() =>
                          updateCableQty(row.id, it.id, "in_use_qty", row.in_use_qty)
                        }
                        className="text-center"
                      >
                        <span className="inline-flex min-w-5 lg:min-w-7 justify-center rounded-md lg:rounded-lg bg-blue-100 px-1 lg:px-2 py-0.5 lg:py-1 font-bold hover:text-red-500">
                          {s.inUse}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          updateCableQty(
                            row.id,
                            it.id,
                            "maintenance_qty",
                            row.maintenance_qty
                          )
                        }
                        className="text-center"
                      >
                        <span className="inline-flex min-w-5 lg:min-w-7 justify-center rounded-md lg:rounded-lg bg-yellow-100 px-1 lg:px-2 py-0.5 lg:py-1 font-bold hover:text-red-500">
                          {s.maintenance}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          updateCableQty(row.id, it.id, "in_ksa_qty", row.in_ksa_qty)
                        }
                        className="text-center"
                      >
                        <span className="inline-flex min-w-5 lg:min-w-7 justify-center rounded-md lg:rounded-lg bg-purple-100 px-1 lg:px-2 py-0.5 lg:py-1 font-bold hover:text-red-500">
                          {s.inKsa}
                        </span>
                      </button>

                      {editable ? (
                        <button
                          type="button"
                          onClick={async () => {
                            if (!confirm("Delete cable length?")) return;

                            const { error } = await supabase
                              .from("matrix_rows")
                              .delete()
                              .eq("id", row.id);

                            if (error) {
                              alert(error.message);
                              return;
                            }

                            setCableRowsByItem((prev) => ({
                              ...prev,
                              [it.id]: (prev[it.id] || []).filter(
                                (x) => x.id !== row.id
                              ),
                            }));
                          }}
                          className="flex h-5 w-5 lg:h-7 lg:w-7 items-center justify-center rounded-full text-red-500 hover:bg-red-50 hover:text-black"
                        >
                          <Trash2 size={11} className="lg:hidden" />
                          <Trash2 size={15} className="hidden lg:block" />
                        </button>
                      ) : (
                        <div />
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {editable ? (
            <button
              type="button"
              onClick={() => addCableLength(it.id)}
              className="mt-2 text-[10px] font-medium text-red-500 hover:text-black"
            >
              + Add cable length
            </button>
          ) : null}
        </div>
      );
    }

    return (
      <div
        key={it.id}
        className={!isLast ? "border-b border-gray-100 pb-4 mb-4" : ""}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3 min-w-0 flex-[1.45]">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <ItemPhoto
                photo={it.photo_data}
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
                    {renderItemName(it.name, it.item_type)}
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
                      <Trash2 className="h-3.5 w-3.5 sm:h-[15px] sm:w-[15px]" />
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

                    <button
                      type="button"
                      onClick={() => updateItemQty(it.id, "total_qty", it.total_qty)}
                      className="rounded-md bg-gray-100 px-1 py-0.5 text-[9px] font-semibold hover:ring-1 hover:ring-red-300"
                    >
                      {stats.total}
                    </button>
                    <div className="rounded-md bg-green-100 px-1 py-0.5 text-[9px] font-semibold">
                      {stats.available}
                    </div>
                    <button
                      type="button"
                      onClick={() => updateItemQty(it.id, "in_use_qty", it.in_use_qty)}
                      className="rounded-md bg-blue-100 px-1 py-0.5 text-[9px] font-semibold hover:ring-1 hover:ring-red-300"
                    >
                      {stats.inUse}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateItemQty(it.id, "maintenance_qty", it.maintenance_qty)
                      }
                      className="rounded-md bg-yellow-100 px-1 py-0.5 text-[9px] font-semibold hover:ring-1 hover:ring-red-300"
                    >
                      {stats.maintenance}
                    </button>
                    <button
                      type="button"
                      onClick={() => updateItemQty(it.id, "in_ksa_qty", it.in_ksa_qty)}
                      className="rounded-md bg-purple-100 px-1 py-0.5 text-[9px] font-semibold hover:ring-1 hover:ring-red-300"
                    >
                      {stats.inKsa}
                    </button>
                  </div>
                </div>

                <div className="mt-1 hidden sm:block">
                  <div className="flex flex-wrap gap-2">
                    <StatPill
              label="Total Qty"
              value={stats.total}
              onClick={() => updateItemQty(it.id, "total_qty", it.total_qty)}
            />
                    <StatPill
                      label="Available Qty"
                      value={stats.available}
                      tone="green"
                    />
                    <StatPill
              label="In Use"
              value={stats.inUse}
              tone="blue"
              onClick={() => updateItemQty(it.id, "in_use_qty", it.in_use_qty)}
            />
                    <StatPill
                      label="Maintenance"
                      value={stats.maintenance}
                      tone="yellow"
                      onClick={() =>
                        updateItemQty(it.id, "maintenance_qty", it.maintenance_qty)
                      }
                    />
                    <StatPill
                      label="In KSA"
                      value={stats.inKsa}
                      tone="purple"
                      onClick={() => updateItemQty(it.id, "in_ksa_qty", it.in_ksa_qty)}
                    />
                  </div>
                </div>
              </div>
            </div>
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
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-gray-900">
          Loading items...
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
              Add Items
            </h1>
            <p className="mt-1 text-[10px] text-gray-500">
              Add units, cables, or racks with optional photo and block name.
            </p>
          </div>

          <div
            className={
              itemType === "unit"
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
                  placeholder={itemType === "rack" ? "Rack name" : "Cable model"}
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
                        50
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
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-gray-900">
          No items yet.
        </div>
      ) : (
        brandGroups.map((group) => (
          <div
            key={group.brand}
            className="bg-white border border-gray-200 rounded-2xl p-2 sm:p-4"
          >
            <div className="mb-3 flex items-center gap-2 border-b border-gray-100 pb-2">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500" />

              <h2 className="text-[8px] font-semibold uppercase tracking-wide text-gray-500">
                {group.brand}
              </h2>
            </div>

            {group.items.map((it, index) =>
              renderItemRow(it, index === group.items.length - 1)
            )}
          </div>
        ))
      )}
    </div>
  );
}
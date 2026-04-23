"use client";

import React, { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { Trash2 } from "lucide-react";

type MatrixRow = {
  id: string;
  model_id: string;
  size: string;
  qty: number;
  available_qty: number;
  in_use_qty: number;
  maintenance_qty: number;
  in_ksa_qty: number;
  photo_data?: string | null;
};

type MatrixModel = {
  id: string;
  category_id: string;
  subcategory_id: string;
  name: string;
  matrix_rows?: MatrixRow[];
  created_at?: string;
};

type ParsedLedName = {
  brand: string;
  model: string;
};

type QtyViewMode = "sqm" | "cabinet";

function clampQty(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function normalizeText(v: string) {
  return v.trim().replace(/\s+/g, " ");
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function parseLedName(name: string): ParsedLedName {
  const clean = normalizeText(name);
  const parts = clean.split(" - ");

  if (parts.length >= 2) {
    return {
      brand: normalizeText(parts[0]),
      model: normalizeText(parts.slice(1).join(" - ")),
    };
  }

  const firstSpace = clean.indexOf(" ");
  if (firstSpace === -1) {
    return {
      brand: clean,
      model: "",
    };
  }

  return {
    brand: normalizeText(clean.slice(0, firstSpace)),
    model: normalizeText(clean.slice(firstSpace + 1)),
  };
}

function buildLedName(brand: string, model: string) {
  const b = normalizeText(brand);
  const m = normalizeText(model);

  if (!b && !m) return "";
  if (!m) return b;
  if (!b) return m;

  return `${b} - ${m}`;
}

function rowAvailableFromTotal(
  total: number,
  inUse: number,
  maintenance: number,
  inKsa: number
) {
  return Math.max(0, total - inUse - maintenance - inKsa);
}

function parseCabinetArea(size: string): number {
  const clean = size.toLowerCase().replace(/,/g, ".");
  const nums = clean.match(/(\d+(\.\d+)?)/g);

  if (!nums || nums.length < 2) return 1;

  const a = Number(nums[0]);
  const b = Number(nums[1]);

  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return 1;
  }

  const sideA = a > 20 ? a / 1000 : a;
  const sideB = b > 20 ? b / 1000 : b;

  const sqm = sideA * sideB;

  if (!Number.isFinite(sqm) || sqm <= 0) return 1;
  return sqm;
}

function toUnitValue(cabinets: number, size: string, mode: QtyViewMode) {
  if (mode === "cabinet") return cabinets;
  return cabinets * parseCabinetArea(size);
}

function formatQty(value: number, mode: QtyViewMode) {
  if (mode === "cabinet") return String(clampQty(value));

  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function unitSuffix(mode: QtyViewMode) {
  return mode === "sqm" ? "SQM" : "Cabinet";
}

function StatBadge({
  label,
  value,
  mode,
  tone,
}: {
  label: string;
  value: number;
  mode: QtyViewMode;
  tone: "gray" | "green" | "blue" | "yellow" | "purple";
}) {
  const toneClass =
    tone === "gray"
      ? "bg-gray-100 text-black"
      : tone === "green"
      ? "bg-green-100 text-black"
      : tone === "blue"
      ? "bg-blue-100 text-black"
      : tone === "yellow"
      ? "bg-yellow-100 text-black"
      : "bg-purple-100 text-black";

  return (
    <span
      className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${toneClass}`}
    >
      {label}: {formatQty(value, mode)} {unitSuffix(mode)}
    </span>
  );
}

function LedRowPhoto({
  photo,
  name,
}: {
  photo?: string | null;
  name: string;
}) {
  return (
    <div className="flex h-11 w-11 min-w-[44px] items-center justify-center">
      {photo ? (
        <img
          src={photo}
          alt={name}
          className="h-full w-full rounded-lg bg-white object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded-lg bg-white text-[9px] text-gray-400">
          No photo
        </div>
      )}
    </div>
  );
}

export default function SubcategoryClientLedScreen({
  categoryId,
  subcategoryId,
}: {
  categoryId: string | null;
  subcategoryId: string | null;
}) {
  const supabase = createClient();
  const editable = canEditInventory();

  const [models, setModels] = useState<MatrixModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState("");

  const [resolvedCategoryId, setResolvedCategoryId] = useState<string | null>(
    categoryId ?? null
  );

  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [cabinetSize, setCabinetSize] = useState("");
  const [totalQtyInput, setTotalQtyInput] = useState(0);
  const [newPhoto, setNewPhoto] = useState<string | null>(null);

  const [viewModeByModel, setViewModeByModel] = useState<Record<string, QtyViewMode>>({});

  const [editingRow, setEditingRow] = useState<MatrixRow | null>(null);
  const [editTotal, setEditTotal] = useState(0);
  const [editInUse, setEditInUse] = useState(0);
  const [editInKsa, setEditInKsa] = useState(0);
  const [savingEdit, setSavingEdit] = useState(false);

  const [addingModelId, setAddingModelId] = useState<string | null>(null);
  const [addCabinetSize, setAddCabinetSize] = useState("");
  const [addCabinetQty, setAddCabinetQty] = useState(0);
  const [addCabinetPhoto, setAddCabinetPhoto] = useState<string | null>(null);
  const [savingAddCabinet, setSavingAddCabinet] = useState(false);

  async function resolveCategoryId(subId: string) {
    if (categoryId) {
      setResolvedCategoryId(categoryId);
      return categoryId;
    }

    const { data, error } = await supabase
      .from("subcategories")
      .select("category_id")
      .eq("id", subId)
      .single();

    if (error || !data?.category_id) {
      throw new Error("Failed to resolve category for this LED screen subcategory.");
    }

    setResolvedCategoryId(data.category_id as string);
    return data.category_id as string;
  }

  async function loadModels(subId: string) {
    setLoading(true);
    setErrorMsg(null);

    try {
      const { data, error } = await supabase
        .from("matrix_models")
        .select(
          "id, category_id, subcategory_id, name, created_at, matrix_rows(id, model_id, size, qty, available_qty, in_use_qty, maintenance_qty, in_ksa_qty, photo_data)"
        )
        .eq("subcategory_id", subId)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("loadModels relation query error", error);

        const fallback = await supabase
          .from("matrix_models")
          .select("id, category_id, subcategory_id, name, created_at")
          .eq("subcategory_id", subId)
          .order("created_at", { ascending: false });

        if (fallback.error) {
          console.error("loadModels fallback error", fallback.error);
          setModels([]);
          setErrorMsg(fallback.error.message || "Failed to load LED screen models.");
          setLoading(false);
          return;
        }

        const base = (fallback.data ?? []) as MatrixModel[];

        const withRows = await Promise.all(
          base.map(async (m) => {
            const rres = await supabase
              .from("matrix_rows")
              .select(
                "id, model_id, size, qty, available_qty, in_use_qty, maintenance_qty, in_ksa_qty, photo_data"
              )
              .eq("model_id", m.id);

            return {
              ...m,
              matrix_rows: (rres.data ?? []) as MatrixRow[],
            };
          })
        );

        setModels(withRows);
        setLoading(false);
        return;
      }

      setModels((data ?? []) as MatrixModel[]);
    } catch (e: any) {
      console.error("loadModels unexpected error", e);
      setErrorMsg(e?.message || "Failed to load LED screen models.");
      setModels([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;

    async function boot() {
      if (!subcategoryId) {
        setModels([]);
        setLoading(false);
        setResolvedCategoryId(categoryId ?? null);
        return;
      }

      try {
        const catId = await resolveCategoryId(subcategoryId);
        if (!mounted) return;
        setResolvedCategoryId(catId);
        await loadModels(subcategoryId);
      } catch (e: any) {
        if (!mounted) return;
        setErrorMsg(e?.message || "Failed to prepare LED screen page.");
        setLoading(false);
      }
    }

    void boot();

    return () => {
      mounted = false;
    };
  }, [subcategoryId, categoryId]);

  const parsedModels = useMemo(() => {
    return models.map((m) => ({
      ...m,
      parsed: parseLedName(m.name),
    }));
  }, [models]);

  const brandSuggestions = useMemo(() => {
    const list = Array.from(
      new Set(parsedModels.map((m) => m.parsed.brand).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));

    const q = normalizeText(brand).toLowerCase();
    if (!q) return list;
    return list.filter((x) => x.toLowerCase().includes(q));
  }, [parsedModels, brand]);

  const modelSuggestions = useMemo(() => {
    const currentBrand = normalizeText(brand).toLowerCase();

    const source = parsedModels.filter((m) => {
      if (!currentBrand) return true;
      return m.parsed.brand.toLowerCase() === currentBrand;
    });

    const list = Array.from(
      new Set(source.map((m) => m.parsed.model).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));

    const q = normalizeText(model).toLowerCase();
    if (!q) return list;
    return list.filter((x) => x.toLowerCase().includes(q));
  }, [parsedModels, brand, model]);

  const cabinetSuggestions = useMemo(() => {
    const currentBrand = normalizeText(brand).toLowerCase();
    const currentModel = normalizeText(model).toLowerCase();

    const matchedModels = parsedModels.filter((m) => {
      const brandOk = !currentBrand || m.parsed.brand.toLowerCase() === currentBrand;
      const modelOk = !currentModel || m.parsed.model.toLowerCase() === currentModel;
      return brandOk && modelOk;
    });

    const list = Array.from(
      new Set(
        matchedModels.flatMap((m) =>
          (m.matrix_rows ?? []).map((r) => normalizeText(r.size)).filter(Boolean)
        )
      )
    ).sort((a, b) => a.localeCompare(b));

    const q = normalizeText(cabinetSize).toLowerCase();
    if (!q) return list;
    return list.filter((x) => x.toLowerCase().includes(q));
  }, [parsedModels, brand, model, cabinetSize]);

  async function onPickNewPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;

    try {
      const dataUrl = await fileToDataUrl(f);
      setNewPhoto(dataUrl);
    } finally {
      e.target.value = "";
    }
  }

  async function onPickAddCabinetPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;

    try {
      const dataUrl = await fileToDataUrl(f);
      setAddCabinetPhoto(dataUrl);
    } finally {
      e.target.value = "";
    }
  }

  async function addLedScreen() {
    if (!editable) {
      setErrorMsg("You do not have permission to edit inventory.");
      return;
    }

    setErrorMsg(null);

    if (!subcategoryId) {
      setErrorMsg("Subcategory is not ready yet.");
      return;
    }

    const cleanBrand = normalizeText(brand);
    const cleanModel = normalizeText(model);
    const cleanCabinet = normalizeText(cabinetSize);
    const totalQty = clampQty(totalQtyInput);

    if (!cleanBrand) {
      setErrorMsg("Please enter brand name.");
      return;
    }

    if (!cleanModel) {
      setErrorMsg("Please enter model / pixel pitch.");
      return;
    }

    if (!cleanCabinet) {
      setErrorMsg("Please enter panel size.");
      return;
    }

    if (totalQty <= 0) {
      setErrorMsg("Please enter qty by panel.");
      return;
    }

    setSubmitting(true);

    try {
      const catId = resolvedCategoryId ?? (await resolveCategoryId(subcategoryId));
      const fullName = buildLedName(cleanBrand, cleanModel);

      const existingModel = parsedModels.find(
        (m) =>
          normalizeText(m.parsed.brand).toLowerCase() === cleanBrand.toLowerCase() &&
          normalizeText(m.parsed.model).toLowerCase() === cleanModel.toLowerCase()
      );

      if (existingModel) {
        const existingRow = (existingModel.matrix_rows ?? []).find(
          (r) => normalizeText(r.size).toLowerCase() === cleanCabinet.toLowerCase()
        );

        if (existingRow) {
          const newTotal = clampQty(existingRow.qty) + totalQty;

          const newAvailable = rowAvailableFromTotal(
            newTotal,
            clampQty(existingRow.in_use_qty),
            clampQty(existingRow.maintenance_qty),
            clampQty(existingRow.in_ksa_qty)
          );

          const { error: updateQtyError } = await supabase
            .from("matrix_rows")
            .update({
              qty: newTotal,
              available_qty: newAvailable,
              photo_data: newPhoto || existingRow.photo_data || null,
            })
            .eq("id", existingRow.id);

          if (updateQtyError) {
            console.error("merge qty error", updateQtyError);
            setErrorMsg(updateQtyError.message || "Failed to update qty.");
            return;
          }
        } else {
          const { error: addRowError } = await supabase.from("matrix_rows").insert({
            model_id: existingModel.id,
            size: cleanCabinet,
            qty: totalQty,
            available_qty: totalQty,
            in_use_qty: 0,
            maintenance_qty: 0,
            in_ksa_qty: 0,
            photo_data: newPhoto || null,
          });

          if (addRowError) {
            console.error("add row to existing model error", addRowError);
            setErrorMsg(addRowError.message || "Failed to add cabinet row.");
            return;
          }
        }
      } else {
        const { data: created, error } = await supabase
          .from("matrix_models")
          .insert({
            category_id: catId,
            subcategory_id: subcategoryId,
            name: fullName,
          })
          .select("id, category_id, subcategory_id, name, created_at")
          .single();

        if (error || !created) {
          console.error("add LED model error", error);
          setErrorMsg(error?.message || "Failed to add LED screen model.");
          return;
        }

        const firstRow = await supabase.from("matrix_rows").insert({
          model_id: created.id,
          size: cleanCabinet,
          qty: totalQty,
          available_qty: totalQty,
          in_use_qty: 0,
          maintenance_qty: 0,
          in_ksa_qty: 0,
          photo_data: newPhoto || null,
        });

        if (firstRow.error) {
          console.error("add first LED cabinet row error", firstRow.error);
          setErrorMsg(firstRow.error.message || "Model added, but failed to create first cabinet row.");
          return;
        }
      }

      setBrand("");
      setModel("");
      setCabinetSize("");
      setTotalQtyInput(0);
      setNewPhoto(null);
      setSaveMsg("LED screen added");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "LED screen added" ? "" : prev));
      }, 1500);

      await loadModels(subcategoryId);
    } catch (e: any) {
      console.error("addLedScreen unexpected error", e);
      setErrorMsg(e?.message || "Failed to add LED screen.");
    } finally {
      setSubmitting(false);
    }
  }

  function openEditPopup(row: MatrixRow) {
    setEditingRow(row);
    setEditTotal(clampQty(row.qty));
    setEditInUse(clampQty(row.in_use_qty));
    setEditInKsa(clampQty(row.in_ksa_qty));
  }

  function closeEditPopup() {
    setEditingRow(null);
    setEditTotal(0);
    setEditInUse(0);
    setEditInKsa(0);
    setSavingEdit(false);
  }

  function openAddCabinetPopup(modelId: string) {
    setAddingModelId(modelId);
    setAddCabinetSize("");
    setAddCabinetQty(0);
    setAddCabinetPhoto(null);
    setSavingAddCabinet(false);
  }

  function closeAddCabinetPopup() {
    setAddingModelId(null);
    setAddCabinetSize("");
    setAddCabinetQty(0);
    setAddCabinetPhoto(null);
    setSavingAddCabinet(false);
  }

  async function saveEditPopup() {
    if (!editingRow) return;

    const total = clampQty(editTotal);
    const nextInUse = clampQty(editInUse);
    const nextInKsa = clampQty(editInKsa);
    const nextMaintenance = clampQty(editingRow.maintenance_qty);

    const sumOthers = nextInUse + nextMaintenance + nextInKsa;
    if (sumOthers > total) {
      alert("In Use + Maintenance + In KSA cannot be more than Total Qty");
      return;
    }

    const nextAvailable = rowAvailableFromTotal(
      total,
      nextInUse,
      nextMaintenance,
      nextInKsa
    );

    setSavingEdit(true);

    const { error } = await supabase
      .from("matrix_rows")
      .update({
        qty: total,
        available_qty: nextAvailable,
        in_use_qty: nextInUse,
        in_ksa_qty: nextInKsa,
      })
      .eq("id", editingRow.id);

    if (error) {
      console.error("saveEditPopup error", error);
      alert("Failed to save row");
      setSavingEdit(false);
      return;
    }

    setModels((prev) =>
      prev.map((m) => ({
        ...m,
        matrix_rows: (m.matrix_rows ?? []).map((r) =>
          r.id === editingRow.id
            ? {
                ...r,
                qty: total,
                available_qty: nextAvailable,
                in_use_qty: nextInUse,
                in_ksa_qty: nextInKsa,
              }
            : r
        ),
      }))
    );

    closeEditPopup();
  }

  async function saveAddCabinetPopup() {
    if (!editable || !addingModelId) return;

    const size = normalizeText(addCabinetSize);
    const total = clampQty(addCabinetQty);

    if (!size) {
      alert("Please enter cabinet size");
      return;
    }

    if (total <= 0) {
      alert("Please enter qty");
      return;
    }

    setSavingAddCabinet(true);

    const { error } = await supabase.from("matrix_rows").insert({
      model_id: addingModelId,
      size,
      qty: total,
      available_qty: total,
      in_use_qty: 0,
      maintenance_qty: 0,
      in_ksa_qty: 0,
      photo_data: addCabinetPhoto || null,
    });

    if (error) {
      console.error("add cabinet error", error);
      alert("Failed to add cabinet");
      setSavingAddCabinet(false);
      return;
    }

    if (subcategoryId) {
      setSaveMsg("Cabinet added");
      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Cabinet added" ? "" : prev));
      }, 1500);

      await loadModels(subcategoryId);
    }

    closeAddCabinetPopup();
  }

  async function renameModel(modelId: string, current: string) {
    if (!editable) return;

    const parsed = parseLedName(current);
    const nextBrand = prompt("Brand:", parsed.brand);
    if (nextBrand === null) return;

    const nextModel = prompt("Model / Pixel Pitch:", parsed.model);
    if (nextModel === null) return;

    const cleanName = buildLedName(nextBrand, nextModel);
    if (!cleanName) return;

    const { error } = await supabase
      .from("matrix_models")
      .update({ name: cleanName })
      .eq("id", modelId);

    if (error) {
      console.error("renameModel error", error);
      alert("Rename failed");
      return;
    }

    if (subcategoryId) {
      setSaveMsg("Model renamed");
      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Model renamed" ? "" : prev));
      }, 1500);

      await loadModels(subcategoryId);
    }
  }

  async function renameRow(row: MatrixRow) {
    if (!editable) return;

    const next = prompt("Rename cabinet size:", row.size);
    if (!next) return;

    const clean = normalizeText(next);
    if (!clean) return;

    const { error } = await supabase
      .from("matrix_rows")
      .update({ size: clean })
      .eq("id", row.id);

    if (error) {
      console.error("renameRow error", error);
      alert("Rename cabinet size failed");
      return;
    }

    setModels((prev) =>
      prev.map((m) => ({
        ...m,
        matrix_rows: (m.matrix_rows ?? []).map((r) =>
          r.id === row.id ? { ...r, size: clean } : r
        ),
      }))
    );
  }

  async function deleteModel(modelId: string) {
    if (!editable) return;
    if (!confirm("Delete this LED model?")) return;

    const r = await supabase.from("matrix_rows").delete().eq("model_id", modelId);
    if (r.error) console.warn("delete rows warn", r.error);

    const { error } = await supabase.from("matrix_models").delete().eq("id", modelId);
    if (error) {
      console.error("deleteModel error", error);
      alert("Delete failed");
      return;
    }

    if (subcategoryId) {
      setSaveMsg("Model deleted");
      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Model deleted" ? "" : prev));
      }, 1500);

      await loadModels(subcategoryId);
    }
  }

  function addRow(modelId: string) {
    if (!editable) return;
    openAddCabinetPopup(modelId);
  }

  async function deleteRow(rowId: string) {
    if (!editable) return;
    if (!confirm("Delete this cabinet row?")) return;

    const { error } = await supabase.from("matrix_rows").delete().eq("id", rowId);

    if (error) {
      console.error("deleteRow error", error);
      alert("Delete row failed");
      return;
    }

    setModels((prev) =>
      prev.map((m) => ({
        ...m,
        matrix_rows: (m.matrix_rows ?? []).filter((r) => r.id !== rowId),
      }))
    );
  }

  function setModelViewMode(modelId: string, mode: QtyViewMode) {
    setViewModeByModel((prev) => ({ ...prev, [modelId]: mode }));
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-[1100px] px-3 sm:px-0">
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-6 text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          Loading LED screen models...
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1100px] space-y-3 px-3 text-black sm:px-0">
      {editable && (
        <div className="rounded-2xl border border-gray-200 bg-white p-4 sm:p-6">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h1 className="text-[14px] font-semibold leading-[1.1] text-gray-900">
              Add Led Screen
            </h1>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="md:col-span-2">
              <input
                list="led-brand-list"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="Brand Name (e.g Absen)"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-[12px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
              />
              <datalist id="led-brand-list">
                {brandSuggestions.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </div>

            <div className="md:col-span-2">
              <input
                list="led-model-list"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Model & ph (e.g PL2.9)"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-[12px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
              />
              <datalist id="led-model-list">
                {modelSuggestions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>

            <div className="md:col-span-3">
              <input
                list="led-cabinet-list"
                value={cabinetSize}
                onChange={(e) => setCabinetSize(e.target.value)}
                placeholder="Panel size (e.g 500mm X 500mm)"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-[12px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
              />
              <datalist id="led-cabinet-list">
                {cabinetSuggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>

            <div className="md:col-span-1">
              <input
                type="number"
                min={0}
                value={String(totalQtyInput)}
                onChange={(e) => setTotalQtyInput(clampQty(e.target.value))}
                placeholder="Qty"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-[12px] text-gray-900 outline-none focus:ring-1 focus:ring-black"
              />
            </div>

            <div className="md:col-span-2">
              <label className="flex w-full cursor-pointer items-center justify-center rounded-full border border-gray-300 bg-white px-2.5 py-2 text-[10px] font-medium text-gray-700 transition-all duration-150 ease-out hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-sm active:scale-[0.98]">
                <span>{newPhoto ? "Photo ✔" : "Upload Photo"}</span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPickNewPhoto}
                />
              </label>
            </div>

            <div className="md:col-span-2">
              <button
                type="button"
                onClick={addLedScreen}
                className="w-full rounded-full border border-black bg-black px-2.5 py-2 text-[10px] font-medium text-white transition-all duration-150 ease-out hover:opacity-90 active:scale-[0.98]"
              >
                {submitting ? "Adding..." : "+ Add"}
              </button>
            </div>
          </div>

          {(errorMsg || saveMsg) && (
            <div className={`mt-3 text-xs ${errorMsg ? "text-red-600" : "text-gray-500"}`}>
              {errorMsg || saveMsg}
            </div>
          )}
        </div>
      )}

      {models.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-6 text-gray-900 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          No LED screen models yet.
        </div>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white p-3 sm:p-5">
          {parsedModels.map((m, index) => {
            const isLast = index === parsedModels.length - 1;

            return (
              <div key={m.id} className={!isLast ? "mb-4 pb-4" : ""}>
                <LedModelCard
                  model={m}
                  brand={m.parsed.brand}
                  modelName={m.parsed.model}
                  editable={editable}
                  mode={viewModeByModel[m.id] ?? "sqm"}
                  onChangeMode={(mode) => setModelViewMode(m.id, mode)}
                  onRename={() => renameModel(m.id, m.name)}
                  onDelete={() => deleteModel(m.id)}
                  onAddRow={() => addRow(m.id)}
                  onDeleteRow={(rowId) => deleteRow(rowId)}
                  onOpenEdit={(row) => openEditPopup(row)}
                  onRenameRow={(row) => renameRow(row)}
                />
              </div>
            );
          })}
        </div>
      )}

      {editingRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-4 shadow-xl sm:p-6">
            <h3 className="text-[18px] font-semibold text-gray-900 sm:text-[20px]">
              Edit Qty
            </h3>

            <div className="mt-2 text-[11px] text-gray-600">
              Cabinet Size: <span className="font-semibold text-black">{editingRow.size}</span>
            </div>

            <div className="mt-1 text-[11px] text-gray-600">
              Total Qty: <span className="font-semibold text-black">{editingRow.qty}</span>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Total Qty
                </label>
                <input
                  type="number"
                  min={0}
                  value={String(editTotal)}
                  onChange={(e) => setEditTotal(clampQty(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-4 py-3 outline-none focus:ring-1 focus:ring-black"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  In Use
                </label>
                <input
                  type="number"
                  min={0}
                  value={String(editInUse)}
                  onChange={(e) => setEditInUse(clampQty(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-4 py-3 outline-none focus:ring-1 focus:ring-black"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Maintenance
                </label>
                <div className="w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-700">
                  {editingRow.maintenance_qty} (auto from report)
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  In KSA
                </label>
                <input
                  type="number"
                  min={0}
                  value={String(editInKsa)}
                  onChange={(e) => setEditInKsa(clampQty(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-4 py-3 outline-none focus:ring-1 focus:ring-black"
                />
              </div>

              <div className="pt-1 text-sm text-gray-600">
                Available (auto):
                <span className="ml-2 font-semibold text-black">
                  {rowAvailableFromTotal(
                    clampQty(editTotal),
                    clampQty(editInUse),
                    clampQty(editingRow.maintenance_qty),
                    clampQty(editInKsa)
                  )}
                </span>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeEditPopup}
                className="rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[10px] font-medium text-gray-700 transition-all duration-150 ease-out hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={saveEditPopup}
                disabled={savingEdit}
                className="rounded-full border border-black bg-black px-2.5 py-1 text-[10px] font-medium text-white transition-all duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
              >
                {savingEdit ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {addingModelId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-4 shadow-xl sm:p-6">
            <h3 className="text-[18px] font-semibold text-gray-900 sm:text-[20px]">
              Add Cabinet
            </h3>

            <div className="mt-4 grid grid-cols-1 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Cabinet Size
                </label>
                <input
                  value={addCabinetSize}
                  onChange={(e) => setAddCabinetSize(e.target.value)}
                  placeholder="e.g. 500mm X 500mm"
                  className="w-full rounded-lg border border-gray-300 px-4 py-3 outline-none focus:ring-1 focus:ring-black"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Qty by Panel
                </label>
                <input
                  type="number"
                  min={0}
                  value={String(addCabinetQty)}
                  onChange={(e) => setAddCabinetQty(clampQty(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-4 py-3 outline-none focus:ring-1 focus:ring-black"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Photo
                </label>
                <label className="flex w-full cursor-pointer items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-3 text-sm text-gray-700 transition-all duration-150 hover:border-red-200 hover:bg-red-50 hover:text-red-700">
                  <span>{addCabinetPhoto ? "Photo selected" : "Upload Photo"}</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={onPickAddCabinetPhoto}
                  />
                </label>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeAddCabinetPopup}
                className="rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[10px] font-medium text-gray-700 transition-all duration-150 ease-out hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={saveAddCabinetPopup}
                disabled={savingAddCabinet}
                className="rounded-full border border-black bg-black px-2.5 py-1 text-[10px] font-medium text-white transition-all duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
              >
                {savingAddCabinet ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LedModelCard({
  model,
  brand,
  modelName,
  editable,
  mode,
  onChangeMode,
  onRename,
  onDelete,
  onAddRow,
  onDeleteRow,
  onOpenEdit,
  onRenameRow,
}: {
  model: MatrixModel;
  brand: string;
  modelName: string;
  editable: boolean;
  mode: QtyViewMode;
  onChangeMode: (mode: QtyViewMode) => void;
  onRename: () => void;
  onDelete: () => void;
  onAddRow: () => void;
  onDeleteRow: (rowId: string) => void;
  onOpenEdit: (row: MatrixRow) => void;
  onRenameRow: (row: MatrixRow) => void;
}) {
  const rows = model.matrix_rows ?? [];

  const totalDisplay = rows.reduce(
    (sum, row) => sum + toUnitValue(clampQty(row.qty), row.size, mode),
    0
  );
  const availableDisplay = rows.reduce(
    (sum, row) => sum + toUnitValue(clampQty(row.available_qty), row.size, mode),
    0
  );
  const inUseDisplay = rows.reduce(
    (sum, row) => sum + toUnitValue(clampQty(row.in_use_qty), row.size, mode),
    0
  );
  const maintenanceDisplay = rows.reduce(
    (sum, row) => sum + toUnitValue(clampQty(row.maintenance_qty), row.size, mode),
    0
  );
  const inKsaDisplay = rows.reduce(
    (sum, row) => sum + toUnitValue(clampQty(row.in_ksa_qty), row.size, mode),
    0
  );

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold text-black">
            {brand} <span className="font-normal">{modelName}</span>
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <StatBadge label="Total" value={totalDisplay} mode={mode} tone="gray" />
            <StatBadge label="Available" value={availableDisplay} mode={mode} tone="green" />
            <StatBadge label="In Use" value={inUseDisplay} mode={mode} tone="blue" />
            <StatBadge label="Maintenance" value={maintenanceDisplay} mode={mode} tone="yellow" />
            <StatBadge label="In KSA" value={inKsaDisplay} mode={mode} tone="purple" />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onChangeMode("sqm")}
            className={`rounded-full border px-2.5 py-1 text-[10px] font-medium transition-all duration-150 ease-out active:scale-[0.98] ${
              mode === "sqm"
                ? "border-black bg-black text-white"
                : "border-gray-300 bg-white text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-sm"
            }`}
          >
            SQM
          </button>

          <button
            type="button"
            onClick={() => onChangeMode("cabinet")}
            className={`rounded-full border px-2.5 py-1 text-[10px] font-medium transition-all duration-150 ease-out active:scale-[0.98] ${
              mode === "cabinet"
                ? "border-black bg-black text-white"
                : "border-gray-300 bg-white text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-sm"
            }`}
          >
            Cabinet
          </button>

          {editable && (
            <>
              <button
                type="button"
                onClick={onRename}
                className="rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[10px] font-medium text-gray-700 transition-all duration-150 ease-out hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
              >
                Rename
              </button>

              <button
                type="button"
                onClick={onDelete}
                className="rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[10px] font-medium text-gray-700 transition-all duration-150 ease-out hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {rows.map((r, index) => (
          <div
            key={r.id}
            className={`flex flex-col gap-3 rounded-xl border border-gray-100 bg-white p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:rounded-none sm:border-0 sm:px-4 sm:py-3 ${
              index !== rows.length - 1 ? "sm:border-b sm:border-gray-100" : ""
            }`}
          >
            <div className="flex min-w-0 items-center gap-3 sm:flex-1">
              <LedRowPhoto photo={r.photo_data} name={r.size} />

              <div className="min-w-0 flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-black sm:text-[14px] sm:whitespace-nowrap">
                  {r.size}
                </span>

                {editable && (
                  <button
                    type="button"
                    onClick={() => onRenameRow(r)}
                    title="Rename cabinet size"
                    className="cursor-pointer text-sm text-red-500 transition-colors hover:text-black sm:text-[16px]"
                  >
                    ✎
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 sm:flex-[2] sm:items-center sm:justify-center">
              <div className="rounded-lg bg-gray-100 px-2 py-1 text-[10px] font-semibold text-black sm:text-[8px] whitespace-nowrap">
                Total: {formatQty(toUnitValue(r.qty, r.size, mode), mode)} {unitSuffix(mode)}
              </div>

              <div className="rounded-lg bg-green-100 px-2 py-1 text-[10px] font-semibold text-black sm:text-[8px] whitespace-nowrap">
                Available: {formatQty(toUnitValue(r.available_qty, r.size, mode), mode)} {unitSuffix(mode)}
              </div>

              <div className="rounded-lg bg-blue-100 px-2 py-1 text-[10px] font-semibold text-black sm:text-[8px] whitespace-nowrap">
                In Use: {formatQty(toUnitValue(r.in_use_qty, r.size, mode), mode)} {unitSuffix(mode)}
              </div>

              <div className="rounded-lg bg-yellow-100 px-2 py-1 text-[10px] font-semibold text-black sm:text-[8px] whitespace-nowrap">
                Maintenance: {formatQty(toUnitValue(r.maintenance_qty, r.size, mode), mode)} {unitSuffix(mode)}
              </div>

              <div className="rounded-lg bg-purple-100 px-2 py-1 text-[10px] font-semibold text-black sm:text-[8px] whitespace-nowrap">
                In KSA: {formatQty(toUnitValue(r.in_ksa_qty, r.size, mode), mode)} {unitSuffix(mode)}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 shrink-0">
              {editable && (
                <button
                  type="button"
                  onClick={() => onOpenEdit(r)}
                  className="rounded-full border border-gray-300 bg-white px-2 py-1 text-[10px] font-medium text-gray-700 transition-all duration-150 ease-out hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-sm active:scale-[0.98] sm:px-2.5"
                >
                  Edit
                </button>
              )}

              {editable && (
                <Trash2
                  size={16}
                  className="cursor-pointer text-red-500 transition-colors duration-200 hover:text-black"
                  onClick={() => onDeleteRow(r.id)}
                />
              )}
            </div>
          </div>
        ))}

        {editable && (
          <div className="pt-2">
            <button
              type="button"
              onClick={onAddRow}
              className="rounded-full border border-gray-300 bg-white px-2.5 py-1 text-[10px] font-medium text-gray-700 transition-all duration-150 ease-out hover:border-red-200 hover:bg-red-50 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
            >
              + Add Cabinet
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
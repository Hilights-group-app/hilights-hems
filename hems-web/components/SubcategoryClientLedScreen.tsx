"use client";

import React, { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { ChevronDown, Trash2 } from "lucide-react";

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
  if (firstSpace === -1) return { brand: clean, model: "" };

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

function rowAvailableFromTotal(total: number, inUse: number, maintenance: number, inKsa: number) {
  return Math.max(0, total - inUse - maintenance - inKsa);
}

function parseCabinetArea(size: string): number {
  const clean = size.toLowerCase().replace(/,/g, ".");
  const nums = clean.match(/(\d+(\.\d+)?)/g);

  if (!nums || nums.length < 2) return 1;

  const a = Number(nums[0]);
  const b = Number(nums[1]);

  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 1;

  const sideA = a > 20 ? a / 1000 : a;
  const sideB = b > 20 ? b / 1000 : b;

  const sqm = sideA * sideB;
  if (!Number.isFinite(sqm) || sqm <= 0) return 1;

  return sqm;
}

function toSqm(cabinets: number, size: string) {
  return cabinets * parseCabinetArea(size);
}

function formatSqm(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function LedRowPhoto({ photo, name }: { photo?: string | null; name: string }) {
  return (
    <div className="flex h-12 w-12 min-w-12 items-center justify-center rounded-xl bg-gray-50">
      {photo ? (
        <img src={photo} alt={name} className="h-full w-full rounded-xl object-cover" />
      ) : (
        <div className="text-[9px] text-gray-400">No photo</div>
      )}
    </div>
  );
}

function MobileStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "gray" | "green" | "blue" | "yellow" | "purple";
}) {
  const cls =
    tone === "gray"
      ? "bg-gray-100"
      : tone === "green"
      ? "bg-green-100"
      : tone === "blue"
      ? "bg-blue-100"
      : tone === "yellow"
      ? "bg-yellow-100"
      : "bg-purple-100";

  return (
    <div className="w-[48px] text-center sm:w-auto">
      <div className="mb-1 truncate text-[8px] font-semibold text-gray-500">
        {label}
      </div>
      <div className={`rounded-lg px-1 py-1 text-[9px] font-bold text-black ${cls}`}>
        {formatSqm(value)}
      </div>
    </div>
  );
}

function SmallStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "gray" | "green" | "blue" | "yellow" | "purple";
}) {
  const cls =
    tone === "gray"
      ? "bg-gray-100"
      : tone === "green"
      ? "bg-green-100"
      : tone === "blue"
      ? "bg-blue-100"
      : tone === "yellow"
      ? "bg-yellow-100"
      : "bg-purple-100";

  return (
    <span className={`rounded-lg px-2 py-1 text-[9px] font-semibold text-black ${cls}`}>
      {label}: {formatSqm(value)} SQM
    </span>
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

  const [resolvedCategoryId, setResolvedCategoryId] = useState<string | null>(categoryId ?? null);

  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [cabinetSize, setCabinetSize] = useState("");
  const [totalQtyInput, setTotalQtyInput] = useState(0);
  const [newPhoto, setNewPhoto] = useState<string | null>(null);

  const [openModelId, setOpenModelId] = useState<string | null>(null);

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
        const fallback = await supabase
          .from("matrix_models")
          .select("id, category_id, subcategory_id, name, created_at")
          .eq("subcategory_id", subId)
          .order("created_at", { ascending: false });

        if (fallback.error) {
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
              .select("id, model_id, size, qty, available_qty, in_use_qty, maintenance_qty, in_ksa_qty, photo_data")
              .eq("model_id", m.id);

            return { ...m, matrix_rows: (rres.data ?? []) as MatrixRow[] };
          })
        );

        setModels(withRows);
        setLoading(false);
        return;
      }

      setModels((data ?? []) as MatrixModel[]);
    } catch (e: any) {
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
    return models.map((m) => ({ ...m, parsed: parseLedName(m.name) }));
  }, [models]);

  const brandSuggestions = useMemo(() => {
    const list = Array.from(new Set(parsedModels.map((m) => m.parsed.brand).filter(Boolean))).sort();
    const q = normalizeText(brand).toLowerCase();
    if (!q) return list;
    return list.filter((x) => x.toLowerCase().includes(q));
  }, [parsedModels, brand]);

  const modelSuggestions = useMemo(() => {
    const currentBrand = normalizeText(brand).toLowerCase();
    const source = parsedModels.filter((m) => !currentBrand || m.parsed.brand.toLowerCase() === currentBrand);
    const list = Array.from(new Set(source.map((m) => m.parsed.model).filter(Boolean))).sort();
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
      new Set(matchedModels.flatMap((m) => (m.matrix_rows ?? []).map((r) => normalizeText(r.size)).filter(Boolean)))
    ).sort();

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

    if (!cleanBrand) return setErrorMsg("Please enter brand name.");
    if (!cleanModel) return setErrorMsg("Please enter model / pixel pitch.");
    if (!cleanCabinet) return setErrorMsg("Please enter panel size.");
    if (totalQty <= 0) return setErrorMsg("Please enter qty by panel.");

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

          const { error } = await supabase
            .from("matrix_rows")
            .update({
              qty: newTotal,
              available_qty: newAvailable,
              photo_data: newPhoto || existingRow.photo_data || null,
            })
            .eq("id", existingRow.id);

          if (error) {
            setErrorMsg(error.message || "Failed to update qty.");
            return;
          }
        } else {
          const { error } = await supabase.from("matrix_rows").insert({
            model_id: existingModel.id,
            size: cleanCabinet,
            qty: totalQty,
            available_qty: totalQty,
            in_use_qty: 0,
            maintenance_qty: 0,
            in_ksa_qty: 0,
            photo_data: newPhoto || null,
          });

          if (error) {
            setErrorMsg(error.message || "Failed to add cabinet row.");
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
          setErrorMsg(firstRow.error.message || "Model added, but failed to create first cabinet row.");
          return;
        }

        setOpenModelId(created.id);
      }

      setBrand("");
      setModel("");
      setCabinetSize("");
      setTotalQtyInput(0);
      setNewPhoto(null);
      setSaveMsg("LED screen added");
      setTimeout(() => setSaveMsg((prev) => (prev === "LED screen added" ? "" : prev)), 1500);

      await loadModels(subcategoryId);
    } catch (e: any) {
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

    if (nextInUse + nextMaintenance + nextInKsa > total) {
      alert("In Use + Maintenance + In KSA cannot be more than Total Qty");
      return;
    }

    const nextAvailable = rowAvailableFromTotal(total, nextInUse, nextMaintenance, nextInKsa);

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

    if (!size) return alert("Please enter cabinet size");
    if (total <= 0) return alert("Please enter qty");

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
      alert("Failed to add cabinet");
      setSavingAddCabinet(false);
      return;
    }

    if (subcategoryId) {
      setSaveMsg("Cabinet added");
      setTimeout(() => setSaveMsg((prev) => (prev === "Cabinet added" ? "" : prev)), 1500);
      await loadModels(subcategoryId);
    }

    setOpenModelId(addingModelId);
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

    const { error } = await supabase.from("matrix_models").update({ name: cleanName }).eq("id", modelId);

    if (error) {
      alert("Rename failed");
      return;
    }

    if (subcategoryId) {
      setSaveMsg("Model renamed");
      setTimeout(() => setSaveMsg((prev) => (prev === "Model renamed" ? "" : prev)), 1500);
      await loadModels(subcategoryId);
    }
  }

  async function saveRowDirect(row: MatrixRow, patch: Partial<MatrixRow>) {
    if (!editable) return;

    const nextSize = normalizeText(String(patch.size ?? row.size));
    const nextTotal = clampQty(patch.qty ?? row.qty);
    const nextInUse = clampQty(patch.in_use_qty ?? row.in_use_qty);
    const nextMaintenance = clampQty(row.maintenance_qty);
    const nextInKsa = clampQty(patch.in_ksa_qty ?? row.in_ksa_qty);

    if (!nextSize) {
      alert("Cabinet size cannot be empty");
      return;
    }

    if (nextInUse + nextMaintenance + nextInKsa > nextTotal) {
      alert("In Use + Maintenance + In KSA cannot be more than Total Qty");
      return;
    }

    const nextAvailable = rowAvailableFromTotal(nextTotal, nextInUse, nextMaintenance, nextInKsa);

    setModels((prev) =>
      prev.map((m) => ({
        ...m,
        matrix_rows: (m.matrix_rows ?? []).map((r) =>
          r.id === row.id
            ? {
                ...r,
                size: nextSize,
                qty: nextTotal,
                available_qty: nextAvailable,
                in_use_qty: nextInUse,
                in_ksa_qty: nextInKsa,
              }
            : r
        ),
      }))
    );

    const { error } = await supabase
      .from("matrix_rows")
      .update({
        size: nextSize,
        qty: nextTotal,
        available_qty: nextAvailable,
        in_use_qty: nextInUse,
        in_ksa_qty: nextInKsa,
      })
      .eq("id", row.id);

    if (error) {
      alert("Failed to save row");
      if (subcategoryId) await loadModels(subcategoryId);
    }
  }

  async function deleteModel(modelId: string) {
    if (!editable) return;
    if (!confirm("Delete this LED model?")) return;

    await supabase.from("matrix_rows").delete().eq("model_id", modelId);

    const { error } = await supabase.from("matrix_models").delete().eq("id", modelId);

    if (error) {
      alert("Delete failed");
      return;
    }

    if (subcategoryId) {
      setSaveMsg("Model deleted");
      setTimeout(() => setSaveMsg((prev) => (prev === "Model deleted" ? "" : prev)), 1500);
      await loadModels(subcategoryId);
    }
  }

  async function deleteRow(rowId: string) {
    if (!editable) return;
    if (!confirm("Delete this cabinet row?")) return;

    const { error } = await supabase.from("matrix_rows").delete().eq("id", rowId);

    if (error) {
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

  if (loading) {
    return (
      <div className="mx-auto max-w-[1100px] px-3 sm:px-0">
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-6 text-gray-900">
          Loading LED screen models...
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1100px] space-y-3 px-3 text-black sm:px-0">
      {editable && (
        <div className="rounded-2xl border border-gray-200 bg-white px-3 py-0 sm:px-5">
          <div className="mb-4">
            <h1 className="text-[16px] font-bold text-gray-900">Add LED Screen</h1>
            <p className="mt-1 text-[11px] text-gray-500">
              Add model once, then add cabinet sizes inside it.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
            <input
              list="led-brand-list"
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              placeholder="Brand"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-[12px] outline-none focus:ring-1 focus:ring-black md:col-span-2"
            />
            <datalist id="led-brand-list">
              {brandSuggestions.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>

            <input
              list="led-model-list"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Model / PH"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-[12px] outline-none focus:ring-1 focus:ring-black md:col-span-2"
            />
            <datalist id="led-model-list">
              {modelSuggestions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>

            <input
              list="led-cabinet-list"
              value={cabinetSize}
              onChange={(e) => setCabinetSize(e.target.value)}
              placeholder="Cabinet size"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-[12px] outline-none focus:ring-1 focus:ring-black md:col-span-3"
            />
            <datalist id="led-cabinet-list">
              {cabinetSuggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>

            <input
              type="number"
              min={0}
              value={String(totalQtyInput)}
              onChange={(e) => setTotalQtyInput(clampQty(e.target.value))}
              placeholder="Qty"
              className="w-full rounded-xl border border-gray-200 px-3 py-2 text-[12px] outline-none focus:ring-1 focus:ring-black md:col-span-1"
            />

            <label className="flex w-full cursor-pointer justify-center rounded-full border border-gray-200 bg-white px-3 py-2 text-[10px] font-medium text-gray-700 hover:bg-gray-50 md:col-span-2">
              {newPhoto ? "Photo ✔" : "Upload Photo"}
              <input type="file" accept="image/*" className="hidden" onChange={onPickNewPhoto} />
            </label>

            <button
              type="button"
              onClick={addLedScreen}
              className="w-full rounded-full bg-black px-3 py-2 text-[10px] font-medium text-white hover:opacity-90 md:col-span-2"
            >
              {submitting ? "Adding..." : "+ Add Model"}
            </button>
          </div>

          {(errorMsg || saveMsg) && (
            <div className={`mt-3 text-xs ${errorMsg ? "text-red-600" : "text-gray-500"}`}>
              {errorMsg || saveMsg}
            </div>
          )}
        </div>
      )}

      {models.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-6 text-gray-900">
          No LED screen models yet.
        </div>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white px-3 py-0 sm:px-5">

          <div className="divide-y divide-gray-100">
            {parsedModels.map((m) => (
              <LedModelCard
                key={m.id}
                model={m}
                brand={m.parsed.brand}
                modelName={m.parsed.model}
                editable={editable}
                isOpen={openModelId === m.id}
                onToggle={() => setOpenModelId((prev) => (prev === m.id ? null : m.id))}
                onRename={() => renameModel(m.id, m.name)}
                onDelete={() => deleteModel(m.id)}
                onAddRow={() => openAddCabinetPopup(m.id)}
                onDeleteRow={(rowId) => deleteRow(rowId)}
                onOpenEdit={(row) => openEditPopup(row)}
                onSaveRowDirect={saveRowDirect}
              />
            ))}
          </div>
        </div>
      )}

      {editingRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-[18px] font-semibold text-gray-900">Edit Qty</h3>
            <div className="mt-2 text-[11px] text-gray-600">
              Cabinet Size: <span className="font-semibold text-black">{editingRow.size}</span>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3">
              <input
                type="number"
                min={0}
                value={String(editTotal)}
                onChange={(e) => setEditTotal(clampQty(e.target.value))}
                placeholder="Total Qty"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 outline-none"
              />

              <input
                type="number"
                min={0}
                value={String(editInUse)}
                onChange={(e) => setEditInUse(clampQty(e.target.value))}
                placeholder="In Use"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 outline-none"
              />

              <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
                Maintenance: {editingRow.maintenance_qty} (auto from report)
              </div>

              <input
                type="number"
                min={0}
                value={String(editInKsa)}
                onChange={(e) => setEditInKsa(clampQty(e.target.value))}
                placeholder="In KSA"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 outline-none"
              />

              <div className="text-sm text-gray-600">
                Available:
                <span className="ml-2 font-semibold text-black">
                  {rowAvailableFromTotal(clampQty(editTotal), clampQty(editInUse), clampQty(editingRow.maintenance_qty), clampQty(editInKsa))}
                </span>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button onClick={closeEditPopup} className="rounded-full border px-4 py-1 text-xs">
                Cancel
              </button>
              <button
                onClick={saveEditPopup}
                disabled={savingEdit}
                className="rounded-full bg-black px-4 py-1 text-xs text-white disabled:opacity-50"
              >
                {savingEdit ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {addingModelId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-[18px] font-semibold text-gray-900">Add Cabinet</h3>

            <div className="mt-4 grid grid-cols-1 gap-3">
              <input
                value={addCabinetSize}
                onChange={(e) => setAddCabinetSize(e.target.value)}
                placeholder="Cabinet Size"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 outline-none"
              />

              <input
                type="number"
                min={0}
                value={String(addCabinetQty)}
                onChange={(e) => setAddCabinetQty(clampQty(e.target.value))}
                placeholder="Qty by Panel"
                className="w-full rounded-xl border border-gray-200 px-4 py-3 outline-none"
              />

              <label className="flex cursor-pointer justify-center rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-700 hover:bg-gray-50">
                {addCabinetPhoto ? "Photo selected" : "Upload Photo"}
                <input type="file" accept="image/*" className="hidden" onChange={onPickAddCabinetPhoto} />
              </label>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button onClick={closeAddCabinetPopup} className="rounded-full border px-4 py-1 text-xs">
                Cancel
              </button>
              <button
                onClick={saveAddCabinetPopup}
                disabled={savingAddCabinet}
                className="rounded-full bg-black px-4 py-1 text-xs text-white disabled:opacity-50"
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
  isOpen,
  onToggle,
  onRename,
  onDelete,
  onAddRow,
  onDeleteRow,
  onOpenEdit,
  onSaveRowDirect,
}: {
  model: MatrixModel;
  brand: string;
  modelName: string;
  editable: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
  onAddRow: () => void;
  onDeleteRow: (rowId: string) => void;
  onOpenEdit: (row: MatrixRow) => void;
  onSaveRowDirect: (row: MatrixRow, patch: Partial<MatrixRow>) => Promise<void>;
}) {
  const rows = model.matrix_rows ?? [];
  const firstPhoto = rows.find((r) => r.photo_data)?.photo_data ?? null;

  const totalDisplay = rows.reduce((sum, row) => sum + toSqm(clampQty(row.qty), row.size), 0);
  const availableDisplay = rows.reduce((sum, row) => sum + toSqm(clampQty(row.available_qty), row.size), 0);
  const inUseDisplay = rows.reduce((sum, row) => sum + toSqm(clampQty(row.in_use_qty), row.size), 0);
  const maintenanceDisplay = rows.reduce((sum, row) => sum + toSqm(clampQty(row.maintenance_qty), row.size), 0);
  const inKsaDisplay = rows.reduce((sum, row) => sum + toSqm(clampQty(row.in_ksa_qty), row.size), 0);

  return (
    <div className="py-2">
      <button type="button" onClick={onToggle} className="w-full text-left">
        <div className="flex items-center gap-4">

          <div className="min-w-0 flex-1">
            <div className="mb-3 truncate text-[15px] font-bold text-gray-900 sm:text-[16px]">
              {brand} <span className="font-medium">{modelName}</span>
            </div>

            <div className="flex flex-nowrap items-start gap-1 overflow-hidden sm:hidden">
              <MobileStat label="Total" value={totalDisplay} tone="gray" />
              <MobileStat label="Available" value={availableDisplay} tone="green" />
              <MobileStat label="In Use" value={inUseDisplay} tone="blue" />
              <MobileStat label="Maintenance" value={maintenanceDisplay} tone="yellow" />
              <MobileStat label="In KSA" value={inKsaDisplay} tone="purple" />
            </div>

            <div className="hidden flex-wrap gap-1.5 sm:flex">
              <SmallStat label="Total" value={totalDisplay} tone="gray" />
              <SmallStat label="Available" value={availableDisplay} tone="green" />
              <SmallStat label="In Use" value={inUseDisplay} tone="blue" />
              <SmallStat label="Maintenance" value={maintenanceDisplay} tone="yellow" />
              <SmallStat label="In KSA" value={inKsaDisplay} tone="purple" />
            </div>
          </div>

          <ChevronDown
            size={18}
            className={`shrink-0 text-gray-500 transition-transform ${isOpen ? "rotate-180" : ""}`}
          />
        </div>
      </button>

      {isOpen && (
        <div className="mt-2 rounded-2xl border border-gray-100 bg-gray-50 px-3 py-2 sm:bg-white sm:px-4 sm:py-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-semibold text-gray-500">
              Cabinet Sizes
            </div>

            {editable && (
              <div className="flex flex-wrap gap-2">
                <button onClick={onRename} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-[10px]">
                  Rename Model
                </button>
                <button onClick={onDelete} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-[10px] text-red-500">
                  Delete Model
                </button>
                <button onClick={onAddRow} className="rounded-full bg-black px-3 py-1 text-[10px] text-white">
                  + Cabinet
                </button>
              </div>
            )}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-gray-100 sm:block">
            <div className="grid grid-cols-[70px_1.4fr_0.8fr_0.8fr_0.8fr_0.8fr_0.8fr_70px] bg-gray-50 px-3 py-3 text-[10px] font-semibold text-gray-500">
              <div>Photo</div>
              <div>Cabinet Size</div>
              <div>Total Qty</div>
              <div>Available</div>
              <div>In Use</div>
              <div>Maint.</div>
              <div>In KSA</div>
              <div>Delete</div>
            </div>

            {rows.map((r) => (
              <DesktopEditableCabinetRow
                key={r.id}
                row={r}
                editable={editable}
                onSaveRowDirect={onSaveRowDirect}
                onDeleteRow={onDeleteRow}
              />
            ))}
          </div>

          <div className="space-y-3 sm:hidden">
            {rows.map((r) => (
              <div key={r.id} className="rounded-2xl border border-gray-100 bg-white p-3">
                <div className="flex gap-3">
                  <LedRowPhoto photo={r.photo_data} name={r.size} />

                  <div className="min-w-0 flex-1">
                    <div className="mb-3 truncate text-[14px] font-bold text-gray-900">
                      {r.size}
                    </div>

                    <div className="flex flex-nowrap gap-1 overflow-x-auto">
                      <MobileStat label="Total" value={toSqm(r.qty, r.size)} tone="gray" />
                      <MobileStat label="Available" value={toSqm(r.available_qty, r.size)} tone="green" />
                      <MobileStat label="In Use" value={toSqm(r.in_use_qty, r.size)} tone="blue" />
                      <MobileStat label="Maintenance" value={toSqm(r.maintenance_qty, r.size)} tone="yellow" />
                      <MobileStat label="In KSA" value={toSqm(r.in_ksa_qty, r.size)} tone="purple" />
                    </div>
                  </div>
                </div>

                {editable && (
                  <div className="mt-3 flex justify-end gap-3">
                    <button onClick={() => onOpenEdit(r)} className="rounded-full border border-gray-200 px-3 py-1 text-[10px]">
                      Edit
                    </button>
                    <Trash2 size={16} className="cursor-pointer text-red-500" onClick={() => onDeleteRow(r.id)} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DesktopEditableCabinetRow({
  row,
  editable,
  onSaveRowDirect,
  onDeleteRow,
}: {
  row: MatrixRow;
  editable: boolean;
  onSaveRowDirect: (row: MatrixRow, patch: Partial<MatrixRow>) => Promise<void>;
  onDeleteRow: (rowId: string) => void;
}) {
  const [size, setSize] = useState(row.size);
  const [qty, setQty] = useState(String(row.qty));
  const [inUse, setInUse] = useState(String(row.in_use_qty));
  const [inKsa, setInKsa] = useState(String(row.in_ksa_qty));

  useEffect(() => {
    setSize(row.size);
    setQty(String(row.qty));
    setInUse(String(row.in_use_qty));
    setInKsa(String(row.in_ksa_qty));
  }, [row]);

  const available = rowAvailableFromTotal(
    clampQty(qty),
    clampQty(inUse),
    clampQty(row.maintenance_qty),
    clampQty(inKsa)
  );

  return (
    <div className="grid grid-cols-[70px_1.4fr_0.8fr_0.8fr_0.8fr_0.8fr_0.8fr_70px] items-center border-t border-gray-100 px-3 py-3 text-[11px]">
      <LedRowPhoto photo={row.photo_data} name={row.size} />

      <input
        value={size}
        readOnly={!editable}
        onChange={(e) => setSize(e.target.value)}
        onBlur={() => onSaveRowDirect(row, { size })}
        className="w-full rounded-lg border-none bg-transparent px-1 py-1 font-medium outline-none focus:bg-gray-50"
      />

      <input
        value={qty}
        readOnly={!editable}
        onChange={(e) => setQty(String(clampQty(e.target.value)))}
        onBlur={() => onSaveRowDirect(row, { qty: clampQty(qty) })}
        className="w-full rounded-lg border-none bg-transparent px-1 py-1 outline-none focus:bg-gray-50"
      />

      <div className="font-semibold text-green-700">
        {formatSqm(toSqm(available, size))}
      </div>

      <input
        value={inUse}
        readOnly={!editable}
        onChange={(e) => setInUse(String(clampQty(e.target.value)))}
        onBlur={() => onSaveRowDirect(row, { in_use_qty: clampQty(inUse) })}
        className="w-full rounded-lg border-none bg-transparent px-1 py-1 outline-none focus:bg-gray-50"
      />

      <div className="font-semibold text-yellow-700">
        {formatSqm(toSqm(row.maintenance_qty, size))}
      </div>

      <input
        value={inKsa}
        readOnly={!editable}
        onChange={(e) => setInKsa(String(clampQty(e.target.value)))}
        onBlur={() => onSaveRowDirect(row, { in_ksa_qty: clampQty(inKsa) })}
        className="w-full rounded-lg border-none bg-transparent px-1 py-1 outline-none focus:bg-gray-50"
      />

      <div>
        {editable ? (
          <Trash2 size={15} className="cursor-pointer text-red-500" onClick={() => onDeleteRow(row.id)} />
        ) : null}
      </div>
    </div>
  );
}
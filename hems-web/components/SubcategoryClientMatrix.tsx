"use client";

console.log("MATRIX COMPONENT LOADED");

import React, { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { canEditInventory } from "@/lib/authStore";
import { Trash2, Pencil } from "lucide-react";

type MatrixRow = {
  id: string;
  model_id: string;
  size: string;
  qty: number;
  photo_data?: string | null;
};

type MatrixModel = {
  id: string;
  category_id: string;
  subcategory_id: string;
  name: string;
  model_type?: "length_based" | "component" | "rack";
  photo_data?: string | null;
  matrix_rows?: MatrixRow[];
  created_at?: string;
};

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function clampQty(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function getRowLabel(modelType?: string) {
  if (modelType === "component") return "Item";
  if (modelType === "rack") return "Component";
  return "Specification";
}

function getRowPlaceholder(modelType?: string) {
  if (modelType === "component") return "Enter item";
  if (modelType === "rack") return "Enter component";
  return "Enter specification";
}

export default function SubcategoryClientMatrix({
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

  const [newName, setNewName] = useState("");
  const [newPhoto, setNewPhoto] = useState<string | null>(null);
  const [modelType, setModelType] = useState<"length_based" | "component" | "rack">(
    "length_based"
  );
  const addPhotoRef = useRef<HTMLInputElement | null>(null);

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
      throw new Error("Failed to resolve category for this matrix subcategory.");
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
          "id, category_id, subcategory_id, name, model_type, photo_data, created_at, matrix_rows(id, model_id, size, qty, photo_data)"
        )
        .eq("subcategory_id", subId)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("loadModels relation query error", error);

        const fallback = await supabase
          .from("matrix_models")
          .select("id, category_id, subcategory_id, name, model_type, photo_data, created_at")
          .eq("subcategory_id", subId)
          .order("created_at", { ascending: false });

        if (fallback.error) {
          console.error("loadModels fallback error", fallback.error);
          setModels([]);
          setErrorMsg(fallback.error.message || "Failed to load matrix models.");
          setLoading(false);
          return;
        }

        const base = (fallback.data ?? []) as MatrixModel[];

        const withRows = await Promise.all(
          base.map(async (m) => {
            const rres = await supabase
              .from("matrix_rows")
              .select("id, model_id, size, qty, photo_data")
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
      setErrorMsg(e?.message || "Failed to load matrix models.");
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
        setErrorMsg(e?.message || "Failed to prepare matrix page.");
        setLoading(false);
      }
    }

    void boot();

    return () => {
      mounted = false;
    };
  }, [subcategoryId, categoryId]);

  async function onPickNewPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editable) return;

    const f = e.target.files?.[0];
    if (!f) return;

    try {
      const dataUrl = await fileToDataUrl(f);
      setNewPhoto(dataUrl);
    } finally {
      e.target.value = "";
    }
  }

  async function addModel() {
    if (!editable) {
      setErrorMsg("You do not have permission to add models.");
      return;
    }

    setErrorMsg(null);

    if (!subcategoryId) {
      setErrorMsg("Subcategory is not ready yet.");
      return;
    }

    const clean = newName.trim();
    if (!clean) {
      setErrorMsg("Please enter model name.");
      return;
    }

    setSubmitting(true);

    try {
      const catId = resolvedCategoryId ?? (await resolveCategoryId(subcategoryId));

      const { data: created, error } = await supabase
        .from("matrix_models")
        .insert({
          category_id: catId,
          subcategory_id: subcategoryId,
          name: clean,
          model_type: modelType,
          photo_data: modelType === "component" ? null : newPhoto || null,
        })
        .select("id, category_id, subcategory_id, name, model_type, photo_data, created_at")
        .single();

      if (error || !created) {
        console.error("addModel error", error);
        setErrorMsg(error?.message || "Failed to add model.");
        return;
      }

      const firstRow = await supabase.from("matrix_rows").insert({
        model_id: created.id,
        size: "",
        qty: 0,
        photo_data: null,
      });

      if (firstRow.error) {
        console.error("add first row error", firstRow.error);
        setErrorMsg(firstRow.error.message || "Model added, but failed to create first row.");
        return;
      }

      setNewName("");
      setNewPhoto(null);
      setModelType("length_based");
      setSaveMsg("Model added");

      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Model added" ? "" : prev));
      }, 1500);

      await loadModels(subcategoryId);
    } catch (e: any) {
      console.error("addModel unexpected error", e);
      setErrorMsg(e?.message || "Failed to add model.");
    } finally {
      setSubmitting(false);
    }
  }

  async function renameModel(modelId: string, current: string) {
    if (!editable) return;

    const nextName = prompt("Model name:", current);
    if (!nextName) return;

    const clean = nextName.trim();
    if (!clean) return;

    const { error } = await supabase
      .from("matrix_models")
      .update({ name: clean })
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

  async function deleteModel(modelId: string) {
    if (!editable) return;
    if (!confirm("Delete this model?")) return;

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

  async function changeModelPhoto(modelId: string, file: File) {
    if (!editable) return;

    const dataUrl = await fileToDataUrl(file);

    const { error } = await supabase
      .from("matrix_models")
      .update({ photo_data: dataUrl })
      .eq("id", modelId);

    if (error) {
      console.error("changeModelPhoto error", error);
      alert("Failed to update photo");
      return;
    }

    if (subcategoryId) await loadModels(subcategoryId);
  }

  async function changeRowPhoto(rowId: string, file: File) {
    if (!editable) return;

    const dataUrl = await fileToDataUrl(file);

    const { error } = await supabase
      .from("matrix_rows")
      .update({ photo_data: dataUrl })
      .eq("id", rowId);

    if (error) {
      console.error("changeRowPhoto error", error);
      alert("Failed to update row photo");
      return;
    }

    setModels((prev) =>
      prev.map((m) => ({
        ...m,
        matrix_rows: (m.matrix_rows ?? []).map((r) =>
          r.id === rowId ? { ...r, photo_data: dataUrl } : r
        ),
      }))
    );
  }

  async function addRow(modelId: string) {
    if (!editable) return;

    const { error } = await supabase.from("matrix_rows").insert({
      model_id: modelId,
      size: "",
      qty: 0,
      photo_data: null,
    });

    if (error) {
      console.error("addRow error", error);
      alert("Failed to add row");
      return;
    }

    if (subcategoryId) {
      setSaveMsg("Row added");
      setTimeout(() => {
        setSaveMsg((prev) => (prev === "Row added" ? "" : prev));
      }, 1500);

      await loadModels(subcategoryId);
    }
  }

  async function updateRow(
    rowId: string,
    patch: Partial<Pick<MatrixRow, "size" | "qty">>
  ) {
    if (!editable) return;

    const payload: Partial<Pick<MatrixRow, "size" | "qty">> = {};
    if (patch.size !== undefined) payload.size = patch.size;
    if (patch.qty !== undefined) payload.qty = clampQty(patch.qty);

    const { error } = await supabase.from("matrix_rows").update(payload).eq("id", rowId);

    if (error) {
      console.error("updateRow error", error);
      alert("Update failed");
      return;
    }

    setModels((prev) =>
      prev.map((m) => ({
        ...m,
        matrix_rows: (m.matrix_rows ?? []).map((r) =>
          r.id === rowId ? { ...r, ...payload } : r
        ),
      }))
    );
  }

  async function deleteRow(rowId: string) {
    if (!editable) return;
    if (!confirm("Delete this row?")) return;

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

  if (loading) {
    return (
      <div className="max-w-[1100px] mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
          Loading models...
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1100px] mx-auto space-y-3 text-black">
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
              Add Model
            </h1>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[160px_minmax(0,1fr)_auto_auto] gap-3">
            <select
              value={modelType}
              onChange={(e) =>
                setModelType(e.target.value as "length_based" | "component" | "rack")
              }
              className="border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-black text-[12px] text-gray-900"
            >
              <option value="length_based">Length Based</option>
              <option value="component">Component</option>
              <option value="rack">Rack</option>
            </select>

            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Model name"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-black text-[12px] text-gray-900"
            />

            {modelType !== "component" && (
              <>
                <input
                  ref={addPhotoRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPickNewPhoto}
                />

                <button
                  type="button"
                  onClick={() => addPhotoRef.current?.click()}
                  className="w-full md:w-auto px-2 py-1.5 rounded-full border border-gray-300 text-[9px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
                >
                  {newPhoto ? "Photo ✔" : "Upload Photo"}
                </button>
              </>
            )}

            <button
              type="button"
              onClick={addModel}
              className="w-full md:w-auto px-2 py-1.5 rounded-full border border-black text-[9px] font-medium text-white bg-black transition-all duration-150 ease-out hover:opacity-90 active:scale-[0.98]"
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

      {models.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
          No models yet.
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          {models.map((m, index) => {
            const isLast = index === models.length - 1;

            return (
              <div key={m.id} className={!isLast ? "pb-4 mb-4" : ""}>
                <ModelCard
                  model={m}
                  editable={editable}
                  onRename={() => renameModel(m.id, m.name)}
                  onDelete={() => deleteModel(m.id)}
                  onAddRow={() => addRow(m.id)}
                  onUpdateRow={(rowId, patch) => updateRow(rowId, patch)}
                  onDeleteRow={(rowId) => deleteRow(rowId)}
                  onPickPhoto={(file) => changeModelPhoto(m.id, file)}
                  onPickRowPhoto={(rowId, file) => changeRowPhoto(rowId, file)}
                />
              </div>
            );
          })}
        </div>
      )}

      {!loading && !subcategoryId && (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 text-sm text-red-600">
          Could not resolve this subcategory in database.
        </div>
      )}
    </div>
  );
}

function ModelCard({
  model,
  editable,
  onRename,
  onDelete,
  onAddRow,
  onUpdateRow,
  onDeleteRow,
  onPickPhoto,
  onPickRowPhoto,
}: {
  model: MatrixModel;
  editable: boolean;
  onRename: () => void;
  onDelete: () => void;
  onAddRow: () => void;
  onUpdateRow: (rowId: string, patch: Partial<Pick<MatrixRow, "size" | "qty">>) => void;
  onDeleteRow: (rowId: string) => void;
  onPickPhoto: (file: File) => Promise<void>;
  onPickRowPhoto: (rowId: string, file: File) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const rows = model.matrix_rows ?? [];

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editable) return;

    const f = e.target.files?.[0];
    if (!f) return;
    try {
      await onPickPhoto(f);
    } finally {
      e.target.value = "";
    }
  }

  return (
    <div className="text-black bg-white border border-gray-200 rounded-2xl p-4">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onChange}
      />

      <div className="mb-4">
        <div className="flex items-start gap-3">
          {model.model_type !== "component" && (
            <div className="relative h-[40px] w-[40px] min-w-[40px] sm:h-[56px] sm:w-[56px] sm:min-w-[56px]">
              <ProjectPhotoBlock photo={model.photo_data} name={model.name} />

              {editable && (
                <button
                  type="button"
                  title="Change photo"
                  onClick={() => fileRef.current?.click()}
                  className="absolute top-0 right-0 z-20 translate-x-1/4 -translate-y-1/4 text-red-500 transition-colors hover:text-black"
                >
                  <Pencil size={13} strokeWidth={2} />
                </button>
              )}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h2
                className="truncate text-[10px] sm:text-[14px] font-semibold text-gray-900"
                style={{ lineHeight: 1.1 }}
              >
                {model.name}
              </h2>

              {editable && (
                <button
                  type="button"
                  title="Rename"
                  onClick={onRename}
                  className="text-red-500 text-[12px] shrink-0 transition-colors hover:text-black"
                >
                  ✎
                </button>
              )}

              {editable && (
                <button
                  type="button"
                  title="Delete"
                  onClick={onDelete}
                  className="ml-auto text-red-500 text-[13px] shrink-0 transition-colors hover:text-black"
                >
                  <Trash2 size={15} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl">
        <div className="grid grid-cols-12 gap-2 text-[9px] sm:text-[10px] font-medium text-gray-600 px-1 pb-2 border-b border-gray-200">
          <div className="col-span-8">{getRowLabel(model.model_type)}</div>
          <div className="col-span-2 text-right">Qty</div>
          <div className="col-span-2"></div>
        </div>

        {rows.map((r, index) => (
          <MatrixRowItem
            key={r.id}
            row={r}
            modelType={model.model_type}
            editable={editable}
            onUpdateRow={onUpdateRow}
            onDeleteRow={onDeleteRow}
            onPickRowPhoto={onPickRowPhoto}
            isLast={index === rows.length - 1}
          />
        ))}

        {editable && (
          <div className="pt-3">
            <button
              type="button"
              onClick={onAddRow}
              className="px-2 py-1 rounded-full border border-gray-300 text-[9px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
            >
              + Add Row
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MatrixRowItem({
  row,
  modelType,
  editable,
  onUpdateRow,
  onDeleteRow,
  onPickRowPhoto,
  isLast,
}: {
  row: MatrixRow;
  modelType?: "length_based" | "component" | "rack";
  editable: boolean;
  onUpdateRow: (rowId: string, patch: Partial<Pick<MatrixRow, "size" | "qty">>) => void;
  onDeleteRow: (rowId: string) => void;
  onPickRowPhoto: (rowId: string, file: File) => Promise<void>;
  isLast: boolean;
}) {
  const [localSize, setLocalSize] = useState(row.size ?? "");
  const [localQty, setLocalQty] = useState<number>(row.qty ?? 0);
  const rowPhotoRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // sync
  useEffect(() => setLocalSize(row.size ?? ""), [row.size]);
  useEffect(() => setLocalQty(row.qty ?? 0), [row.qty]);

  // auto save size
  useEffect(() => {
    const t = setTimeout(() => {
      if (editable && localSize !== (row.size ?? "")) {
        onUpdateRow(row.id, { size: localSize });
      }
    }, 500);
    return () => clearTimeout(t);
  }, [localSize]);

  // auto save qty
  useEffect(() => {
    const t = setTimeout(() => {
      if (editable && localQty !== (row.qty ?? 0)) {
        onUpdateRow(row.id, { qty: localQty });
      }
    }, 500);
    return () => clearTimeout(t);
  }, [localQty]);

  // auto resize textarea
  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
  }, [localSize]);

  async function onChangeRowPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (!editable) return;
    const f = e.target.files?.[0];
    if (!f) return;

    try {
      await onPickRowPhoto(row.id, f);
    } finally {
      e.target.value = "";
    }
  }

  return (
    <div
      className={`grid grid-cols-12 gap-2 items-start py-2 ${
        !isLast ? "border-b border-gray-100" : ""
      }`}
    >
      {/* SPECIFICATION */}
      <div className="col-span-8">
        {modelType === "component" ? (
          <div className="flex items-start gap-3">
            <input
              ref={rowPhotoRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onChangeRowPhoto}
            />

            {/* PHOTO */}
            <div className="relative h-[34px] w-[34px] min-w-[34px] sm:h-[44px] sm:w-[44px]">
              <RowPhotoBlock photo={row.photo_data} name={row.size || "row"} />

              {editable && (
                <button
                  type="button"
                  onClick={() => rowPhotoRef.current?.click()}
                  className="absolute top-0 right-0 translate-x-1/4 -translate-y-1/4 text-red-500 hover:text-black"
                >
                  ✎
                </button>
              )}
            </div>

            {/* TEXTAREA */}
            <textarea
              ref={textareaRef}
              value={localSize}
              readOnly={!editable}
              onChange={(e) => setLocalSize(e.target.value)}
              placeholder={getRowPlaceholder(modelType)}
              rows={1}
              className="flex-1 resize-none bg-transparent outline-none text-[10px] sm:text-[12px] text-black leading-tight"
            />
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={localSize}
            readOnly={!editable}
            onChange={(e) => setLocalSize(e.target.value)}
            placeholder={getRowPlaceholder(modelType)}
            rows={1}
            className="w-full resize-none bg-transparent outline-none text-[10px] sm:text-[12px] text-black leading-tight"
          />
        )}
      </div>

      {/* QTY */}
      <div className="col-span-2 flex justify-end">
        <input
          type="number"
          min={0}
          value={String(localQty)}
          readOnly={!editable}
          onChange={(e) => setLocalQty(clampQty(e.target.value))}
          className="w-10 sm:w-12 text-right bg-transparent outline-none text-[10px] sm:text-[12px]"
        />
      </div>

      {/* DELETE */}
      <div className="col-span-2 flex justify-end items-center">
        {editable && (
          <Trash2
            size={14}
            className="cursor-pointer text-red-500 hover:text-black"
            onClick={() => onDeleteRow(row.id)}
          />
        )}
      </div>
    </div>
  );
}

function ProjectPhotoBlock({
  photo,
  name,
}: {
  photo?: string | null;
  name: string;
}) {
  const [hover, setHover] = useState(false);

  return (
    <div
      className="w-full h-full relative overflow-visible"
      style={{ zIndex: hover ? 50 : 1 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {photo ? (
        <img
          src={photo}
          alt={name}
          className="w-full h-full object-cover rounded-[8px] block bg-white"
        />
      ) : (
        <div className="w-full h-full rounded-[8px] bg-white flex items-center justify-center text-[8px] sm:text-[10px] text-gray-400">
          No photo
        </div>
      )}

      {hover && photo && (
        <div
          style={{
            position: "absolute",
            top: "0",
            left: "70px",
            width: "240px",
            height: "240px",
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: "12px",
            padding: "8px",
            boxShadow: "0 15px 35px rgba(0,0,0,0.2)",
            zIndex: 9999,
          }}
        >
          <img
            src={photo}
            alt={name}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              borderRadius: "8px",
              display: "block",
              background: "#ffffff",
            }}
          />
        </div>
      )}
    </div>
  );
}

function RowPhotoBlock({
  photo,
  name,
}: {
  photo?: string | null;
  name: string;
}) {
  const [hover, setHover] = useState(false);

  return (
    <div
      className="w-full h-full relative overflow-visible"
      style={{ zIndex: hover ? 50 : 1 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {photo ? (
        <img
          src={photo}
          alt={name}
          className="w-full h-full object-cover rounded-[8px] block bg-white"
        />
      ) : (
        <div className="w-full h-full rounded-[8px] bg-white flex items-center justify-center text-[7px] sm:text-[9px] text-gray-400 border border-gray-200">
          No
        </div>
      )}

      {hover && photo && (
        <div
          style={{
            position: "absolute",
            top: "0",
            left: "56px",
            width: "220px",
            height: "220px",
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: "12px",
            padding: "8px",
            boxShadow: "0 15px 35px rgba(0,0,0,0.2)",
            zIndex: 9999,
          }}
        >
          <img
            src={photo}
            alt={name}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              borderRadius: "8px",
              display: "block",
              background: "#ffffff",
            }}
          />
        </div>
      )}
    </div>
  );
}
"use client";

import { useEffect, useMemo, useState } from "react";
import type { Catalog, SubcategoryType } from "@/lib/catalogStore";
import {
  readCatalog,
  addCategory,
  renameCategory,
  deleteCategory,
  addSubcategory,
  renameSubcategory,
  deleteSubcategory,
  setSubcategoryType,
} from "@/lib/catalogStore";
import Link from "next/link";

const TYPE_LABEL: Record<SubcategoryType, string> = {
  matrix: "Matrix",
  fixture_units: "Serialized",
  chain_hoist_units: "Chain Hoist",
  projector_units: "Projector",
  lens_units: "Lens",
  led_screen_units: "LED Screen",
};

function slugify(input: string) {
  return input
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export default function CatalogSettingsClient() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false);

  const [newCatName, setNewCatName] = useState("");
  const [catErr, setCatErr] = useState<string | null>(null);

  const [subName, setSubName] = useState<Record<string, string>>({});
  const [subType, setSubType] = useState<Record<string, SubcategoryType>>({});

  const typeOptions = useMemo(() => {
    return (Object.keys(TYPE_LABEL) as SubcategoryType[]).map((t) => ({
      value: t,
      label: TYPE_LABEL[t],
    }));
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const c = await readCatalog();
      setCatalog(c);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onAddCategory() {
    setCatErr(null);

    const name = newCatName.trim();
    if (!name) {
      setCatErr("Please enter a category name.");
      return;
    }

    const slug = slugify(name);

    const res = await addCategory(name, slug);
    if (!res) {
      setCatErr("Failed to add category.");
      return;
    }

    setNewCatName("");
    await refresh();
  }

  async function onRenameCategory(catId: string, currentName: string, currentSlug: string) {
    const next = prompt("Rename category:", currentName);
    if (!next) return;

    const name = next.trim();
    if (!name) return;

    const slug = slugify(name) || currentSlug;

    const res = await renameCategory(catId, name, slug);
    if (!res) {
      alert("Rename failed");
      return;
    }

    await refresh();
  }

  async function onDeleteCategory(catId: string) {
    if (!confirm("Delete this category? (This will remove its subcategories too)")) return;

    const res = await deleteCategory(catId);
    if (!res) {
      alert("Delete failed");
      return;
    }

    await refresh();
  }

  async function onAddSub(catId: string) {
    const name = (subName[catId] ?? "").trim();
    if (!name) {
      alert("Enter subcategory name");
      return;
    }

    const slug = slugify(name);
    const type = subType[catId] ?? "fixture_units";

    const res = await addSubcategory(catId, name, slug, type);
    if (!res) {
      alert("Failed to add subcategory");
      return;
    }

    setSubName((p) => ({ ...p, [catId]: "" }));
    await refresh();
  }

  async function onRenameSub(subId: string, currentName: string, currentSlug: string) {
    const next = prompt("Rename subcategory:", currentName);
    if (!next) return;

    const name = next.trim();
    if (!name) return;

    const slug = slugify(name) || currentSlug;

    const res = await renameSubcategory(subId, name, slug);
    if (!res) {
      alert("Rename failed");
      return;
    }

    await refresh();
  }

  async function onDeleteSub(subId: string) {
    if (!confirm("Delete this subcategory?")) return;

    const res = await deleteSubcategory(subId);
    if (!res) {
      alert("Delete failed");
      return;
    }

    await refresh();
  }

  async function onChangeType(subId: string, nextType: SubcategoryType) {
    const res = await setSubcategoryType(subId, nextType);
    if (!res) {
      alert("Failed to update type");
      return;
    }
    await refresh();
  }

  if (!catalog) {
    return (
      <div className="bg-white border rounded-2xl p-4 text-gray-900 text-sm">
        Loading...
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* HEADER */}
      <div className="bg-white border rounded-2xl p-4 text-gray-900">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-bold leading-tight">
              Manage Categories & Subcategories
            </h1>
            <p className="text-xs text-gray-600 mt-1">
              Create, rename, delete and manage inventory structure.
            </p>
            {loading && <p className="text-[11px] text-gray-500 mt-1">Refreshing…</p>}
          </div>

          <Link
            href="/settings"
            className="px-3 py-1.5 rounded-full border text-xs font-medium hover:bg-gray-50 shrink-0"
          >
            Back
          </Link>
        </div>
      </div>

      {/* ADD CATEGORY */}
      <div className="bg-white border rounded-2xl p-4 text-gray-900">
        <h2 className="text-xs font-bold text-gray-900 mb-2 uppercase tracking-wide">
          Add Category
        </h2>

        <div className="flex gap-2 max-w-xl">
          <input
            value={newCatName}
            onChange={(e) => setNewCatName(e.target.value)}
            placeholder="Category name"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black"
          />
          <button
            onClick={onAddCategory}
            className="px-4 py-2 rounded-full bg-black text-white text-xs font-medium hover:opacity-90 shrink-0"
          >
            Add
          </button>
        </div>

        {catErr && <div className="text-xs text-red-600 mt-2">{catErr}</div>}
      </div>

      {/* CATEGORIES LIST */}
      <div className="bg-white border rounded-2xl p-4 text-gray-900">
        <h2 className="text-xs font-bold text-gray-900 mb-3 uppercase tracking-wide">
          Categories
        </h2>

        {(catalog.categories?.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-600">No categories yet.</p>
        ) : (
          <div className="space-y-3">
            {catalog.categories.map((cat) => {
              const draftName = subName[cat.id] ?? "";
              const draftType = subType[cat.id] ?? "fixture_units";
              const subcats = cat.subcategories ?? [];

              return (
                <div key={cat.id} className="border rounded-2xl p-3">
                  {/* Category header */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-gray-900 truncate">
                        {cat.name}
                      </div>
                      <div className="text-[11px] text-gray-500 break-all">
                        Slug: {cat.slug}
                      </div>
                    </div>

                    <div className="flex gap-1.5 shrink-0">
                      <button
                        onClick={() => onRenameCategory(cat.id, cat.name, cat.slug)}
                        className="px-3 py-1.5 rounded-full border text-[11px] font-medium hover:bg-gray-50"
                      >
                        Rename
                      </button>

                      <button
                        onClick={() => onDeleteCategory(cat.id)}
                        className="px-3 py-1.5 rounded-full border text-[11px] font-medium hover:bg-gray-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>

                  {/* Add subcategory */}
                  <div className="mt-3 border-t pt-3">
                    <div className="text-[11px] font-bold text-gray-700 mb-2 uppercase tracking-wide">
                      Add Subcategory
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                      <input
                        value={draftName}
                        onChange={(e) =>
                          setSubName((p) => ({ ...p, [cat.id]: e.target.value }))
                        }
                        placeholder="Subcategory name"
                        className="md:col-span-6 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black"
                      />

                      <select
                        value={draftType}
                        onChange={(e) =>
                          setSubType((p) => ({
                            ...p,
                            [cat.id]: e.target.value as SubcategoryType,
                          }))
                        }
                        className="md:col-span-4 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-black"
                      >
                        {typeOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>

                      <button
                        onClick={() => onAddSub(cat.id)}
                        className="md:col-span-2 px-4 py-2 rounded-full bg-black text-white text-xs font-medium hover:opacity-90"
                      >
                        Add
                      </button>
                    </div>
                  </div>

                  {/* Subcategories list */}
                  <div className="mt-3">
                    <div className="text-[11px] font-bold text-gray-700 mb-2 uppercase tracking-wide">
                      Subcategories
                    </div>

                    {subcats.length === 0 ? (
                      <p className="text-sm text-gray-600">No subcategories yet.</p>
                    ) : (
                      <div className="border rounded-2xl overflow-hidden">
                        {subcats.map((sub, idx) => {
                          const t = (sub.type ?? "fixture_units") as SubcategoryType;

                          return (
                            <div
                              key={sub.id}
                              className={`px-3 py-2.5 ${
                                idx !== subcats.length - 1 ? "border-b" : ""
                              }`}
                            >
                              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="font-medium text-sm text-gray-900 truncate">
                                    {sub.name}
                                  </div>
                                  <div className="text-[11px] text-gray-500 break-all">
                                    Slug: {sub.slug} • Type: {TYPE_LABEL[t]}
                                  </div>
                                </div>

                                <div className="flex flex-wrap gap-1.5 items-center shrink-0">
                                  <select
                                    value={t}
                                    onChange={(e) =>
                                      onChangeType(sub.id, e.target.value as SubcategoryType)
                                    }
                                    className="border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-[11px] outline-none focus:ring-2 focus:ring-black"
                                  >
                                    {typeOptions.map((o) => (
                                      <option key={o.value} value={o.value}>
                                        {o.label}
                                      </option>
                                    ))}
                                  </select>

                                  <button
                                    onClick={() => onRenameSub(sub.id, sub.name, sub.slug)}
                                    className="px-3 py-1.5 rounded-full border text-[11px] font-medium hover:bg-gray-50"
                                  >
                                    Rename
                                  </button>

                                  <button
                                    onClick={() => onDeleteSub(sub.id)}
                                    className="px-3 py-1.5 rounded-full border text-[11px] font-medium hover:bg-gray-50"
                                  >
                                    Delete
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
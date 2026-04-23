"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Department = "" | "lighting" | "video" | "rigging";
type UserRole = "admin" | "warehouse_manager" | "viewer" | "head";

type Item = {
  id: string;
  name: string;
};

type MatrixRowOption = {
  id: string;
  size: string;
};

type SubOption = {
  label: string;
  value: string;
};

export default function UpdateReportPage() {
  const supabase = createClient();

  const [role, setRole] = useState<UserRole | "">("");
  const [department, setDepartment] = useState<Department>("");
  const [subcategory, setSubcategory] = useState<string>("");

  const [items, setItems] = useState<Item[]>([]);
  const [filteredItems, setFilteredItems] = useState<Item[]>([]);
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);

  const [ledRows, setLedRows] = useState<MatrixRowOption[]>([]);
  const [selectedLedRow, setSelectedLedRow] = useState<MatrixRowOption | null>(null);

  const [search, setSearch] = useState("");

  const [loadingProfile, setLoadingProfile] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function loadUserProfile() {
    setLoadingProfile(true);
    setErr(null);

    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();

      if (userErr || !user) {
        throw new Error("User not found.");
      }

      const { data: profile, error: profileErr } = await supabase
        .from("profiles")
        .select("role, department")
        .eq("id", user.id)
        .single();

      if (profileErr || !profile) {
        throw new Error("Profile not found.");
      }

      const nextRole = (profile.role ?? "") as UserRole | "";
      const nextDepartment = (profile.department ?? "") as Department;

      setRole(nextRole);

      if (nextRole === "head") {
        setDepartment(nextDepartment);
      } else if (nextRole === "admin") {
        setDepartment("");
      } else {
        setDepartment(nextDepartment || "");
      }
    } catch (e: any) {
      setErr(e?.message || "Failed to load user profile.");
    } finally {
      setLoadingProfile(false);
    }
  }

  function getSubcategoryOptions(dep: Department): SubOption[] {
    if (dep === "lighting") {
      return [
        { label: "Lighting Fixtures", value: "lighting-fixtures" },
        { label: "Lighting Controllers", value: "lighting-controllers" },
      ];
    }

    if (dep === "video") {
      return [
        { label: "LED Screen", value: "led-screen" },
        { label: "Projectors", value: "projectors" },
        { label: "Media Server", value: "media-server" },
        { label: "LED Video Processor", value: "led-video-processor" },
      ];
    }

    if (dep === "rigging") {
      return [{ label: "Chain Hoist", value: "chain-hoist" }];
    }

    return [];
  }

  const subcategoryOptions = useMemo(
    () => getSubcategoryOptions(department),
    [department]
  );

  async function resolveSubcategoryId(slug: string) {
    const candidates = Array.from(
      new Set(
        [
          slug,
          slug.replace(/_/g, "-"),
          slug.replace(/-/g, "_"),
          slug.endsWith("s") ? slug.slice(0, -1) : `${slug}s`,
          slug === "chain-hoists" ? "chain-hoist" : "",
          slug === "chain-hoist" ? "chain-hoists" : "",
          slug === "led-screen" ? "led-screens" : "",
          slug === "led-screens" ? "led-screen" : "",
          slug === "media-server" ? "media-servers" : "",
          slug === "media-servers" ? "media-server" : "",
          slug === "led-video-processor" ? "led-video-processors" : "",
          slug === "led-video-processors" ? "led-video-processor" : "",
        ].filter(Boolean)
      )
    );

    for (const candidate of candidates) {
      const { data, error } = await supabase
        .from("subcategories")
        .select("id, slug")
        .eq("slug", candidate)
        .maybeSingle();

      if (!error && data?.id) {
        return data.id as string;
      }
    }

    throw new Error("Subcategory not found.");
  }

  async function loadItemsForSubcategory() {
    if (!subcategory) {
      setItems([]);
      setFilteredItems([]);
      setSelectedItem(null);
      setLedRows([]);
      setSelectedLedRow(null);
      return;
    }

    setLoadingItems(true);
    setErr(null);

    try {
      const subcategoryId = await resolveSubcategoryId(subcategory);

      if (subcategory === "led-screen" || subcategory === "led-screens") {
        const { data, error } = await supabase
          .from("matrix_models")
          .select("id, name")
          .eq("subcategory_id", subcategoryId)
          .order("name");

        if (error) throw error;

        const list = (data ?? []) as Item[];
        setItems(list);
        setFilteredItems(list);
        setSelectedItem(null);
        setLedRows([]);
        setSelectedLedRow(null);
        return;
      }

      const { data, error } = await supabase
        .from("items")
        .select("id, name")
        .eq("subcategory_id", subcategoryId)
        .order("name");

      if (error) throw error;

      const list = (data ?? []) as Item[];
      setItems(list);
      setFilteredItems(list);
      setSelectedItem(null);
      setLedRows([]);
      setSelectedLedRow(null);
    } catch (e: any) {
      setErr(e?.message || "Failed to load items.");
      setItems([]);
      setFilteredItems([]);
      setSelectedItem(null);
      setLedRows([]);
      setSelectedLedRow(null);
    } finally {
      setLoadingItems(false);
    }
  }

  async function loadLedRows(modelId: string) {
    setLoadingRows(true);
    setErr(null);

    try {
      const { data, error } = await supabase
        .from("matrix_rows")
        .select("id, size")
        .eq("model_id", modelId)
        .order("size", { ascending: true });

      if (error) throw error;

      setLedRows((data ?? []) as MatrixRowOption[]);
      setSelectedLedRow(null);
    } catch (e: any) {
      setErr(e?.message || "Failed to load cabinet sizes.");
      setLedRows([]);
      setSelectedLedRow(null);
    } finally {
      setLoadingRows(false);
    }
  }

  useEffect(() => {
    void loadUserProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setSubcategory("");
    setItems([]);
    setFilteredItems([]);
    setSelectedItem(null);
    setLedRows([]);
    setSelectedLedRow(null);
    setSearch("");
    setErr(null);
  }, [department]);

  useEffect(() => {
    setSearch("");
    setSelectedItem(null);
    setSelectedLedRow(null);
    void loadItemsForSubcategory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subcategory]);

  useEffect(() => {
    const q = search.trim().toLowerCase();

    if (!q) {
      setFilteredItems(items);
      return;
    }

    setFilteredItems(
      items.filter((item) => item.name.toLowerCase().includes(q))
    );
  }, [search, items]);

  useEffect(() => {
    if ((subcategory === "led-screen" || subcategory === "led-screens") && selectedItem?.id) {
      void loadLedRows(selectedItem.id);
      return;
    }

    setLedRows([]);
    setSelectedLedRow(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem, subcategory]);

  function openReport() {
    if (!subcategory) return;

    if (subcategory === "led-screen" || subcategory === "led-screens") {
      if (!selectedLedRow) return;
      window.location.href = `/equipment-report/update/led-screen/${selectedLedRow.id}`;
      return;
    }

    if (!selectedItem) return;

    if (subcategory === "projectors") {
      window.location.href = `/equipment-report/update/projectors/${selectedItem.id}`;
      return;
    }

    if (subcategory === "chain-hoist" || subcategory === "chain-hoists") {
      window.location.href = `/equipment-report/update/chain-hoist/${selectedItem.id}`;
      return;
    }

    if (
      subcategory === "led-video-processor" ||
      subcategory === "led-video-processors"
    ) {
      window.location.href = `/equipment-report/update/led-video-processor/${selectedItem.id}`;
      return;
    }

    window.location.href = `/equipment-report/update/${subcategory}/${selectedItem.id}`;
  }

  const canOpen =
    subcategory === "led-screen" || subcategory === "led-screens"
      ? !!selectedLedRow
      : !!selectedItem;

  if (loadingProfile || !role) {
    return (
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="max-w-[1100px] mx-auto space-y-3">
          <div className="bg-white border border-gray-200 rounded-2xl p-6 text-gray-900">
            Loading...
          </div>
        </div>
      </div>
    );
  }

  if (role === "viewer") {
    return (
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="max-w-[900px] mx-auto">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-gray-900">
            <div className="text-lg font-semibold">Access denied</div>
            <div className="text-sm text-gray-600 mt-2">
              You do not have permission to access Update Report.
            </div>

            <div className="mt-4">
              <Link
                href="/equipment-report"
                className="px-3 py-2 rounded-full border border-gray-300 text-[11px] font-medium text-gray-700 bg-white hover:bg-red-50 hover:border-red-200 hover:text-red-700"
              >
                ← Back
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
        <div className="bg-white border border-gray-200 rounded-2xl p-6 text-gray-900">
          <div className="flex justify-between items-start gap-3">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    backgroundColor: "#ef4444",
                    display: "inline-block",
                  }}
                ></span>

                <h1 className="text-[26px] font-bold text-gray-900 leading-tight">
                  Update Report
                </h1>
              </div>

              <p className="text-[12px] text-gray-600 mt-2">
                Select department, category, and item to open report.
              </p>
            </div>

            <Link
              href="/equipment-report"
              className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
            >
              ← Back
            </Link>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl p-6 text-gray-900 space-y-5">
          {err ? (
            <div className="text-[12px] text-red-600">{err}</div>
          ) : null}

          <div>
            <label className="text-[12px] font-medium text-gray-700">Department</label>

            {role === "admin" ? (
              <select
                value={department}
                onChange={(e) => setDepartment(e.target.value as Department)}
                className="w-full mt-1 border border-gray-300 rounded-xl px-3 py-2 bg-white text-[12px] text-gray-900"
              >
                <option value="">Select department</option>
                <option value="lighting">Lighting</option>
                <option value="video">Video</option>
                <option value="rigging">Rigging</option>
              </select>
            ) : (
              <input
                value={department}
                readOnly
                className="w-full mt-1 border border-gray-300 rounded-xl px-3 py-2 bg-gray-50 text-[12px] text-gray-900"
              />
            )}
          </div>

          <div>
            <label className="text-[12px] font-medium text-gray-700">Category</label>

            <select
              value={subcategory}
              onChange={(e) => {
                setSubcategory(e.target.value);
              }}
              disabled={!department}
              className="w-full mt-1 border border-gray-300 rounded-xl px-3 py-2 bg-white text-[12px] text-gray-900 disabled:bg-gray-50"
            >
              <option value="">Select category</option>
              {subcategoryOptions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {subcategory ? (
            <div>
              <label className="text-[12px] font-medium text-gray-700">
                {subcategory === "led-screen" || subcategory === "led-screens"
                  ? "Search & Select Brand & Model"
                  : "Search & Select Item"}
              </label>

              <div className="relative mt-1">
                <input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setSelectedItem(null);
                    setSelectedLedRow(null);
                  }}
                  placeholder={
                    subcategory === "led-screen" || subcategory === "led-screens"
                      ? "Type brand or model..."
                      : "Type item name..."
                  }
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-[12px] text-gray-900"
                />

                {search && !selectedItem ? (
                  <div className="absolute z-10 mt-1 w-full border border-gray-300 rounded-xl bg-white max-h-60 overflow-y-auto shadow-sm">
                    {loadingItems ? (
                      <div className="p-3 text-[12px] text-gray-500">Loading...</div>
                    ) : filteredItems.length === 0 ? (
                      <div className="p-3 text-[12px] text-gray-500">No items found.</div>
                    ) : (
                      filteredItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setSelectedItem(item);
                            setSearch(item.name);
                          }}
                          className="w-full text-left px-3 py-2 text-[12px] text-gray-800 hover:bg-gray-50 border-b border-gray-200 last:border-b-0"
                        >
                          {item.name}
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>

              {selectedItem ? (
                <div className="mt-2 text-[11px] text-gray-500">
                  Selected:{" "}
                  <span className="text-gray-900 font-medium">
                    {selectedItem.name}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {(subcategory === "led-screen" || subcategory === "led-screens") && selectedItem ? (
            <div>
              <label className="text-[12px] font-medium text-gray-700">
                Select Cabinet Size
              </label>

              <div className="mt-1 border border-gray-300 rounded-xl max-h-64 overflow-y-auto bg-white">
                {loadingRows ? (
                  <div className="p-3 text-[12px] text-gray-500">Loading cabinet sizes...</div>
                ) : ledRows.length === 0 ? (
                  <div className="p-3 text-[12px] text-gray-500">No cabinet sizes found.</div>
                ) : (
                  ledRows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => setSelectedLedRow(row)}
                      className={`w-full text-left p-3 text-[12px] hover:bg-gray-50 border-b border-gray-200 last:border-b-0 ${
                        selectedLedRow?.id === row.id ? "bg-gray-100 font-medium text-gray-900" : "text-gray-800"
                      }`}
                    >
                      {row.size}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}

          <div className="pt-1">
            <button
              onClick={openReport}
              disabled={!canOpen}
              className="px-3 py-2 rounded-full bg-black text-white text-[11px] font-medium transition-all duration-150 ease-out disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 active:scale-[0.98]"
            >
              Open Report
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
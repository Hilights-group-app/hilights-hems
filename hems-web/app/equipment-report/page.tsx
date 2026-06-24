"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, Download } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { SerializedRowsBlock } from "@/app/equipment-report/update/[subcategory]/[itemId]/page";
import { ChainHoistRowsBlock } from "@/app/equipment-report/update/chain-hoist/[itemId]/page";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

type ReportItem = {
  id: string;
  name: string;
  photo_url: string | null;
};

type LedRowOption = {
  id: string;
  model_id: string;
  size: string;
  qty: number | null;
  available_qty: number | null;
  in_use_qty: number | null;
  maintenance_qty: number | null;
  in_ksa_qty: number | null;
};

type Stats = {
  total: number;
  available: number;
  inUse: number;
  maintenance: number;
  inKsa: number;
};

type ChainStats = {
  total: number;
  available: number;
  inuse: number;
  maintenance: number;
  ksa: number;
  expired: number;
};

type ReportGroup = {
  id: string;
  title: string;
  options: {
    label: string;
    slug: string;
  }[];
};

type UserRole = "admin" | "warehouse_manager" | "viewer" | "head";
type Department = "" | "lighting" | "video" | "rigging";

type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

type ProjectorUnit = {
  id: string;
  unit_no: number | string | null;
  serial: string | null;
  status: string | null;
  lamp_hours: number | null;
  notes: string | null;
  testing_date: string | null;
  damage_photos: string[] | null;
};

type LedMaintenanceLog = {
  id: string;
  problem_type: string;
  qty: number | null;
  team_name: string | null;
  event_name: string | null;
  event_date: string | null;
  note: string | null;
  photo_data: string | null;
  photo_data_list: string[] | null;
  created_at: string | null;
};

const reportGroups: ReportGroup[] = [
  {
    id: "lighting",
    title: "Lighting",
    options: [
      { label: "Lighting Fixtures", slug: "lighting-fixtures" },
      { label: "Lighting Controllers", slug: "lighting-controllers" },
    ],
  },
  {
    id: "video",
    title: "Video",
    options: [
      { label: "LED Screen", slug: "led-screen" },
      { label: "Projectors", slug: "projectors" },
      { label: "Media Server", slug: "media-server" },
      { label: "LED Video Processor", slug: "led-video-processor" },
    ],
  },
  {
    id: "rigging",
    title: "Rigging",
    options: [{ label: "Chain Hoist", slug: "chain-hoist" }],
  },
];

function toStatus(v: any): UnitStatus {
  if (
    v === "available" ||
    v === "in_use" ||
    v === "maintenance" ||
    v === "in_ksa"
  ) {
    return v;
  }

  return "available";
}

function clampQty(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function getStatusLabel(status: string | null) {
  if (status === "in_use") return "In Use";
  if (status === "in_ksa") return "In KSA";
  if (status === "maintenance") return "Maintenance";
  return "Available";
}

function getStatusTextColor(status: string | null) {
  switch (status) {
    case "available":
      return "#16a34a";
    case "in_use":
      return "#2563eb";
    case "maintenance":
      return "#ca8a04";
    case "in_ksa":
      return "#7c3aed";
    default:
      return "#374151";
  }
}

function normalizePhotoList(input: unknown, fallback?: string | null): string[] {
  const arr = Array.isArray(input)
    ? input.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];

  if (arr.length > 0) return arr.slice(0, 3);
  if (fallback && typeof fallback === "string") return [fallback];
  return [];
}

function parseLedName(name: string) {
  const clean = name.trim().replace(/\s+/g, " ");
  const parts = clean.split(" - ");

  if (parts.length >= 2) {
    return {
      brand: parts[0],
      model: parts.slice(1).join(" - "),
    };
  }

  const firstSpace = clean.indexOf(" ");
  if (firstSpace === -1) return { brand: clean, model: "" };

  return {
    brand: clean.slice(0, firstSpace),
    model: clean.slice(firstSpace + 1),
  };
}

export default function EquipmentReportPage() {
  const supabase = createClient();

  const [profileLoading, setProfileLoading] = useState(true);
  const [role, setRole] = useState<UserRole | "">("");
  const [department, setDepartment] = useState<Department>("");

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    lighting: true,
    video: true,
    rigging: true,
  });

  const [selectedSubcategory, setSelectedSubcategory] = useState("");
  const [selectedSubcategoryLabel, setSelectedSubcategoryLabel] = useState("");
  const [items, setItems] = useState<ReportItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<ReportItem | null>(null);

  const [ledRows, setLedRows] = useState<LedRowOption[]>([]);
  const [selectedLedRow, setSelectedLedRow] = useState<LedRowOption | null>(null);
  const [loadingLedRows, setLoadingLedRows] = useState(false);

  const [loadingItems, setLoadingItems] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [stats, setStats] = useState<Stats>({
    total: 0,
    available: 0,
    inUse: 0,
    maintenance: 0,
    inKsa: 0,
  });

  const [chainStats, setChainStats] = useState<ChainStats>({
    total: 0,
    available: 0,
    inuse: 0,
    maintenance: 0,
    ksa: 0,
    expired: 0,
  });

  useEffect(() => {
    void loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadProfile() {
    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();

      if (userErr || !user) {
        setRole("viewer");
        setDepartment("");
        return;
      }

      const { data: profile, error: profileErr } = await supabase
        .from("profiles")
        .select("role, department")
        .eq("id", user.id)
        .single();

      if (profileErr || !profile) {
        setRole("viewer");
        setDepartment("");
        return;
      }

      setRole((profile.role ?? "viewer") as UserRole);
      setDepartment((profile.department ?? "") as Department);
    } catch (e) {
      console.error("load profile error:", e);
      setRole("viewer");
      setDepartment("");
    } finally {
      setProfileLoading(false);
    }
  }

  const selectedGroupTitle = useMemo(() => {
    for (const group of reportGroups) {
      if (group.options.some((x) => x.slug === selectedSubcategory)) {
        return group.title;
      }
    }
    return "";
  }, [selectedSubcategory]);

  const selectedTitle = useMemo(() => {
    if (!selectedItem) return "";
    if (isLedScreen() && selectedLedRow) {
      return `${selectedItem.name} - ${selectedLedRow.size}`;
    }
    return selectedItem.name;
  }, [selectedItem, selectedLedRow]);

  function isLedScreen(slug = selectedSubcategory) {
    return slug === "led-screen" || slug === "led-screens";
  }

  function isChainHoist(slug = selectedSubcategory) {
    return slug === "chain-hoist" || slug === "chain-hoists";
  }

  function isProjector(slug = selectedSubcategory) {
    return slug === "projectors" || slug === "projector";
  }

  function isSerializedReport(slug = selectedSubcategory) {
    return !isLedScreen(slug) && !isChainHoist(slug) && !isProjector(slug);
  }

  function displayStats() {
    if (isChainHoist()) {
      return {
        total: chainStats.total,
        available: chainStats.available,
        inUse: chainStats.inuse,
        maintenance: chainStats.maintenance,
        inKsa: chainStats.ksa,
        expired: chainStats.expired,
      };
    }

    return { ...stats, expired: null as number | null };
  }

  function toggleGroup(groupId: string) {
    setOpenGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  }

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

      if (!error && data?.id) return data.id as string;
    }

    throw new Error("Subcategory not found.");
  }

  async function loadItems(slug: string, label: string) {
    setSelectedSubcategory(slug);
    setSelectedSubcategoryLabel(label);
    setSelectedItem(null);
    setSelectedLedRow(null);
    setLedRows([]);
    setItems([]);
    setErr(null);
    setLoadingItems(true);
    setStats({
      total: 0,
      available: 0,
      inUse: 0,
      maintenance: 0,
      inKsa: 0,
    });
    setChainStats({
      total: 0,
      available: 0,
      inuse: 0,
      maintenance: 0,
      ksa: 0,
      expired: 0,
    });

    try {
      const subcategoryId = await resolveSubcategoryId(slug);

      if (isLedScreen(slug)) {
        const { data, error } = await supabase
          .from("matrix_models")
          .select("id, name")
          .eq("subcategory_id", subcategoryId)
          .order("name");

        if (error) throw error;

        setItems(
          (data ?? []).map((x: any) => ({
            id: x.id,
            name: x.name,
            photo_url: null,
          }))
        );

        return;
      }

      const { data, error } = await supabase
        .from("items")
        .select("id, name, photo_url")
        .eq("subcategory_id", subcategoryId)
        .order("name");

      if (error) throw error;

      setItems((data ?? []) as ReportItem[]);
    } catch (e: any) {
      setErr(e?.message || "Failed to load items.");
    } finally {
      setLoadingItems(false);
    }
  }

  async function loadLedRows(modelId: string) {
    setLoadingLedRows(true);
    setErr(null);
    setSelectedLedRow(null);
    setLedRows([]);

    try {
      const { data, error } = await supabase
        .from("matrix_rows")
        .select(
          "id, model_id, size, qty, available_qty, in_use_qty, maintenance_qty, in_ksa_qty"
        )
        .eq("model_id", modelId)
        .order("size", { ascending: true });

      if (error) throw error;

      setLedRows((data ?? []) as LedRowOption[]);
    } catch (e: any) {
      setErr(e?.message || "Failed to load cabinet sizes.");
      setLedRows([]);
    } finally {
      setLoadingLedRows(false);
    }
  }

  function selectItem(item: ReportItem) {
    setSelectedItem(item);
    setSelectedLedRow(null);
    setStats({
      total: 0,
      available: 0,
      inUse: 0,
      maintenance: 0,
      inKsa: 0,
    });
    setChainStats({
      total: 0,
      available: 0,
      inuse: 0,
      maintenance: 0,
      ksa: 0,
      expired: 0,
    });

    if (isLedScreen()) {
      void loadLedRows(item.id);
    }
  }

  function selectLedRow(row: LedRowOption) {
    setSelectedLedRow(row);
    setStats({
      total: clampQty(row.qty),
      available: clampQty(row.available_qty),
      inUse: clampQty(row.in_use_qty),
      maintenance: clampQty(row.maintenance_qty),
      inKsa: clampQty(row.in_ksa_qty),
    });
  }

  function selectedGroupId() {
    for (const group of reportGroups) {
      if (group.options.some((x) => x.slug === selectedSubcategory)) {
        return group.id;
      }
    }

    return "";
  }

  function canEditCurrentReport() {
    const groupId = selectedGroupId();

    if (role === "admin" || role === "warehouse_manager") return true;
    if (role !== "head") return false;

    if (department === "lighting" && groupId === "lighting") return true;
    if (department === "video" && groupId === "video") return true;
    if (department === "rigging" && groupId === "rigging") return true;

    return false;
  }

  function editHref() {
    if (!selectedItem) return "";

    if (isLedScreen()) {
      if (!selectedLedRow) return "";
      return `/equipment-report/update/led-screen/${selectedLedRow.id}`;
    }

    if (isProjector()) {
      return `/equipment-report/update/projectors/${selectedItem.id}`;
    }

    if (isChainHoist()) {
      return `/equipment-report/update/chain-hoist/${selectedItem.id}`;
    }

    if (
      selectedSubcategory === "led-video-processor" ||
      selectedSubcategory === "led-video-processors"
    ) {
      return `/equipment-report/update/led-video-processor/${selectedItem.id}`;
    }

    return `/equipment-report/update/${selectedSubcategory}/${selectedItem.id}`;
  }

  async function downloadPdf() {
  const element = document.getElementById("report-preview");
  if (!element) return;

  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    backgroundColor: "#ffffff",
    windowWidth: 1400,
  });

  const imgData = canvas.toDataURL("image/png");

  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a4",
  });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  const imgWidth = pageWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  pdf.addImage(
    imgData,
    "PNG",
    0,
    0,
    imgWidth,
    Math.min(imgHeight, pageHeight)
  );

  pdf.save(`${selectedTitle || "equipment-report"}.pdf`);
}

  const shownStats = displayStats();
  const canEditCurrent = canEditCurrentReport();
  const currentEditHref = editHref();

  if (profileLoading) {
    return (
      <div className="min-h-screen bg-gray-50 p-3 text-gray-900">
        <div className="rounded-2xl border border-gray-200 bg-white p-6">
          Loading...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-3 text-gray-900">
      <div className="w-full space-y-3">
        <div className="rounded-2xl border border-gray-200 bg-white p-5 print:hidden">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                <h1 className="text-[24px] font-bold leading-tight text-gray-900">
                  Equipment Report
                </h1>
              </div>

              <p className="mt-2 text-[12px] text-gray-600">
                Select item, preview report, download PDF, or edit if you have permission.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Link
                href="/"
                className="rounded-full border border-gray-300 bg-white px-3 py-2 text-[11px] font-medium text-gray-700 hover:border-red-200 hover:bg-red-50 hover:text-red-700"
              >
                ← Home
              </Link>

              <button
  type="button"
  onClick={downloadPdf}
  disabled={!selectedItem || (isLedScreen() && !selectedLedRow)}
  className="inline-flex items-center gap-1 rounded-full bg-black px-3 py-2 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
>
  <Download size={13} />
  Download PDF
</button>

              {canEditCurrent && currentEditHref ? (
                <Link
                  href={currentEditHref}
                  className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-medium text-red-700 hover:border-red-300 hover:bg-red-100"
                >
                  Edit
                </Link>
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_330px]">
          <main className="rounded-2xl border border-gray-200 bg-white p-3 sm:p-5">
            {!selectedItem || (isLedScreen() && !selectedLedRow) ? (
              <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center print:hidden">
                <div>
                  <div className="text-[16px] font-bold text-gray-900">
                    {isLedScreen() && selectedItem
                      ? "Select cabinet size"
                      : "Select item"}
                  </div>
                  <p className="mt-2 max-w-md text-[12px] text-gray-500">
                    Choose category then item from the sidebar.
                    {isLedScreen() && selectedItem
                      ? " After selecting LED model, choose cabinet size."
                      : ""}
                  </p>
                </div>
              </div>
            ) : (
              <div
  id="report-preview"
  className="w-[1400px] max-w-none bg-white"
>
                <div className="mb-3 rounded-2xl border border-gray-200 bg-white p-2 sm:p-6">
                  <div className="flex justify-between items-center gap-2 sm:gap-4">
                    <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
                      <div className="w-[58px] min-w-[58px] sm:w-[120px] sm:min-w-[120px] flex items-center justify-center">
                        <div className="w-[48px] h-[48px] sm:w-[96px] sm:h-[96px] flex items-center justify-center bg-transparent">
                          {selectedItem.photo_url ? (
                            <img
                              src={selectedItem.photo_url}
                              alt={selectedItem.name}
                              loading="lazy"
                              decoding="async"
                              className="w-full h-full object-contain"
                            />
                          ) : (
                            <div className="text-[8px] sm:text-[10px] text-gray-400">
                              No photo
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="min-w-0 flex-1 flex flex-col justify-center">
                        <div className="flex items-center gap-1.5 sm:gap-2">
                          <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-red-500 shrink-0" />
                          <p className="text-[10px] sm:text-[16px] text-gray-600 m-0 leading-none">
                            Report
                          </p>
                        </div>

                        <h1 className="text-[14px] sm:text-[26px] lg:text-[28px] font-bold text-gray-900 leading-tight mt-1 sm:mt-2 mb-2 sm:mb-4 truncate">
                          {selectedTitle}
                        </h1>

                        <div className="text-[10px] text-gray-500 mb-2 print:hidden">
                          {selectedGroupTitle} / {selectedSubcategoryLabel}
                        </div>

                        <div className="border-t border-gray-200 pt-1.5 sm:pt-4">
                          <div className="flex flex-nowrap items-center gap-[2px] sm:gap-2 text-[5px] sm:text-[8px] font-semibold overflow-hidden">
                            <span className="whitespace-nowrap px-[3px] sm:px-2 py-[2px] sm:py-1 rounded-md sm:rounded-lg bg-gray-100 text-black">
                              Total Qty: {shownStats.total}
                            </span>
                            <span className="whitespace-nowrap px-[3px] sm:px-2 py-[2px] sm:py-1 rounded-md sm:rounded-lg bg-green-100 text-black">
                              Available Qty: {shownStats.available}
                            </span>
                            <span className="whitespace-nowrap px-[3px] sm:px-2 py-[2px] sm:py-1 rounded-md sm:rounded-lg bg-blue-100 text-black">
                              In Use: {shownStats.inUse}
                            </span>
                            <span className="whitespace-nowrap px-[3px] sm:px-2 py-[2px] sm:py-1 rounded-md sm:rounded-lg bg-yellow-100 text-black">
                              Maintenance: {shownStats.maintenance}
                            </span>
                            <span className="whitespace-nowrap px-[3px] sm:px-2 py-[2px] sm:py-1 rounded-md sm:rounded-lg bg-purple-100 text-black">
                              In KSA: {shownStats.inKsa}
                            </span>
                            {shownStats.expired !== null ? (
                              <span className="whitespace-nowrap px-[3px] sm:px-2 py-[2px] sm:py-1 rounded-md sm:rounded-lg bg-red-100 text-black">
                                Expired: {shownStats.expired}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {isChainHoist() ? (
                  <ChainHoistRowsBlock
                    itemId={selectedItem.id}
                    editable={canEditCurrent}
                    allowAdd={canEditCurrent}
                    allowDelete={canEditCurrent}
                    allowUpload={canEditCurrent}
                    onStatsChange={setChainStats}
                  />
                ) : isProjector() ? (
                  <ProjectorRowsBlock
                    itemId={selectedItem.id}
                    onStatsChange={setStats}
                  />
                ) : isLedScreen() && selectedLedRow ? (
                  <LedScreenReadonlyBlock
                    row={selectedLedRow}
                    modelName={selectedItem.name}
                    onStatsChange={setStats}
                  />
                ) : isSerializedReport() ? (
                  <SerializedRowsBlock
                    itemId={selectedItem.id}
                    editable={canEditCurrent}
                    onStatsChange={setStats}
                  />
                ) : null}
              </div>
            )}
          </main>

          <aside className="rounded-2xl border border-gray-200 bg-white p-3 lg:order-last print:hidden">
            <div className="mb-3 px-2">
              <div className="text-[13px] font-bold text-gray-900">
                Report Navigator
              </div>
              <div className="mt-1 text-[11px] text-gray-500">
                Select category then item.
              </div>
            </div>

            {err ? (
              <div className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-[11px] text-red-600">
                {err}
              </div>
            ) : null}

            <div className="space-y-2">
              {reportGroups.map((group) => {
                const isOpen = !!openGroups[group.id];

                return (
                  <div
                    key={group.id}
                    className="overflow-hidden rounded-2xl border border-gray-200"
                  >
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      className="flex w-full items-center justify-between bg-gray-50 px-3 py-3 text-left text-[12px] font-bold text-gray-900 hover:bg-red-50"
                    >
                      <span>{group.title}</span>
                      <ChevronDown
                        size={14}
                        className={`transition-transform ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      />
                    </button>

                    {isOpen ? (
                      <div className="space-y-1 p-2">
                        {group.options.map((option) => {
                          const activeSub =
                            selectedSubcategory === option.slug;

                          return (
                            <div key={option.slug}>
                              <button
                                type="button"
                                onClick={() =>
                                  loadItems(option.slug, option.label)
                                }
                                className={`w-full rounded-xl px-3 py-2 text-left text-[11px] font-semibold ${
                                  activeSub
                                    ? "bg-red-50 text-red-700"
                                    : "text-gray-700 hover:bg-gray-50"
                                }`}
                              >
                                {option.label}
                              </button>

                              {activeSub ? (
                                <div className="ml-3 mt-1 space-y-1 border-l border-gray-200 pl-2">
                                  {loadingItems ? (
                                    <div className="px-2 py-2 text-[10px] text-gray-400">
                                      Loading items...
                                    </div>
                                  ) : items.length === 0 ? (
                                    <div className="px-2 py-2 text-[10px] text-gray-400">
                                      No items found.
                                    </div>
                                  ) : (
                                    items.map((item) => {
                                      const activeItem =
                                        selectedItem?.id === item.id;

                                      return (
                                        <div key={item.id}>
                                          <button
                                            type="button"
                                            onClick={() => selectItem(item)}
                                            className={`block w-full rounded-lg px-2 py-1.5 text-left text-[10px] ${
                                              activeItem
                                                ? "bg-black text-white"
                                                : "text-gray-600 hover:bg-gray-100"
                                            }`}
                                          >
                                            {item.name}
                                          </button>

                                          {activeItem && isLedScreen() ? (
                                            <div className="ml-3 mt-1 space-y-1 border-l border-gray-200 pl-2">
                                              {loadingLedRows ? (
                                                <div className="px-2 py-2 text-[10px] text-gray-400">
                                                  Loading cabinet sizes...
                                                </div>
                                              ) : ledRows.length === 0 ? (
                                                <div className="px-2 py-2 text-[10px] text-gray-400">
                                                  No cabinet sizes.
                                                </div>
                                              ) : (
                                                ledRows.map((row) => (
                                                  <button
                                                    key={row.id}
                                                    type="button"
                                                    onClick={() =>
                                                      selectLedRow(row)
                                                    }
                                                    className={`block w-full rounded-lg px-2 py-1.5 text-left text-[10px] ${
                                                      selectedLedRow?.id ===
                                                      row.id
                                                        ? "bg-red-50 text-red-700"
                                                        : "text-gray-500 hover:bg-gray-100"
                                                    }`}
                                                  >
                                                    {row.size}
                                                  </button>
                                                ))
                                              )}
                                            </div>
                                          ) : null}
                                        </div>
                                      );
                                    })
                                  )}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function ProjectorRowsBlock({
  itemId,
  onStatsChange,
}: {
  itemId: string;
  onStatsChange?: (stats: Stats) => void;
}) {
  const supabase = createClient();
  const [units, setUnits] = useState<ProjectorUnit[]>([]);
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);

  useEffect(() => {
    void loadUnits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  async function loadUnits() {
    const { data, error } = await supabase
      .from("units")
      .select(
        "id, unit_no, serial, status, lamp_hours, notes, testing_date, damage_photos"
      )
      .eq("item_id", itemId)
      .order("unit_no", { ascending: true });

    if (error) {
      console.error("load projector units error:", error);
      setUnits([]);
      return;
    }

    setUnits((data ?? []) as ProjectorUnit[]);
  }

  useEffect(() => {
    onStatsChange?.({
      total: units.length,
      available: units.filter((u) => toStatus(u.status) === "available").length,
      inUse: units.filter((u) => toStatus(u.status) === "in_use").length,
      maintenance: units.filter((u) => toStatus(u.status) === "maintenance")
        .length,
      inKsa: units.filter((u) => toStatus(u.status) === "in_ksa").length,
    });
  }, [units, onStatsChange]);

  return (
    <>
      {previewPhoto ? (
        <div className="fixed inset-0 z-[999999] bg-black/90 flex items-center justify-center p-4">
          <button
            type="button"
            onClick={() => setPreviewPhoto(null)}
            className="absolute top-4 right-4 rounded-full bg-white px-3 py-1 text-xs font-semibold text-black"
          >
            Close
          </button>

          <img
            src={previewPhoto}
            alt="Damage Photo"
            className="max-w-full max-h-[85vh] object-contain rounded-lg bg-white"
          />
        </div>
      ) : null}

      <div className="bg-white border border-gray-200 rounded-xl px-[2px] lg:px-5 pt-4 lg:pt-5 pb-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
        <div className="hidden lg:flex items-center gap-2 text-[11px] font-semibold text-gray-600 pt-2 pb-4">
          <div className="w-[32px] min-w-[32px] text-center">ID</div>
          <div className="w-[120px] min-w-[120px]">Serial</div>
          <div className="w-[95px] min-w-[95px]">Status</div>
          <div className="w-[95px] min-w-[95px]">Lamp Hours</div>
          <div className="w-[230px] min-w-[230px]">Note</div>
          <div className="w-[130px] min-w-[130px]">Test Date</div>
          <div className="flex-1 min-w-[200px]">Damage</div>
        </div>

        {units.length === 0 ? (
          <div className="text-sm text-gray-500">No projector units found.</div>
        ) : (
          units.map((unit) => (
            <ProjectorUnitRow
              key={unit.id}
              unit={unit}
              onOpenPhoto={setPreviewPhoto}
            />
          ))
        )}
      </div>
    </>
  );
}

function ProjectorUnitRow({
  unit,
  onOpenPhoto,
}: {
  unit: ProjectorUnit;
  onOpenPhoto: (url: string) => void;
}) {
  const photos = unit.damage_photos ?? [];

  return (
    <div className="border-t border-gray-200 pt-3">
      <div className="lg:hidden rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold text-gray-400">Unit</div>
            <div className="mt-1 text-[22px] font-extrabold tracking-tight text-gray-900">
              {unit.unit_no ?? "-"}
            </div>
          </div>

          <span
            style={{ color: getStatusTextColor(unit.status) }}
            className="rounded-full bg-gray-100 px-2 py-1 text-[10px] font-semibold"
          >
            {getStatusLabel(unit.status)}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <ReadonlyField label="Serial" value={unit.serial || "-"} />
          <ReadonlyField label="Lamp Hours" value={unit.lamp_hours ?? 0} />
          <ReadonlyField label="Test Date" value={unit.testing_date || "-"} full />
          <ReadonlyField label="Note" value={unit.notes || "-"} full />
        </div>

        <PhotoList photos={photos} onOpenPhoto={onOpenPhoto} />
      </div>

      <div className="hidden lg:flex items-center gap-2 flex-nowrap overflow-visible">
        <div className="w-[32px] min-w-[32px] rounded-lg bg-white px-0 py-1 text-center text-[11px] text-gray-700">
          {unit.unit_no ?? "-"}
        </div>

        <div className="w-[120px] min-w-[120px] truncate rounded-lg bg-white px-2 py-1 text-[12px] text-gray-700">
          {unit.serial || "-"}
        </div>

        <div
          style={{ color: getStatusTextColor(unit.status) }}
          className="w-[95px] min-w-[95px] rounded-lg bg-white px-1 py-1 text-[12px] font-semibold"
        >
          {getStatusLabel(unit.status)}
        </div>

        <div className="w-[95px] min-w-[95px] rounded-lg bg-white px-1 py-1 text-[12px] text-gray-700">
          {unit.lamp_hours ?? 0}
        </div>

        <div className="w-[230px] min-w-[230px] rounded-lg bg-white px-2 py-1 text-[12px] text-gray-700 whitespace-pre-wrap break-words">
          {unit.notes || "-"}
        </div>

        <div className="w-[130px] min-w-[130px] rounded-lg bg-white px-1 py-1 text-[12px] text-gray-700">
          {unit.testing_date || "-"}
        </div>

        <PhotoList photos={photos} onOpenPhoto={onOpenPhoto} desktop />
      </div>
    </div>
  );
}

function LedScreenReadonlyBlock({
  row,
  modelName,
  onStatsChange,
}: {
  row: LedRowOption;
  modelName: string;
  onStatsChange?: (stats: Stats) => void;
}) {
  const supabase = createClient();
  const [issues, setIssues] = useState<LedMaintenanceLog[]>([]);
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);

  useEffect(() => {
    onStatsChange?.({
      total: clampQty(row.qty),
      available: clampQty(row.available_qty),
      inUse: clampQty(row.in_use_qty),
      maintenance: clampQty(row.maintenance_qty),
      inKsa: clampQty(row.in_ksa_qty),
    });
  }, [row, onStatsChange]);

  useEffect(() => {
    void loadIssues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  async function loadIssues() {
    const { data, error } = await supabase
      .from("led_maintenance_logs")
      .select(
        "id, problem_type, qty, team_name, event_name, event_date, note, photo_data, photo_data_list, created_at"
      )
      .eq("matrix_row_id", row.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("load led issues error:", error);
      setIssues([]);
      return;
    }

    setIssues((data ?? []) as LedMaintenanceLog[]);
  }

  const parsed = parseLedName(modelName);

  return (
    <>
      {previewPhoto ? (
        <div className="fixed inset-0 z-[999999] bg-black/90 flex items-center justify-center p-4">
          <button
            type="button"
            onClick={() => setPreviewPhoto(null)}
            className="absolute top-4 right-4 rounded-full bg-white px-3 py-1 text-xs font-semibold text-black"
          >
            Close
          </button>

          <img
            src={previewPhoto}
            alt="LED issue photo"
            className="max-w-full max-h-[85vh] object-contain rounded-lg bg-white"
          />
        </div>
      ) : null}

      <div className="space-y-3">
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
          <div className="mb-3 text-[13px] font-bold text-gray-900">
            LED Screen Details
          </div>

          <div className="grid grid-cols-1 gap-2 text-[12px] text-gray-700 sm:grid-cols-3">
            <div>
              <span className="font-semibold">Brand:</span> {parsed.brand || "-"}
            </div>
            <div>
              <span className="font-semibold">Model:</span> {parsed.model || "-"}
            </div>
            <div>
              <span className="font-semibold">Cabinet Size:</span> {row.size}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
          <div className="mb-3 text-[13px] font-bold text-gray-900">
            Issues / Maintenance
          </div>

          {issues.length === 0 ? (
            <div className="text-sm text-gray-500">No issues found.</div>
          ) : (
            <div className="space-y-2">
              {issues.map((issue) => {
                const photos = normalizePhotoList(
                  issue.photo_data_list,
                  issue.photo_data
                );

                return (
                  <div
                    key={issue.id}
                    className="rounded-2xl border border-gray-100 bg-gray-50 p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-[12px] font-bold text-gray-900 capitalize">
                          {String(issue.problem_type || "-").replaceAll("_", " ")}
                        </div>
                        <div className="mt-1 text-[11px] text-gray-500">
                          Qty: {issue.qty ?? 0}
                          {issue.team_name ? ` • Team: ${issue.team_name}` : ""}
                          {issue.event_name
                            ? ` • Event: ${issue.event_name}`
                            : ""}
                          {issue.event_date ? ` • Date: ${issue.event_date}` : ""}
                        </div>
                      </div>
                    </div>

                    {issue.note ? (
                      <div className="mt-2 text-[12px] text-gray-700 whitespace-pre-wrap">
                        {issue.note}
                      </div>
                    ) : null}

                    <PhotoList photos={photos} onOpenPhoto={setPreviewPhoto} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ReadonlyField({
  label,
  value,
  full = false,
}: {
  label: string;
  value: string | number;
  full?: boolean;
}) {
  return (
    <label className={`rounded-xl bg-gray-50 p-2 ${full ? "col-span-2" : ""}`}>
      <div className="text-[10px] font-semibold text-gray-400">{label}</div>
      <div className="mt-1 w-full text-[12px] font-medium text-gray-800">
        {value}
      </div>
    </label>
  );
}

function PhotoList({
  photos,
  onOpenPhoto,
  desktop = false,
}: {
  photos: string[];
  onOpenPhoto: (url: string) => void;
  desktop?: boolean;
}) {
  if (photos.length === 0) {
    return desktop ? (
      <div className="flex min-w-[200px] items-center gap-2 text-xs text-gray-400">
        No photos
      </div>
    ) : (
      <div className="mt-3 text-[11px] text-gray-400">No photos</div>
    );
  }

  return (
    <div
      className={
        desktop
          ? "flex min-w-[200px] items-center gap-2 overflow-visible"
          : "mt-3 flex flex-wrap gap-2"
      }
    >
      {photos.slice(0, 3).map((photo, idx) => (
        <img
          key={`${photo}-${idx}`}
          src={photo}
          alt={`Photo ${idx + 1}`}
          onClick={() => onOpenPhoto(photo)}
          className={
            desktop
              ? "h-10 w-10 cursor-pointer rounded-lg object-cover"
              : "h-12 w-12 cursor-pointer rounded-lg object-cover"
          }
        />
      ))}
    </div>
  );
}

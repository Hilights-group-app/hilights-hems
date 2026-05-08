"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ImagePlus, Trash2 } from "lucide-react";

type UserRole = "admin" | "warehouse_manager" | "viewer" | "head";
type Department = "" | "lighting" | "video" | "rigging";

type UnitStatus = "available" | "in_use" | "maintenance" | "in_ksa";

type Unit = {
  id: string;
  unit_no: number | null;
  serial: string | null;
  status: string | null;
  notes: string | null;
  testing_date: string | null;
  damage_photos: string[] | null;
};

type Stats = {
  total: number;
  available: number;
  inUse: number;
  maintenance: number;
  inKsa: number;
};

type UnitPatch = Partial<Unit>;

function toStatus(v: any): UnitStatus {
  if (v === "available" || v === "in_use" || v === "maintenance" || v === "in_ksa") {
    return v;
  }
  return "available";
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

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

export function SerializedRowsBlock({
  itemId,
  editable = true,
  onStatsChange,
}: {
  itemId: string;
  editable?: boolean;
  onStatsChange?: (stats: Stats) => void;
}) {
  const supabase = createClient();
  const [units, setUnits] = useState<Unit[]>([]);
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);

  useEffect(() => {
    void loadUnits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  async function loadUnits() {
    const { data, error } = await supabase
      .from("units")
      .select("id, unit_no, serial, status, notes, testing_date, damage_photos")
      .eq("item_id", itemId)
      .order("unit_no", { ascending: true });

    if (error) {
      console.error("loadUnits error:", error);
      return;
    }

    setUnits((data ?? []) as Unit[]);
  }

  useEffect(() => {
    onStatsChange?.({
      total: units.length,
      available: units.filter((u) => toStatus(u.status) === "available").length,
      inUse: units.filter((u) => toStatus(u.status) === "in_use").length,
      maintenance: units.filter((u) => toStatus(u.status) === "maintenance").length,
      inKsa: units.filter((u) => toStatus(u.status) === "in_ksa").length,
    });
  }, [units, onStatsChange]);

  async function updateUnit(id: string, patch: UnitPatch) {
    if (!editable) return;

    const nextPatch: UnitPatch = { ...patch };

    if (patch.unit_no !== undefined) {
      nextPatch.unit_no = Number(patch.unit_no) || 0;
    }

    setUnits((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...nextPatch } : u))
    );

    const { error } = await supabase.from("units").update(nextPatch).eq("id", id);

    if (error) {
      console.error("updateUnit error:", error);
      await loadUnits();
    }
  }

  async function addRow() {
    if (!editable) return;

    const nextNumber =
      units.length > 0
        ? Math.max(
            ...units.map((u) => {
              const n = Number(u.unit_no);
              return Number.isFinite(n) ? n : 0;
            })
          ) + 1
        : 1;

    const { data, error } = await supabase
      .from("units")
      .insert({
        item_id: itemId,
        unit_no: nextNumber,
        serial: "",
        status: "available",
        notes: "",
        testing_date: null,
        damage_photos: [],
      })
      .select("id, unit_no, serial, status, notes, testing_date, damage_photos")
      .single();

    if (error) {
      console.error("addRow error:", error);
      return;
    }
    
    setUnits((prev) => [...prev, data as Unit]);
  }

  async function deleteRow(id: string) {
    if (!editable) return;
    if (!confirm("Delete this unit?")) return;

    const { error } = await supabase.from("units").delete().eq("id", id);

    if (error) {
      console.error("deleteRow error:", error);
      return;
    }

    setUnits((prev) => prev.filter((u) => u.id !== id));
  }

  async function onPickDamagePhotos(unitId: string, files: FileList | null) {
    if (!editable || !files || files.length === 0) return;

    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;

    const currentPhotos = unit.damage_photos ?? [];
    if (currentPhotos.length >= 3) return;

    const remainingSlots = Math.max(0, 3 - currentPhotos.length);
    const picked = Array.from(files).slice(0, remainingSlots);
    const dataUrls = await Promise.all(picked.map((file) => fileToDataUrl(file)));
    const nextPhotos = [...currentPhotos, ...dataUrls].slice(0, 3);

    await updateUnit(unitId, { damage_photos: nextPhotos });
  }

  async function deleteDamagePhoto(unitId: string, photoIndex: number) {
    if (!editable) return;

    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;

    const currentPhotos = unit.damage_photos ?? [];
    const nextPhotos = currentPhotos.filter((_, idx) => idx !== photoIndex);

    await updateUnit(unitId, { damage_photos: nextPhotos });
  }

  function openPhoto(url: string) {
    setPreviewPhoto(url);
  }

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
          <div className="w-[230px] min-w-[230px]">Note</div>
          <div className="w-[90px] min-w-[90px]">Test Date</div>
          <div className="flex-1 min-w-[200px]">Damage</div>
        </div>

        {units.length === 0 ? (
          <div className="text-sm text-gray-500">No units found.</div>
        ) : (
          units.map((unit, idx) => (
            <SerializedUnitRow
              key={unit.id}
              unit={unit}
              index={idx}
              editable={editable}
              onChange={updateUnit}
              onPickDamagePhotos={onPickDamagePhotos}
              onDeleteDamagePhoto={deleteDamagePhoto}
              onOpenPhoto={openPhoto}
              onDeleteRow={deleteRow}
            />
          ))
        )}

        {editable ? (
          <div className="flex justify-start mt-8 pb-4">
            <button
              type="button"
              onClick={addRow}
              className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
            >
              + Add Row
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

export default function ItemReportPage() {
  const supabase = createClient();
  const params = useParams();
  const itemId = params.itemId as string;

  const itemPhotoRef = useRef<HTMLInputElement | null>(null);

  const [role, setRole] = useState<UserRole | "">("");
  const [department, setDepartment] = useState<Department>("");

  const [itemName, setItemName] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [stats, setStats] = useState<Stats>({
    total: 0,
    available: 0,
    inUse: 0,
    maintenance: 0,
    inKsa: 0,
  });

  useEffect(() => {
    void loadPageData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  async function loadPageData() {
    setLoading(true);

    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();

      if (userErr || !user) {
        console.error("auth user error:", userErr);
        setLoading(false);
        return;
      }

      const { data: profile, error: profileErr } = await supabase
        .from("profiles")
        .select("role, department")
        .eq("id", user.id)
        .single();

      if (!profileErr && profile) {
        setRole((profile.role ?? "") as UserRole | "");
        setDepartment((profile.department ?? "") as Department);
      }

      const { data: item, error } = await supabase
        .from("items")
        .select("name, photo_url")
        .eq("id", itemId)
        .single();

      if (error) {
        console.error("loadItem error:", error);
        setLoading(false);
        return;
      }

      if (item) {
        setItemName(item.name ?? "");
        setPhotoUrl(item.photo_url ?? null);
      }
    } catch (err) {
      console.error("loadPageData unexpected error:", err);
    } finally {
      setLoading(false);
    }
  }

  const canOpenPage =
    role === "admin" ||
    role === "warehouse_manager" ||
    role === "head";

  const canEditPage =
    role === "admin" ||
    role === "warehouse_manager" ||
    role === "head";

  async function renameItem() {
    if (!canEditPage) return;

    const next = prompt("Item name:", itemName);
    if (!next) return;

    const clean = next.trim();
    if (!clean) return;

    const { error } = await supabase
      .from("items")
      .update({ name: clean })
      .eq("id", itemId);

    if (error) {
      console.error("renameItem error:", error);
      alert("Failed to rename item");
      return;
    }

    setItemName(clean);
  }

  async function onPickItemPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (!canEditPage) return;

    const f = e.target.files?.[0];
    if (!f) return;

    try {
      const dataUrl = await fileToDataUrl(f);

      const { error } = await supabase
        .from("items")
        .update({ photo_url: dataUrl })
        .eq("id", itemId);

      if (error) {
        console.error("item photo update error:", error);
        alert("Failed to update photo");
        return;
      }

      setPhotoUrl(dataUrl);
    } finally {
      e.target.value = "";
    }
  }

  if (loading || !role) {
    return (
      <div className="min-h-screen bg-gray-50 px-[2px] py-2 sm:p-3">
        <div className="w-full max-w-none sm:max-w-[1100px] mx-auto space-y-3 px-0">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-gray-900">
            Loading report...
          </div>
        </div>
      </div>
    );
  }

  if (!canOpenPage) {
    return (
      <div className="min-h-screen bg-gray-50 px-[2px] py-2 sm:p-3">
        <div className="w-full max-w-none sm:max-w-[900px] mx-auto px-0">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 text-gray-900">
            <div className="text-lg font-semibold">Access denied</div>
            <div className="text-sm text-gray-600 mt-2">
              You do not have permission to access this report.
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
    <div className="min-h-screen bg-gray-50 px-[2px] py-2 sm:p-3">
      <div className="w-full max-w-none sm:max-w-[1100px] mx-auto space-y-3 px-0">
        <input
          ref={itemPhotoRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickItemPhoto}
        />

        <div className="bg-white border border-gray-200 rounded-2xl p-2 sm:p-6">
          <div className="flex justify-between items-center gap-2 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
              <div className="w-[58px] min-w-[58px] sm:w-[120px] sm:min-w-[120px] flex items-center justify-center">
                <div className="flex items-start gap-1 sm:gap-2">
                  <div className="w-[48px] h-[48px] sm:w-[96px] sm:h-[96px] flex items-center justify-center bg-transparent">
                    {photoUrl ? (
                      <img
                        src={photoUrl}
                        alt={itemName}
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <div className="text-[8px] sm:text-[10px] text-gray-400">
                        No photo
                      </div>
                    )}
                  </div>

                  {canEditPage ? (
                    <button
                      type="button"
                      onClick={() => itemPhotoRef.current?.click()}
                      className="mt-0.5 sm:mt-1 text-[10px] sm:text-[16px] text-red-500 transition hover:text-black"
                      title="Change photo"
                    >
                      ✎
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0 flex-1 flex flex-col justify-center">
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-red-500 shrink-0" />

                  <p className="text-[10px] sm:text-[16px] text-gray-600 m-0 leading-none">
                    Report
                  </p>
                </div>

                <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                  <h1 className="text-[14px] sm:text-[26px] lg:text-[28px] font-bold text-gray-900 leading-tight mt-1 sm:mt-2 mb-2 sm:mb-4 truncate">
                    {itemName || "-"}
                  </h1>

                  {canEditPage ? (
                    <button
                      type="button"
                      onClick={renameItem}
                      title="Edit name"
                      className="text-[10px] sm:text-[16px] text-red-500 transition hover:text-black shrink-0"
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
              </div>
            </div>

            <Link
              href="/equipment-report/update"
              className="px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-full border border-gray-300 text-[9px] sm:text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98] shrink-0"
            >
              ← Back
            </Link>
          </div>
        </div>

        <SerializedRowsBlock
          itemId={itemId}
          editable={canEditPage}
          onStatsChange={setStats}
        />
      </div>
    </div>
  );
}

function DamagePhotoThumb({
  photo,
  index,
  editable,
  onDelete,
  onOpenPhoto,
}: {
  photo: string;
  index: number;
  editable: boolean;
  onDelete: () => void;
  onOpenPhoto: (url: string) => void;
}) {
  const [hover, setHover] = useState(false);

  return (
    <div
      className="relative w-[10px] h-[10px] lg:w-10 lg:h-10 overflow-visible bg-white shrink-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <img
        src={photo}
        alt={`Damage ${index + 1}`}
        className="w-[10px] h-[10px] lg:w-10 lg:h-10 object-cover cursor-pointer rounded-[2px] lg:rounded-lg"
        onClick={() => onOpenPhoto(photo)}
      />

      {editable ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute -top-[5px] -right-[5px] w-[8px] h-[8px] lg:w-4 lg:h-4 rounded-full bg-white border text-[5px] lg:text-[9px] flex items-center justify-center hover:bg-gray-50 z-20"
          title="Delete photo"
        >
          ✕
        </button>
      ) : null}

      {hover ? (
        <div
          className="hidden lg:block"
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "300px",
            height: "300px",
            background: "#ffffff",
            border: "1px solid #e5e7eb",
            borderRadius: "12px",
            padding: "10px",
            boxShadow: "0 20px 50px rgba(0,0,0,0.3)",
            zIndex: 999999,
          }}
        >
          <img
            src={photo}
            alt={`Damage ${index + 1}`}
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
      ) : null}
    </div>
  );
}

function SerializedUnitRow({
  unit,
  index,
  editable,
  onChange,
  onPickDamagePhotos,
  onDeleteDamagePhoto,
  onOpenPhoto,
  onDeleteRow,
}: {
  unit: Unit;
  index: number;
  editable: boolean;
  onChange: (unitId: string, patch: Partial<Unit>) => Promise<void>;
  onPickDamagePhotos: (unitId: string, files: FileList | null) => Promise<void>;
  onDeleteDamagePhoto: (unitId: string, photoIndex: number) => Promise<void>;
  onOpenPhoto: (url: string) => void;
  onDeleteRow: (id: string) => Promise<void>;
}) {
  const [unitNo, setUnitNo] = useState(String(unit.unit_no ?? ""));
  const [serial, setSerial] = useState(unit.serial || "");
  const [status, setStatus] = useState(unit.status || "available");
  const [notes, setNotes] = useState(unit.notes || "");
  const [testingDate, setTestingDate] = useState(unit.testing_date || "");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const didInitRef = useRef(false);

  useEffect(() => {
    if (!didInitRef.current) {
      setUnitNo(String(unit.unit_no ?? ""));
      setSerial(unit.serial || "");
      setStatus(unit.status || "available");
      setNotes(unit.notes || "");
      setTestingDate(unit.testing_date || "");
      didInitRef.current = true;
    }
  }, [unit]);

  const photos = unit.damage_photos ?? [];

  function debounceSave(key: string, fn: () => void) {
    if (timerRef.current[key]) clearTimeout(timerRef.current[key]);
    timerRef.current[key] = setTimeout(fn, 800);
  }

  return (
    <div className="border-t border-gray-200 pt-3">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={async (e) => {
          if (!editable) return;
          await onPickDamagePhotos(unit.id, e.target.files);
          e.target.value = "";
        }}
      />

      {/* MOBILE CARD STYLE */}
      <div className="lg:hidden rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-gray-400">
              Unit
            </div>

            <input
              value={unitNo}
              readOnly={!editable}
              onChange={(e) => {
                if (!editable) return;
                const v = e.target.value;
                setUnitNo(v);
                debounceSave("unit_no_mobile", () => {
                  void onChange(unit.id, { unit_no: Number(v) || 0 });
                });
              }}
              onBlur={() => {
                if (!editable) return;
                void onChange(unit.id, { unit_no: Number(unitNo) || 0 });
              }}
              className="mt-1 w-full border-none bg-transparent p-0 text-[22px] font-extrabold tracking-tight text-gray-900 outline-none"
            />
          </div>

          <div className="flex items-center gap-2">
            <span
              style={{ color: getStatusTextColor(status) }}
              className="rounded-full bg-gray-100 px-2 py-1 text-[10px] font-semibold"
            >
              {status === "in_use"
                ? "In Use"
                : status === "in_ksa"
                ? "In KSA"
                : status
                ? status.charAt(0).toUpperCase() + status.slice(1)
                : "Available"}
            </span>

            {editable ? (
              <Trash2
                size={16}
                className="cursor-pointer text-red-500"
                onClick={() => void onDeleteRow(unit.id)}
              />
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="rounded-xl bg-gray-50 p-2">
            <div className="text-[10px] font-semibold text-gray-400">Serial</div>
            <input
              value={serial}
              readOnly={!editable}
              placeholder="Serial"
              onChange={(e) => {
                if (!editable) return;
                const v = e.target.value;
                setSerial(v);
                debounceSave("serial_mobile", () => {
                  void onChange(unit.id, { serial: v });
                });
              }}
              onBlur={() => {
                if (!editable) return;
                void onChange(unit.id, { serial });
              }}
              className="mt-1 w-full border-none bg-transparent p-0 text-[12px] font-medium text-gray-800 outline-none"
            />
          </label>

          <label className="rounded-xl bg-gray-50 p-2">
            <div className="text-[10px] font-semibold text-gray-400">Status</div>
            <select
              value={status}
              disabled={!editable}
              onChange={(e) => {
                if (!editable) return;
                const v = e.target.value as UnitStatus;
                setStatus(v);
                void onChange(unit.id, { status: v });
              }}
              style={{ color: getStatusTextColor(status) }}
              className="mt-1 w-full border-none bg-transparent p-0 text-[12px] font-semibold outline-none disabled:bg-transparent"
            >
              <option value="available">Available</option>
              <option value="in_use">In Use</option>
              <option value="maintenance">Maintenance</option>
              <option value="in_ksa">In KSA</option>
            </select>
          </label>

          <label className="rounded-xl bg-gray-50 p-2 col-span-2">
            <div className="text-[10px] font-semibold text-gray-400">Test Date</div>
            <input
              type="date"
              value={testingDate}
              readOnly={!editable}
              onChange={(e) => {
                if (!editable) return;
                const v = e.target.value;
                setTestingDate(v);
                debounceSave("testing_date_mobile", () => {
                  void onChange(unit.id, { testing_date: v || null });
                });
              }}
              onBlur={() => {
                if (!editable) return;
                void onChange(unit.id, { testing_date: testingDate || null });
              }}
              className="mt-1 w-full border-none bg-transparent p-0 text-[11px] text-gray-800 outline-none"
            />
          </label>
        </div>

        <label className="mt-2 block rounded-xl bg-gray-50 p-2">
          <div className="text-[10px] font-semibold text-gray-400">Note</div>
          <textarea
            value={notes}
            readOnly={!editable}
            placeholder="Write note..."
            onChange={(e) => {
              if (!editable) return;
              const v = e.target.value;
              setNotes(v);
              debounceSave("notes_mobile", () => {
                void onChange(unit.id, { notes: v });
              });
            }}
            onBlur={() => {
              if (!editable) return;
              void onChange(unit.id, { notes });
            }}
            rows={2}
            className="mt-1 w-full resize-none border-none bg-transparent p-0 text-[12px] text-gray-800 outline-none"
          />
        </label>

        <div className="mt-3 rounded-xl bg-gray-50 p-2">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[10px] font-semibold text-gray-400">
              Damage Photos ({photos.length}/3)
            </div>

            {editable ? (
              <ImagePlus
                size={17}
                className="cursor-pointer text-red-500"
                onClick={() => fileRef.current?.click()}
              />
            ) : null}
          </div>

          {photos.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {photos.slice(0, 3).map((photo, idx) => (
                <div key={`${unit.id}-mobile-${idx}`} className="relative">
                  <img
                    src={photo}
                    alt={`Damage ${idx + 1}`}
                    onClick={() => onOpenPhoto(photo)}
                    className="h-12 w-12 cursor-pointer rounded-lg object-cover"
                  />

                  {editable ? (
                    <button
                      type="button"
                      onClick={() => void onDeleteDamagePhoto(unit.id, idx)}
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border bg-white text-[9px] text-red-500 shadow-sm"
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-gray-400">No photos</div>
          )}
        </div>
      </div>

      {/* DESKTOP TABLE STYLE */}
      <div className="hidden lg:flex items-center gap-2 flex-nowrap overflow-visible">
        <input
          value={unitNo}
          readOnly={!editable}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setUnitNo(v);
            debounceSave("unit_no", () => {
              void onChange(unit.id, { unit_no: Number(v) || 0 });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onChange(unit.id, { unit_no: Number(unitNo) || 0 });
          }}
          className="w-[32px] min-w-[32px] rounded-lg border-none bg-white px-0 py-1 text-center text-[11px] outline-none read-only:text-gray-700"
        />

        <input
          value={serial}
          readOnly={!editable}
          placeholder={editable ? "Serial" : ""}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setSerial(v);
            debounceSave("serial", () => {
              void onChange(unit.id, { serial: v });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onChange(unit.id, { serial });
          }}
          className="w-[120px] min-w-[120px] truncate rounded-lg border-none bg-white px-2 py-1 text-[12px] outline-none read-only:text-gray-700"
        />

        <select
          value={status}
          disabled={!editable}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value as UnitStatus;
            setStatus(v);
            void onChange(unit.id, { status: v });
          }}
          style={{ color: getStatusTextColor(status) }}
          className="w-[95px] min-w-[95px] rounded-lg border-none bg-white px-1 py-1 text-[12px] outline-none disabled:bg-white"
        >
          <option value="available">Available</option>
          <option value="in_use">In Use</option>
          <option value="maintenance">Maintenance</option>
          <option value="in_ksa">In KSA</option>
        </select>

        <textarea
          value={notes}
          readOnly={!editable}
          placeholder={editable ? "Note..." : ""}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setNotes(v);
            debounceSave("notes", () => {
              void onChange(unit.id, { notes: v });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onChange(unit.id, { notes });
          }}
          rows={1}
          className="w-[230px] min-w-[230px] resize-none overflow-hidden rounded-lg border-none bg-white px-2 py-1 text-[12px] outline-none read-only:text-gray-700"
          style={{
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            wordBreak: "break-word",
          }}
        />

        <input
          type="date"
          value={testingDate}
          readOnly={!editable}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setTestingDate(v);
            debounceSave("testing_date", () => {
              void onChange(unit.id, { testing_date: v || null });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onChange(unit.id, { testing_date: testingDate || null });
          }}
          className="w-[90px] min-w-[90px] rounded-lg border-none bg-white px-1 py-1 text-[12px] outline-none read-only:text-gray-700"
        />

        <div className="flex min-w-[200px] items-center gap-2 overflow-visible">
          {editable ? (
            <ImagePlus
              size={20}
              className="cursor-pointer shrink-0 transition-colors duration-200"
              style={{ color: "#ef4444" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#000000")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
              onClick={() => fileRef.current?.click()}
            />
          ) : null}

          {editable ? (
            <span className="text-xs text-gray-400 shrink-0">
              {photos.length}/3
            </span>
          ) : null}

          {photos.length > 0 ? (
            <div className="flex items-center gap-2 overflow-visible">
              {photos.slice(0, 3).map((photo, idx) => (
                <DamagePhotoThumb
                  key={`${unit.id}-${idx}`}
                  photo={photo}
                  index={idx}
                  editable={editable}
                  onOpenPhoto={onOpenPhoto}
                  onDelete={() => void onDeleteDamagePhoto(unit.id, idx)}
                />
              ))}
            </div>
          ) : editable ? (
            <span className="text-xs text-gray-400 shrink-0">No photos</span>
          ) : null}
        </div>

        <div className="w-[28px] min-w-[28px] flex justify-center">
          {editable ? (
            <Trash2
              size={16}
              className="cursor-pointer transition-colors duration-200"
              style={{ color: "#ef4444" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#000000")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
              onClick={() => void onDeleteRow(unit.id)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
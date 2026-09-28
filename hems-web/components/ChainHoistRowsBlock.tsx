"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ImagePlus, Trash2 } from "lucide-react";
import { logActivity } from "@/lib/activityStore";
type Unit = {
  id: string;
  unit_no: string | null;
  serial: string | null;
  status: string;
  notes: string;
  cert_date: string | null;
  expiry_date: string | null;
  damage_photos: string[] | null;
};
type UnitPatch = Partial<
  Pick<Unit, "unit_no" | "serial" | "status" | "notes" | "cert_date" | "damage_photos">
>;
type Stats = {
  total: number;
  available: number;
  inuse: number;
  maintenance: number;
  ksa: number;
  expired: number;
};
function addOneYear(dateStr: string) {
  const s = (dateStr || "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const next = new Date(d);
  next.setFullYear(next.getFullYear() + 1);
  return next.toISOString().split("T")[0];
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
function getStatusLabel(status: string | null) {
  if (status === "in_use") return "In Use";
  if (status === "in_ksa") return "In KSA";
  if (status === "maintenance") return "Maintenance";
  return "Available";
}
function valuesMatch(a: unknown, b: unknown) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  }
  return String(a ?? "") === String(b ?? "");
}
async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}
export function ChainHoistRowsBlock({
  itemId,
  itemName,
  activityLink,
  onStatsChange,
  editable = true,
  allowAdd = true,
  allowDelete = true,
  allowUpload = true,
}: {
  itemId: string;
  itemName?: string;
  activityLink?: string;
  onStatsChange?: (stats: Stats) => void;
  editable?: boolean;
  allowAdd?: boolean;
  allowDelete?: boolean;
  allowUpload?: boolean;
}) {
  const supabase = createClient();
  const [units, setUnits] = useState<Unit[]>([]);
  const unitsRef = useRef<Unit[]>([]);
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);
  useEffect(() => {
    void loadUnits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);
  async function loadUnits() {
    const { data, error } = await supabase
      .from("units")
      .select("id, unit_no, serial, status, notes, cert_date, expiry_date, damage_photos")
      .eq("item_id", itemId)
      .order("unit_no", { ascending: true });
    if (error) {
      console.error("loadUnits error:", error);
      return;
    }
    const nextUnits = (data ?? []) as Unit[];
    unitsRef.current = nextUnits;
    setUnits(nextUnits);
  }
  function isExpired(unit: Unit) {
    if (!unit.expiry_date) return false;
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const expiry = new Date(unit.expiry_date);
    if (Number.isNaN(expiry.getTime())) return false;
    expiry.setHours(0, 0, 0, 0);
    return expiry.getTime() < now.getTime();
  }
  useEffect(() => {
    let available = 0;
    let inuse = 0;
    let maintenance = 0;
    let ksa = 0;
    let expired = 0;
    units.forEach((u) => {
      const expiredNow = isExpired(u);
      if (u.status === "available" && !expiredNow) available++;
      if (u.status === "in_use") inuse++;
      if (u.status === "maintenance") maintenance++;
      if (u.status === "in_ksa") ksa++;
      if (expiredNow) expired++;
    });
    onStatsChange?.({
      total: units.length,
      available,
      inuse,
      maintenance,
      ksa,
      expired,
    });
  }, [units, onStatsChange]);
  async function updateUnit(id: string, patch: UnitPatch) {
    if (!editable) return;
    const previous = unitsRef.current.find((unit) => unit.id === id);
    if (!previous) return;
    const nextPatch: Partial<Unit> = { ...patch };
    if (patch.unit_no !== undefined) {
      nextPatch.unit_no = String(patch.unit_no).trim();
    }
    if (patch.cert_date !== undefined) {
      nextPatch.expiry_date = patch.cert_date ? addOneYear(patch.cert_date) : null;
    }
    const changedEntries = Object.entries(nextPatch).filter(
      ([key, value]) => !valuesMatch(previous[key as keyof Unit], value)
    );
    if (changedEntries.length === 0) return;
    const optimisticUnits = unitsRef.current.map((unit) =>
      unit.id === id ? { ...unit, ...nextPatch } : unit
    );
    unitsRef.current = optimisticUnits;
    setUnits(optimisticUnits);
    const { error } = await supabase.from("units").update(nextPatch).eq("id", id);
    if (error) {
      console.error("updateUnit error:", error);
      await loadUnits();
      return;
    }
    const unitLabel = `Unit #${nextPatch.unit_no ?? previous.unit_no ?? "-"}`;
    const keys = changedEntries.map(([key]) => key);
    let message = `${unitLabel} was updated`;
    if (keys.includes("status")) {
      message = `${unitLabel} status changed to ${getStatusLabel(nextPatch.status ?? previous.status)}`;
    } else if (keys.includes("serial")) {
      message = `${unitLabel} serial changed to ${nextPatch.serial || "empty"}`;
    } else if (keys.includes("cert_date")) {
      message = nextPatch.cert_date
        ? `${unitLabel} certificate updated; expiry ${nextPatch.expiry_date}`
        : `${unitLabel} certificate date was removed`;
    } else if (keys.includes("notes")) {
      message = `${unitLabel} notes were updated`;
    } else if (keys.includes("damage_photos")) {
      message = `${unitLabel} damage photos were updated`;
    } else if (keys.includes("unit_no")) {
      message = `${unitLabel} number was updated`;
    }
    await logActivity({
      title: `edited ${itemName || "Chain Hoist"}`,
      message,
      link: activityLink,
    });
  }
  function validStatus(unit: Unit) {
    return isExpired(unit) ? "expired" : "valid";
  }
  async function uploadPhoto(unitId: string, file: File) {
    if (!allowUpload) return;
    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;
    const currentPhotos = unit.damage_photos ?? [];
if (currentPhotos.length >= 3) return;
const dataUrl = await fileToDataUrl(file);
const nextPhotos = [...currentPhotos, dataUrl].slice(0, 3);
    await updateUnit(unitId, { damage_photos: nextPhotos });
  }
  function deleteDamagePhoto(unitId: string, photoIndex: number) {
    if (!allowUpload) return;
    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;
    const currentPhotos = unit.damage_photos ?? [];
    const nextPhotos = currentPhotos.filter((_, idx) => idx !== photoIndex);
    void updateUnit(unitId, { damage_photos: nextPhotos });
  }
  async function addRow() {
    if (!allowAdd) return;
    const nextNo =
      units.length > 0
        ? Math.max(...units.map((u) => Number(u.unit_no || 0))) + 1
        : 1;
    const { data, error } = await supabase
      .from("units")
      .insert({
        item_id: itemId,
        unit_no: String(nextNo),
        serial: "",
        status: "available",
        notes: "",
        cert_date: null,
        expiry_date: null,
        damage_photos: [],
      })
      .select("id, unit_no, serial, status, notes, cert_date, expiry_date, damage_photos")
      .single();
    if (error) {
      console.error("addRow error:", error);
      return;
    }
    const nextUnits = [...unitsRef.current, data as Unit];
    unitsRef.current = nextUnits;
    setUnits(nextUnits);
    await logActivity({
      title: `added a unit to ${itemName || "Chain Hoist"}`,
      message: `Unit #${(data as Unit).unit_no ?? nextNo} was added`,
      link: activityLink,
    });
  }
  async function deleteRow(unitId: string) {
    if (!allowDelete) return;
    if (!confirm("Delete this row?")) return;
    const deletedUnit = unitsRef.current.find((unit) => unit.id === unitId);
    const { error } = await supabase.from("units").delete().eq("id", unitId);
    if (error) {
      console.error("deleteRow error:", error);
      return;
    }
    const nextUnits = unitsRef.current.filter((unit) => unit.id !== unitId);
    unitsRef.current = nextUnits;
    setUnits(nextUnits);
    await logActivity({
      title: `deleted a unit from ${itemName || "Chain Hoist"}`,
      message: `Unit #${deletedUnit?.unit_no ?? "-"} was deleted`,
      link: activityLink,
    });
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
    <div className="w-full min-w-0 overflow-hidden bg-white border border-gray-200 rounded-xl px-[2px] sm:px-5 pt-4 sm:pt-5 pb-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <div className="hidden lg:grid w-full min-w-0 grid-cols-[32px_minmax(0,1fr)_minmax(0,1.05fr)_minmax(0,1.05fr)_minmax(0,0.65fr)_minmax(0,0.85fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_24px] items-center gap-1 pt-2 pb-4 text-[10px] font-semibold text-gray-600">
        <div className="min-w-0 text-center">ID</div>
        <div className="min-w-0 truncate">Serial</div>
        <div className="min-w-0 truncate">Cert</div>
        <div className="min-w-0 truncate">Expiry</div>
        <div className="min-w-0 truncate text-center">Valid</div>
        <div className="min-w-0 truncate">Status</div>
        <div className="min-w-0 truncate">Note</div>
        <div className="min-w-0 truncate">Damage</div>
        <div aria-hidden="true" />
      </div>
      {units.length === 0 ? (
        <div className="text-sm text-gray-500">No units found.</div>
      ) : (
        units.map((u) => (
          <ChainHoistEditableRow
            key={u.id}
            unit={u}
            editable={editable}
            allowDelete={allowDelete}
            allowUpload={allowUpload}
            onSave={updateUnit}
            onUpload={uploadPhoto}
            onDelete={deleteRow}
            onDeleteDamagePhoto={deleteDamagePhoto}
            onOpenPhoto={openPhoto}
            validStatus={validStatus(u)}
          />
        ))
      )}
      {allowAdd ? (
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
function DamagePhotoThumb({
  photo,
  index,
  canDeletePhoto,
  onDelete,
  onOpenPhoto,
}: {
  photo: string;
  index: number;
  canDeletePhoto: boolean;
  onDelete: () => void;
  onOpenPhoto: (url: string) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="relative w-[10px] h-[10px] sm:w-10 sm:h-10 overflow-visible bg-white shrink-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <img
        src={photo}
        alt={`Damage ${index + 1}`}
        className="w-[10px] h-[10px] sm:w-10 sm:h-10 object-cover cursor-pointer rounded-[2px] sm:rounded-lg"
        onClick={() => onOpenPhoto(photo)}
      />
      {canDeletePhoto ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute -top-[5px] -right-[5px] w-[8px] h-[8px] sm:w-4 sm:h-4 rounded-full bg-white border text-[5px] sm:text-[9px] flex items-center justify-center hover:bg-gray-50 z-20"
          title="Delete photo"
        >
          ✕
        </button>
      ) : null}
      {hover ? (
        <div
          className="hidden sm:block"
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
function ChainHoistEditableRow({
  unit,
  validStatus,
  editable,
  allowDelete,
  allowUpload,
  onSave,
  onUpload,
  onDelete,
  onDeleteDamagePhoto,
  onOpenPhoto,
}: {
  unit: Unit;
  validStatus: "valid" | "expired";
  editable: boolean;
  allowDelete: boolean;
  allowUpload: boolean;
  onSave: (id: string, patch: UnitPatch) => Promise<void>;
  onUpload: (unitId: string, file: File) => Promise<void>;
  onDelete: (unitId: string) => Promise<void>;
  onDeleteDamagePhoto: (unitId: string, photoIndex: number) => void;
  onOpenPhoto: (url: string) => void;
}) {
  const [unitNo, setUnitNo] = useState(String(unit.unit_no));
  const [serial, setSerial] = useState(unit.serial || "");
  const [status, setStatus] = useState(unit.status || "available");
  const [notes, setNotes] = useState(unit.notes || "");
  const [certDate, setCertDate] = useState(unit.cert_date || "");
  const [expiryDate, setExpiryDate] = useState(unit.expiry_date || "");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    setUnitNo(String(unit.unit_no));
    setSerial(unit.serial || "");
    setStatus(unit.status || "available");
    setNotes(unit.notes || "");
    setCertDate(unit.cert_date || "");
    setExpiryDate(unit.expiry_date || "");
    didInitRef.current = true;
  }, [unit]);
  function debounceSave(key: string, fn: () => void) {
    if (timerRef.current[key]) clearTimeout(timerRef.current[key]);
    timerRef.current[key] = setTimeout(fn, 800);
  }
  const photos = unit.damage_photos ?? [];
  return (
    <div className="min-w-0 overflow-hidden border-t border-gray-200 pt-3">
      <input
        ref={fileRef}
        type="file"
        hidden
        accept="image/*"
        onChange={(e) => {
          if (!allowUpload) return;
          if (e.target.files?.[0]) {
            void onUpload(unit.id, e.target.files[0]);
          }
          e.target.value = "";
        }}
      />
      {/* MOBILE CARD STYLE */}
      <div className="lg:hidden rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-gray-400">
              Chain Hoist Unit
            </div>
            <input
              value={unitNo}
              readOnly={!editable}
              onChange={(e) => {
                if (!editable) return;
                const v = e.target.value;
                setUnitNo(v);
                debounceSave("unit_no_mobile", () => {
                  void onSave(unit.id, { unit_no: v.trim() });
                });
              }}
              onBlur={() => {
                if (!editable) return;
                void onSave(unit.id, { unit_no: unitNo.trim() });
              }}
              className="mt-1 w-full border-none bg-transparent p-0 text-[18px] font-bold text-gray-900 outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-1 text-[10px] font-semibold ${
                validStatus === "expired"
                  ? "bg-red-100 text-red-700"
                  : "bg-green-100 text-green-700"
              }`}
            >
              {validStatus === "expired" ? "Expired" : "Valid"}
            </span>
            {allowDelete ? (
              <Trash2
                size={16}
                className="cursor-pointer text-red-500"
                onClick={() => void onDelete(unit.id)}
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
                  void onSave(unit.id, { serial: v });
                });
              }}
              onBlur={() => {
                if (!editable) return;
                void onSave(unit.id, { serial });
              }}
              className="mt-1 w-full border-none bg-transparent p-0 text-[12px] font-medium text-gray-800 outline-none"
            />
          </label>
          <label className="rounded-xl bg-gray-50 p-2">
            <div className="text-[10px] font-semibold text-gray-400">Status</div>
            {editable ? (
              <select
                value={status}
                onChange={(e) => {
                  const v = e.target.value;
                  setStatus(v);
                  void onSave(unit.id, { status: v });
                }}
                style={{ color: getStatusTextColor(status) }}
                className="mt-1 w-full border-none bg-transparent p-0 text-[12px] font-semibold outline-none"
              >
                <option value="available">Available</option>
                <option value="in_use">In Use</option>
                <option value="maintenance">Maintenance</option>
                <option value="in_ksa">In KSA</option>
              </select>
            ) : (
              <div
                style={{ color: getStatusTextColor(status) }}
                className="mt-1 w-full text-[12px] font-semibold"
              >
                {getStatusLabel(status)}
              </div>
            )}
          </label>
          <label className="rounded-xl bg-gray-50 p-2">
            <div className="text-[10px] font-semibold text-gray-400">Cert Date</div>
            {editable ? (
              <input
                type="date"
                value={certDate}
                onChange={(e) => {
                  const v = e.target.value;
                  setCertDate(v);
                  const newExpiry = v ? addOneYear(v) : "";
                  setExpiryDate(newExpiry);
                  debounceSave("cert_mobile", () => {
                    void onSave(unit.id, { cert_date: v || null });
                  });
                }}
                onBlur={() => {
                  void onSave(unit.id, { cert_date: certDate || null });
                }}
                className="mt-1 w-full border-none bg-transparent p-0 text-[11px] text-gray-800 outline-none"
              />
            ) : (
              <div className="mt-1 w-full text-[11px] text-gray-800">
                {certDate || "-"}
              </div>
            )}
          </label>
          <label className="rounded-xl bg-gray-50 p-2">
            <div className="text-[10px] font-semibold text-gray-400">Expiry</div>
            <div className="mt-1 w-full text-[11px] text-gray-500">
              {expiryDate || "-"}
            </div>
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
                void onSave(unit.id, { notes: v });
              });
            }}
            onBlur={() => {
              if (!editable) return;
              void onSave(unit.id, { notes });
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
            {allowUpload ? (
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
    {allowUpload ? (
      <button
        type="button"
        onClick={() => onDeleteDamagePhoto(unit.id, idx)}
        className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border bg-white text-[9px] text-red-500 shadow-sm"
      >
        ✕
      </button>
    ) : null}
  </div>
))}
{photos.length > 3 ? (
  <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-gray-100 text-[11px] font-semibold text-gray-500">
    +{photos.length - 3}
  </span>
) : null}
            </div>
          ) : (
            <div className="text-[11px] text-gray-400">No photos</div>
          )}
        </div>
      </div>
      {/* DESKTOP TABLE STYLE */}
      <div className="hidden lg:grid w-full min-w-0 grid-cols-[32px_minmax(0,1fr)_minmax(0,1.05fr)_minmax(0,1.05fr)_minmax(0,0.65fr)_minmax(0,0.85fr)_minmax(0,1.2fr)_minmax(0,1.3fr)_24px] items-center gap-1">
        <input
          value={unitNo}
          readOnly={!editable}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setUnitNo(v);
            debounceSave("unit_no", () => {
              void onSave(unit.id, { unit_no: v.trim() });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onSave(unit.id, { unit_no: unitNo.trim() });
          }}
          className="w-full min-w-0 rounded-lg border-none bg-white px-0 py-1 text-center text-[10px] outline-none read-only:text-gray-700"
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
              void onSave(unit.id, { serial: v });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onSave(unit.id, { serial });
          }}
          className="w-full min-w-0 truncate rounded-lg border-none bg-white px-1 py-1 text-[11px] outline-none read-only:text-gray-700"
        />
        {editable ? (
          <input
            type="date"
            value={certDate}
            onChange={(e) => {
              const v = e.target.value;
              setCertDate(v);
              const newExpiry = v ? addOneYear(v) : "";
              setExpiryDate(newExpiry);
              debounceSave("cert_date", () => {
                void onSave(unit.id, { cert_date: v || null });
              });
            }}
            onBlur={() => {
              void onSave(unit.id, { cert_date: certDate || null });
            }}
            className="w-full min-w-0 rounded-lg border-none bg-white px-0.5 py-1 text-[10px] outline-none"
          />
        ) : (
          <div className="w-full min-w-0 truncate rounded-lg bg-white px-1 py-1 text-[10px] text-gray-700">
            {certDate || "-"}
          </div>
        )}
        <div className="w-full min-w-0 truncate rounded-lg bg-white px-1 py-1 text-[10px] text-gray-500">
          {expiryDate || "-"}
        </div>
        <div
          className={`w-full min-w-0 truncate rounded-lg px-1 py-1 text-[9px] font-semibold text-center ${
            validStatus === "expired"
              ? "bg-red-100 text-red-700"
              : "bg-green-100 text-green-700"
          }`}
        >
          {validStatus === "expired" ? "Expired" : "Valid"}
        </div>
        {editable ? (
          <select
            value={status}
            onChange={(e) => {
              const v = e.target.value;
              setStatus(v);
              void onSave(unit.id, { status: v });
            }}
            style={{ color: getStatusTextColor(status) }}
            className="w-full min-w-0 rounded-lg border-none bg-white px-0.5 py-1 text-[10px] outline-none"
          >
            <option value="available">Available</option>
            <option value="in_use">In Use</option>
            <option value="maintenance">Maintenance</option>
            <option value="in_ksa">In KSA</option>
          </select>
        ) : (
          <div
            style={{ color: getStatusTextColor(status) }}
            className="w-full min-w-0 truncate rounded-lg bg-white px-1 py-1 text-[10px] font-semibold"
          >
            {getStatusLabel(status)}
          </div>
        )}
        <textarea
          value={notes}
          readOnly={!editable}
          placeholder={editable ? "Note..." : ""}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setNotes(v);
            debounceSave("notes", () => {
              void onSave(unit.id, { notes: v });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onSave(unit.id, { notes });
          }}
          rows={1}
          className="w-full min-w-0 resize-none overflow-hidden rounded-lg border-none bg-white px-1 py-1 text-[10px] outline-none read-only:text-gray-700"
        />
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          {allowUpload ? (
            <ImagePlus
              size={20}
              className="cursor-pointer shrink-0 transition-colors duration-200"
              style={{ color: "#ef4444" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#000000")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
              onClick={() => fileRef.current?.click()}
            />
          ) : null}
          {allowUpload ? (
            <span className="text-xs text-gray-400 shrink-0">{photos.length}/3</span>
          ) : null}
          {photos.length > 0 ? (
            <div className="flex min-w-0 items-center gap-1 overflow-hidden">
              {photos.slice(0, 3).map((photo, idx) => (
                <DamagePhotoThumb
                  key={`${unit.id}-${idx}`}
                  photo={photo}
                  index={idx}
                  canDeletePhoto={allowUpload}
                  onOpenPhoto={onOpenPhoto}
                  onDelete={() => onDeleteDamagePhoto(unit.id, idx)}
                />
              ))}
              {photos.length > 3 ? (
                <span className="text-xs text-gray-400 shrink-0">
                  +{photos.length - 3}
                </span>
              ) : null}
            </div>
          ) : allowUpload ? (
            <span className="text-xs text-gray-400 shrink-0">No photos</span>
          ) : null}
        </div>
        <div className="flex w-full min-w-0 justify-center">
          {allowDelete ? (
            <Trash2
              size={16}
              className="cursor-pointer transition-colors duration-200"
              style={{ color: "#ef4444" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#000000")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
              onClick={() => void onDelete(unit.id)}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

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
  unit_no: string | number | null;
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

    const typed = (data ?? []) as Unit[];
    setUnits(typed);
  }

  useEffect(() => {
    const nextStats: Stats = {
      total: units.length,
      available: units.filter((u) => toStatus(u.status) === "available").length,
      inUse: units.filter((u) => toStatus(u.status) === "in_use").length,
      maintenance: units.filter((u) => toStatus(u.status) === "maintenance").length,
      inKsa: units.filter((u) => toStatus(u.status) === "in_ksa").length,
    };

    onStatsChange?.(nextStats);
  }, [units, onStatsChange]);

  async function updateUnit(id: string, patch: UnitPatch) {
    if (!editable) return;

    const nextPatch: UnitPatch = { ...patch };

    if (patch.unit_no !== undefined) {
      nextPatch.unit_no = String(patch.unit_no ?? "").trim();
    }

    setUnits((prev) =>
      prev.map((u) => (u.id === id ? { ...u, ...nextPatch } : u))
    );

    const { error } = await supabase
      .from("units")
      .update(nextPatch)
      .eq("id", id);

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
        unit_no: String(nextNumber),
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

    const ok = confirm("Delete this unit?");
    if (!ok) return;

    const { error } = await supabase.from("units").delete().eq("id", id);

    if (error) {
      console.error("deleteRow error:", error);
      return;
    }

    setUnits((prev) => prev.filter((u) => u.id !== id));
  }

  async function onPickDamagePhotos(unitId: string, files: FileList | null) {
    if (!editable || !files || files.length === 0) return;

    try {
      const unit = units.find((u) => u.id === unitId);
      if (!unit) return;

      const currentPhotos = unit.damage_photos ?? [];
      const remainingSlots = Math.max(0, 5 - currentPhotos.length);
      if (remainingSlots === 0) return;

      const picked = Array.from(files).slice(0, remainingSlots);
      const dataUrls = await Promise.all(picked.map((file) => fileToDataUrl(file)));
      const nextPhotos = [...currentPhotos, ...dataUrls].slice(0, 5);

      await updateUnit(unitId, { damage_photos: nextPhotos });
    } catch (error) {
      console.error("damage photos error", error);
    }
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
    const win = window.open("", "_blank");
    if (!win) return;

    win.document.write(`
      <html>
        <head>
          <title>Damage Photo</title>
          <style>
            body {
              margin: 0;
              background: #111;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
            }
            img {
              max-width: 95vw;
              max-height: 95vh;
              object-fit: contain;
            }
          </style>
        </head>
        <body>
          <img src="${url}" alt="Damage Photo" />
        </body>
      </html>
    `);
    win.document.close();
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 pt-5 pb-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <div className="flex items-center gap-2 text-[11px] font-semibold text-gray-600 pt-2 pb-4 overflow-x-auto">
        <div style={{ width: "32px", minWidth: "32px", maxWidth: "32px", textAlign: "center" }}>
          ID
        </div>

        <div style={{ width: "120px", minWidth: "120px", maxWidth: "120px" }}>
          Serial
        </div>

        <div style={{ width: "95px", minWidth: "95px", maxWidth: "95px" }}>
          Status
        </div>

        <div style={{ width: "230px", minWidth: "230px", maxWidth: "230px" }}>
          Note
        </div>

        <div style={{ width: "90px", minWidth: "90px", maxWidth: "90px" }}>
          Test Date
        </div>

        <div style={{ minWidth: "200px" }}>
          Damage Photos
        </div>
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
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="max-w-[1100px] mx-auto space-y-3">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
            Loading report...
          </div>
        </div>
      </div>
    );
  }

  if (!canOpenPage) {
    return (
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="max-w-[900px] mx-auto">
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
    <div className="min-h-screen bg-gray-50 p-3">
      <div className="max-w-[1100px] mx-auto space-y-3">
        <input
          ref={itemPhotoRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickItemPhoto}
        />

        <div className="bg-white border border-gray-200 rounded-2xl p-6">
          <div className="flex justify-between items-start gap-4">
            <div className="flex items-start gap-4 min-w-0">
              <div
                style={{
                  width: "120px",
                  minWidth: "120px",
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "center",
                  paddingTop: "18px",
                }}
              >
                <div className="flex items-start gap-2">
                  <div
                    style={{
                      width: "96px",
                      height: "96px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                    }}
                  >
                    {photoUrl ? (
                      <img
                        src={photoUrl}
                        alt={itemName}
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                        }}
                      />
                    ) : (
                      <div style={{ fontSize: "10px", color: "#9ca3af" }}>No photo</div>
                    )}
                  </div>

                  {canEditPage ? (
                    <button
                      type="button"
                      onClick={() => itemPhotoRef.current?.click()}
                      className="mt-1 transition"
                      title="Change photo"
                      style={{ color: "#ef4444", fontSize: "16px", cursor: "pointer" }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "#000000")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
                    >
                      ✎
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0">
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      backgroundColor: "#ef4444",
                      display: "inline-block",
                    }}
                  />

                  <p
                    style={{
                      fontSize: "16px",
                      color: "#4b5563",
                      margin: 0,
                      lineHeight: 1,
                    }}
                  >
                    Report
                  </p>
                </div>

                <div className="flex items-center gap-2 min-w-0">
                  <h1
                    style={{
                      fontSize: "25px",
                      fontWeight: 700,
                      color: "#111827",
                      lineHeight: 1.1,
                      marginTop: "10px",
                      marginBottom: "16px",
                    }}
                  >
                    {itemName || "-"}
                  </h1>

                  {canEditPage ? (
                    <button
                      type="button"
                      onClick={renameItem}
                      title="Edit name"
                      style={{
                        color: "#ef4444",
                        fontSize: "16px",
                        cursor: "pointer",
                        marginTop: "4px",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "#000000")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
                    >
                      ✎
                    </button>
                  ) : null}
                </div>

                <div
                  style={{
                    borderTop: "1px solid #e5e7eb",
                    paddingTop: "16px",
                  }}
                >
                  <div className="flex flex-wrap gap-2 text-[8px] font-semibold">
                    <span className="px-2 py-1 rounded-lg bg-gray-100 text-black">
                      Total Qty: {stats.total}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-green-100 text-black">
                      Available Qty: {stats.available}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-blue-100 text-black">
                      In Use: {stats.inUse}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-yellow-100 text-black">
                      Maintenance: {stats.maintenance}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-purple-100 text-black">
                      In KSA: {stats.inKsa}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <Link
              href="/equipment-report/update"
              className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98] shrink-0"
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
      className="relative w-10 h-10 overflow-visible bg-white shrink-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <img
        src={photo}
        alt={`Damage ${index + 1}`}
        className="w-10 h-10 object-cover cursor-pointer rounded-lg"
        onClick={() => onOpenPhoto(photo)}
      />

      {editable ? (
        <button
          type="button"
          onClick={onDelete}
          className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-white border text-[9px] flex items-center justify-center hover:bg-gray-50 z-20"
          title="Delete photo"
        >
          ✕
        </button>
      ) : null}

      {hover ? (
        <div
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
      <div className="flex items-center gap-1 flex-nowrap overflow-visible">
        <input
          value={unitNo}
          readOnly={!editable}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setUnitNo(v);
            debounceSave("unit_no", () => {
              void onChange(unit.id, { unit_no: v.trim() });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onChange(unit.id, { unit_no: unitNo.trim() });
          }}
          style={{
            width: "32px",
            minWidth: "32px",
            maxWidth: "32px",
            flex: "0 0 32px",
            border: "none",
            outline: "none",
          }}
          className="rounded-lg px-0 py-1 text-[11px] text-center bg-white read-only:text-gray-700"
        />

        <input
          value={serial}
          readOnly={!editable}
          placeholder={editable ? "Serial number" : ""}
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
          style={{
            width: "120px",
            minWidth: "120px",
            maxWidth: "120px",
            flex: "0 0 120px",
            border: "none",
            outline: "none",
          }}
          className="rounded-lg px-2 py-1 text-[12px] bg-white read-only:text-gray-700"
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
          style={{
            width: "95px",
            minWidth: "95px",
            maxWidth: "95px",
            flex: "0 0 95px",
            border: "none",
            outline: "none",
            color: getStatusTextColor(status),
          }}
          className="rounded-lg px-1 py-1 text-[12px] bg-white disabled:bg-white"
        >
          <option value="available">Available</option>
          <option value="in_use">In Use</option>
          <option value="maintenance">Maintenance</option>
          <option value="in_ksa">In KSA</option>
        </select>

        <textarea
          value={notes}
          readOnly={!editable}
          placeholder={editable ? "Write note..." : ""}
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
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
          }}
          rows={1}
          style={{
            width: "230px",
            minWidth: "230px",
            maxWidth: "230px",
            flex: "0 0 230px",
            border: "none",
            outline: "none",
            resize: "none",
            overflow: "hidden",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            wordBreak: "break-word",
            lineHeight: "1.35",
          }}
          className="rounded-lg px-2 py-1 text-[12px] bg-white read-only:text-gray-700"
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
          style={{
            width: "90px",
            minWidth: "90px",
            maxWidth: "90px",
            flex: "0 0 90px",
            border: "none",
            outline: "none",
          }}
          className="rounded-lg px-1 py-1 text-[12px] bg-white read-only:text-gray-700"
        />

        <div className="min-w-[200px] flex items-center gap-2 overflow-visible">
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

          {editable ? (
  <ImagePlus
    size={20}
    className="cursor-pointer transition-colors duration-200 shrink-0"
    style={{ color: "#ef4444" }}
    onMouseEnter={(e) => (e.currentTarget.style.color = "#000000")}
    onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
    onClick={() => fileRef.current?.click()}
  />
) : null}

          {editable ? (
  <span className="text-xs text-gray-400 shrink-0">
    {photos.length}/5
  </span>
) : null}

          {photos.length > 0 ? (
            photos.map((photo, idx) => (
              <DamagePhotoThumb
                key={`${unit.id}-${idx}`}
                photo={photo}
                index={idx}
                editable={editable}
                onOpenPhoto={onOpenPhoto}
                onDelete={() => void onDeleteDamagePhoto(unit.id, idx)}
              />
            ))
          ) : editable ? (
  <span className="text-xs text-gray-400 shrink-0">No photos</span>
) : null}
        </div>

        <div className="w-[28px] flex justify-center">
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
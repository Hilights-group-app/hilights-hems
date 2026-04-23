"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ImagePlus, Trash2 } from "lucide-react";

/* ===== TYPES ===== */
type UserRole = "admin" | "warehouse_manager" | "viewer" | "head";
type Department = "" | "lighting" | "video" | "rigging";

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
  Pick<
    Unit,
    "unit_no" | "serial" | "status" | "notes" | "cert_date" | "damage_photos"
  >
>;

type Stats = {
  total: number;
  available: number;
  inuse: number;
  maintenance: number;
  ksa: number;
  expired: number;
};

/* ===== HELPERS ===== */
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

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

/* ===================================================== */
/* 🔥 SHARED ROWS BLOCK */
/* ===================================================== */

export function ChainHoistRowsBlock({
  itemId,
  onStatsChange,
  editable = true,
  allowAdd = true,
  allowDelete = true,
  allowUpload = true,
}: {
  itemId: string;
  onStatsChange?: (stats: Stats) => void;
  editable?: boolean;
  allowAdd?: boolean;
  allowDelete?: boolean;
  allowUpload?: boolean;
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
      .select("id, unit_no, serial, status, notes, cert_date, expiry_date, damage_photos")
      .eq("item_id", itemId)
      .order("unit_no", { ascending: true });

    if (error) {
      console.error("loadUnits error:", error);
      return;
    }

    setUnits((data ?? []) as Unit[]);
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

    const newStats: Stats = {
      total: units.length,
      available,
      inuse,
      maintenance,
      ksa,
      expired,
    };

    onStatsChange?.(newStats);
  }, [units, onStatsChange]);

  async function updateUnit(id: string, patch: UnitPatch) {
    const nextPatch: Partial<Unit> = { ...patch };

    if (patch.unit_no !== undefined) {
      nextPatch.unit_no = String(patch.unit_no).trim();
    }

    if (patch.cert_date !== undefined) {
      nextPatch.expiry_date = patch.cert_date ? addOneYear(patch.cert_date) : null;
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

  function validStatus(unit: Unit) {
    return isExpired(unit) ? "expired" : "valid";
  }

  async function uploadPhoto(unitId: string, file: File) {
    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;

    const currentPhotos = unit.damage_photos ?? [];
    if (currentPhotos.length >= 5) return;

    try {
      const dataUrl = await fileToDataUrl(file);
      const nextPhotos = [...currentPhotos, dataUrl].slice(0, 5);

      setUnits((prev) =>
        prev.map((u) =>
          u.id === unitId ? { ...u, damage_photos: nextPhotos } : u
        )
      );

      const { error } = await supabase
        .from("units")
        .update({ damage_photos: nextPhotos })
        .eq("id", unitId);

      if (error) {
        console.error("uploadPhoto error:", error);
        await loadUnits();
      }
    } catch (e) {
      console.error("fileToDataUrl error:", e);
    }
  }

  function deleteDamagePhoto(unitId: string, photoIndex: number) {
    const unit = units.find((u) => u.id === unitId);
    if (!unit) return;

    const currentPhotos = unit.damage_photos ?? [];
    const nextPhotos = currentPhotos.filter((_, idx) => idx !== photoIndex);

    void updateUnit(unitId, { damage_photos: nextPhotos });
  }

  async function addRow() {
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

    setUnits((prev) => [...prev, data as Unit]);
  }

  async function deleteRow(unitId: string) {
    const ok = confirm("Delete this row?");
    if (!ok) return;

    const { error } = await supabase.from("units").delete().eq("id", unitId);

    if (error) {
      console.error("deleteRow error:", error);
      return;
    }

    setUnits((prev) => prev.filter((u) => u.id !== unitId));
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

        <div style={{ width: "100px", minWidth: "100px", maxWidth: "100px" }}>
          Cert Date
        </div>

        <div style={{ width: "100px", minWidth: "100px", maxWidth: "100px" }}>
          Expiry
        </div>

        <div style={{ width: "70px", minWidth: "70px", maxWidth: "70px" }}>
          Valid
        </div>

        <div style={{ width: "95px", minWidth: "95px", maxWidth: "95px" }}>
          Status
        </div>

        <div style={{ width: "230px", minWidth: "230px", maxWidth: "230px" }}>
          Note
        </div>

        <div style={{ minWidth: "200px" }}>
          Damage Photos
        </div>
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
  );
}

/* ===================================================== */
/* PAGE */
/* ===================================================== */

export default function ChainHoistReportPage() {
  const supabase = createClient();
  const params = useParams();
  const itemId = params.itemId as string;

  const itemPhotoRef = useRef<HTMLInputElement | null>(null);

  const [itemName, setItemName] = useState("");
  const [itemPhotoUrl, setItemPhotoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [stats, setStats] = useState<Stats>({
    total: 0,
    available: 0,
    inuse: 0,
    maintenance: 0,
    ksa: 0,
    expired: 0,
  });

  const [role, setRole] = useState<UserRole | "">("");
  const [department, setDepartment] = useState<Department>("");

  useEffect(() => {
    void loadProfileAndItem();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  async function loadProfileAndItem() {
    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();

      if (userErr || !user) {
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

      const { data, error } = await supabase
        .from("items")
        .select("name, photo_url")
        .eq("id", itemId)
        .single();

      if (error) {
        console.error("loadItem error:", error);
        setLoading(false);
        return;
      }

      if (data) {
        setItemName(data.name ?? "");
        setItemPhotoUrl(data.photo_url ?? null);
      }
    } catch (e) {
      console.error("loadProfileAndItem error:", e);
    } finally {
      setLoading(false);
    }
  }

  const canOpenPage =
    role === "admin" ||
    role === "warehouse_manager" ||
    (role === "head" && department === "rigging");

  const canEditPage =
    role === "admin" ||
    role === "warehouse_manager" ||
    (role === "head" && department === "rigging");

  async function renameItem() {
    if (!canEditPage) return;

    const next = prompt("Chain hoist name:", itemName);
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

      setItemPhotoUrl(dataUrl);
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
                    {itemPhotoUrl ? (
                      <img
                        src={itemPhotoUrl}
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
                      In Use: {stats.inuse}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-yellow-100 text-black">
                      Maintenance: {stats.maintenance}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-purple-100 text-black">
                      In KSA: {stats.ksa}
                    </span>
                    <span className="px-2 py-1 rounded-lg bg-red-100 text-black">
                      Expired: {stats.expired}
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

        <ChainHoistRowsBlock
          itemId={itemId}
          onStatsChange={setStats}
          editable={canEditPage}
          allowAdd={canEditPage}
          allowDelete={canEditPage}
          allowUpload={canEditPage}
        />
      </div>
    </div>
  );
}

/* ===================================================== */
/* ROW */
/* ===================================================== */

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

      {canDeletePhoto ? (
        <button
          type="button"
          onClick={onDelete}
          className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-white border text-[9px] flex items-center justify-center hover:bg-gray-50 z-20"
          title="Delete photo"
        >
          ✕
        </button>
      ) : null}

      {hover && (
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
      )}
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
              void onSave(unit.id, { unit_no: v.trim() });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onSave(unit.id, { unit_no: unitNo.trim() });
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
              void onSave(unit.id, { serial: v });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onSave(unit.id, { serial });
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

        <input
          type="date"
          value={certDate}
          readOnly={!editable}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setCertDate(v);

            const newExpiry = v ? addOneYear(v) : "";
            setExpiryDate(newExpiry);

            debounceSave("cert_date", () => {
              void onSave(unit.id, { cert_date: v || null });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onSave(unit.id, { cert_date: certDate || null });
          }}
          style={{
            width: "100px",
            minWidth: "100px",
            maxWidth: "100px",
            flex: "0 0 100px",
            border: "none",
            outline: "none",
          }}
          className="rounded-lg px-1 py-1 text-[11px] bg-white read-only:text-gray-700"
        />

        <input
          type="date"
          value={expiryDate}
          readOnly
          style={{
            width: "100px",
            minWidth: "100px",
            maxWidth: "100px",
            flex: "0 0 100px",
            border: "none",
            outline: "none",
            color: "#6b7280",
          }}
          className="rounded-lg px-1 py-1 text-[11px] bg-white"
        />

        <div
          style={{
            width: "70px",
            minWidth: "70px",
            maxWidth: "70px",
            flex: "0 0 70px",
          }}
          className={`rounded-lg px-2 py-1 text-[11px] font-semibold text-center ${
            validStatus === "expired"
              ? "bg-red-100 text-red-700"
              : "bg-green-100 text-green-700"
          }`}
        >
          {validStatus === "expired" ? "Expired" : "Valid"}
        </div>

        <select
          value={status}
          disabled={!editable}
          onChange={(e) => {
            if (!editable) return;
            const v = e.target.value;
            setStatus(v);
            void onSave(unit.id, { status: v });
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
              void onSave(unit.id, { notes: v });
            });
          }}
          onBlur={() => {
            if (!editable) return;
            void onSave(unit.id, { notes });
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

        <div className="min-w-[200px] flex items-center gap-2 overflow-visible">
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
                canDeletePhoto={allowUpload}
                onOpenPhoto={onOpenPhoto}
                onDelete={() => onDeleteDamagePhoto(unit.id, idx)}
              />
            ))
          ) : editable ? (
  <span className="text-xs text-gray-400 shrink-0">No photos</span>
) : null}
        </div>

        <div className="w-[28px] min-w-[28px] flex justify-center">
          {allowDelete ? (
            <Trash2
              size={16}
              strokeWidth={2}
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
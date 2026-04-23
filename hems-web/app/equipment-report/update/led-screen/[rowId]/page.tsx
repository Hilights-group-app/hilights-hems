"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserName } from "@/lib/authStore";
import { Pencil, Trash2 } from "lucide-react";

type UserRole = "admin" | "warehouse_manager" | "viewer" | "head";
type Department = "" | "lighting" | "video" | "rigging";

type QtyViewMode = "cabinet" | "sqm";

type MatrixRow = {
  id: string;
  model_id: string;
  size: string;
  qty: number;
  available_qty: number;
  in_use_qty: number;
  maintenance_qty: number;
  in_ksa_qty: number;
};

type MatrixModel = {
  id: string;
  name: string;
};

type IssueType =
  | "dead_pixels"
  | "ic_problem"
  | "hub_card_problem"
  | "damaged_pixels"
  | "damaged_housing";

type MaintenanceLog = {
  id: string;
  matrix_row_id: string;
  problem_type: IssueType;
  qty: number;
  team_name: string | null;
  event_name: string | null;
  event_date: string | null;
  note: string | null;
  photo_data: string | null;
  photo_data_list: string[] | null;
  created_at: string;
  created_by: string | null;
};

const ISSUE_OPTIONS: { value: IssueType; label: string }[] = [
  { value: "dead_pixels", label: "Dead Pixels" },
  { value: "ic_problem", label: "IC Problem" },
  { value: "hub_card_problem", label: "Hub Card Problem" },
  { value: "damaged_pixels", label: "Damaged Pixels" },
  { value: "damaged_housing", label: "Damaged Housing" },
];

function normalizeText(v: string) {
  return v.trim().replace(/\s+/g, " ");
}

function parseLedName(name: string) {
  const clean = normalizeText(name);
  const parts = clean.split(" - ");

  if (parts.length >= 2) {
    return {
      brand: parts[0],
      model: parts.slice(1).join(" - "),
    };
  }

  const firstSpace = clean.indexOf(" ");
  if (firstSpace === -1) {
    return { brand: clean, model: "" };
  }

  return {
    brand: clean.slice(0, firstSpace),
    model: clean.slice(firstSpace + 1),
  };
}

function clampQty(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
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
  return !Number.isFinite(sqm) || sqm <= 0 ? 1 : sqm;
}

function toDisplayQty(value: number, size: string, mode: QtyViewMode) {
  if (mode === "cabinet") return value;
  return value * parseCabinetArea(size);
}

function formatQty(value: number, mode: QtyViewMode) {
  if (mode === "cabinet") return String(clampQty(value));
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function unitSuffix(mode: QtyViewMode) {
  return mode === "cabinet" ? "Cabinet" : "SQM";
}

function isTechnicalIssue(type: IssueType) {
  return (
    type === "dead_pixels" ||
    type === "ic_problem" ||
    type === "hub_card_problem"
  );
}

function isCrewDamage(type: IssueType) {
  return type === "damaged_pixels" || type === "damaged_housing";
}

function getIssueLabel(type: IssueType) {
  return ISSUE_OPTIONS.find((x) => x.value === type)?.label || type;
}

function rowAvailableFromTotal(
  total: number,
  inUse: number,
  maintenance: number,
  inKsa: number
) {
  return Math.max(0, total - inUse - maintenance - inKsa);
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function normalizePhotoList(input: unknown, fallback?: string | null): string[] {
  const arr = Array.isArray(input)
    ? input.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];

  if (arr.length > 0) return arr.slice(0, 3);
  if (fallback && typeof fallback === "string") return [fallback];
  return [];
}

export default function LedScreenRowReportPage() {
  const supabase = createClient();
  const params = useParams();

  const rowId =
    typeof params?.rowId === "string"
      ? params.rowId
      : Array.isArray(params?.rowId)
      ? params.rowId[0]
      : "";

  const [role, setRole] = useState<UserRole | "">("");
  const [department, setDepartment] = useState<Department>("");

  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<QtyViewMode>("sqm");
  const [row, setRow] = useState<MatrixRow | null>(null);
  const [model, setModel] = useState<MatrixModel | null>(null);
  const [issues, setIssues] = useState<MaintenanceLog[]>([]);

  const [showAddModal, setShowAddModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const [issueType, setIssueType] = useState<IssueType>("dead_pixels");
  const [qty, setQty] = useState(1);
  const [teamName, setTeamName] = useState("");
  const [eventName, setEventName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [note, setNote] = useState("");
  const [photoList, setPhotoList] = useState<string[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [editIssueId, setEditIssueId] = useState<string | null>(null);
  const [editQty, setEditQty] = useState(1);
  const [showEditModal, setShowEditModal] = useState(false);

  useEffect(() => {
    if (!rowId) {
      setLoading(false);
      return;
    }
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId]);

  async function loadData() {
    setLoading(true);

    try {
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();

      if (userErr || !user) {
        console.error("auth user error", userErr);
        setRow(null);
        setModel(null);
        setIssues([]);
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

      const { data: rowData, error: rowError } = await supabase
        .from("matrix_rows")
        .select(
          "id, model_id, size, qty, available_qty, in_use_qty, maintenance_qty, in_ksa_qty"
        )
        .eq("id", rowId)
        .single();

      if (rowError || !rowData) {
        console.error("load row error", rowError);
        setRow(null);
        setModel(null);
        setIssues([]);
        setLoading(false);
        return;
      }

      const { data: modelData, error: modelError } = await supabase
        .from("matrix_models")
        .select("id, name")
        .eq("id", rowData.model_id)
        .single();

      if (modelError) {
        console.error("load model error", modelError);
      }

      const { data: issueRows, error: issueError } = await supabase
        .from("led_maintenance_logs")
        .select(
          "id, matrix_row_id, problem_type, qty, team_name, event_name, event_date, note, photo_data, photo_data_list, created_at, created_by"
        )
        .eq("matrix_row_id", rowId)
        .order("created_at", { ascending: false });

      if (issueError) {
        console.error("load issues error", issueError);
      }

      const normalizedIssues = ((issueRows ?? []) as any[]).map((item) => ({
        ...item,
        photo_data_list: normalizePhotoList(item.photo_data_list, item.photo_data),
      })) as MaintenanceLog[];

      setRow(rowData as MatrixRow);
      setModel((modelData ?? null) as MatrixModel | null);
      setIssues(normalizedIssues);
    } catch (error) {
      console.error("loadData unexpected error", error);
      setRow(null);
      setModel(null);
      setIssues([]);
    } finally {
      setLoading(false);
    }
  }

  async function syncMaintenance(nextIssues: MaintenanceLog[]) {
    if (!row || !canEditPage) return;

    const maintenanceQty = nextIssues
      .filter(
        (item) =>
          item.problem_type !== "damaged_housing" &&
          item.problem_type !== "hub_card_problem"
      )
      .reduce((sum, item) => sum + clampQty(item.qty), 0);

    const nextAvailable = rowAvailableFromTotal(
      clampQty(row.qty),
      clampQty(row.in_use_qty),
      maintenanceQty,
      clampQty(row.in_ksa_qty)
    );

    const { error } = await supabase
      .from("matrix_rows")
      .update({
        maintenance_qty: maintenanceQty,
        available_qty: nextAvailable,
      })
      .eq("id", row.id);

    if (error) {
      console.error("sync maintenance error", error);
      return;
    }

    setRow((prev) =>
      prev
        ? {
            ...prev,
            maintenance_qty: maintenanceQty,
            available_qty: nextAvailable,
          }
        : prev
    );
  }

  function resetAddForm() {
    setIssueType("dead_pixels");
    setQty(1);
    setTeamName("");
    setEventName("");
    setEventDate("");
    setNote("");
    setPhotoList([]);
    setPhotoError(null);
  }

  const parsedName = useMemo(() => {
    return model ? parseLedName(model.name) : { brand: "", model: "" };
  }, [model]);

  const technicalIssues = useMemo(
    () => issues.filter((x) => isTechnicalIssue(x.problem_type)),
    [issues]
  );

  const crewIssues = useMemo(
    () => issues.filter((x) => isCrewDamage(x.problem_type)),
    [issues]
  );

  const canOpenPage =
    role === "admin" ||
    role === "warehouse_manager" ||
    (role === "head" && department === "video");

  const canEditPage = canOpenPage;

  function openAddIssue() {
    if (!canEditPage) return;
    resetAddForm();
    setShowAddModal(true);
  }

  function closeAddIssue() {
    setShowAddModal(false);
    resetAddForm();
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    if (!canEditPage) return;

    const files = Array.from(e.target.files || []);
    setPhotoError(null);

    if (files.length === 0) return;

    if (files.length > 3) {
      setPhotoError("Maximum 3 photos only.");
      e.target.value = "";
      return;
    }

    try {
      const list = await Promise.all(files.map((file) => fileToDataUrl(file)));
      setPhotoList(list.slice(0, 3));
    } catch (error) {
      console.error("photo read error", error);
      setPhotoError("Failed to read selected photo.");
    } finally {
      e.target.value = "";
    }
  }

  async function addIssue() {
    if (!canEditPage || !row) return;

    const cleanQty = clampQty(qty);
    if (cleanQty <= 0) {
      alert("Please enter qty");
      return;
    }

    if (isCrewDamage(issueType)) {
      if (!teamName.trim()) {
        alert("Please enter team name");
        return;
      }
      if (!eventName.trim()) {
        alert("Please enter event name");
        return;
      }
      if (!eventDate.trim()) {
        alert("Please enter date");
        return;
      }
    }

    setSaving(true);

    try {
      if (isTechnicalIssue(issueType)) {
        const existingTechnicalList = issues.filter(
          (item) =>
            item.matrix_row_id === row.id &&
            item.problem_type === issueType &&
            isTechnicalIssue(item.problem_type)
        );

        if (existingTechnicalList.length > 0) {
          const baseIssue = existingTechnicalList[0];
          const duplicatedIssues = existingTechnicalList.slice(1);

          const mergedQty =
            existingTechnicalList.reduce(
              (sum, item) => sum + clampQty(item.qty),
              0
            ) + cleanQty;

          const { error: updateError } = await supabase
            .from("led_maintenance_logs")
            .update({
              qty: mergedQty,
              team_name: null,
              event_name: null,
              event_date: null,
              note: null,
              photo_data: null,
              photo_data_list: null,
              created_by: getUserName?.() || baseIssue.created_by || null,
            })
            .eq("id", baseIssue.id);

          if (updateError) {
            console.error("merge technical issue error", updateError);
            alert(updateError.message || "Failed to update issue qty");
            setSaving(false);
            return;
          }

          if (duplicatedIssues.length > 0) {
            const duplicateIds = duplicatedIssues.map((item) => item.id);

            const { error: deleteDuplicatesError } = await supabase
              .from("led_maintenance_logs")
              .delete()
              .in("id", duplicateIds);

            if (deleteDuplicatesError) {
              console.error(
                "delete duplicate technical issues error",
                deleteDuplicatesError
              );
            }
          }

          const normalizedUpdated: MaintenanceLog = {
            ...baseIssue,
            qty: mergedQty,
            team_name: null,
            event_name: null,
            event_date: null,
            note: null,
            photo_data: null,
            photo_data_list: null,
            created_by: getUserName?.() || baseIssue.created_by || null,
          };

          const remainingIssues = issues.filter(
            (item) => !existingTechnicalList.some((x) => x.id === item.id)
          );

          const nextIssues = [normalizedUpdated, ...remainingIssues];
          setIssues(nextIssues);
          await syncMaintenance(nextIssues);
          setSaving(false);
          closeAddIssue();
          return;
        }

        const technicalPayload = {
          matrix_row_id: row.id,
          problem_type: issueType,
          qty: cleanQty,
          team_name: null,
          event_name: null,
          event_date: null,
          note: null,
          photo_data: null,
          photo_data_list: null,
          created_by: getUserName?.() || null,
        };

        const { data: insertedTechRows, error: insertTechError } = await supabase
          .from("led_maintenance_logs")
          .insert(technicalPayload)
          .select(
            "id, matrix_row_id, problem_type, qty, team_name, event_name, event_date, note, photo_data, photo_data_list, created_at, created_by"
          );

        if (
          insertTechError ||
          !insertedTechRows ||
          insertedTechRows.length === 0
        ) {
          console.error("insert technical issue error", insertTechError);
          alert(insertTechError?.message || "Failed to add issue");
          setSaving(false);
          return;
        }

        const insertedNormalized = {
          ...(insertedTechRows[0] as any),
          photo_data_list: normalizePhotoList(
            (insertedTechRows[0] as any)?.photo_data_list,
            (insertedTechRows[0] as any)?.photo_data
          ),
        } as MaintenanceLog;

        const nextIssues = [insertedNormalized, ...issues];
        setIssues(nextIssues);
        await syncMaintenance(nextIssues);
        setSaving(false);
        closeAddIssue();
        return;
      }

      const payload = {
        matrix_row_id: row.id,
        problem_type: issueType,
        qty: cleanQty,
        team_name: teamName.trim(),
        event_name: eventName.trim(),
        event_date: eventDate,
        note: note.trim() || null,
        photo_data: photoList[0] || null,
        photo_data_list: photoList.length > 0 ? photoList : null,
        created_by: getUserName?.() || null,
      };

      const { data: insertedRows, error } = await supabase
        .from("led_maintenance_logs")
        .insert(payload)
        .select(
          "id, matrix_row_id, problem_type, qty, team_name, event_name, event_date, note, photo_data, photo_data_list, created_at, created_by"
        );

      if (error || !insertedRows || insertedRows.length === 0) {
        console.error("add crew issue error", error);
        alert(error?.message || "Failed to add issue");
        setSaving(false);
        return;
      }

      const inserted = {
        ...(insertedRows[0] as any),
        photo_data_list: normalizePhotoList(
          (insertedRows[0] as any)?.photo_data_list,
          (insertedRows[0] as any)?.photo_data
        ),
      } as MaintenanceLog;

      const nextIssues = [inserted, ...issues];
      setIssues(nextIssues);
      await syncMaintenance(nextIssues);
      setSaving(false);
      closeAddIssue();
    } catch (error) {
      console.error("addIssue unexpected error", error);
      alert("Something went wrong");
      setSaving(false);
    }
  }

  function editIssue(issueId: string) {
    if (!canEditPage) return;

    const issue = issues.find((x) => x.id === issueId);
    if (!issue) return;

    setEditIssueId(issueId);
    setEditQty(issue.qty);
    setShowEditModal(true);
  }

  async function updateIssueQty() {
    if (!canEditPage || !editIssueId) return;

    const cleanQty = clampQty(editQty);
    if (cleanQty <= 0) {
      alert("Invalid qty");
      return;
    }

    const editorName = getUserName?.() || null;

    const { error } = await supabase
      .from("led_maintenance_logs")
      .update({
        qty: cleanQty,
        created_by: editorName,
      })
      .eq("id", editIssueId);

    if (error) {
      alert("Update failed");
      console.error(error);
      return;
    }

    const nextIssues = issues.map((x) =>
      x.id === editIssueId
        ? {
            ...x,
            qty: cleanQty,
            created_by: editorName,
          }
        : x
    );

    setIssues(nextIssues);
    await syncMaintenance(nextIssues);

    setShowEditModal(false);
    setEditIssueId(null);
  }

  async function deleteIssue(issueId: string) {
    if (!canEditPage) return;

    const ok = confirm("Delete this issue?");
    if (!ok) return;

    const { error } = await supabase
      .from("led_maintenance_logs")
      .delete()
      .eq("id", issueId);

    if (error) {
      alert("Delete failed");
      console.error(error);
      return;
    }

    const nextIssues = issues.filter((x) => x.id !== issueId);
    setIssues(nextIssues);
    await syncMaintenance(nextIssues);
  }

  const totalDisplay = row ? toDisplayQty(row.qty, row.size, viewMode) : 0;
  const availableDisplay = row
    ? toDisplayQty(row.available_qty, row.size, viewMode)
    : 0;
  const inUseDisplay = row
    ? toDisplayQty(row.in_use_qty, row.size, viewMode)
    : 0;
  const maintenanceDisplay = row
    ? toDisplayQty(row.maintenance_qty, row.size, viewMode)
    : 0;
  const inKsaDisplay = row
    ? toDisplayQty(row.in_ksa_qty, row.size, viewMode)
    : 0;

  if (loading || !role) {
    return (
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="max-w-[1100px] mx-auto space-y-3">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
            Loading...
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

  if (!rowId || !row) {
    return (
      <div className="min-h-screen bg-gray-50 p-3">
        <div className="max-w-[1100px] mx-auto space-y-3">
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)] text-gray-900">
            LED screen report not found.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-3">
      <div className="max-w-[1100px] mx-auto space-y-3">
        <div className="bg-white border border-gray-200 rounded-xl px-5 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 pt-1 pb-1">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                <h1 className="text-[18px] font-semibold text-gray-900 leading-none">
                  LED Report
                </h1>
              </div>

              <div className="space-y-1 text-[10px] text-gray-900 leading-[1.35]">
                <div>
                  <span className="font-semibold">Brand :</span>{" "}
                  {parsedName.brand || "-"}
                </div>
                <div>
                  <span className="font-semibold">Model :</span>{" "}
                  {parsedName.model || "-"}
                </div>
                <div>
                  <span className="font-semibold">Cabinet size :</span> {row.size}
                </div>
              </div>
            </div>

            <div className="flex flex-col items-end gap-2 shrink-0 pt-1 pb-1">
              <Link
                href="/equipment-report/update"
                className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
              >
                Back
              </Link>

              {canEditPage ? (
                <button
                  type="button"
                  onClick={openAddIssue}
                  className="px-2.5 py-1 rounded-full border border-gray-300 text-[10px] font-medium text-gray-700 bg-white transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
                >
                  Add Issue
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div className="text-[12px] font-semibold text-gray-800">Qty</div>

            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setViewMode("sqm")}
                className={`px-2.5 py-0.5 rounded-full border text-[10px] font-medium transition-all duration-150 ease-out ${
                  viewMode === "sqm"
                    ? "border-red-200 bg-red-50 text-red-700"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-red-50 hover:border-red-200 hover:text-red-700"
                }`}
              >
                SQM
              </button>

              <button
                type="button"
                onClick={() => setViewMode("cabinet")}
                className={`px-2.5 py-0.5 rounded-full border text-[10px] font-medium transition-all duration-150 ease-out ${
                  viewMode === "cabinet"
                    ? "border-red-200 bg-red-50 text-red-700"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-red-50 hover:border-red-200 hover:text-red-700"
                }`}
              >
                Cabinet
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className="px-2.5 py-1 rounded-lg bg-gray-100 text-gray-900 text-[10px] font-semibold">
              Total : {formatQty(totalDisplay, viewMode)} {unitSuffix(viewMode)}
            </span>

            <span className="px-2.5 py-1 rounded-lg bg-green-100 text-green-700 text-[10px] font-semibold">
              Available : {formatQty(availableDisplay, viewMode)}{" "}
              {unitSuffix(viewMode)}
            </span>

            <span className="px-2.5 py-1 rounded-lg bg-blue-100 text-blue-700 text-[10px] font-semibold">
              In Use : {formatQty(inUseDisplay, viewMode)} {unitSuffix(viewMode)}
            </span>

            <span className="px-2.5 py-1 rounded-lg bg-yellow-100 text-yellow-700 text-[10px] font-semibold">
              Maintenance : {formatQty(maintenanceDisplay, viewMode)}{" "}
              {unitSuffix(viewMode)}
            </span>

            <span className="px-2.5 py-1 rounded-lg bg-purple-100 text-purple-700 text-[10px] font-semibold">
              In KSA : {formatQty(inKsaDisplay, viewMode)} {unitSuffix(viewMode)}
            </span>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl px-5 py-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-1.5 h-1.5 bg-black rounded-full" />
            <div className="text-[13px] font-semibold text-red-700">
              Manufacturing Defect
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              Issues related to factory or product defects
            </div>
          </div>

          {technicalIssues.length === 0 ? (
            <div className="text-[12px] text-gray-400">No technical issues.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 px-1">
              {technicalIssues.map((log) => (
                <div
                  key={log.id}
                  className="rounded-xl bg-gray-50 border border-gray-200 p-3"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-[14px] text-gray-900">
                        {getIssueLabel(log.problem_type)} : {log.qty} Cabinet
                      </div>
                      <div className="text-[11px] text-gray-500 mt-1">
                        Saved: {new Date(log.created_at).toLocaleString()} added by{" "}
                        {log.created_by || "-"}
                      </div>
                    </div>

                    {canEditPage ? (
                      <div className="flex gap-2 shrink-0">
                        <Pencil
                          size={16}
                          strokeWidth={2}
                          className="cursor-pointer transition-colors duration-200"
                          style={{ color: "#ef4444" }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = "#000")}
                          onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
                          onClick={() => editIssue(log.id)}
                        />

                        <Trash2
                          size={16}
                          strokeWidth={2}
                          className="cursor-pointer transition-colors duration-200"
                          style={{ color: "#ef4444" }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = "#000")}
                          onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
                          onClick={() => deleteIssue(log.id)}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-xl px-5 py-5 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-1.5 h-1.5 bg-black rounded-full" />
            <div className="text-[15px] font-semibold text-red-700">
              Handling Damage
            </div>
          </div>

          <div className="text-[12px] text-gray-700 mb-4">
            All Damage Qty :{" "}
            <span className="font-semibold">
              {crewIssues.reduce((sum, x) => sum + clampQty(x.qty), 0)} Cabinets
            </span>
          </div>

          {crewIssues.length === 0 ? (
            <div className="text-[12px] text-gray-400">No crew-caused damage.</div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {crewIssues.map((log) => {
                const photos = normalizePhotoList(log.photo_data_list, log.photo_data);

                return (
                  <div
                    key={log.id}
                    className="w-full rounded-xl bg-gray-50 border border-gray-200 p-3"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-semibold text-gray-900">
                          {getIssueLabel(log.problem_type)}
                        </div>

                        <div className="mt-2 space-y-1 text-[12px] text-gray-700 leading-snug">
                          <div>Qty by Cabinet : {log.qty}</div>
                          <div>Team : {log.team_name || "-"}</div>
                          <div>Event : {log.event_name || "-"}</div>
                          <div>Date : {log.event_date || "-"}</div>

                          {log.note ? (
                            <div className="text-[12px] text-gray-700">
                              Note : {log.note}
                            </div>
                          ) : null}

                          <div className="pt-1 text-[11px] text-gray-500">
                            Saved: {new Date(log.created_at).toLocaleString()} added by{" "}
                            {log.created_by || "-"}
                          </div>
                        </div>
                      </div>

                      <div className="shrink-0 flex items-start gap-2">
                        {photos.length > 0 ? (
                          <div className="flex items-center gap-1">
                            {photos.map((src, index) => (
                              <div
                                key={`${log.id}-${index}`}
                                className="overflow-hidden rounded-md border border-gray-300 bg-white"
                                style={{
                                  width: "120px",
                                  height: "120px",
                                  minWidth: "120px",
                                  minHeight: "120px",
                                }}
                              >
                                <img
                                  src={src}
                                  alt={`Issue ${index + 1}`}
                                  style={{
                                    width: "100%",
                                    height: "100%",
                                    objectFit: "cover",
                                    display: "block",
                                  }}
                                />
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {canEditPage ? (
                          <div className="flex gap-2">
                            <Pencil
                              size={16}
                              strokeWidth={2}
                              className="cursor-pointer transition-colors duration-200"
                              style={{ color: "#ef4444" }}
                              onMouseEnter={(e) => (e.currentTarget.style.color = "#000")}
                              onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
                              onClick={() => editIssue(log.id)}
                            />

                            <Trash2
                              size={16}
                              strokeWidth={2}
                              className="cursor-pointer transition-colors duration-200"
                              style={{ color: "#ef4444" }}
                              onMouseEnter={(e) => (e.currentTarget.style.color = "#000")}
                              onMouseLeave={(e) => (e.currentTarget.style.color = "#ef4444")}
                              onClick={() => deleteIssue(log.id)}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {canEditPage && showEditModal && (
        <div
          className="fixed inset-0 z-50 bg-black/35 flex items-center justify-center"
          onClick={() => setShowEditModal(false)}
        >
          <div
            className="bg-white rounded-2xl border border-gray-200 p-5 shadow-xl w-[320px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[16px] font-semibold mb-4">Edit Qty</div>

            <input
              type="number"
              min={1}
              value={editQty}
              onChange={(e) => setEditQty(clampQty(e.target.value))}
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-[12px]"
            />

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowEditModal(false)}
                className="px-3 py-1.5 rounded-full border border-gray-300 text-[12px]"
              >
                Cancel
              </button>

              <button
                onClick={updateIssueQty}
                className="px-3 py-1.5 rounded-full bg-black text-white text-[12px]"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {canEditPage && showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/35 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white rounded-2xl border border-gray-200 p-5 shadow-xl">
            <div className="text-[16px] font-semibold text-gray-900 mb-4">
              Add Issue
            </div>

            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-1">
                  Issue Type
                </label>
                <select
                  value={issueType}
                  onChange={(e) => {
                    const nextType = e.target.value as IssueType;
                    setIssueType(nextType);

                    if (!isCrewDamage(nextType)) {
                      setTeamName("");
                      setEventName("");
                      setEventDate("");
                      setNote("");
                      setPhotoList([]);
                      setPhotoError(null);
                    }
                  }}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-[12px] bg-white"
                >
                  {ISSUE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-1">
                  Qty by Cabinet
                </label>
                <input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(clampQty(e.target.value))}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-[12px]"
                />
              </div>

              {isCrewDamage(issueType) && (
                <>
                  <div>
                    <label className="block text-[12px] font-medium text-gray-700 mb-1">
                      Team Name
                    </label>
                    <input
                      value={teamName}
                      onChange={(e) => setTeamName(e.target.value)}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2 text-[12px]"
                    />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-gray-700 mb-1">
                      Event Name
                    </label>
                    <input
                      value={eventName}
                      onChange={(e) => setEventName(e.target.value)}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2 text-[12px]"
                    />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-gray-700 mb-1">
                      Date
                    </label>
                    <input
                      type="date"
                      value={eventDate}
                      onChange={(e) => setEventDate(e.target.value)}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2 text-[12px] bg-white"
                    />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-gray-700 mb-1">
                      Note
                    </label>
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2 text-[12px] min-h-[80px]"
                    />
                  </div>

                  <div>
                    <label className="block text-[12px] font-medium text-gray-700 mb-1">
                      Photos (max 3)
                    </label>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={onPickPhoto}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2 text-[12px] bg-white"
                    />

                    {photoError ? (
                      <div className="mt-2 text-[11px] text-red-600">{photoError}</div>
                    ) : null}

                    {photoList.length > 0 ? (
                      <div className="mt-2 text-[11px] text-gray-500">
                        {photoList.length} photo{photoList.length > 1 ? "s" : ""} selected
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button
                type="button"
                onClick={closeAddIssue}
                className="px-3 py-1.5 rounded-full border border-gray-300 text-[12px] font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={addIssue}
                disabled={saving}
                className="px-3 py-1.5 rounded-full bg-black text-white text-[12px] font-medium disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
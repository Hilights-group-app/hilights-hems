"use client";

import { CheckCircle2, Loader2, Wrench } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserDepartment, getUserRole } from "@/lib/authStore";

type MaintenanceRequest = {
  id: string;
  display_name: string;
  serial_number: string | null;
  quantity: number;
  source_reference: string;
  source_summary: string | null;
  department: string;
  received_quantity: number;
  tested_quantity: number;
  source_type: string;
  status: "pending_report" | "reported" | "sent" | "received" | "resolved";
  created_at: string;
};

export default function MaintenanceRequestBanner() {
  const pathname = usePathname();
  const supabase = useMemo(() => createClient(), []);
  const [requestId, setRequestId] = useState("");
  const [request, setRequest] = useState<MaintenanceRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [role, setRole] = useState("");
  const [department, setDepartment] = useState("");

  useEffect(() => {
    setRole(getUserRole() || "");
    setDepartment((getUserDepartment() || "").toLowerCase());
  }, []);

  useEffect(() => {
    const nextRequestId = new URLSearchParams(window.location.search).get(
      "maintenanceRequest",
    );
    setRequestId(nextRequestId || "");
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;

    async function loadRequest() {
      if (!requestId) {
        setRequest(null);
        setError("");
        return;
      }

      setLoading(true);
      setError("");

      const { data, error: requestError } = await supabase
        .from("maintenance_requests")
        .select(
          "id,display_name,serial_number,quantity,received_quantity,tested_quantity,department,source_reference,source_type,source_summary,status,created_at",
        )
        .eq("id", requestId)
        .single();

      if (cancelled) return;

      if (requestError || !data) {
        console.error("load maintenance request error", requestError);
        setRequest(null);
        setError("This maintenance alert could not be loaded.");
      } else {
        setRequest(data as MaintenanceRequest);
      }

      setLoading(false);
    }

    void loadRequest();

    return () => {
      cancelled = true;
    };
  }, [requestId, supabase]);

  async function markReportCompleted() {
    if (
      !request ||
      saving ||
      !["pending_report", "received"].includes(request.status)
    ) {
      return;
    }

    const repairWorkflow =
      request.source_type === "maintenance" && request.status === "received";

    const confirmed = window.confirm(
      repairWorkflow
        ? "Confirm this repaired equipment passed testing? It will become Available."
        : "Mark this maintenance report as completed? The Head alert will be cleared.",
    );
    if (!confirmed) return;

    setSaving(true);
    setError("");

    const { error: updateError } = await supabase.rpc(
      repairWorkflow
        ? "test_maintenance_list_item"
        : "mark_maintenance_request_reported",
      { p_request_id: request.id },
    );

    if (updateError) {
      console.error("complete maintenance request error", updateError);
      setError(updateError.message || "The maintenance alert could not be completed.");
      setSaving(false);
      return;
    }

    setRequest((current) =>
      current
        ? {
            ...current,
            status: repairWorkflow ? "resolved" : "reported",
            tested_quantity: repairWorkflow
              ? current.quantity
              : current.tested_quantity,
          }
        : current,
    );
    window.dispatchEvent(new CustomEvent("hems:maintenance-requests-change"));
    setSaving(false);
  }

  if (!requestId) return null;

  if (loading) {
    return (
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[11px] text-amber-800">
        <Loader2 size={13} className="animate-spin" />
        Loading maintenance alert...
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[11px] text-red-700">
        {error}
      </div>
    );
  }

  if (!request) return null;

  const unitDescription = request.serial_number?.trim()
    ? `Serial ${request.serial_number.trim()}`
    : `${request.quantity} pc${request.quantity === 1 ? "" : "s"}`;
  const repairWorkflow = request.source_type === "maintenance";
  const canComplete =
    role === "admin" ||
    (role === "head" && department === request.department.toLowerCase());
  const pendingAction =
    request.status === "pending_report" ||
    (repairWorkflow && request.status === "received");
  const actionRequired =
    canComplete && pendingAction;

  return (
    <div
      className={`mb-2 rounded-2xl border px-4 py-3 ${
        pendingAction
          ? "border-amber-300 bg-amber-50"
          : "border-green-200 bg-green-50"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full ${
              pendingAction
                ? "bg-amber-100 text-amber-700"
                : "bg-green-100 text-green-700"
            }`}
          >
            {actionRequired ? (
              <Wrench size={15} />
            ) : (
              <CheckCircle2 size={15} />
            )}
          </div>

          <div className="min-w-0">
            <div className="text-[11px] font-bold text-gray-900">
              {request.status === "pending_report"
                ? "Returned to Maintenance — Head Report Required"
                : request.status === "received"
                  ? "Received from Repair — Testing Required"
                  : request.status === "sent"
                    ? "At External Repair"
                    : repairWorkflow
                      ? "Repair Tested — Available"
                      : "Maintenance Report Completed"}
            </div>
            <div className="mt-0.5 text-[10px] leading-4 text-gray-600">
              <span className="font-semibold">{request.display_name}</span>
              {` · ${unitDescription} · ${request.source_reference}`}
              {request.source_summary ? ` · ${request.source_summary}` : ""}
            </div>
          </div>
        </div>

        {actionRequired ? (
          <button
            type="button"
            onClick={() => void markReportCompleted()}
            disabled={saving}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-black px-3 py-2 text-[10px] font-bold text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <CheckCircle2 size={12} />
            )}
            {saving
              ? "Saving..."
              : request.status === "received"
                ? "Tested — Available"
                : "Report Completed"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

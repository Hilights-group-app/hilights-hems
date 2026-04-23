"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { getUserRole } from "@/lib/authStore";

export default function EquipmentReportPage() {
  const router = useRouter();
  const role = getUserRole();
  const isViewer = role === "viewer";

  function handleBlockedAccess() {
    alert("You do not have access to this section.");
  }

  return (
    <div className="min-h-screen bg-gray-50 p-3">
      <div className="max-w-[1100px] mx-auto space-y-3">
        <div className="bg-white border border-gray-200 rounded-2xl p-6">
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
              Equipment Report
            </h1>
          </div>

          <p className="text-[12px] text-gray-600 mt-2">
            Create, update, and export equipment reports.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-white border border-gray-200 rounded-2xl p-6 text-gray-900">
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

              <h2 className="text-[17px] font-semibold text-gray-900 leading-none">
                Create New Report
              </h2>
            </div>

            <p className="text-[12px] text-gray-600 mt-2">
              Start a new department report.
            </p>

            <div className="mt-6">
              {isViewer ? (
                <button
                  type="button"
                  onClick={handleBlockedAccess}
                  className="block w-full px-3 py-2 rounded-full bg-gray-200 text-gray-500 text-[11px] font-medium text-center cursor-not-allowed"
                >
                  Create New Report
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => router.push("/equipment-report/new")}
                  className="block w-full px-3 py-2 rounded-full bg-black text-white text-[11px] font-medium text-center transition-all duration-150 ease-out hover:opacity-90 active:scale-[0.98]"
                >
                  Create New Report
                </button>
              )}
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl p-6 text-gray-900">
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

              <h2 className="text-[17px] font-semibold text-gray-900 leading-none">
                Update Report
              </h2>
            </div>

            <p className="text-[12px] text-gray-600 mt-2">
              Open and continue existing report sections.
            </p>

            <div className="mt-6">
              {isViewer ? (
                <button
                  type="button"
                  onClick={handleBlockedAccess}
                  className="block w-full px-3 py-2 rounded-full border border-gray-200 text-[11px] font-medium text-gray-500 bg-gray-100 text-center cursor-not-allowed"
                >
                  Update Report
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => router.push("/equipment-report/update")}
                  className="block w-full px-3 py-2 rounded-full border border-gray-300 text-[11px] font-medium text-gray-700 bg-white text-center transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
                >
                  Update Report
                </button>
              )}
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl p-6 text-gray-900">
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

              <h2 className="text-[17px] font-semibold text-gray-900 leading-none">
                Export PDF
              </h2>
            </div>

            <p className="text-[12px] text-gray-600 mt-2">
              Export report sections as PDF.
            </p>

            <div className="mt-6">
              <Link
                href="/equipment-report/export"
                className="block w-full px-3 py-2 rounded-full border border-gray-300 text-[11px] font-medium text-gray-700 bg-white text-center transition-all duration-150 ease-out hover:bg-red-50 hover:border-red-200 hover:text-red-700 hover:shadow-sm active:scale-[0.98]"
              >
                Export PDF
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
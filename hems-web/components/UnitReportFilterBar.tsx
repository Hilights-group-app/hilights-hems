"use client";

import { Search, X } from "lucide-react";
import type {
  ChainValidityFilter,
  UnitReportStatusFilter,
} from "@/lib/unitReportTools";

export default function UnitReportFilterBar({
  query,
  status,
  validity,
  resultCount,
  totalCount,
  onQueryChange,
  onStatusChange,
  onValidityChange,
}: {
  query: string;
  status: UnitReportStatusFilter;
  validity?: ChainValidityFilter;
  resultCount: number;
  totalCount: number;
  onQueryChange: (value: string) => void;
  onStatusChange: (value: UnitReportStatusFilter) => void;
  onValidityChange?: (value: ChainValidityFilter) => void;
}) {
  const filtered = Boolean(
    query.trim() || status !== "all" || (validity && validity !== "all"),
  );

  function clear() {
    onQueryChange("");
    onStatusChange("all");
    onValidityChange?.("all");
  }

  return (
    <div className="mb-4 rounded-2xl border border-gray-200 bg-gray-50 p-2.5 sm:p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search ID, serial or note..."
            className="h-9 w-full rounded-xl border border-gray-300 bg-white pl-8 pr-3 text-[11px] text-gray-900 outline-none transition focus:border-black"
          />
        </label>

        <select
          value={status}
          onChange={(event) =>
            onStatusChange(event.target.value as UnitReportStatusFilter)
          }
          className="h-9 rounded-xl border border-gray-300 bg-white px-3 text-[10px] font-semibold text-gray-700 outline-none focus:border-black"
          aria-label="Filter report status"
        >
          <option value="all">All Statuses</option>
          <option value="available">Available</option>
          <option value="maintenance">Maintenance</option>
          <option value="assigned">Assigned to List</option>
        </select>

        {validity && onValidityChange ? (
          <select
            value={validity}
            onChange={(event) =>
              onValidityChange(event.target.value as ChainValidityFilter)
            }
            className="h-9 rounded-xl border border-gray-300 bg-white px-3 text-[10px] font-semibold text-gray-700 outline-none focus:border-black"
            aria-label="Filter certificate validity"
          >
            <option value="all">All Certificates</option>
            <option value="valid">Valid</option>
            <option value="expired">Expired</option>
          </select>
        ) : null}

        {filtered ? (
          <button
            type="button"
            onClick={clear}
            className="inline-flex h-9 items-center justify-center gap-1 rounded-xl border border-gray-300 bg-white px-3 text-[10px] font-semibold text-gray-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-700"
          >
            <X size={11} />
            Clear
          </button>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[9px] text-gray-500">
        <span>
          Showing <strong className="text-gray-800">{resultCount}</strong> of{" "}
          {totalCount} units
        </span>
        <span>Excel tip: paste a Serial Number column into any serial field.</span>
      </div>
    </div>
  );
}

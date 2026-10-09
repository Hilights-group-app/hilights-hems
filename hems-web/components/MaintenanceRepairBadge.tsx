"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type RepairBadge = {
  listId: string;
  reference: string;
  label: string;
  quantity: number;
  awaitingTest: boolean;
};

type RepairRequestRow = {
  parent_record_id: string | null;
  list_id: string;
  quantity: number;
  tested_quantity: number | null;
  status: string;
  source_reference: string;
  source_summary: string | null;
};

type RepairMap = Record<string, RepairBadge[]>;

let cachedRepairs: RepairMap | null = null;
let repairRequest: Promise<RepairMap> | null = null;

function loadRepairs(force = false): Promise<RepairMap> {
  if (!force && cachedRepairs) return Promise.resolve(cachedRepairs);
  if (!force && repairRequest) return repairRequest;

  const supabase = createClient();
  repairRequest = (async () => {
    const { data, error } = await supabase
      .from("maintenance_requests")
      .select(
        "parent_record_id,list_id,quantity,tested_quantity,status,source_reference,source_summary",
      )
      .eq("source_type", "maintenance")
      .in("status", ["sent", "received"])
      .order("created_at", { ascending: false });

    if (error) {
      // The migration may not have been run yet. Keep inventory usable and
      // simply omit repair badges until the database is ready.
      return {};
    }

    const grouped = new Map<string, RepairBadge>();
    for (const row of (data ?? []) as RepairRequestRow[]) {
      if (!row.parent_record_id) continue;
      const remaining = Math.max(
        0,
        (Number(row.quantity) || 0) - (Number(row.tested_quantity) || 0),
      );
      if (remaining === 0) continue;

      const key = `${row.parent_record_id}:${row.list_id}:${row.status}`;
      const current = grouped.get(key);
      if (current) {
        current.quantity += remaining;
      } else {
        grouped.set(key, {
          listId: row.list_id,
          reference: row.source_reference,
          label: row.source_summary || "External Repair",
          quantity: remaining,
          awaitingTest: row.status === "received",
        });
      }
    }

    const next: RepairMap = {};
    for (const [key, badge] of grouped) {
      const itemId = key.split(":", 1)[0];
      if (!next[itemId]) next[itemId] = [];
      next[itemId].push(badge);
    }

    cachedRepairs = next;
    return next;
  })().finally(() => {
    repairRequest = null;
  });

  return repairRequest;
}

export function invalidateMaintenanceRepairBadges() {
  cachedRepairs = null;
  repairRequest = null;
}

export default function MaintenanceRepairBadge({ itemId }: { itemId: string }) {
  const [badges, setBadges] = useState<RepairBadge[]>(
    () => cachedRepairs?.[itemId] ?? [],
  );

  useEffect(() => {
    let cancelled = false;

    async function sync(force = false) {
      const repairs = await loadRepairs(force);
      if (!cancelled) setBadges(repairs[itemId] ?? []);
    }

    function handleChange() {
      invalidateMaintenanceRepairBadges();
      void sync(true);
    }

    void sync();
    window.addEventListener("hems:maintenance-requests-change", handleChange);
    return () => {
      cancelled = true;
      window.removeEventListener(
        "hems:maintenance-requests-change",
        handleChange,
      );
    };
  }, [itemId]);

  if (badges.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {badges.map((badge) => (
        <Link
          key={`${badge.listId}:${badge.awaitingTest ? "received" : "sent"}`}
          href={`/inventory/lists/${badge.listId}`}
          onClick={(event) => event.stopPropagation()}
          title={`${badge.reference} · ${badge.label}`}
          className={`max-w-full truncate rounded-lg px-2 py-1 text-[8px] font-semibold transition hover:opacity-80 sm:text-[9px] ${
            badge.awaitingTest
              ? "bg-violet-100 text-violet-800"
              : "bg-amber-100 text-amber-800"
          }`}
        >
          {badge.quantity} unit{badge.quantity === 1 ? "" : "s"} · {badge.awaitingTest
            ? "Received · Awaiting Test"
            : badge.label}
        </Link>
      ))}
    </div>
  );
}

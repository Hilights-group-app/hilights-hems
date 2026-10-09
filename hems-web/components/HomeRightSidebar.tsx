"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, Clock3, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import InventoryImportClient from "@/components/InventoryImportClient";
import {
  CATALOG_CACHE_KEY,
  CATALOG_CHANGED_EVENT,
  readCatalog,
  type CatalogCategory,
} from "@/lib/catalogStore";
import {
  canImportInventory,
  getUserDepartment,
  getUserRole,
} from "@/lib/authStore";

type Activity = {
  id: string;
  title: string;
  message: string | null;
  link: string | null;
  created_at: string;
  actor_name: string | null;
};

type Alert = {
  id: string;
  title: string;
  description: string;
  href: string;
  expired: boolean;
  time: number;
  kind: "certificate" | "maintenance";
};

type MaintenanceRequest = {
  id: string;
  display_name: string;
  serial_number: string | null;
  quantity: number;
  department: string;
  source_reference: string;
  source_summary: string | null;
  report_href: string | null;
  source_type: string;
  status: string;
  created_at: string;
};

const ALERTS_CACHE_KEY = "hems:home-sidebar:alerts";
const ACTIVITY_CACHE_KEY = "hems:home-sidebar:activity";

function readCache<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The live data still works if browser storage is unavailable.
  }
}

function ago(value: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(value).toLocaleDateString();
}

function expiryText(time: number) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(time);
  expiry.setHours(0, 0, 0, 0);
  const days = Math.ceil((expiry.getTime() - today.getTime()) / 86_400_000);

  if (days < 0)
    return `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
  if (days === 0) return "Expires today";
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}

export default function HomeRightSidebar() {
  const pathname = usePathname();
  const supabase = useMemo(() => createClient(), []);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [inventoryCategories, setInventoryCategories] = useState<
    CatalogCategory[]
  >([]);
  const pathSegments = pathname.toLowerCase().split("/").filter(Boolean);
  const showInventoryImport = pathname === "/inventory";
  const showLightingAction = pathSegments.some((segment) =>
    segment.includes("lighting"),
  );
  const showChainHoistAction = pathSegments.some((segment) =>
    segment.includes("chain-hoist"),
  );
  const showProjectorAction = pathSegments.some(
    (segment) =>
      segment.includes("projector") || segment.includes("projection"),
  );
  const showLedScreenAction = pathSegments.some((segment) =>
    segment.includes("led-screen"),
  );
  const showLedReportTools =
    pathSegments[0] === "inventory" &&
    pathSegments[3] === "led-report" &&
    pathSegments.length >= 5;
  const showInventoryTools =
    showLedReportTools ||
    (pathSegments[0] === "inventory" &&
      pathSegments[1] !== "lists" &&
      pathSegments.length === 3);

  useEffect(() => {
    if (!showInventoryImport) return;

    let cancelled = false;

    try {
      const cached = sessionStorage.getItem(CATALOG_CACHE_KEY);
      if (cached) {
        setInventoryCategories(JSON.parse(cached) as CatalogCategory[]);
      }
    } catch {
      // Continue with the live catalog when browser storage is unavailable.
    }

    async function loadInventoryCategories() {
      const catalog = await readCatalog();
      if (cancelled) return;

      setInventoryCategories(catalog.categories);

      try {
        sessionStorage.setItem(
          CATALOG_CACHE_KEY,
          JSON.stringify(catalog.categories),
        );
      } catch {
        // The live catalog still works if browser storage is unavailable.
      }
    }

    void loadInventoryCategories();

    function refreshCatalog() {
      void loadInventoryCategories();
    }

    window.addEventListener(CATALOG_CHANGED_EVENT, refreshCatalog);
    return () => {
      cancelled = true;
      window.removeEventListener(CATALOG_CHANGED_EVENT, refreshCatalog);
    };
  }, [showInventoryImport]);

  useEffect(() => {
    let cancelled = false;

    const cachedAlerts = readCache<Alert[]>(ALERTS_CACHE_KEY);
    const cachedActivity = readCache<Activity[]>(ACTIVITY_CACHE_KEY);

    if (cachedAlerts !== null) setAlerts(cachedAlerts);
    if (cachedActivity !== null) setActivity(cachedActivity);

    async function load() {
      const role = getUserRole() ?? "";
      const department = getUserDepartment() ?? "";

      let maintenanceQuery: any = null;
      if (role === "admin" || role === "warehouse_manager" || role === "head") {
        maintenanceQuery = supabase
          .from("maintenance_requests")
          .select(
            "id,display_name,serial_number,quantity,department,source_reference,source_type,source_summary,report_href,status,created_at",
          )
          .in("status", ["pending_report", "sent", "received"])
          .order("created_at", { ascending: false })
          .limit(20);

        if (role === "head") {
          maintenanceQuery = maintenanceQuery.eq("department", department);
        }
      }

      const [notificationResult, unitResult, maintenanceResult] =
        await Promise.all([
          supabase
            .from("notifications")
            .select("id,title,message,link,created_at,actor_name")
            .order("created_at", { ascending: false })
            .limit(8),
          supabase
            .from("units")
            .select("id,item_id,unit_no,serial,expiry_date")
            .not("expiry_date", "is", null)
            .order("expiry_date", { ascending: true })
            .limit(100),
          maintenanceQuery ?? Promise.resolve({ data: [], error: null }),
        ]);

      if (cancelled) return;

      if (!notificationResult.error) {
        const nextActivity = (notificationResult.data ?? []) as Activity[];
        setActivity(nextActivity);
        writeCache(ACTIVITY_CACHE_KEY, nextActivity);
      }

      const maintenanceAlerts = maintenanceResult.error
        ? []
        : ((maintenanceResult.data ?? []) as MaintenanceRequest[]).map(
            (request): Alert => {
              const reportHref = request.report_href || "/inventory";
              const separator = reportHref.includes("?") ? "&" : "?";
              const serial = request.serial_number?.trim()
                ? ` · ${request.serial_number.trim()}`
                : request.quantity > 1
                  ? ` · ${request.quantity} pcs`
                  : "";

              return {
                id: `maintenance:${request.id}`,
                title: `${request.display_name}${serial}`,
                description:
                  request.source_type === "maintenance"
                    ? request.status === "received"
                      ? `Received from repair · Awaiting Test · ${request.source_reference}`
                      : `${request.source_summary || "At external repair"} · ${request.source_reference}`
                    : `Returned to Maintenance from ${request.source_reference}${
                        request.source_summary ? ` · ${request.source_summary}` : ""
                      }`,
                href: `${reportHref}${separator}maintenanceRequest=${encodeURIComponent(
                  request.id,
                )}`,
                expired:
                  request.status === "pending_report" ||
                  request.status === "received",
                time: new Date(request.created_at).getTime(),
                kind: "maintenance",
              };
            },
          );

      if (unitResult.error) {
        setAlerts(maintenanceAlerts);
        writeCache(ALERTS_CACHE_KEY, maintenanceAlerts);
        return;
      }

      const units = (unitResult.data ?? []) as any[];
      const itemIds = [...new Set(units.map((unit) => unit.item_id))].filter(
        Boolean,
      );
      let certificateAlerts: Alert[] = [];

      if (itemIds.length > 0) {
        const itemResult = await supabase
          .from("items")
          .select("id,name,subcategory_id")
          .in("id", itemIds);
        if (cancelled) return;

        if (!itemResult.error) {
          const items = (itemResult.data ?? []) as any[];
          const subIds = [
            ...new Set(items.map((item) => item.subcategory_id)),
          ].filter(Boolean);
          const subResult = subIds.length
            ? await supabase
                .from("subcategories")
                .select("id,slug,category_id")
                .in("id", subIds)
            : { data: [], error: null };

          if (cancelled) return;

          if (!subResult.error) {
            const subs = (subResult.data ?? []) as any[];
            const categoryIds = [
              ...new Set(subs.map((sub) => sub.category_id)),
            ].filter(Boolean);
            const categoryResult = categoryIds.length
              ? await supabase
                  .from("categories")
                  .select("id,slug")
                  .in("id", categoryIds)
              : { data: [], error: null };

            if (cancelled) return;

            if (!categoryResult.error) {
              const itemMap = new Map(items.map((item) => [item.id, item]));
              const subMap = new Map(subs.map((sub) => [sub.id, sub]));
              const categoryMap = new Map(
                (categoryResult.data ?? []).map((category: any) => [
                  category.id,
                  category,
                ]),
              );
              const alertLimit = Date.now() + 30 * 86_400_000;

              certificateAlerts = units
                .map((unit): Alert | null => {
                  const time = new Date(unit.expiry_date).getTime();
                  if (!Number.isFinite(time) || time > alertLimit) return null;

                  const item: any = itemMap.get(unit.item_id);
                  const sub: any = item
                    ? subMap.get(item.subcategory_id)
                    : null;
                  const category: any = sub
                    ? categoryMap.get(sub.category_id)
                    : null;
                  if (!item || !sub?.slug || !category?.slug) return null;

                  const unitName =
                    unit.unit_no !== null
                      ? `Unit #${unit.unit_no}`
                      : unit.serial
                        ? `Serial ${unit.serial}`
                        : "Unit";

                  return {
                    id: `certificate:${unit.id}`,
                    title: `${item.name} — ${unitName}`,
                    description: expiryText(time),
                    href: `/inventory/${encodeURIComponent(
                      category.slug,
                    )}/${encodeURIComponent(sub.slug)}/${encodeURIComponent(
                      item.id,
                    )}`,
                    expired: time < Date.now(),
                    time,
                    kind: "certificate",
                  };
                })
                .filter((item): item is Alert => item !== null)
                .sort((a, b) => a.time - b.time)
                .slice(0, 5);
            }
          }
        }
      }

      const next = [...maintenanceAlerts, ...certificateAlerts].slice(0, 8);
      setAlerts(next);
      writeCache(ALERTS_CACHE_KEY, next);
    }

    void load();

    function refreshInBackground() {
      void load();
    }

    window.addEventListener("focus", refreshInBackground);
    window.addEventListener(
      "hems:maintenance-requests-change",
      refreshInBackground,
    );
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshInBackground);
      window.removeEventListener(
        "hems:maintenance-requests-change",
        refreshInBackground,
      );
    };
  }, [supabase]);

  if (showInventoryTools) {
    const toolsTitle = showLedReportTools
      ? "LED Report Tools"
      : showChainHoistAction
      ? "Chain Hoist Tools"
      : showProjectorAction
        ? "Projector Tools"
        : showLightingAction
          ? "Lighting Tools"
          : showLedScreenAction
            ? "LED Screen Tools"
            : "Inventory Tools";
    const toolsDescription = showLedReportTools
      ? "Select a report issue to edit it, or add a new issue."
      : showChainHoistAction
      ? "Select a chain hoist to edit it, or add a new one."
      : showProjectorAction
        ? "Select a projector to edit it, or add a new one."
        : showLightingAction
          ? "Select a fixture to edit it, or add a new one."
          : showLedScreenAction
            ? "Select an LED model or cabinet to edit it, or add a new one."
            : "Select an item to edit it, or add a new one.";

    return (
      <div className="p-4">
        <div className="mb-3">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
            {toolsTitle}
          </h2>
          <p className="mt-1 text-[10px] text-gray-400">{toolsDescription}</p>
        </div>

        <div id="right-sidebar-actions" />
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4">
      {showInventoryImport && canImportInventory() ? (
        <>
          <section>
            <h2 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
              Inventory tools
            </h2>
            <p className="mb-3 mt-1 text-[10px] leading-4 text-gray-400">
              Download the Excel template or import inventory in bulk.
            </p>

            <InventoryImportClient categories={inventoryCategories} />
          </section>

          <div className="h-px bg-gray-200" />
        </>
      ) : null}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">
            Important alerts
          </h2>
          {alerts.length > 0 && (
            <span className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] font-bold text-white">
              {alerts.length}
            </span>
          )}
        </div>

        <div className="space-y-2">
          {alerts.length === 0 ? (
            <EmptyBox text="No urgent alerts." success />
          ) : (
            alerts.map((alert) => (
              <Link
                key={alert.id}
                href={alert.href}
                className={`block rounded-xl border px-3 py-3 transition hover:shadow-sm ${
                  alert.kind === "maintenance" || alert.expired
                    ? "border-red-200 bg-red-50"
                    : "border-amber-200 bg-amber-50"
                }`}
              >
                <div className="flex items-start gap-2">
                  {alert.kind === "maintenance" ? (
                    <Wrench size={15} className="shrink-0 text-red-600" />
                  ) : (
                    <AlertTriangle
                      size={15}
                      className={
                        alert.expired ? "text-red-600" : "text-amber-600"
                      }
                    />
                  )}
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-xs font-semibold text-gray-900">
                      {alert.title}
                    </div>
                    <div className="mt-1 text-[10px] font-medium text-gray-600">
                      {alert.description}
                    </div>
                  </div>
                </div>
              </Link>
            ))
          )}
        </div>
      </section>

      <div className="h-px bg-gray-200" />

      <section>
        <h2 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-gray-500">
          Recent activity
        </h2>

        {activity.length === 0 ? (
          <EmptyBox text="No recent activity yet." />
        ) : (
          <div className="space-y-1">
            {activity.map((entry) => (
              <ActivityItem key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EmptyBox({
  text,
  success = false,
}: {
  text: string;
  success?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-3 py-4 text-xs ${
        success
          ? "border-green-200 bg-green-50 text-green-700"
          : "border-gray-200 bg-gray-50 text-gray-500"
      }`}
    >
      {text}
    </div>
  );
}

function ActivityItem({ entry }: { entry: Activity }) {
  const body = (
    <div className="rounded-xl px-2 py-2.5 transition hover:bg-gray-50">
      <div className="text-xs leading-5 text-gray-700">
        {entry.actor_name && (
          <span className="font-bold text-gray-900">{entry.actor_name} </span>
        )}
        {entry.title}
      </div>
      {entry.message && (
        <div className="line-clamp-2 text-[10px] leading-4 text-gray-500">
          {entry.message}
        </div>
      )}
      <div className="mt-1 flex items-center gap-1 text-[9px] text-gray-400">
        <Clock3 size={10} /> {ago(entry.created_at)}
      </div>
    </div>
  );

  return entry.link ? <Link href={entry.link}>{body}</Link> : body;
}

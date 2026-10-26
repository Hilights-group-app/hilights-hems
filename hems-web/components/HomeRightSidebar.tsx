"use client";

import ActionRequiredAlerts from "@/components/ActionRequiredAlerts";
import Link from "next/link";
import { IMPORTANT_ACTIVITY_FILTER, isImportantActivity } from "@/lib/importantActivity";
import { usePathname } from "next/navigation";
import { AlertTriangle, Clock3, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { createRefreshQueue, MAINTENANCE_ALERTS_EVENT, NOTIFICATION_FEED_EVENT } from "@/lib/workspaceRefresh";
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
  getUserId,
} from "@/lib/authStore";

type Activity = {
  id: string;
  title: string;
  message: string | null;
  link: string | null;
  created_at: string;
  actor_name: string | null;
  actor_id: string | null;
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
const ACTIVITY_CACHE_KEY = "hems:home-sidebar:important-activity-v3";

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
    // Inventory subcategory pages render their own tools in this sidebar.
    if (showInventoryTools) return;
    let cancelled = false;
    let lastActivityRead = 0, lastMaintenanceRead = 0, lastCertificateRead = 0;
    const userId = getUserId();
    if (!userId) { setAlerts([]); setActivity([]); return; }
    const isCurrent = () => !cancelled && userId === getUserId();
    const alertsCacheKey = `${ALERTS_CACHE_KEY}:${userId}:${getUserRole()}:${getUserDepartment()}`;
    const activityCacheKey = `${ACTIVITY_CACHE_KEY}:${userId}`;
    const cachedAlerts = readCache<Alert[]>(alertsCacheKey);
    const cachedActivity = readCache<Activity[]>(activityCacheKey);
    let maintenanceAlerts = (cachedAlerts ?? []).filter(alert => alert.kind === "maintenance");
    let certificateAlerts = (cachedAlerts ?? []).filter(alert => alert.kind === "certificate");
    if (cachedAlerts !== null) setAlerts(cachedAlerts);
    if (cachedActivity !== null) setActivity(cachedActivity.filter(entry => entry.actor_id !== userId && isImportantActivity(entry)));

    function publishAlerts() {
      if (!isCurrent()) return;
      const next = [...maintenanceAlerts, ...certificateAlerts].slice(0, 8);
      setAlerts(next);
      writeCache(alertsCacheKey, next);
    }

    async function loadActivity() {
      if (!isCurrent()) return;
      const result = await supabase.from("notifications")
        .select("id,title,message,link,created_at,actor_name,actor_id")
        .or(IMPORTANT_ACTIVITY_FILTER).order("created_at", { ascending: false }).limit(8);
      if (!isCurrent() || result.error) return;
      lastActivityRead = Date.now();
      const next = ((result.data ?? []) as Activity[])
        .filter(entry => entry.actor_id !== userId && isImportantActivity(entry));
      // Publish as soon as this read finishes, not after certificates/repairs.
      setActivity(next);
      writeCache(activityCacheKey, next);
    }

    async function loadMaintenance() {
      if (!isCurrent()) return;
      const role = getUserRole() ?? "";
      if (!["admin", "warehouse_manager", "head"].includes(role)) {
        maintenanceAlerts = [];
        lastMaintenanceRead = Date.now();
        publishAlerts();
        return;
      }
      let query = supabase.from("maintenance_requests")
        .select("id,display_name,serial_number,quantity,department,source_reference,source_type,source_summary,report_href,status,created_at")
        .in("status", ["pending_report", "sent"])
        .order("created_at", { ascending: false }).limit(20);
      if (role === "head") query = query.eq("department", getUserDepartment() ?? "");
      const result = await query;
      if (!isCurrent() || result.error) return;
      lastMaintenanceRead = Date.now();
      maintenanceAlerts = ((result.data ?? []) as MaintenanceRequest[]).map((request): Alert => {
        const reportHref = request.report_href || "/inventory";
        const separator = reportHref.includes("?") ? "&" : "?";
        const serial = request.serial_number?.trim()
          ? ` · ${request.serial_number.trim()}`
          : request.quantity > 1 ? ` · ${request.quantity} pcs` : "";
        return {
          id: `maintenance:${request.id}`,
          title: `${request.display_name}${serial}`,
          description: request.source_type === "maintenance"
            ? request.status === "received"
              ? `Received from repair · Awaiting Test · ${request.source_reference}`
              : `${request.source_summary || "At external repair"} · ${request.source_reference}`
            : `Returned to Maintenance from ${request.source_reference}${request.source_summary ? ` · ${request.source_summary}` : ""}`,
          href: `${reportHref}${separator}maintenanceRequest=${encodeURIComponent(request.id)}`,
          expired: request.status === "pending_report" || request.status === "received",
          time: new Date(request.created_at).getTime(),
          kind: "maintenance",
        };
      });
      publishAlerts();
    }

    async function loadCertificates() {
      if (!isCurrent()) return;
      const unitResult = await supabase.from("units")
        .select("id,item_id,unit_no,serial,expiry_date")
        .not("expiry_date", "is", null).order("expiry_date", { ascending: true }).limit(100);
      if (!isCurrent() || unitResult.error) return;
      const units = (unitResult.data ?? []) as any[];
      const itemIds = [...new Set(units.map(unit => unit.item_id))].filter(Boolean);
      let nextCertificates: Alert[] = [];
      if (itemIds.length > 0) {
        const itemResult = await supabase.from("items").select("id,name,subcategory_id").in("id", itemIds);
        if (!isCurrent() || itemResult.error) return;
        const items = (itemResult.data ?? []) as any[];
        const subIds = [...new Set(items.map(item => item.subcategory_id))].filter(Boolean);
        const subResult = subIds.length
          ? await supabase.from("subcategories").select("id,slug,category_id").in("id", subIds)
          : { data: [], error: null };
        if (!isCurrent() || subResult.error) return;
        const subs = (subResult.data ?? []) as any[];
        const categoryIds = [...new Set(subs.map(sub => sub.category_id))].filter(Boolean);
        const categoryResult = categoryIds.length
          ? await supabase.from("categories").select("id,slug").in("id", categoryIds)
          : { data: [], error: null };
        if (!isCurrent() || categoryResult.error) return;
        const itemMap = new Map(items.map(item => [item.id, item]));
        const subMap = new Map(subs.map(sub => [sub.id, sub]));
        const categoryMap = new Map((categoryResult.data ?? []).map((category: any) => [category.id, category]));
        const alertLimit = Date.now() + 30 * 86_400_000;
        nextCertificates = units.map((unit): Alert | null => {
          const time = new Date(unit.expiry_date).getTime();
          if (!Number.isFinite(time) || time > alertLimit) return null;
          const item: any = itemMap.get(unit.item_id);
          const sub: any = item ? subMap.get(item.subcategory_id) : null;
          const category: any = sub ? categoryMap.get(sub.category_id) : null;
          if (!item || !sub?.slug || !category?.slug) return null;
          const unitName = unit.unit_no !== null
            ? `Unit #${unit.unit_no}`
            : unit.serial ? `Serial ${unit.serial}` : "Unit";
          return {
            id: `certificate:${unit.id}`,
            title: `${item.name} — ${unitName}`,
            description: expiryText(time),
            href: `/inventory/${encodeURIComponent(category.slug)}/${encodeURIComponent(sub.slug)}/${encodeURIComponent(item.id)}`,
            expired: time < Date.now(),
            time,
            kind: "certificate",
          };
        }).filter((alert): alert is Alert => alert !== null)
          .sort((a, b) => a.time - b.time).slice(0, 5);
      }
      certificateAlerts = nextCertificates;
      lastCertificateRead = Date.now();
      publishAlerts();
    }

    const activityQueue = createRefreshQueue(loadActivity, {
      onError: error => { if (isCurrent()) console.error("recent activity load error", error); },
    });
    const maintenanceQueue = createRefreshQueue(loadMaintenance, {
      onError: error => { if (isCurrent()) console.error("maintenance alerts load error", error); },
    });
    const certificateQueue = createRefreshQueue(loadCertificates, {
      onError: error => { if (isCurrent()) console.error("certificate alerts load error", error); },
    });

    function refreshActivity(event: Event) {
      activityQueue.schedule();
      const certificateChanged = (event as CustomEvent<{certificateChanged?: boolean}>).detail?.certificateChanged;
      // A normal activity insert does not require walking units/items/catalog.
      if (certificateChanged || Date.now() - lastCertificateRead >= 60000) {
        if (certificateChanged || !certificateQueue.isPending()) certificateQueue.schedule();
      }
    }
    function refreshMaintenance() { maintenanceQueue.schedule(); }
    function wake() {
      if (document.visibilityState !== "visible") return;
      activityQueue.resume(); maintenanceQueue.resume(); certificateQueue.resume();
      if (!activityQueue.isPending() && Date.now() - lastActivityRead >= 30000) activityQueue.request();
      if (!maintenanceQueue.isPending() && Date.now() - lastMaintenanceRead >= 30000) maintenanceQueue.request();
      if (!certificateQueue.isPending() && Date.now() - lastCertificateRead >= 60000) certificateQueue.request();
    }

    activityQueue.request(); maintenanceQueue.request(); certificateQueue.request();
    window.addEventListener(NOTIFICATION_FEED_EVENT, refreshActivity);
    window.addEventListener(MAINTENANCE_ALERTS_EVENT, refreshMaintenance);
    window.addEventListener("hems:maintenance-requests-change", refreshMaintenance);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      cancelled = true;
      activityQueue.dispose(); maintenanceQueue.dispose(); certificateQueue.dispose();
      window.removeEventListener(NOTIFICATION_FEED_EVENT, refreshActivity);
      window.removeEventListener(MAINTENANCE_ALERTS_EVENT, refreshMaintenance);
      window.removeEventListener("hems:maintenance-requests-change", refreshMaintenance);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [showInventoryTools, supabase]);

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
        <ActionRequiredAlerts />
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
      <ActionRequiredAlerts />
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

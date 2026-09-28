"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, Clock3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

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
  const pathSegments = pathname.toLowerCase().split("/").filter(Boolean);
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
  const showSerializedAction =
    pathSegments[0] === "inventory" &&
    pathSegments.length === 3 &&
    !showLightingAction &&
    !showChainHoistAction &&
    !showProjectorAction &&
    !showLedScreenAction;

  useEffect(() => {
    let cancelled = false;

    const cachedAlerts = readCache<Alert[]>(ALERTS_CACHE_KEY);
    const cachedActivity = readCache<Activity[]>(ACTIVITY_CACHE_KEY);

    if (cachedAlerts !== null) setAlerts(cachedAlerts);
    if (cachedActivity !== null) setActivity(cachedActivity);

    async function load() {
      const [notificationResult, unitResult] = await Promise.all([
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
      ]);

      if (cancelled) return;
      if (!notificationResult.error) {
        const nextActivity = (notificationResult.data ?? []) as Activity[];
        setActivity(nextActivity);
        writeCache(ACTIVITY_CACHE_KEY, nextActivity);
      }

      const units = (unitResult.data ?? []) as any[];
      const itemIds = [...new Set(units.map((unit) => unit.item_id))].filter(
        Boolean,
      );

      if (unitResult.error) {
        return;
      }

      if (itemIds.length === 0) {
        setAlerts([]);
        writeCache(ALERTS_CACHE_KEY, []);
        return;
      }

      const itemResult = await supabase
        .from("items")
        .select("id,name,subcategory_id")
        .in("id", itemIds);
      if (cancelled || itemResult.error) return;

      const items = (itemResult.data ?? []) as any[];
      const subIds = [
        ...new Set(items.map((item) => item.subcategory_id)),
      ].filter(Boolean);
      const subResult = await supabase
        .from("subcategories")
        .select("id,slug,category_id")
        .in("id", subIds);
      if (cancelled || subResult.error) return;

      const subs = (subResult.data ?? []) as any[];
      const categoryIds = [
        ...new Set(subs.map((sub) => sub.category_id)),
      ].filter(Boolean);
      const categoryResult = await supabase
        .from("categories")
        .select("id,slug")
        .in("id", categoryIds);
      if (cancelled || categoryResult.error) return;

      const itemMap = new Map(items.map((item) => [item.id, item]));
      const subMap = new Map(subs.map((sub) => [sub.id, sub]));
      const categoryMap = new Map(
        (categoryResult.data ?? []).map((category: any) => [
          category.id,
          category,
        ]),
      );
      const alertLimit = Date.now() + 30 * 86_400_000;

      const next = units
        .map((unit): Alert | null => {
          const time = new Date(unit.expiry_date).getTime();
          if (!Number.isFinite(time) || time > alertLimit) return null;

          const item: any = itemMap.get(unit.item_id);
          const sub: any = item ? subMap.get(item.subcategory_id) : null;
          const category: any = sub ? categoryMap.get(sub.category_id) : null;
          if (!item || !sub?.slug || !category?.slug) return null;

          const unitName =
            unit.unit_no !== null
              ? `Unit #${unit.unit_no}`
              : unit.serial
                ? `Serial ${unit.serial}`
                : "Unit";

          return {
            id: unit.id,
            title: `${item.name} — ${unitName}`,
            description: expiryText(time),
            href: `/inventory/${encodeURIComponent(category.slug)}/${encodeURIComponent(
              sub.slug,
            )}/${encodeURIComponent(item.id)}`,
            expired: time < Date.now(),
            time,
          };
        })
        .filter((item): item is Alert => item !== null)
        .sort((a, b) => a.time - b.time)
        .slice(0, 5);

      setAlerts(next);
      writeCache(ALERTS_CACHE_KEY, next);
    }

    void load();

    function refreshInBackground() {
      void load();
    }

    window.addEventListener("focus", refreshInBackground);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshInBackground);
    };
  }, [supabase]);

  if (
    showLightingAction ||
    showChainHoistAction ||
    showProjectorAction ||
    showLedScreenAction ||
    showSerializedAction
  ) {
    const toolsTitle = showChainHoistAction
      ? "Chain Hoist Tools"
      : showProjectorAction
        ? "Projector Tools"
        : showLedScreenAction
          ? "LED Screen Tools"
          : showLightingAction
            ? "Lighting Tools"
            : "Item Tools";
    const toolsDescription = showChainHoistAction
      ? "Select a chain hoist to edit it, or add a new one."
      : showProjectorAction
        ? "Select a projector to edit it, or add a new one."
        : showLedScreenAction
          ? "Select a cabinet to edit it, or add a new LED screen."
          : showLightingAction
            ? "Select a fixture to edit it, or add a new one."
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
                  alert.expired
                    ? "border-red-200 bg-red-50"
                    : "border-amber-200 bg-amber-50"
                }`}
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle
                    size={15}
                    className={
                      alert.expired ? "text-red-600" : "text-amber-600"
                    }
                  />
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

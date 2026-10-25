"use client";
import { offlineStore } from "@/lib/offline";
import { OfflineStatus } from "@/components/OfflineWorkspace";

import { getAppLayout } from "@/lib/appLayout";
import { useAppLayout } from "@/lib/useAppLayout";

import ActionRequiredAlerts from "@/components/ActionRequiredAlerts";
import { useActionNotifications } from "@/components/ActionNotificationsProvider";
import Link from "next/link";
import { IMPORTANT_ACTIVITY_FILTER, isImportantActivity } from "@/lib/importantActivity";
import { readWorkingDraft, readWorkspaceProfile } from "@/lib/workspaceStartup";
import {
  Bell,
  Boxes,
  ChevronDown,
  House,
  Loader2,
  Menu,
  Search,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { usePathname, useRouter } from "next/navigation";
import { createClient, readBrowserSession } from "@/lib/supabase/client";
import {
  getUserName,
  getUserId,
  canManageEquipmentLists,
  logout,
  setUserDepartment,
  setUserId,
  setUserName,
  setUserRole,
} from "@/lib/authStore";
import EquipmentListsSidebar from "@/components/EquipmentListsSidebar";
import EquipmentListUnitPicker from "@/components/EquipmentListUnitPicker";
import EquipmentListMatrixQuantityAction, {
  type MatrixListTarget,
} from "@/components/EquipmentListMatrixQuantityAction";
import {
  ACTIVE_EQUIPMENT_LIST_EVENT,
  ACTIVE_EQUIPMENT_LIST_KEY,
  canAddToEquipmentList,
  type EquipmentList,
} from "@/lib/equipmentLists";
import { CATALOG_CHANGED_EVENT } from "@/lib/catalogStore";

type NotificationRow = {
  id: string;
  title: string;
  message: string | null;
  link: string | null;
  is_read: boolean;
  created_at: string;
  actor_name: string | null;
  actor_id: string | null;
};

type CategoryRow = {
  id: string;
  slug?: string | null;
  name?: string | null;
  label?: string | null;
  title?: string | null;
};

type SubcategoryRow = CategoryRow & {
  category_id: string;
};

type ItemRow = {
  id: string;
  name: string;
  subcategory_id: string;
  photo_url?: string | null;
  fixture_type?: string | null;
};

type UnitRow = {
  id: string;
  item_id: string;
  unit_no: number | null;
  serial: string | null;
};

type MatrixModelRow = {
  id: string;
  name: string;
  category_id: string;
  subcategory_id: string;
  item_type?: "unit" | "cable" | "rack" | null;
  block_name?: string | null;
  total_qty?: number | null;
  in_use_qty?: number | null;
  maintenance_qty?: number | null;
  in_ksa_qty?: number | null;
};

type MatrixRow = {
  id: string;
  model_id: string | null;
  item_id?: string | null;
  size: string | null;
  cabinet_model: string | null;
  cable_length?: string | null;
  qty?: number | null;
  total_qty?: number | null;
  in_use_qty?: number | null;
  maintenance_qty?: number | null;
  in_ksa_qty?: number | null;
};

type SearchIndex = {
  categories: CategoryRow[];
  subcategories: SubcategoryRow[];
  items: ItemRow[];
  units: UnitRow[];
  matrixModels: MatrixModelRow[];
  matrixRows: MatrixRow[];
};

type SearchResult = {
  key: string;
  kind: string;
  title: string;
  subtitle: string;
  href: string;
  score: number;
  addTarget?: {
    item: Pick<ItemRow, "id" | "name" | "photo_url" | "fixture_type">;
    category: string;
    subcategory: string;
  };
  matrixAddTarget?: {
    target: MatrixListTarget;
    category: string;
    subcategory: string;
  };
};

function rowName(row: CategoryRow) {
  return String(row.name || row.label || row.title || row.slug || "").trim();
}

function normalizeSearch(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function matchScore(value: unknown, query: string) {
  const text = normalizeSearch(value);
  if (!text || !text.includes(query)) return null;
  if (text === query) return 0;
  if (text.startsWith(query)) return 1;
  return 2;
}

export default function TopBar() {
  const appLayout = useAppLayout();
  const actionInbox = useActionNotifications();
  const notificationReadVersion = useRef(0);
  const notificationLoadedAt = useRef(0);
  const pathname = usePathname();
  const router = useRouter();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const notifRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchLoadRef = useRef<Promise<void> | null>(null);

  const [userName, setUserNameState] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [open, setOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarMounted, setSidebarMounted] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchIndex, setSearchIndex] = useState<SearchIndex | null>(null);
  const [activeSearchDraft, setActiveSearchDraft] = useState<EquipmentList | null>(null);
  const [searchPickerTarget, setSearchPickerTarget] = useState<NonNullable<SearchResult["addTarget"]> | null>(null);

  const [profile, setProfile] = useState<{
    role?: string;
    department?: string;
    avatar_url?: string | null;
  }>(() => {
    if (typeof window === "undefined") return {};
    return {
      role: localStorage.getItem("hems:profile:role") || "",
      department: localStorage.getItem("hems:profile:department") || "",
      avatar_url: localStorage.getItem("hems:profile:avatar_url") || "",
    };
  });

  const supabase = useMemo(() => createClient(), []);
  const showPrivateNav = loggedIn && pathname !== "/login";

  const topbarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const bar = topbarRef.current;
    if (!bar) return;
    const updateHeight = () => {
      document.documentElement.style.setProperty(
        "--hems-topbar-height", `${Math.ceil(bar.getBoundingClientRect().height)}px`,
      );
    };
    updateHeight();
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(updateHeight) : null;
    observer?.observe(bar);
    window.addEventListener("resize", updateHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateHeight);
      document.documentElement.style.removeProperty("--hems-topbar-height");
    };
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
    setOpen(false);
    setNotifOpen(false);
    setSearchQuery("");
    setSearchFocused(false);
  }, [pathname]);

  useEffect(() => {
    const closeDesktopDrawer = () => {
      if (getAppLayout() === "desktop") setSidebarOpen(false);
    };
    const closeAfterListSelection = () => setSidebarOpen(false);
    const openMobileLists = () => setSidebarOpen(true);
    window.addEventListener("hems:open-mobile-lists", openMobileLists);

    closeDesktopDrawer();
    window.addEventListener("resize", closeDesktopDrawer);
    window.addEventListener(
      ACTIVE_EQUIPMENT_LIST_EVENT,
      closeAfterListSelection,
    );

    return () => {
      window.removeEventListener("hems:open-mobile-lists", openMobileLists);
      window.removeEventListener("resize", closeDesktopDrawer);
      window.removeEventListener(
        ACTIVE_EQUIPMENT_LIST_EVENT,
        closeAfterListSelection,
      );
    };
  }, []);

  useEffect(() => { if (appLayout === "desktop") setSidebarOpen(false); }, [appLayout]);

  useEffect(() => {
    // Defer the list queries until the drawer is actually used, then preserve
    // its state so closing and reopening it stays instant.
    if (sidebarOpen) setSidebarMounted(true);
  }, [sidebarOpen]);

  useEffect(() => {
    let cancelled = false;
    async function refreshActiveDraft(force = false) {
      const listId = localStorage.getItem(ACTIVE_EQUIPMENT_LIST_KEY);
      if (!listId || !getUserId()) {
        if (!cancelled) setActiveSearchDraft(null);
        return;
      }
      const { data } = await readWorkingDraft(supabase, listId, force);
      const usable = Boolean(data) &&
        canAddToEquipmentList(data, getUserId(), canManageEquipmentLists());
      if (!cancelled) setActiveSearchDraft(usable ? data : null);
    }
    const handleChange = () => void refreshActiveDraft(true);
    void refreshActiveDraft();
    window.addEventListener(ACTIVE_EQUIPMENT_LIST_EVENT, handleChange);
    window.addEventListener("hems:equipment-lists-change", handleChange);
    return () => {
      cancelled = true;
      window.removeEventListener(ACTIVE_EQUIPMENT_LIST_EVENT, handleChange);
      window.removeEventListener("hems:equipment-lists-change", handleChange);
    };
  }, [supabase, pathname]);

  useEffect(() => {
    function invalidateSearchCatalog() {
      setSearchIndex(null);
      searchLoadRef.current = null;
    }

    window.addEventListener(CATALOG_CHANGED_EVENT, invalidateSearchCatalog);
    return () => {
      window.removeEventListener(
        CATALOG_CHANGED_EVENT,
        invalidateSearchCatalog,
      );
    };
  }, []);

  async function loadNotifications(force = false) {
    if (!force && Date.now() - notificationLoadedAt.current < 15000) return;
    notificationLoadedAt.current = Date.now();
    const version=++notificationReadVersion.current;
    const userId=getUserId();
    if(!userId){setNotifications([]);return;}
    const { data, error } = await supabase
      .from("notifications")
      .select("id, title, message, link, is_read, created_at, actor_name, actor_id")
      .or(IMPORTANT_ACTIVITY_FILTER)
      .order("created_at", { ascending: false })
      .limit(10);

    if (!error && version===notificationReadVersion.current && userId===getUserId()) setNotifications(((data ?? []) as NotificationRow[]).filter(entry=>entry.actor_id!==userId && isImportantActivity(entry)));
    else if (error) notificationLoadedAt.current = 0;
  }

  useEffect(() => { void loadNotifications(); }, [actionInbox.revision]);

  async function markNotificationsRead() {
    const unreadIds = notifications.filter((n) => !n.is_read).map((n) => n.id);
    if (unreadIds.length === 0) return;

    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));

    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .in("id", unreadIds);

    if (error) await loadNotifications();
  }

  async function fetchAllRows(table: string, columns: string) {
    const rows: any[] = [];
    const pageSize = 1000;
    let from = 0;

    while (true) {
      const { data, error } = await (supabase as any)
        .from(table)
        .select(columns)
        .range(from, from + pageSize - 1);

      if (error) throw error;

      const page = (data ?? []) as any[];
      rows.push(...page);

      if (page.length < pageSize) break;
      from += pageSize;
    }

    return rows;
  }

  async function loadSearchIndex() {
    if (searchIndex || searchLoadRef.current) {
      return searchLoadRef.current ?? Promise.resolve();
    }

    setSearchLoading(true);
    setSearchError("");

    const request = (async () => {
      try {
        const [categories, subcategories, items, units, matrixModels, matrixRows] =
          await Promise.all([
            fetchAllRows("categories", "*"),
            fetchAllRows("subcategories", "*"),
            fetchAllRows("items", "id,name,subcategory_id,photo_url,fixture_type"),
            fetchAllRows("units", "id,item_id,unit_no,serial"),
            fetchAllRows(
              "matrix_models",
              "id,name,category_id,subcategory_id,item_type,block_name,total_qty,in_use_qty,maintenance_qty,in_ksa_qty"
            ),
            fetchAllRows(
              "matrix_rows",
              "id,model_id,item_id,size,cabinet_model,cable_length,qty,total_qty,in_use_qty,maintenance_qty,in_ksa_qty",
            ),
          ]);

        setSearchIndex({
          categories: categories as CategoryRow[],
          subcategories: subcategories as SubcategoryRow[],
          items: items as ItemRow[],
          units: units as UnitRow[],
          matrixModels: matrixModels as MatrixModelRow[],
          matrixRows: matrixRows as MatrixRow[],
        });
      } catch (error: any) {
        console.error("inventory search error:", error);
        setSearchError(error?.message || "Failed to load inventory search.");
      } finally {
        setSearchLoading(false);
        searchLoadRef.current = null;
      }
    })();

    searchLoadRef.current = request;
    return request;
  }

  const searchResults = useMemo<SearchResult[]>(() => {
    const query = normalizeSearch(searchQuery);
    if (query.length < 2 || !searchIndex) return [];

    const results: SearchResult[] = [];
    const categoriesById = new Map(
      searchIndex.categories.map((category) => [category.id, category])
    );
    const subcategoriesById = new Map(
      searchIndex.subcategories.map((subcategory) => [subcategory.id, subcategory])
    );
    const itemsById = new Map(searchIndex.items.map((item) => [item.id, item]));
    const modelsById = new Map(
      searchIndex.matrixModels.map((model) => [model.id, model])
    );

    function locationForSubcategory(subcategoryId: string) {
      const subcategory = subcategoriesById.get(subcategoryId);
      const category = subcategory
        ? categoriesById.get(subcategory.category_id)
        : undefined;

      if (!subcategory?.slug || !category?.slug) return null;

      return {
        category,
        subcategory,
        baseHref: `/inventory/${encodeURIComponent(
          category.slug
        )}/${encodeURIComponent(subcategory.slug)}`,
      };
    }

    for (const category of searchIndex.categories) {
      const name = rowName(category);
      const score = matchScore(`${name} ${category.slug ?? ""}`, query);
      if (score === null || !category.slug) continue;

      results.push({
        key: `category-${category.id}`,
        kind: "Category",
        title: name || category.slug,
        subtitle: "Inventory category",
        href: `/inventory/${encodeURIComponent(category.slug)}`,
        score,
      });
    }

    for (const subcategory of searchIndex.subcategories) {
      const location = locationForSubcategory(subcategory.id);
      const name = rowName(subcategory);
      const score = matchScore(`${name} ${subcategory.slug ?? ""}`, query);
      if (score === null || !location) continue;

      results.push({
        key: `subcategory-${subcategory.id}`,
        kind: "Subcategory",
        title: name || subcategory.slug || "Subcategory",
        subtitle: rowName(location.category),
        href: location.baseHref,
        score,
      });
    }

    for (const item of searchIndex.items) {
      const score = matchScore(item.name, query);
      const location = locationForSubcategory(item.subcategory_id);
      if (score === null || !location) continue;

      results.push({
        key: `item-${item.id}`,
        kind: "Equipment",
        title: item.name,
        subtitle: `${rowName(location.category)} / ${rowName(
          location.subcategory
        )}`,
        href: `${location.baseHref}/${encodeURIComponent(item.id)}`,
        score,
        addTarget: {
          item,
          category: String(location.category.slug),
          subcategory: String(location.subcategory.slug),
        },
      });
    }

    for (const unit of searchIndex.units) {
      const item = itemsById.get(unit.item_id);
      const location = item ? locationForSubcategory(item.subcategory_id) : null;
      const unitText = `${unit.serial ?? ""} unit ${unit.unit_no ?? ""} #${
        unit.unit_no ?? ""
      }`;
      const score = matchScore(unitText, query);
      if (score === null || !item || !location) continue;

      const details = [
        unit.serial ? `Serial: ${unit.serial}` : "",
        unit.unit_no !== null ? `Unit #${unit.unit_no}` : "",
      ].filter(Boolean);

      results.push({
        key: `unit-${unit.id}`,
        kind: "Serial / Unit",
        title: item.name,
        subtitle: details.join(" • ") || rowName(location.subcategory),
        href: `${location.baseHref}/${encodeURIComponent(item.id)}`,
        score,
        addTarget: {
          item,
          category: String(location.category.slug),
          subcategory: String(location.subcategory.slug),
        },
      });
    }

    for (const model of searchIndex.matrixModels) {
      const score = matchScore(model.name, query);
      const location = locationForSubcategory(model.subcategory_id);
      if (score === null || !location) continue;

      const genericMatrixItem = model.item_type === "unit";

      results.push({
        key: `matrix-model-${model.id}`,
        kind: genericMatrixItem
          ? "Matrix item"
          : model.item_type === "cable"
            ? "Cable group"
            : model.item_type === "rack"
              ? "Rack group"
              : "LED model",
        title: model.name,
        subtitle: `${rowName(location.category)} / ${rowName(
          location.subcategory
        )}`,
        href: location.baseHref,
        score,
        matrixAddTarget: genericMatrixItem
          ? {
              target: {
                id: model.id,
                parentId: null,
                recordType: "matrix_model",
                displayName: model.name,
                blockName: model.block_name || null,
                photoUrl: null,
                itemType: model.item_type || "unit",
                total: Number(model.total_qty || 0),
                inUse: Number(model.in_use_qty || 0),
                maintenance: Number(model.maintenance_qty || 0),
                inKsa: Number(model.in_ksa_qty || 0),
              },
              category: String(location.category.slug),
              subcategory: String(location.subcategory.slug),
            }
          : undefined,
      });
    }

    for (const row of searchIndex.matrixRows) {
      const parentId = row.model_id || row.item_id || "";
      const model = modelsById.get(parentId);
      const location = model ? locationForSubcategory(model.subcategory_id) : null;
      const rowLabel =
        row.cable_length ||
        [row.size, row.cabinet_model].filter(Boolean).join(" · ");
      const ownText = `${model?.name ?? ""} ${rowLabel}`;
      const score = matchScore(ownText, query);
      if (score === null || !model || !location) continue;

      const rowKind =
        model.item_type === "cable"
          ? "Cable length"
          : model.item_type === "rack"
            ? "Rack item"
            : "LED cabinet";

      results.push({
        key: `matrix-row-${row.id}`,
        kind: rowKind,
        title: model.name,
        subtitle: rowLabel || rowName(location.subcategory),
        href:
          rowKind === "LED cabinet"
            ? `${location.baseHref}/led-report/${encodeURIComponent(row.id)}`
            : location.baseHref,
        score,
        matrixAddTarget: {
          target: {
            id: row.id,
            parentId: model.id,
            recordType: "matrix_row",
            displayName: model.name,
            blockName: model.block_name || null,
            photoUrl: null,
            itemType: model.item_type || null,
            rowLabel: rowLabel || null,
            total: Number(row.total_qty ?? row.qty ?? 0),
            inUse: Number(row.in_use_qty || 0),
            maintenance: Number(row.maintenance_qty || 0),
            inKsa: Number(row.in_ksa_qty || 0),
          },
          category: String(location.category.slug),
          subcategory: String(location.subcategory.slug),
        },
      });
    }

    return results
      .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
      .slice(0, 10);
  }, [searchIndex, searchQuery]);

  useEffect(() => {
    if (normalizeSearch(searchQuery).length >= 2 && !searchIndex) {
      void loadSearchIndex();
    }
    // loadSearchIndex intentionally reads the current cached index.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, searchIndex]);

  useEffect(() => {
    let mounted = true;

    async function loadProfile(userId: string) {
      const { data } = await readWorkspaceProfile(supabase, userId);

      if (!mounted || !data) return;

      const avatar = data.avatar_url ?? "";

      setProfile({
        role: data.role ?? "",
        department: data.department ?? "",
        avatar_url: avatar,
      });

      localStorage.setItem("hems:profile:role", data.role ?? "");
      localStorage.setItem("hems:profile:department", data.department ?? "");
      setUserId(userId);
      setUserRole(data.role ?? "viewer");
      setUserDepartment(data.department ?? "");

      if (avatar && !avatar.startsWith("data:image")) {
        localStorage.setItem("hems:profile:avatar_url", avatar);
      } else {
        localStorage.removeItem("hems:profile:avatar_url");
      }

      if (data.full_name) {
        setUserNameState(data.full_name);
        setUserName(data.full_name);
      }

    }

    async function syncAuth() {
      const {
        data: { session },
      } = await readBrowserSession();

      if (!mounted) return;

      setLoggedIn(!!session);
      setUserNameState(getUserName());

      if (session?.user?.id) {
        await loadProfile(session.user.id);

        const notifCache = sessionStorage.getItem("hems:notif-loaded");

if (!notifCache) {
  void loadNotifications();
  sessionStorage.setItem("hems:notif-loaded", "1");
}
      } else {
        setProfile({});
        setNotifications([]);
      }
    }

    void syncAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      if (!mounted) return;

      setLoggedIn(!!session);
      setUserNameState(getUserName());
      setOpen(false);
      setNotifOpen(false);

      if (session?.user?.id) {
        void loadProfile(session.user.id);
        void loadNotifications();
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;

      if (wrapperRef.current && !wrapperRef.current.contains(target)) {
        setOpen(false);
      }

      if (notifRef.current && !notifRef.current.contains(target)) {
        setNotifOpen(false);
      }

      if (searchRef.current && !searchRef.current.contains(target)) {
        setSearchFocused(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSearchFocused(false);
        searchInputRef.current?.blur();
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        setSearchFocused(true);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function onLogout() {
    if (loggingOut) return;
    try {
      const store = await offlineStore(), owner = store.owner();
      if (owner && (await store.all(owner, 'draft:')).some((draft: any) => draft.dirty)) {
        window.dispatchEvent(new Event('hems:open-offline'));
        window.dispatchEvent(new CustomEvent('hems:offline-message', {detail:'Sync your offline drafts, or export and discard their local changes, before signing out.'}));
        return;
      }
    } catch { /* A browser without offline storage can still sign out. */ }

    setLoggingOut(true);
    setNotifOpen(false);
    setSidebarOpen(false);
    setOpen(true);

    localStorage.removeItem("hems:profile:role");
    localStorage.removeItem("hems:profile:department");
    localStorage.removeItem("hems:profile:avatar_url");

    try {
      await Promise.race([logout(), new Promise((resolve) => setTimeout(resolve, 1200))]);
      await supabase.auth.signOut({ scope: "global" });
    } catch (e) {
      console.error("logout error:", e);
    } finally {
      setLoggedIn(false);
      setUserNameState(null);
      setProfile({});
      setNotifications([]);
      window.location.replace("/login");
    }
  }

  const unreadCount = notifications.filter((n) => !n.is_read).length + actionInbox.tasks.length;

  const userInitials = useMemo(() => {
    if (!userName) return "U";
    const parts = userName.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "U";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }, [userName]);

  function roleLabel() {
    if (!profile.role) return "";
    if (profile.role === "admin") return "Admin";
    if (profile.role === "warehouse_manager") return "Warehouse Manager";
    if (profile.role === "viewer") return "Viewer";
    if (profile.role === "head") {
      if (profile.department === "lighting") return "Head of Lighting";
      if (profile.department === "video") return "Head of Video";
      if (profile.department === "rigging") return "Head of Rigging";
      return "Head";
    }
    return profile.role;
  }

  function openNotification(n: NotificationRow) {
    setNotifOpen(false);
    if (n.link) router.push(n.link);
  }

  const navItems = [
    { label: "Home", href: "/", icon: House },
    { label: "Inventory", href: "/inventory", icon: Boxes },
    ...(profile.role === "admin"
      ? [{ label: "Settings", href: "/settings", icon: SettingsIcon }]
      : []),
  ];

  return (
    <>
      <header ref={topbarRef} data-hems-topbar className="bg-white shadow-sm">
        <div data-hems-header-row className="flex w-full items-center gap-2 px-2 py-2 hems-wide:px-4">
          <div className="flex shrink-0 items-center gap-2">
            {showPrivateNav ? (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 active:scale-95 hems-desktop:hidden"
                aria-label="Open navigation and equipment lists"
                title="Menu"
              >
                <Menu size={22} strokeWidth={2.4} />
              </button>
            ) : null}

            <Link href="/" className="flex shrink-0 items-center">
              <img
                src="/logo-icon.png"
                alt="Logo"
                className="h-6 w-6 rounded-md bg-white object-contain p-[2px] hems-wide:h-7 hems-wide:w-7"
              />
            </Link>

            <span data-hems-brand-divider className="h-3 w-px shrink-0 bg-black/30 hems-wide:h-5" />
            <span data-hems-mobile-brand className="hidden text-sm font-bold tracking-tight">HEMS</span>

            <span className="hidden truncate text-xs font-semibold tracking-wide text-gray-900 hems-desktop:block">
              Equipment Management System
            </span>
          </div>

          {showPrivateNav ? (
            <div
              ref={searchRef}
              data-hems-search
              className="relative min-w-0 flex-1 hems-wide:mx-2 hems-wide:max-w-md lg:max-w-xl"
            >
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-gray-400"
              />

              <input
                ref={searchInputRef}
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onFocus={() => {
                  setSearchFocused(true);
                  setOpen(false);
                  setNotifOpen(false);
                }}
                placeholder="Search inventory..."
                autoComplete="off"
                className="h-8 w-full rounded-full border border-gray-200 bg-gray-50 pl-8 pr-8 text-[11px] text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-gray-400 focus:bg-white focus:ring-2 focus:ring-gray-100 hems-wide:text-xs"
                aria-label="Search inventory"
              />

              {searchLoading ? (
                <Loader2
                  size={13}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-gray-400"
                />
              ) : searchQuery ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                  className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-200 hover:text-gray-700"
                  title="Clear search"
                >
                  <X size={12} />
                </button>
              ) : null}

              {searchFocused && normalizeSearch(searchQuery).length > 0 ? (
                <div className="fixed left-2 right-2 top-[50px] z-[100] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl hems-wide:absolute hems-wide:left-0 hems-wide:right-0 hems-wide:top-full hems-wide:mt-2">
                  {normalizeSearch(searchQuery).length < 2 ? (
                    <div className="px-4 py-4 text-xs text-gray-500">
                      Type at least 2 characters.
                    </div>
                  ) : searchLoading ? (
                    <div className="flex items-center gap-2 px-4 py-4 text-xs text-gray-500">
                      <Loader2 size={14} className="animate-spin" />
                      Searching inventory...
                    </div>
                  ) : searchError ? (
                    <div className="px-4 py-4">
                      <div className="text-xs text-red-600">{searchError}</div>
                      <button
                        type="button"
                        onClick={() => void loadSearchIndex()}
                        className="mt-2 text-xs font-semibold text-gray-900 underline"
                      >
                        Try again
                      </button>
                    </div>
                  ) : searchResults.length === 0 ? (
                    <div className="px-4 py-4 text-xs text-gray-500">
                      No inventory results found.
                    </div>
                  ) : (
                    <div className="max-h-[min(420px,65vh)] overflow-y-auto p-1.5">
                      {searchResults.map((result) => (
                        <div key={result.key} className="flex items-center gap-2 rounded-lg transition hover:bg-gray-50">
                          <Link
                            href={result.href}
                            onClick={() => {
                              setSearchQuery("");
                              setSearchFocused(false);
                            }}
                            className="min-w-0 flex-1 px-3 py-2.5"
                          >
                            <div className="truncate text-xs font-semibold text-gray-900">
                              {result.title}
                            </div>
                            <div className="mt-0.5 truncate text-[10px] text-gray-500 hems-wide:text-[11px]">
                              {result.subtitle}
                            </div>
                          </Link>

                          {activeSearchDraft && result.matrixAddTarget ? (
                            <div className="mr-2 shrink-0">
                              <EquipmentListMatrixQuantityAction
                                target={result.matrixAddTarget.target}
                                category={result.matrixAddTarget.category}
                                subcategory={result.matrixAddTarget.subcategory}
                                compact
                                variant="topbar"
                              />
                            </div>
                          ) : activeSearchDraft && result.addTarget ? (
                            <button
                              type="button"
                              onClick={() => {
                                setSearchPickerTarget(result.addTarget!);
                                setSearchFocused(false);
                              }}
                              title={`Add ${result.title} to ${activeSearchDraft.reference}`}
                              aria-label={`Add ${result.title} to active draft`}
                              className="mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-600 text-lg font-bold text-white shadow-sm transition hover:bg-red-700 active:scale-95"
                            >
                              +
                            </button>
                          ) : result.kind !== "LED model" ? (
                            <span className="mr-2 shrink-0 rounded-full bg-gray-100 px-2 py-1 text-[9px] font-semibold text-gray-600">
                              {result.kind}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex-1" />
          )}

          <div className="relative ml-auto flex shrink-0 items-center gap-2">
            <OfflineStatus />

            {loggedIn ? (
              <div className="flex items-center gap-2 px-1 py-0.5">
                {pathname !== "/login" ? (
                  <>
                    <Link
                      href="/"
                      className={`flex h-6 w-6 items-center justify-center rounded-full transition ${
                        pathname === "/"
                          ? "bg-gray-900 text-white"
                          : "text-gray-700 hover:bg-gray-100"
                      }`}
                      title="Home"
                      aria-label="Home"
                    >
                      <House size={14} strokeWidth={2.1} />
                    </Link>

                    <Link
                      href="/inventory"
                      className={`hidden h-6 w-6 items-center justify-center rounded-full transition hems-wide:flex ${
                        pathname.startsWith("/inventory")
                          ? "bg-gray-900 text-white"
                          : "text-gray-700 hover:bg-gray-100"
                      }`}
                      title="Inventory"
                      aria-label="Inventory"
                    >
                      <Boxes size={14} strokeWidth={2.1} />
                    </Link>

                    {profile.role === "admin" ? (
                      <Link
                        href="/settings"
                        className={`flex h-6 w-6 items-center justify-center rounded-full transition ${
                          pathname.startsWith("/settings")
                            ? "bg-gray-900 text-white"
                            : "text-gray-700 hover:bg-gray-100"
                        }`}
                        title="Settings"
                        aria-label="Settings"
                      >
                        <SettingsIcon size={14} strokeWidth={2.1} />
                      </Link>
                    ) : null}

                    <div ref={notifRef} className="relative">
                      <button
                        type="button"
                        onClick={() => {
                          setNotifOpen((v) => !v);
                          setOpen(false);
                          void markNotificationsRead();
                        }}
                        className="relative flex h-6 w-6 items-center justify-center rounded-full text-gray-700 transition hover:bg-gray-100"
                        title="Notifications"
                      >
                        <Bell size={15} strokeWidth={2} />
                        {unreadCount > 0 ? (
                          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[8px] font-bold text-white">
                            {unreadCount > 9 ? "9+" : unreadCount}
                          </span>
                        ) : null}
                      </button>

                      {notifOpen ? (
                        <div className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border border-gray-200 bg-white p-2 shadow-md">
                          <div className="px-2 py-2 text-xs font-semibold text-gray-900">
                            Notifications
                          </div>

                          <div className="max-h-72 overflow-y-auto">
                            <div className="px-1"><ActionRequiredAlerts compact onOpen={() => setNotifOpen(false)} /></div>
                            {notifications.length === 0 && actionInbox.tasks.length === 0 ? (
                              <div className="px-2 py-4 text-xs text-gray-500">
                                No notifications yet.
                              </div>
                            ) : (
                              notifications.map((n) => (
                                <button
                                  key={n.id}
                                  type="button"
                                  onClick={() => openNotification(n)}
                                  className="w-full rounded-lg px-2 py-2 text-left transition hover:bg-gray-50"
                                >
                                  <div className="flex items-start gap-2">
                                    <span
                                      className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                                        n.is_read ? "bg-gray-200" : "bg-red-500"
                                      }`}
                                    />
                                    <div className="min-w-0">
                                      <div className="truncate text-xs font-semibold text-gray-900">
                                        {n.title}
                                      </div>
                                      <div className="line-clamp-2 text-[11px] text-gray-500">
                                        {n.message || ""}
                                      </div>
                                      <div className="mt-1 text-[10px] text-gray-400">
                                        {n.actor_name ? `${n.actor_name} • ` : ""}
                                        {new Date(n.created_at).toLocaleString()}
                                      </div>
                                    </div>
                                  </div>
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div className="h-5 w-px bg-gray-200" />
                  </>
                ) : null}

                <div ref={wrapperRef} className="relative">
                  <button
                    type="button"
                    aria-label="Profile menu"
                    onClick={() => {
                      setOpen((v) => !v);
                      setNotifOpen(false);
                    }}
                    className="flex items-center gap-1.5 rounded-lg px-1 py-0.5 transition hover:bg-gray-50 active:scale-[0.98]"
                  >
                    <div className="relative h-6 w-6 overflow-hidden rounded-full bg-gray-900">
                      {profile.avatar_url ? (
                        <img
                          src={profile.avatar_url}
                          alt={userName || "User"}
                          loading="eager"
                          onLoad={() => setAvatarLoaded(true)}
                          className={`h-full w-full object-cover transition-opacity duration-200 ${
                            avatarLoaded ? "opacity-100" : "opacity-0"
                          }`}
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center text-[9px] font-semibold text-white">
                          {userInitials}
                        </span>
                      )}
                    </div>

                    <span className="hidden text-left leading-none hems-wide:block">
                      <span className="block max-w-[120px] truncate text-[10px] font-semibold leading-3 text-gray-900">
                        {userName}
                      </span>
                      <span className="block max-w-[120px] truncate text-[9px] leading-3 text-gray-500">
                        {roleLabel()}
                      </span>
                    </span>

                    <ChevronDown
                      size={10}
                      className={`text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
                    />
                  </button>

                  {open ? (
                    <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border border-gray-200 bg-white p-3 shadow-md">
                      <div className="flex items-center gap-3">
                        {profile.avatar_url ? (
                          <img
                            src={profile.avatar_url}
                            alt={userName || "User"}
                            className="h-10 w-10 rounded-full object-cover"
                          />
                        ) : (
                          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-900 text-xs font-semibold text-white">
                            {userInitials}
                          </span>
                        )}

                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-gray-900">
                            {userName}
                          </div>
                          <div className="truncate text-xs text-gray-500">
                            {roleLabel()}
                          </div>
                        </div>
                      </div>

                      <div className="my-3 h-px bg-gray-200" />

                      <button type="button" onClick={() => {
                        window.dispatchEvent(new CustomEvent("hems:toggle-mobile-layout"));
                        setOpen(false);
                      }} className="mb-1 w-full rounded-lg px-2 py-3 text-left text-sm font-medium text-gray-700 hems-wide:hidden">
                        Switch mobile layout
                      </button>
                      <button
                        type="button"
                        onClick={onLogout}
                        disabled={loggingOut}
                        className="w-full rounded-lg px-2 py-2 text-left text-sm text-red-500 transition hover:bg-red-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {loggingOut ? "Logging out..." : "Logout"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <Link
                href="/login"
                className="rounded-full bg-gray-900 px-3 py-1 text-[10px] font-medium text-white shadow-sm transition hover:opacity-90 active:scale-[0.96]"
              >
                Login
              </Link>
            )}
          </div>
        </div>
      </header>

      {showPrivateNav ? (
        <>
          <div
            className={`fixed inset-0 z-[9998] bg-black/30 transition-opacity duration-200 hems-desktop:hidden ${
              sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
            }`}
            onClick={() => setSidebarOpen(false)}
          />

          <aside
            className={`fixed left-0 top-0 z-[9999] flex h-full w-[min(88vw,360px)] flex-col bg-white shadow-2xl transition-transform duration-300 ease-out hems-desktop:hidden ${
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            }`}
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-4">
              <div className="flex items-center gap-2">
                <img src="/logo.png" alt="Logo" className="h-5 w-auto object-contain" />
                <span className="text-sm font-bold text-gray-900">HEMS</span>
              </div>

              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100"
              >
                <X size={18} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <nav className="p-3 pb-2">
                {navItems.map((item) => {
                  const active =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname?.startsWith(item.href);
                  const NavIcon = item.icon;

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`mb-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition ${
                        active
                          ? "bg-gray-900 text-white"
                          : "text-gray-700 hover:bg-gray-100"
                      }`}
                    >
                      <NavIcon size={16} strokeWidth={2.1} />
                      {item.label}
                    </Link>
                  );
                })}
              </nav>

              <div className="border-t border-gray-200">
                {sidebarMounted ? <EquipmentListsSidebar /> : null}
              </div>
            </div>
          </aside>
        </>
      ) : null}
      {activeSearchDraft && searchPickerTarget ? (
        <EquipmentListUnitPicker
          list={activeSearchDraft}
          item={searchPickerTarget.item}
          category={searchPickerTarget.category}
          subcategory={searchPickerTarget.subcategory}
          onClose={() => setSearchPickerTarget(null)}
          onAdded={() => {
            setSearchPickerTarget(null);
            setSearchQuery("");
          }}
        />
      ) : null}
    </>
  );
}

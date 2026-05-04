"use client";

import Link from "next/link";
import { Bell, ChevronDown, Menu, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserName, logout } from "@/lib/authStore";

type NotificationRow = {
  id: string;
  title: string;
  message: string | null;
  link: string | null;
  is_read: boolean;
  created_at: string;
  actor_name: string | null;
};

export default function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const notifRef = useRef<HTMLDivElement | null>(null);

  const [userName, setUserNameState] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [open, setOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [notifications, setNotifications] = useState<NotificationRow[]>([]);

  const [profile, setProfile] = useState<{
    role?: string;
    department?: string;
    avatar_url?: string | null;
  }>({});

  const supabase = createClient();

  useEffect(() => {
    setSidebarOpen(false);
    setOpen(false);
    setNotifOpen(false);
  }, [pathname]);

  async function loadNotifications() {
    const { data, error } = await supabase
      .from("notifications")
      .select("id, title, message, link, is_read, created_at, actor_name")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) {
      console.error("load notifications error:", error);
      return;
    }

    setNotifications((data ?? []) as NotificationRow[]);
  }

  async function markNotificationsRead() {
    const unreadIds = notifications.filter((n) => !n.is_read).map((n) => n.id);
    if (unreadIds.length === 0) return;

    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));

    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .in("id", unreadIds);

    if (error) {
      console.error("mark notifications read error:", error);
      await loadNotifications();
    }
  }

  useEffect(() => {
    let mounted = true;

    async function loadProfile(userId: string) {
      const { data } = await supabase
        .from("profiles")
        .select("role, department, avatar_url, full_name")
        .eq("id", userId)
        .single();

      if (!mounted || !data) return;

      setProfile({
        role: data.role ?? "",
        department: data.department ?? "",
        avatar_url: data.avatar_url ?? "",
      });

      if (data.full_name) setUserNameState(data.full_name);
    }

    async function syncAuth() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!mounted) return;

      setLoggedIn(!!session);
      setUserNameState(getUserName());

      if (session?.user?.id) {
        await loadProfile(session.user.id);
        await loadNotifications();
      } else {
        setProfile({});
        setNotifications([]);
      }
    }

    syncAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;

      setLoggedIn(!!session);
      setUserNameState(getUserName());
      setOpen(false);
      setNotifOpen(false);

      if (session?.user?.id) {
        void loadProfile(session.user.id);
        void loadNotifications();
      } else {
        setProfile({});
        setNotifications([]);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [pathname]);

  useEffect(() => {
    if (!loggedIn) return;

    const channel = supabase
      .channel("notifications-topbar")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
        },
        () => {
          void loadNotifications();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loggedIn]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;

      if (wrapperRef.current && !wrapperRef.current.contains(target)) {
        setOpen(false);
      }

      if (notifRef.current && !notifRef.current.contains(target)) {
        setNotifOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function onLogout() {
    await logout();
    setLoggedIn(false);
    setUserNameState(null);
    setProfile({});
    setNotifications([]);
    setOpen(false);
    setNotifOpen(false);
    setSidebarOpen(false);
    router.replace("/login");
    router.refresh();
  }

  const unreadCount = notifications.filter((n) => !n.is_read).length;

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
    { label: "Home", href: "/" },
    { label: "Inventory", href: "/inventory" },
    { label: "Report", href: "/equipment-report" },
    { label: "Setting", href: "/settings" },
  ];

  return (
    <>
      <header className="bg-white shadow-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-2.5 py-2 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-700 transition hover:bg-gray-100 active:scale-95"
              title="Menu"
            >
              <Menu size={22} strokeWidth={2.4} />
            </button>

            <Link href="/" className="flex shrink-0 items-center">
              <img
                src="/logo-icon.png"
                alt="Logo"
                className="h-6 w-6 rounded-md object-contain bg-white p-[2px] sm:h-7 sm:w-7"
              />
            </Link>

            <span className="h-3 w-px shrink-0 bg-black/30 sm:h-5" />

            <span className="min-w-0 truncate text-[9px] font-semibold tracking-wide text-gray-900 sm:text-xs">
              Equipment Management System
            </span>
          </div>

          <div className="relative flex items-center gap-2">
            {loggedIn ? (
              <>
                <div className="flex items-center gap-2 px-1 py-0.5">
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
                          {notifications.length === 0 ? (
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
                                    className={`mt-1 h-2 w-2 rounded-full shrink-0 ${
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

                  <div ref={wrapperRef} className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        setOpen((v) => !v);
                        setNotifOpen(false);
                      }}
                      className="flex items-center gap-1.5 rounded-lg px-1 py-0.5 transition hover:bg-gray-50 active:scale-[0.98]"
                    >
                      {profile.avatar_url ? (
                        <img
                          src={profile.avatar_url}
                          alt={userName || "User"}
                          className="h-6 w-6 rounded-full object-cover"
                        />
                      ) : (
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-900 text-[9px] font-semibold text-white">
                          {userInitials}
                        </span>
                      )}

                      <span className="hidden text-left leading-none sm:block">
                        <span className="block max-w-[120px] truncate text-[10px] font-semibold leading-3 text-gray-900">
                          {userName}
                        </span>
                        <span className="block max-w-[120px] truncate text-[9px] leading-3 text-gray-500">
                          {roleLabel()}
                        </span>
                      </span>

                      <ChevronDown
                        size={10}
                        className={`text-gray-400 transition-transform ${
                          open ? "rotate-180" : ""
                        }`}
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

                        <button
                          type="button"
                          onClick={onLogout}
                          className="w-full rounded-lg px-2 py-2 text-left text-sm text-red-500 transition hover:bg-red-50"
                        >
                          Logout
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </>
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

      <div
        className={`fixed inset-0 z-[9998] bg-black/30 transition-opacity duration-200 ${
          sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside
        className={`fixed left-0 top-0 z-[9999] h-full w-[260px] bg-white shadow-2xl transition-transform duration-300 ease-out ${
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

        <nav className="p-3">
          {navItems.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : pathname?.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`mb-1 flex items-center rounded-xl px-3 py-3 text-sm font-medium transition ${
                  active ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
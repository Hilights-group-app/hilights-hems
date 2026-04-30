"use client";

import Link from "next/link";
import { Bell, ChevronDown, Menu, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserName, logout } from "@/lib/authStore";

export default function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const [userName, setUserNameState] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [open, setOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [profile, setProfile] = useState<{
    role?: string;
    department?: string;
    avatar_url?: string | null;
  }>({});

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    let mounted = true;
    const supabase = createClient();

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

      if (session?.user?.id) await loadProfile(session.user.id);
      else setProfile({});
    }

    syncAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;

      setLoggedIn(!!session);
      setUserNameState(getUserName());
      setOpen(false);

      if (session?.user?.id) void loadProfile(session.user.id);
      else setProfile({});
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [pathname]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
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
    setOpen(false);
    setSidebarOpen(false);
    router.replace("/login");
    router.refresh();
  }

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
          {/* Left */}
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

          {/* Right */}
          <div ref={wrapperRef} className="relative flex items-center gap-2">
            {loggedIn ? (
              <>
                <div className="flex items-center gap-2 px-1 py-0.5">
                  <button
                    type="button"
                    className="relative flex h-6 w-6 items-center justify-center rounded-full text-gray-700 transition hover:bg-gray-100"
                    title="Notifications"
                  >
                    <Bell size={15} strokeWidth={2} />
                    <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[8px] font-bold text-white">
                      3
                    </span>
                  </button>

                  <div className="h-5 w-px bg-gray-200" />

                  <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
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
                </div>

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

      {/* Sidebar overlay */}
      <div
        className={`fixed inset-0 z-[9998] bg-black/30 transition-opacity duration-200 ${
          sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setSidebarOpen(false)}
      />

      {/* Sidebar */}
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
              item.href === "/"
                ? pathname === "/"
                : pathname?.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`mb-1 flex items-center rounded-xl px-3 py-3 text-sm font-medium transition ${
                  active
                    ? "bg-gray-900 text-white"
                    : "text-gray-700 hover:bg-gray-100"
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
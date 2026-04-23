"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserName, logout } from "@/lib/authStore";

export default function TopBar() {
  const pathname = usePathname();
  const router = useRouter();

  const [userName, setUserNameState] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    let mounted = true;
    const supabase = createClient();

    async function syncAuth() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!mounted) return;

      setLoggedIn(!!session);
      setUserNameState(getUserName());
    }

    syncAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setLoggedIn(!!session);
      setUserNameState(getUserName());
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [pathname]);

  async function onLogout() {
    await logout();
    setLoggedIn(false);
    setUserNameState(null);
    router.replace("/login");
    router.refresh();
  }

  const userInitials = useMemo(() => {
    if (!userName) return "";

    const parts = userName.trim().split(/\s+/).filter(Boolean);

    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();

    return (parts[0][0] + parts[1][0]).toUpperCase();
  }, [userName]);

  return (
    <header className="border-b border-black bg-white">
      <div className="mx-auto flex max-w-6xl flex-row items-center justify-between px-2.5 py-2 sm:px-6">
        
        {/* Left */}
        <div className="flex min-w-0 items-center gap-1">
          <Link href="/" className="flex shrink-0 items-center">
            <img
              src="/logo.png"
              alt="Logo"
              className="h-3 w-auto object-contain sm:h-5"
            />
          </Link>

          <span className="h-3 w-px shrink-0 bg-black/60 sm:h-5" />

          <span className="min-w-0 truncate text-[9px] font-semibold tracking-wide text-gray-900 sm:text-xs">
            Equipment Management System
          </span>
        </div>

        {/* Right */}
        <div className="flex items-center gap-1">
          {loggedIn && userInitials && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-gray-300 px-1 text-[9px] font-semibold text-gray-700 sm:h-6 sm:min-w-6 sm:px-1.5 sm:text-[10px]">
              {userInitials}
            </span>
          )}

          {loggedIn ? (
            <button
              onClick={onLogout}
              className="rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[10px] text-gray-900 transition hover:bg-gray-100 sm:px-3 sm:text-xs"
            >
              Logout
            </button>
          ) : (
            <Link
              href="/login"
              className="rounded-full bg-black px-2 py-0.5 text-[10px] text-white transition hover:opacity-90 sm:px-3 sm:text-xs"
            >
              Login
            </Link>
          )}
        </div>

      </div>
    </header>
  );
}
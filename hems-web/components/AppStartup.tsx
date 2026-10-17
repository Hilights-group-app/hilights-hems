"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { clearAuthStore, setUserId, setUserRole, setUserName, setUserDepartment } from "@/lib/authStore";
import { isOffline } from "@/lib/offline";
import { CATALOG_CHANGED_EVENT, readCatalog } from "@/lib/catalogStore";
import { ACTIVE_EQUIPMENT_LIST_KEY } from "@/lib/equipmentLists";
import { readWorkingDraft, readWorkspaceProfile, seedCatalogRoutes } from "@/lib/workspaceStartup";

export default function AppStartup({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/login";
  const client = useMemo(() => createClient(), []);
  const [readyScope, setReadyScope] = useState<boolean | null>(null);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setReadyScope(null); setSlow(false);
    const timer = setTimeout(() => { if (!cancelled) setSlow(true); }, 8000);
    async function warmWorkspace(userId: string) {
      // Optional preparation must never hold the opening screen open.
      await Promise.all([
        (async () => {
          try {
            const catalog = await readCatalog();
            if (!cancelled) seedCatalogRoutes(catalog);
          } catch { /* The inventory page can load its own catalog. */ }
        })(),
        (async () => {
          try {
            const draftId = localStorage.getItem(ACTIVE_EQUIPMENT_LIST_KEY);
            if (draftId && !cancelled) {
              await readWorkingDraft(client, draftId, false, userId);
            }
          } catch { /* Draft controls can retry when their page is opened. */ }
        })(),
      ]);
    }
    async function prepare() {
      try {
        // Login has its own auth flow and must not wait for a session refresh.
        if (isLogin) { if (!cancelled) setReadyScope(true); return; }
        const { data: { session } } = await client.auth.getSession();
        if (cancelled) return;
        if (!session) {
          // A cached app route can bypass middleware. Never expose that cached
          // inventory shell after an online sign-out. Offline users keep the
          // dedicated saved-workspace viewer instead.
          if (isOffline()) window.location.replace("/offline.html");
          else {
            clearAuthStore();
            window.location.replace("/login");
          }
          return;
        }
        setUserId(session.user.id);
        const profileResult = await readWorkspaceProfile(client, session.user.id);
        if (cancelled) return;
        const profile = profileResult.data;
        if (!profileResult.error && profile) {
          setUserRole(profile.role || "viewer");
          setUserDepartment(profile.department || "");
          setUserName(profile.full_name || "");
        }
        setReadyScope(isLogin);
        clearTimeout(timer);
        void warmWorkspace(session.user.id);
        // Warm one shared entry route; stock is fetched when a page is opened.
        router.prefetch("/inventory");
      } catch {
        // Show the real page/auth state if preparation fails; don't trap users.
        if (!cancelled) setReadyScope(isLogin);
      } finally { clearTimeout(timer); }
    }
    async function updateRoutes() {
      const catalog = await readCatalog();
      if (!cancelled) seedCatalogRoutes(catalog);
    }
    window.addEventListener(CATALOG_CHANGED_EVENT, updateRoutes);
    void prepare();
    return () => {
      cancelled = true; clearTimeout(timer);
      window.removeEventListener(CATALOG_CHANGED_EVENT, updateRoutes);
    };
  }, [isLogin, attempt, client, router]);

  useEffect(() => {
    if (isLogin) return;
    let alive = true;

    function goToLogin() {
      if (!alive || isOffline()) return;
      clearAuthStore();
      window.location.replace("/login");
    }

    const { data: { subscription } } = client.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") queueMicrotask(goToLogin);
    });

    const verifyVisibleSession = () => {
      if (document.visibilityState !== "visible" || isOffline()) return;
      void client.auth.getSession().then(({ data, error }) => {
        if (!error && !data.session) goToLogin();
      }).catch(() => {
        // A temporary connection failure is handled by offline mode, not logout.
      });
    };

    window.addEventListener("focus", verifyVisibleSession);
    document.addEventListener("visibilitychange", verifyVisibleSession);
    return () => {
      alive = false;
      subscription.unsubscribe();
      window.removeEventListener("focus", verifyVisibleSession);
      document.removeEventListener("visibilitychange", verifyVisibleSession);
    };
  }, [client, isLogin]);

  if (readyScope === isLogin) return <>{children}</>;
  return <div role="status" aria-live="polite" aria-label="Preparing your workspace" className="fixed inset-0 z-[20000] flex min-h-dvh flex-col items-center justify-center bg-white px-8 text-center">
    <img src="/logo-icon.png" alt="Hilights" width={64} height={64} fetchPriority="high" className="h-14 w-14 object-contain sm:h-16 sm:w-16" />
    <div className="mt-6 h-4 w-4 animate-spin rounded-full border-2 border-gray-200 border-t-red-600 motion-reduce:animate-none" />
    {slow ? <div className="mt-6 max-w-xs text-xs text-gray-500">
      <div className="mt-3 flex justify-center gap-3">
        <button type="button" onClick={() => setReadyScope(isLogin)} className="min-h-11 rounded-xl bg-gray-900 px-5 font-semibold text-white">Continue</button>
        <button type="button" onClick={() => setAttempt(value => value + 1)} className="min-h-11 rounded-xl border border-gray-200 px-5 font-semibold text-gray-700">Retry</button>
      </div>
    </div> : null}
  </div>;
}

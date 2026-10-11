"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { setUserId, setUserRole, setUserName, setUserDepartment } from "@/lib/authStore";
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
    async function prepare() {
      try {
        const { data: { session } } = await client.auth.getSession();
        if (cancelled) return;
        if (isLogin || !session) { setReadyScope(isLogin); return; }
        setUserId(session.user.id);
        const [profileResult, catalog] = await Promise.all([
          readWorkspaceProfile(client, session.user.id), readCatalog(),
        ]);
        if (cancelled) return;
        const profile = profileResult.data;
        setUserRole(profile?.role || "viewer");
        setUserDepartment(profile?.department || "");
        setUserName(profile?.full_name || "");
        seedCatalogRoutes(catalog);
        let draftId: string | null = null;
        try { draftId = localStorage.getItem(ACTIVE_EQUIPMENT_LIST_KEY); } catch {}
        if (draftId) await readWorkingDraft(client, draftId, false, session.user.id);
        if (cancelled) return;
        setReadyScope(isLogin);
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

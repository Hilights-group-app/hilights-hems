"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { usePathname } from 'next/navigation';
import { createClient, readBrowserSession } from '@/lib/supabase/client';
import { getUserId } from '@/lib/authStore';
import { connectionChanged, isOffline, offlineStore } from '@/lib/offline';

function subscribe(callback: () => void) {
  window.addEventListener('hems:connection', callback);
  window.addEventListener('online', callback); window.addEventListener('offline', callback);
  return () => { window.removeEventListener('hems:connection', callback); window.removeEventListener('online', callback); window.removeEventListener('offline', callback); };
}
export function OfflineStatus() {
  const offline = useSyncExternalStore(subscribe, isOffline, () => false);
  return <span
    title={offline ? 'App is offline' : 'App is online'} aria-label={offline ? 'Offline' : 'Online'}
    className={`shrink-0 rounded-full px-2 py-1.5 text-[10px] font-bold ${offline ? 'bg-amber-100 text-amber-800' : 'bg-emerald-50 text-emerald-700'}`}>
    <span aria-hidden="true">● </span>{offline ? 'Offline' : 'Online'}
  </span>;
}

export default function OfflineWorkspace() {
  const pathname = usePathname();
  const client = useMemo(() => createClient(), []);
  const [opened, setOpened] = useState(false), [toast, setToast] = useState('');
  const [pending, setPending] = useState(0), [syncing, setSyncing] = useState(false);
  useEffect(() => {
    let alive = true, syncingNow = false, user = '', timer: ReturnType<typeof setTimeout> | undefined;
    let countTimer: ReturnType<typeof setTimeout> | undefined;
    let storage: any;
    const snapshotVersion = new Map<string, number>();
    const lastSnapshot = new Map<string, number>(), scheduled = new Map<string, ReturnType<typeof setTimeout>>();
    async function count() {
      if (!storage) return;
      const id = storage.owner();
      const drafts = id ? await storage.all(id, 'draft:') : [];
      if (alive && storage.owner() === id) setPending(drafts.filter((d: any) => d.dirty).length);
    }
    function scheduleCount() {
      clearTimeout(countTimer);
      countTimer = setTimeout(() => void count(), 250);
    }
    function showMessage(event: Event) { setToast((event as CustomEvent).detail || 'App offline.'); }
    function openWorkspace() { setOpened(true); }
    function offline() {
      // Keep the normal HEMS interface visible. The status pill and write guards
      // turn it into a read-only view; Saved workspace remains available on demand.
      connectionChanged(true);
    }
    async function online() {
      // Browser online is a hint: prove the database is reachable before enabling writes.
      try {
        const { data: { session } } = await readBrowserSession();
        if (!session?.user.id) { connectionChanged(false); return; }
        const result = await client.from('profiles').select('id').eq('id', session.user.id).setHeader('x-hems-online-probe', '1').maybeSingle();
        if (!result.error && result.data) { connectionChanged(false); await count(); }
      } catch { /* Keep the offline workspace open and retry on focus / online. */ }
    }
    async function captureDraft(id: string) {
      if (!storage || !user || isOffline() || storage.owner() !== user || !id ||
          Date.now() - (lastSnapshot.get(id) || 0) < 15000) return;
      lastSnapshot.set(id, Date.now());
      const startedAt = Date.now();
      const owner = user, version = (snapshotVersion.get(id) || 0) + 1;
      snapshotVersion.set(id, version);
      try {
        const { data, error } = await client.rpc('hems_offline_draft_snapshot', { p_list_id: id });
        if (alive && snapshotVersion.get(id) === version && storage.owner() === owner) {
          if (!error && data) await storage.snapshot(owner, data, startedAt);
          else if (!error || error.code === '42501') await storage.invalidateDraft(owner, id, 'This draft is no longer available or your access changed.');
        }
      } catch { /* SQL may not have been installed yet; never block the live page. */ }
    }
    function scheduleDraft(event: Event) {
      const id = String((event as CustomEvent).detail?.listId || (event as CustomEvent).detail || localStorage.getItem('hems:active-equipment-list-id') || '');
      if (event.type !== 'hems:offline-draft-read') lastSnapshot.delete(id);
      if (!id || scheduled.has(id)) return;
      scheduled.set(id, setTimeout(() => { scheduled.delete(id); void captureDraft(id); }, 500));
    }
    async function sync() {
      if (syncingNow || !storage) return;
      if (isOffline()) { setToast('App offline. Drafts stay saved on this device. Submit requires an online connection.'); return; }
      syncingNow = true; if (alive) setSyncing(true);
      try {
        const { data, error } = await client.auth.getUser();
        if (error || !data.user || data.user.id !== storage.owner()) throw new Error('Sign in online with the same user to sync these drafts.');
        const owner = data.user.id;
        const drafts = (await storage.all(owner, 'draft:')).filter((d: any) => d.dirty);
        let failed = 0;
        for (const candidate of drafts) {
          if (!alive || storage.owner() !== owner || isOffline()) break;
          const draft = await storage.beginSync(owner, candidate.id);
          if (!draft) continue;
          try {
            const { data: result, error: syncError } = await client.rpc('hems_sync_offline_draft', {
              p_list_id: draft.id, p_sync_id: draft.syncId, p_expected_list: draft.baseline?.list || null,
              p_expected_items: draft.baseline?.items || [], p_header: draft.list, p_items: draft.items,
            });
            if (syncError) throw syncError;
            if (!result?.list?.id) throw new Error('Unexpected sync response. Your local draft was kept.');
            await storage.completeSync(owner, draft, result);
          } catch (error: any) {
            failed++;
            await storage.syncFailed(owner, draft, error?.message || 'Sync failed. Your local draft was kept.');
          }
        }
        const remaining = storage.owner() === owner ? (await storage.all(owner, 'draft:')).filter((d: any) => d.dirty).length : -1;
        if (alive) setToast(remaining < 0 ? 'The signed-in user changed. Sync stopped.' : remaining > 0
          ? (failed ? 'Some drafts could not sync. Open Saved workspace to review the message. Your local changes were kept.' : 'Some drafts are still saved on this device. Reconnect and sync again; another tab may be syncing.')
          : 'Offline drafts synced. Review availability online before Submit.');
        window.dispatchEvent(new Event('hems:equipment-lists-change'));
        window.dispatchEvent(new Event('hems:equipment-list-items-change'));
        window.dispatchEvent(new Event('hems:offline-data'));
      } catch (error: any) { if (alive) setToast(error?.message || 'Could not sync drafts.'); }
      finally { syncingNow = false; if (alive) setSyncing(false); void count(); }
    }
    function message(event: MessageEvent) {
      const frame = document.querySelector<HTMLIFrameElement>('[data-hems-offline-frame]');
      if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
      if (event.data?.type === 'hems:sync-drafts') void sync();
      if (event.data?.type === 'hems:close-offline' && !isOffline()) setOpened(false);
    }
    let photoObserver: MutationObserver | undefined, photoTimer: ReturnType<typeof setTimeout> | undefined;
    const photoSeen = new Set<string>();
    function cachePhotos() {
      clearTimeout(photoTimer);
      photoTimer = setTimeout(() => {
        if (!storage || !user || isOffline()) return;
        const owner = user;
        const sources = [...document.querySelectorAll<HTMLImageElement>('main img')]
          .filter(img => img.complete && img.naturalWidth > 0).map(img => img.currentSrc || img.src)
          .filter(src => src.startsWith('https://') && !photoSeen.has(src)).slice(0, 6);
        // Cache gently after the visible page settles; never compete with its reads.
        for (const src of sources) photoSeen.add(src);
        void (async () => { for (const src of sources) {
          if (!alive || storage.owner() !== owner || isOffline()) break;
          await storage.savePhoto(owner, src);
        } })().catch(() => {});
      }, 3000);
    }
    async function prepare() {
      try {
        storage = await offlineStore();
        if (!alive) return;
        if (navigator.onLine === false) { offline(); await count(); return; }
        const cachedUser = getUserId();
        const sessionResult = cachedUser ? null : await readBrowserSession();
        if (!alive) return;
        if (!cachedUser && !sessionResult?.data.session && !sessionResult?.error) await storage.purge();
        user = cachedUser || sessionResult?.data.session?.user.id || '';
        if (user) await storage.setOwner(user);
        await count();
        photoObserver = new MutationObserver(cachePhotos);
        photoObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        document.addEventListener('load', cachePhotos, true); cachePhotos();
        const id = localStorage.getItem('hems:active-equipment-list-id');
        if (id) void captureDraft(id);
        if (new URLSearchParams(location.search).has('offlineSync')) setOpened(true);
        if ('serviceWorker' in navigator && window.isSecureContext && process.env.NODE_ENV === 'production') {
          const registration = await navigator.serviceWorker.register('/hems-sw.js', { scope: '/', updateViaCache: 'none' });
          void registration.update();
          if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {});
        }
      } catch { if (alive) setToast('Offline storage is unavailable in this browser. Online use can continue.'); }
    }
    // Auth callbacks must not await Supabase auth APIs (auth-js holds an internal lock).
    const { data: { subscription } } = client.auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
      queueMicrotask(() => {
        if (!alive || !storage) return;
        if (session?.user.id) {
          if (event === 'SIGNED_IN') setOpened(false);
          user = session.user.id;
          void storage.setOwner(user).then(count).catch(() => {});
        } else if (event === 'SIGNED_OUT' && !isOffline()) {
          user = ''; void storage.purge().then(count).catch(() => {});
        }
      });
    });
    window.addEventListener('offline', offline); window.addEventListener('online', online);
    window.addEventListener('hems:open-offline', openWorkspace);
    window.addEventListener('hems:offline-message', showMessage);
    window.addEventListener('hems:offline-data', scheduleCount);
    window.addEventListener('hems:offline-draft-read', scheduleDraft);
    window.addEventListener('hems:equipment-list-items-change', scheduleDraft);
    window.addEventListener('hems:active-equipment-list-change', scheduleDraft);
    window.addEventListener('hems:sync-drafts', sync); window.addEventListener('message', message);
    const connection = () => {
      document.querySelector<HTMLIFrameElement>('[data-hems-offline-frame]')?.contentWindow?.postMessage({type:'hems:connection-state',offline:isOffline()},location.origin);
    };
    window.addEventListener('hems:connection', connection);
    const focus = () => { if (isOffline() && navigator.onLine) void online(); };
    window.addEventListener('focus', focus);
    timer = setInterval(() => { if (navigator.onLine && isOffline()) void online(); }, 30000);
    void prepare();
    return () => {
      alive = false; subscription.unsubscribe(); clearInterval(timer); clearTimeout(countTimer); scheduled.forEach(clearTimeout);
      clearTimeout(photoTimer); photoObserver?.disconnect(); document.removeEventListener('load', cachePhotos, true);
      window.removeEventListener('offline', offline); window.removeEventListener('online', online);
      window.removeEventListener('hems:open-offline', openWorkspace); window.removeEventListener('hems:offline-message', showMessage);
      window.removeEventListener('hems:offline-data', scheduleCount); window.removeEventListener('hems:offline-draft-read', scheduleDraft);
      window.removeEventListener('hems:equipment-list-items-change', scheduleDraft); window.removeEventListener('hems:active-equipment-list-change', scheduleDraft);
      window.removeEventListener('hems:sync-drafts', sync); window.removeEventListener('message', message);
      window.removeEventListener('hems:connection', connection); window.removeEventListener('focus', focus);
    };
  }, [client]);
  useEffect(() => {
    // Never carry the Saved workspace overlay through logout/login navigation.
    if (pathname === '/login') setOpened(false);
  }, [pathname]);
  useEffect(() => {
    const app = document.querySelector<HTMLElement>('[data-hems-online-app]');
    if (app) app.inert = opened;
    return () => { if (app) app.inert = false; };
  }, [opened]);
  useEffect(() => {
    if (pathname === '/login' || typeof navigator === 'undefined' || !('serviceWorker' in navigator) ||
        !window.isSecureContext || process.env.NODE_ENV !== 'production') return;
    let cancelled = false;
    void navigator.serviceWorker.ready.then(registration => {
      if (!cancelled && !isOffline()) registration.active?.postMessage({ type: 'hems:cache-route', url: location.href });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [pathname]);
  return <>
    {pending > 0 && !opened ? <div className="fixed bottom-3 left-1/2 z-[19000] flex max-w-[95vw] -translate-x-1/2 items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs shadow-lg">
      <button type="button" onClick={() => setOpened(true)} className="text-left text-amber-900">{pending} offline draft{pending === 1 ? '' : 's'} waiting to sync</button>
      <button type="button" disabled={syncing} onClick={() => window.dispatchEvent(new Event('hems:sync-drafts'))} className="shrink-0 rounded-xl bg-gray-900 px-3 py-2 font-bold text-white">{syncing ? 'Syncing…' : 'Sync drafts'}</button>
    </div> : null}
    {opened ? <div className="fixed inset-0 z-[30000] bg-white" role="dialog" aria-modal="true" aria-label="Saved offline workspace">
      <iframe data-hems-offline-frame src={`/offline.html?embedded=1&path=${encodeURIComponent(pathname)}`} onLoad={(event) => event.currentTarget.contentWindow?.postMessage({ type: 'hems:connection-state', offline: isOffline() }, location.origin)} title="Offline workspace" className="h-full w-full border-0" />
    </div> : null}
    {toast ? <div role="alert" className="fixed bottom-5 left-1/2 z-[31000] w-[min(92vw,480px)] -translate-x-1/2 rounded-2xl bg-gray-900 p-4 text-sm text-white shadow-xl">
      <p>{toast}</p><button type="button" onClick={() => setToast('')} className="mt-2 min-h-10 font-bold underline">OK</button>
    </div> : null}
  </>;
}

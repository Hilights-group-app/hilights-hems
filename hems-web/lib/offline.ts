/** Local data belongs to the signed-in user; the normal route shell contains no inventory rows. */
declare global { interface Window { HEMSOffline?: any } }
let loading: Promise<any> | undefined;
export function offlineStore(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Browser only.'));
  if (window.HEMSOffline) return Promise.resolve(window.HEMSOffline);
  if (!loading) loading = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/offline-store.js';
    script.onload = () => window.HEMSOffline ? resolve(window.HEMSOffline) : reject(new Error('Offline storage unavailable.'));
    script.onerror = () => reject(new Error('Offline storage unavailable.')); document.head.appendChild(script);
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}
let disconnected = false, requestSequence = 0;
const CACHEABLE_TABLES = new Set([
  'categories','subcategories','items','units','matrix_models','matrix_rows',
  'equipment_lists','equipment_list_items','maintenance_requests',
  'led_maintenance_logs','led_issue_repairs','inventory_locations',
]);
const CACHEABLE_RPCS = new Set([
  'hems_repair_status','hems_ksa_inventory_groups','hems_ksa_unit_choices',
  'hems_offline_draft_snapshot','is_equipment_list_manager',
  'hems_maintenance_user_access','hems_action_notifications',
]);
let captureQueue: Promise<void> = Promise.resolve();
function queueCapture(task: () => Promise<unknown>) {
  captureQueue = captureQueue.catch(() => {}).then(() => new Promise<void>((resolve) => {
    const run = () => { void task().catch(() => {}).finally(resolve); };
    const idle = (window as any).requestIdleCallback as undefined | ((callback: () => void, options?: {timeout:number}) => number);
    if (typeof idle === 'function') idle(run, { timeout: 1200 });
    else window.setTimeout(run, 80);
  }));
}
export function isOffline() { return typeof navigator !== 'undefined' && (navigator.onLine === false || disconnected); }
export function connectionChanged(offline: boolean) {
  disconnected = offline;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('hems:connection'));
    if ('serviceWorker' in navigator) {
      const message = { type: 'hems:connection-state', offline };
      navigator.serviceWorker.controller?.postMessage(message);
      void navigator.serviceWorker.getRegistration('/').then(registration => {
        registration?.active?.postMessage(message);
      }).catch(() => {});
    }
  }
}
export const OFFLINE_MESSAGE = 'App offline. Inventory is read-only. Open Offline drafts to edit a draft; Submit requires an online connection.';
function failure(message: string, announce = true) {
  if (announce && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('hems:offline-message', { detail: message }));
  return new Response(JSON.stringify({ code: 'HEMS_OFFLINE', message, details: null, hint: null }), {
    status: 503, headers: { 'Content-Type': 'application/json' },
  });
}
function tokenOwner(headers: Headers) {
  try {
    const part = (headers.get('authorization') || '').replace(/^Bearer /i, '').split('.')[1];
    const decoded = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return decoded.role === 'authenticated' && typeof decoded.sub === 'string' ? decoded.sub : '';
  } catch { return ''; }
}
export const offlineFetch: typeof fetch = async (input, init) => {
  if (typeof window === 'undefined') return fetch(input, init);
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
  if (url.origin !== project.origin) return fetch(input, init);
  const page = location.pathname, order = Date.now() * 1000 + (requestSequence++ % 1000);
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((v,k) => headers.set(k,v));
  const probe = headers.get('x-hems-online-probe') === '1';
  headers.delete('x-hems-online-probe');
  if (probe) init = { ...init, headers };
  const user = tokenOwner(headers);
  const rest = url.pathname.startsWith('/rest/v1/');
  const resource = url.pathname.split('/').pop() || '';
  const rpc = url.pathname.includes('/rest/v1/rpc/') ? resource : '';
  const cacheableRead = rest && ['GET','HEAD'].includes(method) && CACHEABLE_TABLES.has(resource);
  const cacheableRpc = rest && method === 'POST' && CACHEABLE_RPCS.has(rpc);
  let store: any;
  const needsStore = isOffline() || cacheableRead || cacheableRpc || (rest && !['GET','HEAD'].includes(method));
  if (needsStore) {
    try { store = await offlineStore(); } catch { /* Online use does not depend on local storage. */ }
  }
  const safeRead = !rest || (store ? store.readOnly(method, url.pathname) : method === 'GET' || method === 'HEAD');
  if (isOffline() && (!safeRead || url.pathname.startsWith('/storage/v1/') && !['GET','HEAD'].includes(method))) return failure(OFFLINE_MESSAGE);
  if (rest && !safeRead && user && store?.owner() === user) {
    const pending = (await store.all(user, 'draft:').catch(() => [])).some((draft: any) => draft.dirty);
    if (pending && ['equipment_lists','equipment_list_items','hems_reorder_draft_items','hems_edit_custom_draft_item','hems_add_ksa_units','hems_add_ksa_item','hems_share_equipment_draft'].includes(url.pathname.split('/').pop() || '')) {
      return failure('Offline draft changes are waiting. Sync drafts before editing or submitting lists online.');
    }
  }
  if (rest && method === 'GET' && isOffline() && !probe) {
    const cached = user && store?.owner() === user ? await store.get(user, store.queryKey(url, headers.get('accept'), headers.get('range'))).catch(() => null) : null;
    return cached ? new Response(JSON.stringify(cached.data), { status: 200, headers: { 'Content-Type': 'application/json', 'X-HEMS-Offline': '1' } }) : failure('This data is not saved on this device. Open it online first.', false);
  }
  if (rest && method === 'POST' && safeRead && isOffline() && !probe) return failure('This live read requires an online connection.', false);
  let response: Response;
  try { response = await fetch(input, init); }
  catch (error) {
    if (init?.signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw error;
    if (rest) connectionChanged(true);
    // Never retry a mutation: the server may already have committed it.
    if (rest && method === 'GET' && user && store?.owner() === user) {
      const cached = await store.get(user, store.queryKey(url, headers.get('accept'), headers.get('range'))).catch(() => null);
      if (cached) return new Response(JSON.stringify(cached.data), { status: 200, headers: { 'Content-Type': 'application/json', 'X-HEMS-Offline': '1' } });
    }
    throw error;
  }
  // A server error is not an offline signal. Never replace 401/403/500 with stale success.
  if (rest && response.ok && user && store && store.owner() === user) {
    if (cacheableRead) {
      const clone = response.clone();
      queueCapture(async () => {
        const data = await clone.json();
        if (store.owner() !== user || location.pathname !== page) return;
        await store.capture(user, url.href, headers.get('accept'), headers.get('range'), data, page, order);
        if (url.pathname.endsWith('/equipment_list_items')) {
          const filter = url.searchParams.get('list_id');
          if (filter?.startsWith('eq.')) window.dispatchEvent(new CustomEvent('hems:offline-draft-read', { detail: filter.slice(3) }));
        }
      });
    } else if (cacheableRpc && safeRead) {
      const clone = response.clone();
      queueCapture(async () => {
        const data = await clone.json();
        if (store.owner() !== user || location.pathname !== page) return;
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        await store.captureRPC(user, rpc, body, data, page, order);
      });
    }
  }
  return response;
};

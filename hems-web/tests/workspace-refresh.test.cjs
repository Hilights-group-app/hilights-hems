// Deterministic client-side tests. No credentials, network or database writes.
// Run from hems-web: node --test tests/workspace-refresh.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

class Clock {
  time = Date.parse('2026-10-26T10:00:00Z');
  sequence = 0;
  timers = new Map();
  setTimeout = (callback, delay = 0) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + Math.max(0, delay), callback });
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    for (let guard = 0; guard < 10000; guard++) {
      await settle();
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) { this.time = end; await settle(); return; }
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    throw new Error('Timer loop did not settle');
  }
}

function environment(options = {}) {
  const clock = new Clock();
  const window = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const errors = [];
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.time])); }
    static now() { return clock.time; }
  }
  class CustomEvent extends Event {
    constructor(type, init = {}) { super(type); this.detail = init.detail; }
  }
  const storage = () => {
    const data = new Map();
    return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
  };
  const sandbox = {
    Date: FakeDate, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    Event, CustomEvent, window, document, sessionStorage: storage(), localStorage: storage(),
    console: { error: (...args) => errors.push(args), log() {}, warn() {} },
    queueMicrotask,
  };
  function load(file, imports = {}) {
    const exports = {};
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    vm.runInNewContext(compiled, { ...sandbox, exports, require(name) {
      if (!(name in imports)) throw new Error(`Unexpected import ${name} in ${file}`);
      return imports[name];
    } }, { filename: file });
    return exports;
  }
  const refresh = load('lib/workspaceRefresh.ts');
  const state = [], effects = [], cleanups = [];
  const react = {
    useState(initial) {
      const index = state.length;
      state.push(options.stateOverrides?.[index] ?? (typeof initial === 'function' ? initial() : initial));
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useMemo: fn => fn(), useEffect: effect => effects.push(effect),
    createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
  };
  const calls = [], channels = [], authListeners = [];
  let user = 'alice';
  const userResult = () => ({ data: { session: user ? { user: { id: user } } : null }, error: null });
  const fixtures = options.fixtures ?? {};
  const response = (key, details) => {
    calls.push({ key, owner: user, at: clock.time, ...details });
    const fixture = fixtures[key];
    try {
      return Promise.resolve(typeof fixture === 'function' ? fixture(details) : fixture ?? { data: [], error: null });
    } catch (error) { return Promise.reject(error); }
  };
  const client = {
    rpc: name => response(`rpc:${name}`),
    from(table) {
      const operations = [];
      const builder = new Proxy({}, { get(_target, key) {
        if (key === 'then') return (resolve, reject) => response(table, { operations }).then(resolve, reject);
        return (...args) => { operations.push([key, ...args]); return builder; };
      } });
      return builder;
    },
    auth: { onAuthStateChange(fn) {
      authListeners.push(fn);
      return { data: { subscription: { unsubscribe() { const i = authListeners.indexOf(fn); if (i >= 0) authListeners.splice(i, 1); } } } };
    } },
    channel(name) {
      const channel = { name, bindings: [], removed: false, status: null,
        on(_type, filter, callback) { this.bindings.push({ filter, callback }); return this; },
        subscribe(callback) { this.status = callback; callback?.('SUBSCRIBED'); return this; },
      };
      channels.push(channel);
      return channel;
    },
    removeChannel(channel) { channel.removed = true; return Promise.resolve(); },
  };
  const lists = {
    EQUIPMENT_LISTS_EVENT: 'lists-change', EQUIPMENT_LIST_ITEMS_EVENT: 'items-change',
    ACTIVE_EQUIPMENT_LIST_EVENT: 'active-list-change', ACTIVE_EQUIPMENT_LIST_KEY: 'active-list',
    SHAREABLE_DRAFT_TYPES: ['dry_hire', 'local_event', 'transfer_out'],
    EQUIPMENT_LIST_TYPE_OPTIONS: [],
    canEditWorkingEquipmentList: () => true, isSharedEquipmentDraft: () => false,
    equipmentListStatusLabel: value => value,
  };
  const imports = {
    react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'next/link': { default: 'Link' }, 'next/navigation': { usePathname: () => options.pathname ?? '/' },
    'lucide-react': new Proxy({}, { get: (_obj, key) => key }),
    '@/components/ActionRequiredAlerts': { default: 'ActionRequiredAlerts' },
    '@/components/InventoryImportClient': { default: 'InventoryImportClient' },
    '@/lib/supabase/client': { createClient: () => client, readBrowserSession: () => Promise.resolve(userResult()) },
    '@/lib/browserId': { createBrowserId: () => 'test-tab' },
    '@/lib/workspaceRefresh': refresh,
    '@/lib/equipmentLists': lists,
    '@/lib/importantActivity': { IMPORTANT_ACTIVITY_FILTER: 'important', isImportantActivity: () => true },
    '@/lib/catalogStore': { CATALOG_CACHE_KEY: 'catalog', CATALOG_CHANGED_EVENT: 'catalog-change', readCatalog: () => Promise.resolve({ categories: [] }) },
    '@/lib/authStore': {
      getUserId: () => user, getUserRole: () => options.role ?? 'admin', getUserDepartment: () => 'video',
      canImportInventory: () => true, canCreateEquipmentLists: () => true, canCreateMaintenanceLists: () => true,
      canManageEquipmentLists: () => true, getUserName: () => user,
    },
  };
  return {
    clock, window, document, state, refresh, calls, channels, errors, lists,
    count: key => calls.filter(call => call.key === key).length,
    mount(file) { load(file, imports).default({ children: null }); for (const effect of effects.splice(0)) cleanups.push(effect()); },
    emit(table, data = {}, eventType = 'UPDATE') {
      for (const channel of channels.filter(channel => !channel.removed)) {
        for (const binding of channel.bindings) {
          if (binding.filter.table === table && ['*', eventType].includes(binding.filter.event)) {
            binding.callback({ new: data, old: data, eventType });
          }
        }
      }
    },
    signal: (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail })),
    auth(next) { user = next; for (const listener of [...authListeners]) listener(next ? 'SIGNED_IN' : 'SIGNED_OUT', userResult().data.session); },
    visible(value) { document.visibilityState = value ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); },
    cleanup() { for (const cleanup of cleanups.splice(0)) cleanup?.(); },
  };
}

test('queue collapses a burst into one read', async () => {
  const h = environment(); let count = 0;
  const q = h.refresh.createRefreshQueue(async () => { count++; });
  for (let i = 0; i < 100; i++) q.schedule();
  await h.clock.advance(249); assert.equal(count, 0);
  await h.clock.advance(1); assert.equal(count, 1);
  await h.clock.advance(5000); assert.equal(count, 1);
});

test('queue never overlaps a slow read and retains exactly one follow-up', async () => {
  const h = environment(), pending = deferred(); let count = 0, active = 0, maximum = 0;
  const q = h.refresh.createRefreshQueue(async () => {
    count++; active++; maximum = Math.max(maximum, active);
    if (count === 1) await pending.promise;
    active--;
  });
  q.request(); await h.clock.advance(0);
  for (let i = 0; i < 100; i++) q.schedule();
  await h.clock.advance(10000); assert.equal(count, 1);
  pending.resolve(); await h.clock.advance(0);
  assert.equal(count, 2); assert.equal(maximum, 1);
});

test('queue enforces the minimum start interval, including explicit requests', async () => {
  const h = environment(); const starts = [];
  const q = h.refresh.createRefreshQueue(async () => { starts.push(h.clock.time); });
  q.request(); await h.clock.advance(100); q.request();
  await h.clock.advance(899); assert.equal(starts.length, 1);
  await h.clock.advance(1); assert.equal(starts[1] - starts[0], 1000);
});

test('continuous events cannot postpone a refresh forever', async () => {
  const h = environment(); const starts = [];
  const q = h.refresh.createRefreshQueue(async () => { starts.push(h.clock.time); });
  const beginning = h.clock.time;
  for (let i = 0; i < 45; i++) { q.schedule(); await h.clock.advance(100); }
  assert.ok(starts.length >= 2);
  assert.equal(starts[0] - beginning, 2000);
});

test('hidden tabs retain changes without reading and resume once', async () => {
  const h = environment(); let count = 0; h.visible(false);
  const q = h.refresh.createRefreshQueue(async () => { count++; });
  q.request(); for (let i = 0; i < 20; i++) q.schedule();
  await h.clock.advance(10000); assert.equal(count, 0);
  h.visible(true); q.resume(); await h.clock.advance(0); assert.equal(count, 1);
});

test('dispose prevents a pending follow-up after an in-flight request completes', async () => {
  const h = environment(), pending = deferred(); let count = 0;
  const q = h.refresh.createRefreshQueue(async () => { count++; await pending.promise; });
  q.request(); await h.clock.advance(0); q.schedule(); q.dispose();
  pending.resolve(); await h.clock.advance(10000); assert.equal(count, 1);
});

test('a failed read does not poison later queued reads', async () => {
  const h = environment(); let count = 0, failures = 0;
  const q = h.refresh.createRefreshQueue(async () => { if (++count === 1) throw Error('network'); }, { onError: () => failures++ });
  q.request(); await h.clock.advance(0); q.schedule(); await h.clock.advance(1000);
  assert.equal(count, 2); assert.equal(failures, 1); assert.equal(q.isPending(), false);
});

const task = { id: 'approval:list-a', kind: 'approval', title: 'Approval required', message: 'Submitted', href: '/inventory/lists/list-a', created_at: '2026-10-26' };
const activity = { id: 'notification-a', title: 'List dispatched', message: 'Dispatched', actor_id: 'bob', created_at: '2026-10-26', link: null };

test('task RPC is single-flight during many list/maintenance changes', async () => {
  const pending = deferred(); let n = 0;
  const h = environment({ fixtures: { 'rpc:hems_action_notifications': () => ++n === 1 ? pending.promise : { data: [task], error: null } } });
  h.mount('components/ActionNotificationsProvider.tsx'); await h.clock.advance(0);
  for (let i = 0; i < 100; i++) { h.emit('equipment_lists'); h.emit('maintenance_requests'); }
  await h.clock.advance(5000); assert.equal(h.count('rpc:hems_action_notifications'), 1);
  pending.resolve({ data: [], error: null }); await h.clock.advance(0);
  assert.equal(h.count('rpc:hems_action_notifications'), 2);
  assert.equal(h.state[0][0].id, task.id);
  h.cleanup();
});

test('ordinary notifications refresh the feed without calling the task RPC', async () => {
  const h = environment(); let signals = 0;
  h.window.addEventListener(h.refresh.NOTIFICATION_FEED_EVENT, () => signals++);
  h.mount('components/ActionNotificationsProvider.tsx'); await h.clock.advance(0);
  h.emit('notifications', { message: 'List dispatched' }, 'INSERT'); await h.clock.advance(5000);
  assert.equal(signals, 1); assert.equal(h.count('rpc:hems_action_notifications'), 1);
  h.cleanup();
});

test('unchanged task results do not re-emit inbox changes', async () => {
  const h = environment({ fixtures: { 'rpc:hems_action_notifications': { data: [task], error: null } } });
  let signals = 0; h.window.addEventListener('hems:notification-inbox-change', () => signals++);
  h.mount('components/ActionNotificationsProvider.tsx'); await h.clock.advance(1000);
  const revision = h.state[1]; h.emit('equipment_lists'); await h.clock.advance(1000);
  assert.equal(h.count('rpc:hems_action_notifications'), 2);
  assert.equal(h.state[1], revision); assert.equal(signals, 1);
  h.cleanup();
});

test('sign-out discards an in-flight task result and its queued follow-up', async () => {
  const pending = deferred(); const h = environment({ fixtures: { 'rpc:hems_action_notifications': pending.promise } });
  h.mount('components/ActionNotificationsProvider.tsx'); await h.clock.advance(0);
  h.emit('equipment_lists'); h.auth(null); pending.resolve({ data: [task], error: null });
  await h.clock.advance(5000); assert.equal(h.state[0].length, 0);
  assert.equal(h.count('rpc:hems_action_notifications'), 1); h.cleanup();
});

test('switching accounts cannot publish the previous owner task result', async () => {
  const pending = deferred(); let n = 0;
  const h = environment({ fixtures: { 'rpc:hems_action_notifications': () => ++n === 1 ? pending.promise : { data: [], error: null } } });
  h.mount('components/ActionNotificationsProvider.tsx'); await h.clock.advance(0);
  h.auth('bob'); await h.clock.advance(0);
  pending.resolve({ data: [task], error: null }); await h.clock.advance(1000);
  assert.equal(h.state[0].length, 0); assert.equal(h.channels[0].removed, true); h.cleanup();
});

test('reconnecting Realtime re-reads tasks and signals both sidebar sections', async () => {
  const h = environment(); let feeds = 0, maintenance = 0;
  h.window.addEventListener(h.refresh.NOTIFICATION_FEED_EVENT, () => feeds++);
  h.window.addEventListener(h.refresh.MAINTENANCE_ALERTS_EVENT, () => maintenance++);
  h.mount('components/ActionNotificationsProvider.tsx'); await h.clock.advance(1000);
  h.channels[0].status('SUBSCRIBED'); await h.clock.advance(1000);
  assert.equal(h.count('rpc:hems_action_notifications'), 2);
  assert.equal(feeds, 1); assert.equal(maintenance, 1); h.cleanup();
});

test('activity is shown while certificate data is still pending', async () => {
  const pending = deferred(); const h = environment({ fixtures: {
    notifications: { data: [activity], error: null }, units: pending.promise,
  } });
  h.mount('components/HomeRightSidebar.tsx'); await h.clock.advance(0);
  assert.equal(h.state[1][0].id, activity.id); assert.equal(h.count('units'), 1);
  pending.resolve({ data: [], error: null }); await h.clock.advance(0); h.cleanup();
});

test('ordinary feed changes do not re-read fresh certificates or maintenance', async () => {
  const h = environment(); h.mount('components/HomeRightSidebar.tsx'); await h.clock.advance(1000);
  for (let i = 0; i < 30; i++) h.signal(h.refresh.NOTIFICATION_FEED_EVENT);
  await h.clock.advance(1000);
  assert.equal(h.count('notifications'), 2); assert.equal(h.count('units'), 1);
  assert.equal(h.count('maintenance_requests'), 1); h.cleanup();
});

test('certificate changes explicitly invalidate certificate alerts', async () => {
  const h = environment(); h.mount('components/HomeRightSidebar.tsx'); await h.clock.advance(1000);
  h.signal(h.refresh.NOTIFICATION_FEED_EVENT, { certificateChanged: true }); await h.clock.advance(1000);
  assert.equal(h.count('units'), 2); assert.equal(h.count('maintenance_requests'), 1); h.cleanup();
});

test('maintenance events refresh maintenance independently of activity/certificates', async () => {
  const h = environment(); h.mount('components/HomeRightSidebar.tsx'); await h.clock.advance(1000);
  h.signal(h.refresh.MAINTENANCE_ALERTS_EVENT); await h.clock.advance(1000);
  assert.equal(h.count('maintenance_requests'), 2); assert.equal(h.count('units'), 1);
  assert.equal(h.count('notifications'), 1); h.cleanup();
});

test('home sidebar skips tool pages and still excludes the current actor', async () => {
  const tools = environment({ pathname: '/inventory/lighting/fixtures' });
  tools.mount('components/HomeRightSidebar.tsx'); await tools.clock.advance(1000);
  assert.equal(tools.calls.length, 0); tools.cleanup();
  const home = environment({ fixtures: { notifications: { data: [activity, { ...activity, id: 'own', actor_id: 'alice' }], error: null } } });
  home.mount('components/HomeRightSidebar.tsx'); await home.clock.advance(0);
  assert.equal(home.state[1].length, 1); assert.equal(home.state[1][0].id, activity.id); home.cleanup();
});

test('head maintenance read retains the department filter', async () => {
  const h = environment({ role: 'head' }); h.mount('components/HomeRightSidebar.tsx'); await h.clock.advance(0);
  assert.ok(h.calls.find(call => call.key === 'maintenance_requests').operations
    .some(op => op[0] === 'eq' && op[1] === 'department' && op[2] === 'video'));
  h.cleanup();
});

test('equipment lists appear without waiting for create-form locations', async () => {
  const pending = deferred(); const row = { id: 'list-a', created_at: '2026-10-26' };
  const h = environment({ fixtures: { equipment_lists: { data: [row], error: null }, inventory_locations: pending.promise } });
  h.mount('components/EquipmentListsSidebar.tsx'); await h.clock.advance(0);
  assert.equal(h.state[5], false); assert.equal(h.state[8][0].id, row.id);
  assert.equal(h.count('inventory_locations'), 1);
  pending.resolve({ data: [], error: null }); await h.clock.advance(0); h.cleanup();
});

test('list refreshes collapse bursts and retain both recent and shared queries', async () => {
  const h = environment(); h.mount('components/EquipmentListsSidebar.tsx'); await h.clock.advance(1000);
  for (let i = 0; i < 100; i++) { h.emit('equipment_lists'); h.signal(h.lists.EQUIPMENT_LISTS_EVENT); }
  await h.clock.advance(1000);
  assert.equal(h.count('equipment_lists'), 4); assert.equal(h.count('inventory_locations'), 1);
  assert.ok(h.calls.some(call => call.key === 'equipment_lists' && call.operations.some(op => op[0] === 'contains' && op[1] === 'shared_with')));
  h.cleanup();
});

test('slow list loads are single-flight even with local and Realtime duplicates', async () => {
  const pending = deferred(); let n = 0;
  const h = environment({ fixtures: { equipment_lists: () => ++n <= 2 ? pending.promise : { data: [], error: null } } });
  h.mount('components/EquipmentListsSidebar.tsx'); await h.clock.advance(0);
  for (let i = 0; i < 100; i++) { h.emit('equipment_lists'); h.signal(h.lists.EQUIPMENT_LISTS_EVENT); }
  await h.clock.advance(5000); assert.equal(h.count('equipment_lists'), 2);
  pending.resolve({ data: [], error: null }); await h.clock.advance(0);
  assert.equal(h.count('equipment_lists'), 4); h.cleanup();
});

test('active draft item changes are coalesced and filters remain list-scoped', async () => {
  const h = environment({ stateOverrides: { 10: 'list-a' } });
  h.mount('components/EquipmentListsSidebar.tsx'); await h.clock.advance(1000);
  assert.equal(h.count('equipment_list_items'), 1);
  for (let i = 0; i < 100; i++) h.signal(h.lists.EQUIPMENT_LIST_ITEMS_EVENT, { listId: 'list-a' });
  await h.clock.advance(1000); assert.equal(h.count('equipment_list_items'), 2);
  h.signal(h.lists.EQUIPMENT_LIST_ITEMS_EVENT, { listId: 'some-other-list' });
  await h.clock.advance(1000); assert.equal(h.count('equipment_list_items'), 2);
  const inserts = h.channels.flatMap(channel => channel.bindings).filter(binding => binding.filter.table === 'equipment_list_items' && binding.filter.event === 'INSERT');
  assert.equal(inserts[0].filter.filter, 'list_id=eq.list-a'); h.cleanup();
});

test('hidden sidebar queues wait for visibility before requesting latest data', async () => {
  const h = environment(); h.mount('components/EquipmentListsSidebar.tsx'); await h.clock.advance(1000);
  h.visible(false); h.emit('equipment_lists'); await h.clock.advance(5000);
  assert.equal(h.count('equipment_lists'), 2);
  h.visible(true); await h.clock.advance(0); assert.equal(h.count('equipment_lists'), 4); h.cleanup();
});

test('received items show a testing task and tested items remove it', async () => {
  let tasks = [];
  const h = environment({ fixtures: { 'rpc:hems_action_notifications': () => ({ data: tasks, error: null }) } });
  h.mount('components/ActionNotificationsProvider.tsx'); await h.clock.advance(1000);
  tasks = [{ ...task, id: 'testing:repair-a', kind: 'testing', title: 'RECEIVED - TESTING REQUIRED' }];
  h.emit('maintenance_requests', { status: 'received' }); await h.clock.advance(1000);
  assert.equal(h.state[0][0].kind, 'testing');
  tasks = []; h.emit('maintenance_requests', { status: 'tested' }); await h.clock.advance(1000);
  assert.equal(h.state[0].length, 0); h.cleanup();
});

test('task errors retain the last good inbox and a later event can recover', async () => {
  let result = { data: [task], error: null };
  const h = environment({ fixtures: { 'rpc:hems_action_notifications': () => result } });
  h.mount('components/ActionNotificationsProvider.tsx'); await h.clock.advance(1000);
  result = { data: null, error: { message: 'Temporary network error' } };
  h.emit('equipment_lists'); await h.clock.advance(1000);
  assert.equal(h.state[0][0].id, task.id);
  result = { data: [], error: null }; h.emit('equipment_lists'); await h.clock.advance(1000);
  assert.equal(h.state[0].length, 0); h.cleanup();
});

test('hidden task inbox refreshes once on return and retains live events', async () => {
  let tasks = [];
  const h = environment({ fixtures: { 'rpc:hems_action_notifications': () => ({ data: tasks, error: null }) } });
  h.mount('components/ActionNotificationsProvider.tsx'); await h.clock.advance(1000);
  h.visible(false); tasks = [task];
  for (let i = 0; i < 100; i++) h.emit('equipment_lists');
  await h.clock.advance(10000); assert.equal(h.count('rpc:hems_action_notifications'), 1);
  h.visible(true); await h.clock.advance(0);
  assert.equal(h.count('rpc:hems_action_notifications'), 2); assert.equal(h.state[0][0].id, task.id); h.cleanup();
});

test('certificate metadata still resolves the inventory report link', async () => {
  const h = environment({ fixtures: {
    units: { data: [{ id: 'unit-a', item_id: 'item-a', unit_no: 1, serial: 'SN1', expiry_date: '2026-10-29' }], error: null },
    items: { data: [{ id: 'item-a', name: 'Chain hoist', subcategory_id: 'sub-a' }], error: null },
    subcategories: { data: [{ id: 'sub-a', slug: 'chain-hoists', category_id: 'cat-a' }], error: null },
    categories: { data: [{ id: 'cat-a', slug: 'truss-and-rigging' }], error: null },
  } });
  h.mount('components/HomeRightSidebar.tsx'); await h.clock.advance(0);
  assert.equal(h.state[0][0].kind, 'certificate');
  assert.equal(h.state[0][0].href, '/inventory/truss-and-rigging/chain-hoists/item-a'); h.cleanup();
});

test('a feed error leaves the previous activity visible', async () => {
  let result = { data: [activity], error: null };
  const h = environment({ fixtures: { notifications: () => result } });
  h.mount('components/HomeRightSidebar.tsx'); await h.clock.advance(1000);
  result = { data: null, error: { message: 'Offline cache unavailable' } };
  h.signal(h.refresh.NOTIFICATION_FEED_EVENT); await h.clock.advance(1000);
  assert.equal(h.state[1][0].id, activity.id); h.cleanup();
});

test('unmounting cancels pending sidebar jobs before they start', async () => {
  const h = environment(); h.mount('components/EquipmentListsSidebar.tsx'); h.cleanup();
  await h.clock.advance(10000); assert.equal(h.calls.length, 0);
});

// Local read/render/lifecycle tests. No production access or real stock writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const source = read('lib/useChainHoistAllocations.ts');
const inventory = read('components/SubcategoryClientChainHoist.tsx');
function compile(code, imports = {}, globals = {}) {
  const exports = {};
  const js = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(js, { exports, ...globals, require: name => imports[name] ?? require(name) });
  return exports;
}
const listApi = compile(read('lib/equipmentLists.ts'));
const normalize = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const event = (patch = {}) => ({ id: 'event-a', reference: 'EV-2026-0011', list_type: 'local_event', status: 'active',
  event_name: 'Book Fair Event', venue: 'Expo Sharjah', client_company: null,
  from_location_name: null, destination_name: null, purpose: null, assigned_to: null, ...patch });
const line = (patch = {}) => ({ id: 'line-a', list_id: 'event-a', parent_record_id: 'hoist-a', inventory_record_id: 'serial-a',
  inventory_record_type: 'unit', requested_quantity: 1, approved_quantity: 1,
  returned_ok_quantity: 0, returned_maintenance_quantity: 0, ...patch });
function fakeClient(lists = [event()], lines = [line()], options = {}) {
  const calls = [];
  const client = { from(table) {
    const call = { table, filters: [] }; calls.push(call);
    const query = {
      select(fields) { call.fields = fields; return query; },
      in(field, values) { call.filters.push(['in', field, Array.from(values)]); return query; },
      eq(field, value) { call.filters.push(['eq', field, value]); return query; },
      order(field, value) { call.order = [field, normalize(value)]; return query; },
      async range(from, to) {
        call.range = [from, to];
        const rows = (table === 'equipment_lists' ? lists : lines).filter(row => call.filters.every(([kind, field, value]) =>
          kind === 'in' ? value.includes(row[field]) : value === row[field])).sort((a, b) => a.id.localeCompare(b.id));
        const page = rows.slice(from, to + 1).map(row => ({ ...row }));
        if (calls.indexOf(call) === options.blockAt) await options.gate.promise;
        if (calls.indexOf(call) === options.failAt) return { data: null, error: { message: 'Fixture timeout' } };
        return { data: page, error: null };
      },
    };
    return query;
  } };
  return { client, calls };
}
function loadApi(client = {}, imports = {}, globals = {}) {
  return compile(source, {
    react: React, '@/lib/supabase/client': { createClient: () => client },
    '@/lib/authStore': { getUserId: () => 'user-a' }, '@/lib/equipmentLists': listApi,
    '@/lib/workspaceRefresh': compile(read('lib/workspaceRefresh.ts')), ...imports,
  }, globals);
}
const api = loadApi();
test('local event names its actual venue, with event-name fallback only when venue is absent', () => {
  assert.equal(api.chainHoistAllocationLabel(event()), 'In Expo Sharjah');
  assert.equal(api.chainHoistAllocationLabel(event({ venue: '  ' })), 'In Book Fair Event');
  assert.equal(api.chainHoistAllocationLabel(event({ venue: null, event_name: null })), 'In Local Event');
});
test('Dry Hire names the company; transfers name the destination; Internal Use retains its purpose', () => {
  assert.equal(api.chainHoistAllocationLabel(event({ list_type: 'dry_hire', client_company: ' Eventum ' })), 'Dry Hire · Eventum');
  assert.equal(api.chainHoistAllocationLabel(event({ list_type: 'transfer_out', destination_name: 'KSA' })), 'In KSA');
  assert.equal(api.chainHoistAllocationLabel(event({ list_type: 'internal_use', purpose: 'Workshop', assigned_to: 'Video' })), 'Internal Use · Workshop · Video');
});
test('groups serials by model and active list; retains separate venues and companies', () => {
  const lists = [event(), event({ id: 'event-b', venue: 'Coca-Cola Arena' }),
    event({ id: 'hire-a', list_type: 'dry_hire', client_company: 'Eventum' }),
    event({ id: 'hire-b', list_type: 'dry_hire', client_company: 'Partner B' })];
  const rows = [line(), line({ id: 'line-b', inventory_record_id: 'serial-b' }),
    line({ id: 'line-c', list_id: 'event-b', inventory_record_id: 'serial-c' }),
    line({ id: 'line-d', list_id: 'hire-a', inventory_record_id: 'serial-d' }),
    line({ id: 'line-e', list_id: 'hire-b', parent_record_id: 'hoist-b', inventory_record_id: 'serial-e' })];
  const grouped = normalize(api.groupChainHoistAllocations(lists, rows, ['hoist-a', 'hoist-b']));
  assert.equal(grouped['hoist-a'].length, 3);
  assert.equal(grouped['hoist-a'].find(row => row.listId === 'event-a').quantity, 2);
  assert.equal(grouped['hoist-b'][0].label, 'Dry Hire · Partner B');
  assert.match(grouped['hoist-a'].find(row => row.listId === 'event-a').title, /EV-2026-0011 · Book Fair Event · Expo Sharjah/);
});
test('partial returns deduct both OK and Failed returns, never the original full quantity', () => {
  const result = normalize(api.groupChainHoistAllocations([event({ status: 'partially_returned' })], [
    line({ approved_quantity: 4, requested_quantity: 4, returned_ok_quantity: 1, returned_maintenance_quantity: 1 }),
  ], ['hoist-a']));
  assert.equal(result['hoist-a'][0].quantity, 2);
  assert.equal(result['hoist-a'][0].status, 'partially_returned');
});
test('fully returned and over-returned serials disappear from movement badges', () => {
  for (const returned_ok_quantity of [1, 2]) {
    assert.deepEqual(normalize(api.groupChainHoistAllocations([event()], [line({ returned_ok_quantity })], ['hoist-a'])), {});
  }
});
test('does not display pending/draft/closed/cancelled or duplicate Maintenance and Transfer In movements', () => {
  for (const status of ['draft', 'pending', 'closed', 'cancelled']) {
    assert.deepEqual(normalize(api.groupChainHoistAllocations([event({ status })], [line()], ['hoist-a'])), {});
  }
  for (const list_type of ['maintenance', 'transfer_in']) {
    assert.deepEqual(normalize(api.groupChainHoistAllocations([event({ list_type })], [line()], ['hoist-a'])), {});
  }
});
test('duplicate active serial rows count once, while a returned old row cannot hide a current outstanding row', () => {
  const rows = [line({ returned_ok_quantity: 1 }), line({ id: 'line-b' }), line({ id: 'line-c' })];
  const result = normalize(api.groupChainHoistAllocations([event()], rows, ['hoist-a']));
  assert.equal(result['hoist-a'][0].quantity, 1);
});
test('invalid/non-unit/foreign-model records cannot create location badges', () => {
  const rows = [line({ parent_record_id: 'unrelated' }), line({ inventory_record_type: 'matrix_model' }),
    line({ parent_record_id: null }), line({ inventory_record_id: '' }), line({ approved_quantity: 0, requested_quantity: 0 })];
  assert.deepEqual(normalize(api.groupChainHoistAllocations([event()], rows, ['hoist-a'])), {});
});
test('legacy dispatched quantity fallback matches the existing report movement calculation', () => {
  const result = normalize(api.groupChainHoistAllocations([event()], [line({ approved_quantity: 0, requested_quantity: 1 })], ['hoist-a']));
  assert.equal(result['hoist-a'][0].quantity, 1);
});
test('one ordinary page uses two read-only requests, not a request for every model', async () => {
  const h = fakeClient();
  const result = await api.readChainHoistAllocations(h.client, ['hoist-a', 'hoist-b', 'hoist-a']);
  assert.equal(result['hoist-a'][0].quantity, 1);
  assert.deepEqual(h.calls.map(call => call.table), ['equipment_lists', 'equipment_list_items']);
  assert.deepEqual(h.calls[0].filters, [['in', 'status', ['active', 'partially_returned']],
    ['in', 'list_type', ['local_event', 'dry_hire', 'transfer_out', 'internal_use']]]);
  assert.deepEqual(h.calls[1].filters[0], ['eq', 'inventory_record_type', 'unit']);
  assert.deepEqual(h.calls[1].filters[1], ['in', 'parent_record_id', ['hoist-a', 'hoist-b']]);
  for (const call of h.calls) {
    assert.deepEqual(call.order, ['id', { ascending: true }]);
    assert.ok(!call.fields.includes('avatar') && !call.fields.includes('*'));
  }
  assert.doesNotMatch(source, /\.(?:update|insert|delete|upsert|rpc|channel)\(/);
});
test('empty inventory and no eligible active lists avoid unnecessary item requests', async () => {
  const h = fakeClient([], []);
  assert.deepEqual(normalize(await api.readChainHoistAllocations(h.client, [])), {});
  assert.equal(h.calls.length, 0);
  assert.deepEqual(normalize(await api.readChainHoistAllocations(h.client, ['hoist-a'])), {});
  assert.equal(h.calls.length, 1);
});
test('all serial allocation pages are loaded beyond the API 1000-row limit', async () => {
  const rows = Array.from({ length: 1001 }, (_, index) => line({ id: `line-${String(index).padStart(4, '0')}`, inventory_record_id: `serial-${index}` }));
  const h = fakeClient([event()], rows);
  const result = await api.readChainHoistAllocations(h.client, ['hoist-a']);
  assert.equal(result['hoist-a'][0].quantity, 1001);
  assert.deepEqual(h.calls.slice(1).map(call => call.range), [[0, 999], [1000, 1999]]);
});
test('active lists are paginated without a recent-200 cutoff, and ID filters stay bounded', async () => {
  const lists = Array.from({ length: 1001 }, (_, index) => event({ id: `event-${String(index).padStart(4, '0')}` }));
  const rows = lists.map((list, index) => line({ id: `line-${index}`, list_id: list.id, inventory_record_id: `serial-${index}` }));
  const h = fakeClient(lists, rows);
  const result = await api.readChainHoistAllocations(h.client, ['hoist-a']);
  assert.equal(result['hoist-a'].length, 1001);
  assert.equal(h.calls.filter(call => call.table === 'equipment_lists').length, 2);
  for (const call of h.calls.filter(call => call.table === 'equipment_list_items')) {
    for (const [kind, , value] of call.filters) if (kind === 'in') assert.ok(value.length <= 80);
  }
});
test('a failed allocation page is an error, never a false successful empty location result', async () => {
  for (const failAt of [0, 1]) {
    const h = fakeClient([event()], [line()], { failAt });
    await assert.rejects(api.readChainHoistAllocations(h.client, ['hoist-a']), error => error.message === 'Fixture timeout');
  }
});
test('a stale owner/revision stops remaining batches and cannot publish partial results', async () => {
  let current = true;
  const gate = deferred(), h = fakeClient([event()], [line()], { blockAt: 0, gate });
  const promise = api.readChainHoistAllocations(h.client, ['hoist-a'], () => current);
  await settle(); current = false; gate.resolve();
  assert.equal(await promise, null);
  assert.equal(h.calls.length, 1);
});

const pageAst = ts.createSourceFile('page.tsx', inventory, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const heading = pageAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ChainHoistMovementLinks');
const Link = props => React.createElement('a', props, props.children);
const Links = compile(heading.getText(pageAst) + '\nexports.Links=ChainHoistMovementLinks;', {}, { Link }).Links;
test('named blue badges open each exact list and are not nested inside the model action button', () => {
  const allocations = normalize(api.groupChainHoistAllocations([event(), event({ id: 'hire / a', list_type: 'dry_hire', client_company: 'Eventum' })],
    [line(), line({ id: 'line-b', list_id: 'hire / a', inventory_record_id: 'serial-b' })], ['hoist-a']))['hoist-a'];
  const html = renderToStaticMarkup(React.createElement(Links, { allocations }));
  assert.ok(html.includes('1 pcs · In Expo Sharjah'));
  assert.ok(html.includes('1 pcs · Dry Hire · Eventum'));
  assert.ok(html.includes('href="/inventory/lists/event-a"'));
  assert.ok(html.includes('href="/inventory/lists/hire%20%2F%20a"'));
  assert.ok(html.includes('bg-blue-100'));
  assert.doesNotMatch(html, /In Use|Existing movement|<button/);
  assert.match(inventory, /<\/button>\s*<ChainHoistMovementLinks allocations=\{allocationsByItem\[it\.id\]/);
});
test('badge clicks stop the parent selection action; names wrap and remain escaped', () => {
  let stopped = false;
  const tree = Links({ allocations: [{ listId: 'a', title: 'Name', label: '<img src=x>', quantity: 2, status: 'active' }] });
  tree.props.children[0].props.onClick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /break-words/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img|truncate/);
  assert.equal(Links({ allocations: [] }), null);
});
test('existing KSA link, repair badges and Failed/Expired stock counters remain independent', () => {
  assert.match(inventory, /<KsaStockLink quantity=\{st\.inKsa\} search=\{it\.name\}/);
  assert.match(inventory, /<MaintenanceRepairBadge itemId=\{it\.id\}/);
  assert.match(inventory, /label="Failed"/);
  assert.match(inventory, /st\.expired > 0/);
  assert.doesNotMatch(inventory, /label="In Use Qty"/);
  assert.match(inventory, /<button type="button" onClick=\{retryAllocations\}/);
});

class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } }
function hookHarness(options = {}) {
  let now = 100000, sequence = 0, owner = 'user-a', authCallback, unsubscribe = 0, snapshot;
  const timers = new Map(), snapshots = [], effects = [];
  const window = new EventTarget(), document = new EventTarget(); document.visibilityState = options.hidden ? 'hidden' : 'visible';
  class FakeDate extends Date { static now() { return now; } }
  const globals = { window, document, Date: FakeDate, console: { error() {} },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  const lists = options.lists || [event()], lines = options.lines || [line()];
  const h = fakeClient(lists, lines, options);
  h.client.auth = { onAuthStateChange(callback) { authCallback = callback; return { data: { subscription: { unsubscribe() { unsubscribe++; } } } }; } };
  const react = { useMemo: fn => fn(), useCallback: fn => fn, useRef: value => ({ current: value }),
    useEffect: fn => effects.push(fn), useState: initial => {
      snapshot = initial;
      return [initial, update => { snapshot = typeof update === 'function' ? update(snapshot) : update; snapshots.push(normalize(snapshot)); }];
    } };
  const queueApi = compile(read('lib/workspaceRefresh.ts'), {}, globals);
  const hookApi = loadApi(h.client, { react, '@/lib/authStore': { getUserId: () => owner }, '@/lib/workspaceRefresh': queueApi }, globals);
  const result = hookApi.useChainHoistAllocations(options.itemIds || ['hoist-a']);
  const cleanup = effects[0]();
  return { ...h, lists, lines, result, snapshots, window, document,
    get snapshot() { return snapshot; }, get unsubscribe() { return unsubscribe; },
    dispose() { cleanup?.(); },
    signal(type = listApi.EQUIPMENT_LISTS_EVENT, status) { window.dispatchEvent(new CustomEvent(type, { detail: { status } })); },
    auth(next) { owner = next; authCallback(next ? 'SIGNED_IN' : 'SIGNED_OUT', next ? { user: { id: next } } : null); },
    async tick(ms = 0) {
      const end = now + ms;
      for (let count = 0; count < 1000; count++) {
        await settle();
        const next = [...timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = end; await settle(); return; }
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      throw new Error('Timer overflow');
    },
  };
}
test('bursts of list and item events coalesce; draft/pending edits do not add reads', async () => {
  const h = hookHarness(); await h.tick(); assert.equal(h.calls.length, 2);
  h.signal(undefined, 'draft'); h.signal(undefined, 'pending'); await h.tick(5000); assert.equal(h.calls.length, 2);
  for (let i = 0; i < 100; i++) h.signal(i % 2 ? listApi.EQUIPMENT_LISTS_EVENT : listApi.EQUIPMENT_LIST_ITEMS_EVENT, 'active');
  await h.tick(1000); assert.equal(h.calls.length, 4);
  h.dispose();
});
test('a slow batch stays single-flight and one follow-up publishes latest locations', async () => {
  const gate = deferred(), h = hookHarness({ blockAt: 0, gate });
  await h.tick(); assert.equal(h.calls.length, 1);
  for (let i = 0; i < 50; i++) h.signal(); await h.tick(5000); assert.equal(h.calls.length, 1);
  h.lists[0].venue = 'New Venue'; gate.resolve(); await h.tick(1000);
  assert.equal(h.snapshot.byItem['hoist-a'][0].label, 'In New Venue');
  assert.ok(!h.snapshots.some(s => s.byItem['hoist-a']?.some(row => row.label === 'In Expo Sharjah')));
  h.dispose();
});
test('hidden tabs defer location reads and wake without refreshing the whole page', async () => {
  const h = hookHarness({ hidden: true }); await h.tick(5000); assert.equal(h.calls.length, 0);
  h.document.visibilityState = 'visible'; h.document.dispatchEvent(new Event('visibilitychange')); await h.tick();
  assert.equal(h.calls.length, 2); h.dispose();
});
test('fresh focus does not reload; stale focus refreshes only the location batch', async () => {
  const h = hookHarness(); await h.tick(); h.window.dispatchEvent(new Event('focus')); await h.tick(1000);
  assert.equal(h.calls.length, 2);
  await h.tick(30000); h.window.dispatchEvent(new Event('focus')); await h.tick(); assert.equal(h.calls.length, 4);
  h.dispose();
});
test('failed refresh retains last good locations and Retry can recover', async () => {
  const options = {}, h = hookHarness(options); await h.tick();
  options.failAt = 2; h.signal(); await h.tick(1000);
  assert.equal(h.snapshot.byItem['hoist-a'][0].label, 'In Expo Sharjah');
  assert.ok(h.snapshot.error);
  delete options.failAt; h.result.retry(); await h.tick(1000);
  assert.equal(h.snapshot.error, ''); h.dispose();
});
test('sign-out discards an in-flight private result; token refresh does not reload the batch', async () => {
  const gate = deferred(), h = hookHarness({ blockAt: 0, gate }); await h.tick();
  h.auth(null); gate.resolve(); await h.tick(1000);
  assert.deepEqual(normalize(h.snapshot.byItem), {});
  assert.equal(h.snapshot.owner, null); assert.equal(h.calls.length, 1); h.dispose();
  const same = hookHarness(); await same.tick(); same.auth('user-a'); await same.tick(5000);
  assert.equal(same.calls.length, 2); same.dispose();
});
test('account change and unmount cannot publish results from a previous owner/page', async () => {
  const gate = deferred(), h = hookHarness({ blockAt: 0, gate }); await h.tick();
  h.auth('user-b'); h.lists[0].venue = 'Next Owner Venue'; gate.resolve(); await h.tick(1000);
  assert.equal(h.snapshot.owner, 'user-b');
  assert.equal(h.snapshot.byItem['hoist-a'][0].label, 'In Next Owner Venue'); h.dispose();
  const blocked = deferred(), old = hookHarness({ blockAt: 0, gate: blocked }); await old.tick();
  old.dispose(); const before = old.snapshots.length; blocked.resolve(); await old.tick(5000);
  assert.equal(old.snapshots.length, before); assert.equal(old.unsubscribe, 1);
});

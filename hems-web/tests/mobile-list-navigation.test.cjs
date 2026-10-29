// Real extracted UI handlers + rendered dock markup, with mocked browser/auth.
// No network, Supabase mutation, real equipment or production deployment.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const icons = require('lucide-react');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function compile(code, globals = {}, imports = {}) {
  const exports = {};
  const output = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(output, { exports, ...globals, require: name => imports[name] ?? require(name) });
  return exports;
}
function find(source, predicate) {
  const ast = ts.createSourceFile('fixture.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function walk(node) { if (!found && predicate(node)) found = node; ts.forEachChild(node, walk); }
  walk(ast); assert.ok(found, 'Production fixture not found'); return found;
}
function functionText(source, name) {
  return find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText();
}
const listApi = compile(read('lib/equipmentLists.ts'));
const pickingApi = compile(read('lib/inventoryPickingMode.ts'));
const layoutApi = compile(read('lib/appLayout.ts'));
const sidebarSource = read('components/EquipmentListsSidebar.tsx');
const detailsSource = read('components/EquipmentListDetailsClient.tsx');
const topbarSource = read('components/TopBar.tsx');
const dockSource = read('components/MobileDraftDock.tsx');
class CustomEvent extends Event { constructor(type, options = {}) { super(type); this.detail = options.detail; } }
function browser(initial = 'previous-list', storageError = false) {
  const values = new Map(initial ? [[listApi.ACTIVE_EQUIPMENT_LIST_KEY, initial]] : []);
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (storageError) throw new Error('Storage unavailable'); values.set(key, value); },
    removeItem(key) { if (storageError) throw new Error('Storage unavailable'); values.delete(key); },
  };
  const window = new EventTarget(); window.location = { href: '/inventory' };
  const events = [], routes = [];
  window.addEventListener(listApi.ACTIVE_EQUIPMENT_LIST_EVENT, event => events.push(event.detail));
  return { values, localStorage, window, events, routes, router: { push: href => routes.push(href) } };
}
function navigation(layout = 'compact', options = {}) {
  const b = options.browser || browser(options.selected, options.storageError);
  const changes = [];
  let drawerOpen = true;
  // The actual TopBar callback is wired to the existing active-list event.
  const closeNode = find(topbarSource, node => ts.isVariableDeclaration(node) && node.name.getText() === 'closeAfterListSelection');
  const close = compile(`exports.close=${closeNode.initializer.getText()};`, { setSidebarOpen: value => { drawerOpen = value; } }).close;
  b.window.addEventListener(listApi.ACTIVE_EQUIPMENT_LIST_EVENT, close);
  const api = compile(['clearActiveList', 'handleListLinkClick', 'chooseActiveList'].map(name => functionText(sidebarSource, name)).join('\n') +
    '\nexports.choose=chooseActiveList;exports.clear=clearActiveList;exports.link=handleListLinkClick;', {
    ...listApi, CustomEvent, ...b, getAppLayout: () => layout,
    setActiveListId: value => changes.push(value), activeListId: options.selected || null,
    canEditWorkingList: () => options.editable !== false,
  });
  return { ...b, ...api, changes, get drawerOpen() { return drawerOpen; } };
}
const fixture = (extra = {}) => ({ id: 'list-a', reference: 'EV-2026-0008', list_type: 'local_event', status: 'draft',
  created_by: 'alice', event_name: 'Test Event', venue: 'Dubai', ...extra });
for (const [status, editable] of [['draft', true], ['pending', true], ['active', true], ['partially_returned', true], ['active', false]]) {
  test(`compact ${status}, editable=${editable}: open full List and close drawer without activating Inventory picking`, () => {
    const h = navigation('compact', { editable });
    h.choose(fixture({ status }));
    assert.deepEqual(h.routes, ['/inventory/lists/list-a']);
    assert.equal(h.localStorage.getItem(listApi.ACTIVE_EQUIPMENT_LIST_KEY), null);
    assert.deepEqual(h.changes, [null]);
    assert.equal(h.events[0].listId, null);
    assert.equal(h.drawerOpen, false);
    assert.equal(h.window.location.href, '/inventory'); // no full-page reload
  });
}
test('opening the same List again closes the drawer rather than toggling a picking selection', () => {
  const h = navigation('compact', { selected: 'list-a' }); h.choose(fixture());
  assert.equal(h.drawerOpen, false); assert.equal(h.routes[0], '/inventory/lists/list-a');
  assert.equal(h.events[0].listId, null);
});
test('compact navigation remains usable when selection storage cannot be cleared', () => {
  const h = navigation('compact', { storageError: true }); h.choose(fixture());
  assert.equal(h.routes[0], '/inventory/lists/list-a'); assert.equal(h.drawerOpen, false);
});
test('desktop selection and deselection retain their prior behavior', () => {
  const select = navigation('desktop'); select.choose(fixture());
  assert.equal(select.routes.length, 0);
  assert.equal(select.localStorage.getItem(listApi.ACTIVE_EQUIPMENT_LIST_KEY), 'list-a');
  assert.equal(select.events[0].listId, 'list-a');
  const unselect = navigation('desktop', { selected: 'list-a' }); unselect.choose(fixture());
  assert.equal(unselect.routes.length, 0);
  assert.equal(unselect.localStorage.getItem(listApi.ACTIVE_EQUIPMENT_LIST_KEY), null);
});
test('desktop read-only List opening is not changed by the compact branch', () => {
  const h = navigation('desktop', { editable: false }); h.choose(fixture({ status: 'active' }));
  assert.equal(h.window.location.href, '/inventory/lists/list-a');
  assert.equal(h.events.length, 0);
});
test('Open List, Transfer Out and Maintenance links also clear compact picking context', () => {
  assert.equal((sidebarSource.match(/onClick=\{handleListLinkClick\}/g) || []).length, 3);
  const compact = navigation('compact'); compact.link();
  assert.equal(compact.localStorage.getItem(listApi.ACTIVE_EQUIPMENT_LIST_KEY), null);
  assert.equal(compact.drawerOpen, false);
  const desktop = navigation('desktop'); desktop.link(); assert.equal(desktop.events.length, 0);
});
test('Collapse current list only clears UI selection; it does not navigate or delete data', () => {
  const h = navigation('compact'); h.clear(); assert.equal(h.routes.length, 0);
  assert.equal(h.localStorage.getItem(listApi.ACTIVE_EQUIPMENT_LIST_KEY), null);
  assert.match(sidebarSource, /onClick=\{clearActiveList\}\s+title="Collapse current list"/);
  assert.doesNotMatch(functionText(sidebarSource, 'clearActiveList'), /\.from\(|\.rpc\(|delete\(/);
});
const Link = props => React.createElement('a', props);
function dock(options = {}) {
  const b = options.browser || browser(options.list === null ? null : 'list-a');
  const state = [options.enabled !== false, options.signedIn !== false,
    options.list === undefined ? fixture() : options.list, 3, options.toast || '', Boolean(options.keyboard)];
  let cursor = 0;
  const pickingChanges = [];
  const react = { ...React, useState(initial) {
    const index = cursor++; return [state[index] === undefined ? initial : state[index], value => { state[index] = value; }];
  }, useMemo: fn => fn(), useRef: initial => ({ current: initial }), useEffect() {} };
  const Component = compile(dockSource, { ...b, CustomEvent }, {
    react, 'next/link': { default: Link }, 'next/navigation': { usePathname: () => options.pathname || '/inventory' },
    'lucide-react': icons, '@/lib/useAppLayout': { useAppLayout: () => options.layout || 'compact' },
    '@/lib/browserId': { createBrowserId: () => 'test-tab' },
    '@/lib/inventoryPickingMode': { ...pickingApi, setInventoryPickingMode: value => pickingChanges.push(value) },
    '@/lib/workspaceStartup': { readWorkingDraft() { throw new Error('Unexpected network read'); } },
    '@/lib/supabase/client': { createClient: () => ({}), readBrowserSession() { throw new Error('Unexpected auth read'); } },
    '@/lib/authStore': { canManageEquipmentLists: () => false }, '@/lib/equipmentLists': listApi,
  }).default;
  const tree = Component();
  return { ...b, state, pickingChanges, tree, html: tree ? renderToStaticMarkup(tree) : '' };
}
function collect(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) { node.forEach(child => collect(child, predicate, result)); return result; }
  if (predicate(node)) result.push(node);
  collect(node.props?.children, predicate, result); return result;
}
for (const pathname of ['/', '/inventory/lists/list-a', '/inventory/lighting/fixtures/unit-a', '/inventory/video/screens/led-report/row-a', '/settings']) {
  test(`${pathname}: bottom navigation stays visible without an extra View/Choose row`, () => {
    const h = dock({ pathname, toast: 'List updated' });
    assert.ok(h.html.includes('aria-label="Mobile navigation"'));
    assert.ok(h.html.includes('>Home</a>')); assert.ok(h.html.includes('>Inventory</a>')); assert.ok(h.html.includes('>Lists</button>'));
    assert.ok(!h.html.includes('data-hems-picking-summary'));
    assert.ok(!h.html.includes('>View</span>'));
    assert.ok(!h.html.includes('Choose a draft'));
    assert.ok(!h.html.includes('role="status"'));
  });
}
test('Inventory with no selected List has only the navigation bar', () => {
  const h = dock({ list: null }); assert.ok(h.html.includes('Mobile navigation'));
  assert.ok(!h.html.includes('Choose a draft')); assert.ok(!h.html.includes('data-hems-picking-summary'));
});
for (const pathname of ['/inventory', '/inventory/lighting/lighting-fixtures', '/inventory/ksa']) {
  test(`${pathname}: picking displays the selected List summary directly above navigation`, () => {
    const h = dock({ pathname, toast: 'List updated' });
    assert.ok(h.html.includes('data-hems-picking-summary'));
    assert.ok(h.html.includes('EV-2026-0008'));
    assert.ok(h.html.includes('3 item lines'));
    assert.ok(h.html.includes('href="/inventory/lists/list-a"'));
    assert.ok(h.html.includes('>View</span>'));
    assert.ok(h.html.indexOf('data-hems-picking-summary') < h.html.indexOf('aria-label="Mobile navigation"'));
  });
}
for (const [label, options] of [['desktop', { layout: 'desktop' }], ['classic layout', { enabled: false }],
  ['login', { pathname: '/login' }], ['signed out', { signedIn: false }], ['keyboard open', { keyboard: true }]]) {
  test(`${label}: existing dock visibility guards are preserved`, () => assert.equal(dock(options).tree, null));
}
test('Done ends picking without deleting any List or item', () => {
  const h = dock(); const done = collect(h.tree, node => node.props?.['aria-label'] === 'Finish adding items')[0];
  assert.ok(done); done.props.onClick();
  assert.equal(h.localStorage.getItem(listApi.ACTIVE_EQUIPMENT_LIST_KEY), null);
  assert.equal(h.events[0].listId, null);
  assert.deepEqual(h.pickingChanges, [false]); assert.equal(h.state[2], null);
});
test('Lists tab continues to open the existing drawer', () => {
  const h = dock({ pathname: '/', list: null }); let opened = 0;
  h.window.addEventListener('hems:open-mobile-lists', () => opened++);
  const listsButton = collect(h.tree, node => node.type === 'button')[0];
  listsButton.props.onClick(); assert.equal(opened, 1);
});
function addItems(label, b, list) {
  const node = find(detailsSource, node => ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'button' && node.getText().includes(label));
  const attr = node.openingElement.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.text === 'onClick');
  return compile(`exports.add=${attr.initializer.expression.getText()};`, { ...listApi, ...b, list, CustomEvent }).add;
}
for (const label of ['Add equipment', 'Add items']) {
  test(`${label}: full List -> Inventory picking -> View full List has the intended UI state`, () => {
    const b = browser(), list = fixture({ status: label === 'Add items' ? 'active' : 'draft' });
    const nav = navigation('compact', { browser: b }); nav.choose(list);
    assert.equal(b.localStorage.getItem(listApi.ACTIVE_EQUIPMENT_LIST_KEY), null);
    assert.ok(!dock({ browser: b, pathname: '/inventory/lists/list-a', list: null }).html.includes('data-hems-picking-summary'));
    addItems(label, b, list)();
    assert.equal(b.localStorage.getItem(listApi.ACTIVE_EQUIPMENT_LIST_KEY), 'list-a');
    assert.equal(b.routes.at(-1), '/inventory');
    assert.equal(b.events.at(-1).listId, 'list-a');
    const picking = dock({ browser: b, list, pathname: '/inventory' });
    assert.ok(picking.html.includes('data-hems-picking-summary'));
    const view = collect(picking.tree, node => node.props?.href === '/inventory/lists/list-a')[0];
    assert.ok(view);
    assert.ok(!dock({ browser: b, list, pathname: view.props.href }).html.includes('data-hems-picking-summary'));
  });
}
test('compact/desktop choice follows the existing iPhone, mini iPad and iPad Pro breakpoints', () => {
  assert.equal(layoutApi.selectAppLayout(393, 393, 852, 5), 'compact');
  assert.equal(layoutApi.selectAppLayout(852, 393, 852, 5), 'compact');
  assert.equal(layoutApi.selectAppLayout(768, 768, 1024, 5), 'compact');
  assert.equal(layoutApi.selectAppLayout(1024, 1024, 1366, 5), 'desktop');
  assert.equal(layoutApi.selectAppLayout(1440, 1440, 900, 0), 'desktop');
});
test('extra mobile footer space is reserved only while picking; desktop CSS is untouched', () => {
  const css = read('app/globals.css');
  assert.match(css, /padding: 12px 10px calc\(88px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\[data-hems-mobile="new"\]\[data-hems-inventory-picking="true"\] \[data-hems-main\] \{\s+padding-bottom: calc\(150px/);
  assert.match(css, /html\[data-hems-layout="compact"\]\[data-hems-mobile="new"\]\[data-hems-inventory-picking="true"\][^}]+bottom: calc\(124px/);
});

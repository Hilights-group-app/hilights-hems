// Real inventory aggregation and JSX tests with local fixtures only.
// No database writes, production requests or dispatched stock changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'components/SubcategoryClientChainHoist.tsx'), 'utf8');
const ast = ts.createSourceFile('inventory.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let found;
  function walk(node) { if (!found && predicate(node)) found = node; ts.forEachChild(node, walk); }
  walk(ast);
  assert.ok(found, 'Expected production inventory fixture');
  return found.getText(ast);
}
const functionText = name => find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
const element = className => find(node => ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attr =>
  ts.isJsxAttribute(attr) && attr.name.text === 'className' && ts.isStringLiteral(attr.initializer) && attr.initializer.text === className));
function compile(code, globals = {}) {
  const exports = {};
  const js = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(js, { exports, ...globals, require });
  return exports;
}
const mobile = element('mt-2 hems-wide:hidden');
const desktop = element('mt-1 hidden hems-wide:block');
function render(code, st) {
  const Fixture = compile(`${functionText('StatPill')}\nexport default function Fixture(){return (${code});}`, { st }).default;
  return renderToStaticMarkup(React.createElement(Fixture));
}
const numbers = html => Array.from(html.matchAll(/<div class="rounded-md [^"]*">(\d+)<\/div>/g), match => Number(match[1]));
for (const inUse of [0, 7]) for (const maintenance of [0, 4]) for (const expired of [0, 3]) {
  test(`mobile keeps stock columns aligned without a generic In Use column, inUse=${inUse}, failed=${maintenance}, expired=${expired}`, () => {
    const stats = { total: 40, available: 19, inUse, maintenance, expired };
    const html = render(mobile, stats);
    const expected = [stats.total, stats.available,
      ...(maintenance > 0 ? [maintenance] : []), ...(expired > 0 ? [expired] : [])];
    assert.match(html, new RegExp(`grid-cols-${expected.length}`));
    assert.deepEqual(numbers(html), expected);
    assert.equal(html.includes('In Use'), false);
    assert.equal(html.includes('Failed'), maintenance > 0);
    assert.equal(html.includes('Expired'), expired > 0);
    assert.doesNotMatch(html, /Maintenance/);
  });
}
for (const inUse of [0, 7]) {
  test(`desktop leaves movements to the named location links, inUse=${inUse}`, () => {
    const html = render(desktop, { total: 40, available: 19, inUse, maintenance: 4, expired: 0 });
    assert.equal(html.includes('In Use Qty:'), false);
    assert.ok(html.includes('Available Qty: 19'));
    assert.ok(html.includes('Failed: 4'));
    assert.ok(!html.includes('Expired:'));
  });
}
test('all hoists dispatched retain Total and zero Available without a duplicate In Use counter', () => {
  const stats = { total: 24, available: 0, inUse: 24, maintenance: 0, expired: 0 };
  assert.deepEqual(numbers(render(mobile, stats)), [24, 0]);
  assert.doesNotMatch(render(desktop, stats), /In Use Qty:/);
});
test('real inventory loader counts units in use across paginated reads without any active-list queries', async () => {
  const calls = [];
  let captured;
  const units = Array.from({ length: 1001 }, (_, i) => ({ item_id: i < 1000 ? 'hoist-a' : 'hoist-b',
    status: i < 998 ? 'in_use' : i === 998 ? 'available' : i === 999 ? 'maintenance' : 'in_ksa',
    expiry_date: i === 999 ? '2000-01-01' : '2099-12-31' }));
  const api = compile(['toStatus', 'isExpired', 'loadItems'].map(functionText).join('\n') + '\nexports.load=loadItems;', {
    setLoading() {}, setItems() {}, setStats: stats => { captured = JSON.parse(JSON.stringify(stats)); },
    console: { error() { assert.fail('Mock read must not fail'); } },
    supabase: { from(table) {
      const call = { table }; calls.push(call);
      const query = { select(fields) { call.fields = fields; return query; },
        eq(field, value) { call.eq = [field, value]; return query; },
        in(field, value) { call.in = [field, value]; return query; },
        async order() { return { data: [{ id: 'hoist-a' }, { id: 'hoist-b' }], error: null }; },
        async range(from, to) { call.range = [from, to]; return { data: units.slice(from, to + 1), error: null }; } };
      return query;
    } },
  });
  await api.load('chain-hoist-subcategory', false);
  assert.deepEqual(calls.map(call => call.table), ['items', 'units', 'units']);
  assert.deepEqual(calls.slice(1).map(call => call.range), [[0, 999], [1000, 1999]]);
  assert.deepEqual(captured['hoist-a'], { total: 1000, available: 1, inUse: 998, maintenance: 1, inKsa: 0, expired: 0 });
  assert.deepEqual(captured['hoist-b'], { total: 1, available: 0, inUse: 0, maintenance: 0, inKsa: 1, expired: 0 });
  assert.equal(captured['hoist-a'].inUse, 998);
});

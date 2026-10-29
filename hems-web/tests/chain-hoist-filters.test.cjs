// Tests real extracted production filtering/aggregation handlers with mock reads.
// No Supabase connection or real inventory/list writes are performed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('components/ChainHoistRowsBlock.tsx');
const inventory = read('components/SubcategoryClientChainHoist.tsx');
function compile(code, globals = {}) {
  const exports = {};
  const js = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(js, { exports, ...globals, require });
  return exports;
}
function find(text, predicate) {
  const ast = ts.createSourceFile('fixture.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function walk(node) { if (!found && predicate(node)) found = node; ts.forEachChild(node, walk); }
  walk(ast); assert.ok(found, 'Production source fixture not found'); return found;
}
function functionText(text, name) {
  return find(text, node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText();
}
const helpers = ['isExpired', 'validStatus', 'isMovementStatus'].map(name => functionText(source, name)).join('\n');
const filterCallback = find(source, node => ts.isVariableDeclaration(node) && node.name.getText() === 'filteredUnits').initializer.arguments[0].getText();
const units = [
  { id: 'failed-old', unit_no: '1', serial: 'OLD-CERT', notes: 'old report', status: 'maintenance', cert_date: '2000-01-01', expiry_date: '2001-01-01' },
  { id: 'failed-new', unit_no: '2', serial: 'NEW-FAILED', notes: '', status: 'maintenance', cert_date: null, expiry_date: null },
  { id: 'available-valid', unit_no: '3', serial: 'AVAILABLE', notes: '', status: 'available', expiry_date: '2090-01-01' },
  { id: 'available-expired', unit_no: '4', serial: 'EXPIRED', notes: '', status: 'available', expiry_date: '2000-01-01' },
  { id: 'in-use', unit_no: '5', serial: 'EVENT', notes: '', status: 'in_use', expiry_date: '2090-01-01' },
  { id: 'in-ksa', unit_no: '6', serial: 'KSA', notes: '', status: 'in_ksa', expiry_date: '2090-01-01' },
];
function filter(statusFilter = 'all', validityFilter = 'all', filterQuery = '', movementByUnit = {}) {
  return compile(`${helpers}\nexports.rows=(${filterCallback})();`, { units, statusFilter, validityFilter, filterQuery, movementByUnit }).rows.map(row => row.id);
}
const ids = value => Array.from(value);
for (const validity of ['all', 'valid', 'expired']) {
  test(`Failed filter includes both legacy/new failed units even with stale ${validity} validity`, () => {
    assert.deepEqual(ids(filter('maintenance', validity)), ['failed-old', 'failed-new']);
  });
}
test('Failed filter retains serial/ID/note searching without including Available rows', () => {
  assert.deepEqual(ids(filter('maintenance', 'all', 'old-cert')), ['failed-old']);
  assert.deepEqual(ids(filter('maintenance', 'all', '2')), ['failed-new']);
  assert.deepEqual(ids(filter('maintenance', 'all', 'old report')), ['failed-old']);
  assert.deepEqual(ids(filter('maintenance', 'all', 'AVAILABLE')), []);
});
test('all statuses, certificate validity and assigned filters still work', () => {
  assert.equal(filter().length, 6);
  assert.deepEqual(ids(filter('all', 'expired')), ['available-expired']);
  assert.deepEqual(ids(filter('all', 'valid')), ['available-valid', 'in-use', 'in-ksa']);
  assert.deepEqual(ids(filter('available', 'valid')), ['available-valid']);
  assert.deepEqual(ids(filter('assigned')), ['in-use', 'in-ksa']);
  assert.deepEqual(ids(filter('assigned', 'all', '', { 'failed-old': { listId: 'repair-a' } })), ['failed-old', 'in-use', 'in-ksa']);
});
test('choosing Failed resets stale certificate validity; other statuses do not', () => {
  const calls = [];
  const change = compile(`${functionText(source, 'changeStatusFilter')}\nexports.change=changeStatusFilter;`, {
    setStatusFilter: value => calls.push(['status', value]), setValidityFilter: value => calls.push(['validity', value]),
  }).change;
  change('maintenance'); assert.deepEqual(calls, [['status', 'maintenance'], ['validity', 'all']]);
  calls.length = 0; change('available'); assert.deepEqual(calls, [['status', 'available']]);
});
const Filter = compile(read('components/UnitReportFilterBar.tsx')).default;
const filterJsx = find(source, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'UnitReportFilterBar').getText();
function chainFilterProps(statusFilter, validityFilter, callbacks = {}) {
  const Fixture = compile(`exports.element=(${filterJsx});`, {
    UnitReportFilterBar: Filter, statusFilter, validityFilter, filterQuery: '', units,
    filteredUnits: filter(statusFilter, validityFilter), setFilterQuery() {},
    setValidityFilter() {}, changeStatusFilter() {}, ...callbacks,
  });
  return Fixture.element;
}
test('report UI says Failed and hides inapplicable certificate filter only while Failed is selected', () => {
  for (const status of ['all', 'available', 'maintenance', 'assigned']) {
    const html = renderToStaticMarkup(chainFilterProps(status, 'valid'));
    assert.ok(html.includes('value="maintenance"'));
    assert.ok(html.includes('>Failed</option>'));
    assert.ok(!html.includes('>Maintenance</option>'));
    assert.equal(html.includes('aria-label="Filter certificate validity"'), status !== 'maintenance');
  }
});
function collect(node, predicate, rows = []) {
  if (!node || typeof node !== 'object') return rows;
  if (Array.isArray(node)) { node.forEach(child => collect(child, predicate, rows)); return rows; }
  if (predicate(node)) rows.push(node);
  collect(node.props?.children, predicate, rows); return rows;
}
test('Clear resets both status and certificate filters plus search text', () => {
  const calls = [];
  const element = Filter({ query: 'old', status: 'maintenance', validity: undefined, resultCount: 1, totalCount: 6,
    maintenanceLabel: 'Failed', onQueryChange: value => calls.push(['query', value]),
    onStatusChange: value => calls.push(['status', value]), onValidityChange: value => calls.push(['validity', value]) });
  const clear = collect(element, node => node.type === 'button')[0];
  assert.ok(clear); clear.props.onClick();
  assert.deepEqual(calls, [['query', ''], ['status', 'all'], ['validity', 'all']]);
});
test('other report types keep their default Maintenance filter label', () => {
  const html = renderToStaticMarkup(React.createElement(Filter, { query: '', status: 'all', resultCount: 0, totalCount: 0, onQueryChange() {}, onStatusChange() {} }));
  assert.ok(html.includes('value="maintenance">Maintenance</option>'));
  for (const name of ['SerializedRowsBlock', 'ProjectorRowsBlock']) assert.doesNotMatch(read(`components/${name}.tsx`), /maintenanceLabel="Failed"/);
});
test('inventory totals agree with the report for old Failed rows with old expiry dates', async () => {
  let stats;
  const calls = [];
  const fixture = compile(
    ['toStatus', 'isExpired', 'loadItems'].map(name => functionText(inventory, name)).join('\n') + '\nexports.load=loadItems;', {
      setLoading() {}, setItems() {}, setStats: value => { stats = JSON.parse(JSON.stringify(value)); },
      console: { error() {} }, supabase: { from(table) {
        calls.push(table);
        const query = { select() { return query; }, eq() { return query; }, in() { return query; },
          async order() { return { data: [{ id: 'item-a' }], error: null }; },
          async range() { return { data: units.map(unit => ({ ...unit, item_id: 'item-a' })), error: null }; } };
        return query;
      } },
    });
  await fixture.load('subcategory-a', false);
  assert.deepEqual(calls, ['items', 'units']);
  assert.deepEqual(stats['item-a'], { total: 6, available: 1, inUse: 1, maintenance: 2, inKsa: 1, expired: 1 });
});

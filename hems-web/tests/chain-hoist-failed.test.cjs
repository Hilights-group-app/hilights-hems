// Deterministic local component/handler tests. Supabase writes are mocked.
// No live database writes, certificates, stock or physical equipment are tested.
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
const chainFile = 'components/ChainHoistRowsBlock.tsx';
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function compile(source, globals = {}, imports = {}) {
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(code, { exports, ...globals, require: name => imports[name] ?? require(name) });
  return exports;
}
function extract(source, name) {
  const ast = ts.createSourceFile('fixture.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function walk(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast);
    ts.forEachChild(node, walk);
  }
  walk(ast);
  if (!found) throw new Error(`Missing production function ${name}`);
  return found;
}
const normalize = value => JSON.parse(JSON.stringify(value));
const source = read(chainFile);
const helperNames = ['addOneYear', 'valuesMatch', 'getStatusLabel', 'getStatusTextColor', 'isMovementStatus', 'resizeNoteField', 'isExpired', 'validStatus'];
const helperSource = helperNames.map(name => extract(source, name)).join('\n');
const helpers = compile(`${helperSource}\n${helperNames.map(name => `exports.${name}=${name};`).join('\n')}`);
const fixtureUnit = extra => ({ id: 'unit-a', unit_no: '3', serial: 'KEEP-SERIAL', status: 'available',
  notes: 'Keep this note', testing_date: '2026-10-29', cert_date: '2026-08-14', expiry_date: '2027-08-14',
  damage_photos: [], ...extra });
const settle = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function mutationHarness(options = {}) {
  const database = new Map((options.units || [fixtureUnit()]).map(row => [row.id, { ...row }]));
  const unitsRef = { current: [...database.values()].map(row => ({ ...row })) };
  const calls = [], errors = [], logs = [], updates = [];
  const currentItemRef = { current: 'item-a' };
  const queues = { current: new Map() }, revisions = { current: new Map() };
  let reloads = 0;
  const globals = { ...helpers, itemId: 'item-a', itemName: 'ChainMaster D8 1t', activityLink: '/report-a',
    editable: options.editable !== false, currentItemRef, unitsRef,
    unitWriteQueuesRef: queues, unitWriteRevisionsRef: revisions,
    setUnits(rows) { updates.push(rows); }, setSaveError(error) { errors.push(error); },
    async loadUnits() { reloads++; unitsRef.current = [...database.values()].map(row => ({ ...row })); updates.push(unitsRef.current); },
    async logActivity(entry) { logs.push(entry); if (options.logFailure) throw new Error('Notification unavailable'); },
    console: { error() {} },
    supabase: { from(table) {
      assert.equal(table, 'units');
      return { update(patch) {
        const call = { patch: normalize(patch), filters: {} }; calls.push(call);
        const query = {
          eq(name, value) { call.filters[name] = value; return query; },
          select(fields) { assert.equal(fields, 'id'); return query; },
          async maybeSingle() {
            const index = calls.indexOf(call);
            if (options.waitAt === index) await options.gate.promise;
            if (options.failAt === index) return { data: null, error: { message: 'Use Received, then Tested.' } };
            if (options.missingAt === index) return { data: null, error: null };
            const row = database.get(call.filters.id);
            assert.equal(call.filters.item_id, 'item-a');
            if (call.filters.status !== undefined && row?.status !== call.filters.status) return { data: null, error: null };
            if (row) database.set(row.id, { ...row, ...call.patch });
            return { data: row ? { id: row.id } : null, error: null };
          },
        };
        return query;
      } };
    } },
  };
  const update = compile(`${extract(source, 'updateUnit')}\nexports.updateUnit=updateUnit;`, globals).updateUnit;
  return { update, calls, database, unitsRef, errors, logs, updates, queues, currentItemRef,
    get reloads() { return reloads; } };
}
test('Failed keeps the existing unavailable stock key, with a red report label', () => {
  assert.equal(helpers.getStatusLabel('maintenance'), 'Failed');
  assert.equal(helpers.getStatusTextColor('maintenance'), '#dc2626');
  assert.equal(helpers.getStatusLabel('available'), 'Available');
  assert.equal(helpers.getStatusLabel('in_ksa'), 'In KSA');
});
test('choosing Failed saves status and both null dates in ONE scoped update', async () => {
  const h = mutationHarness();
  await h.update('unit-a', { status: 'maintenance' });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].patch, { status: 'maintenance', cert_date: null, expiry_date: null });
  assert.equal(h.database.get('unit-a').cert_date, null);
  assert.equal(h.database.get('unit-a').expiry_date, null);
  assert.equal(h.database.get('unit-a').serial, 'KEEP-SERIAL');
  assert.equal(h.database.get('unit-a').notes, 'Keep this note');
  assert.equal(h.database.get('unit-a').testing_date, '2026-10-29');
  assert.match(h.logs[0].message, /Failed/);
});
test('reload and changing back to Available do not restore cleared dates', async () => {
  const h = mutationHarness();
  await h.update('unit-a', { status: 'maintenance' });
  await h.update('unit-a', { status: 'available' });
  assert.equal(h.database.get('unit-a').status, 'available');
  assert.equal(h.database.get('unit-a').cert_date, null);
  assert.equal(h.database.get('unit-a').expiry_date, null);
});
test('new certificates on Available still calculate one-year expiry', async () => {
  const h = mutationHarness();
  await h.update('unit-a', { cert_date: '2026-10-29' });
  assert.deepEqual(h.calls[0].patch, { cert_date: '2026-10-29', expiry_date: '2027-10-29' });
});
test('a queued/in-flight certificate cannot arrive after Failed and restore dates', async () => {
  const gate = deferred(), h = mutationHarness({ waitAt: 0, gate });
  const cert = h.update('unit-a', { cert_date: '2026-10-29' });
  await settle();
  const failed = h.update('unit-a', { status: 'maintenance' });
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.unitsRef.current[0].cert_date, null);
  gate.resolve(); await Promise.all([cert, failed]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.database.get('unit-a').status, 'maintenance');
  assert.equal(h.database.get('unit-a').cert_date, null);
  assert.equal(h.database.get('unit-a').expiry_date, null);
});
test('late date callbacks on a Failed unit never populate its certificate fields', async () => {
  const h = mutationHarness();
  await h.update('unit-a', { status: 'maintenance' });
  await h.update('unit-a', { cert_date: '2026-11-01' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.database.get('unit-a').cert_date, null);
});
test('a stale certificate edit cannot repopulate dates after another device marks Failed', async () => {
  const gate = deferred(), h = mutationHarness({ waitAt: 0, gate });
  const dateSave = h.update('unit-a', { cert_date: '2026-10-29' }); await settle();
  h.database.set('unit-a', { ...h.database.get('unit-a'), status: 'maintenance', cert_date: null, expiry_date: null });
  gate.resolve(); await dateSave;
  assert.equal(h.database.get('unit-a').cert_date, null);
  assert.equal(h.unitsRef.current[0].status, 'maintenance');
  assert.equal(h.reloads, 1);
});
test('different units do not wait on one another while saving', async () => {
  const gate = deferred(), h = mutationHarness({ units: [fixtureUnit(), fixtureUnit({ id: 'unit-b' })], waitAt: 0, gate });
  const first = h.update('unit-a', { status: 'maintenance' }); await settle();
  const second = h.update('unit-b', { notes: 'Different row' }); await settle();
  assert.equal(h.calls.length, 2);
  await second; gate.resolve(); await first;
});
test('a rejected write rolls back to the saved dates and displays the server reason', async () => {
  const h = mutationHarness({ failAt: 0 });
  await h.update('unit-a', { status: 'maintenance' });
  assert.equal(h.reloads, 1);
  assert.equal(h.unitsRef.current[0].status, 'available');
  assert.equal(h.unitsRef.current[0].cert_date, '2026-08-14');
  assert.equal(h.errors.at(-1), 'Use Received, then Tested.');
  assert.equal(h.logs.length, 0);
  assert.equal(h.queues.current.size, 0);
});
test('an unconfirmed/RLS-filtered update is not treated as a saved Failed row', async () => {
  const h = mutationHarness({ missingAt: 0 });
  await h.update('unit-a', { status: 'maintenance' });
  assert.equal(h.reloads, 1);
  assert.match(h.errors.at(-1), /permissions/);
  assert.equal(h.unitsRef.current[0].status, 'available');
});
test('an older failed date save does not overwrite a newer Failed choice', async () => {
  const gate = deferred(), h = mutationHarness({ waitAt: 0, failAt: 0, gate });
  const cert = h.update('unit-a', { cert_date: '2026-10-29' }); await settle();
  const failed = h.update('unit-a', { status: 'maintenance' });
  gate.resolve(); await Promise.all([cert, failed]);
  assert.equal(h.reloads, 0);
  assert.equal(h.database.get('unit-a').status, 'maintenance');
  assert.equal(h.database.get('unit-a').cert_date, null);
});
test('read-only users, unknown rows and stale report callbacks cannot write', async () => {
  const readonly = mutationHarness({ editable: false });
  await readonly.update('unit-a', { status: 'maintenance' }); assert.equal(readonly.calls.length, 0);
  const h = mutationHarness();
  await h.update('missing', { status: 'maintenance' }); assert.equal(h.calls.length, 0);
  h.currentItemRef.current = 'item-b';
  await h.update('unit-a', { status: 'maintenance' }); assert.equal(h.calls.length, 0);
});
test('an activity notification error cannot undo a saved Failed state', async () => {
  const h = mutationHarness({ logFailure: true });
  await h.update('unit-a', { status: 'maintenance' });
  assert.equal(h.database.get('unit-a').status, 'maintenance');
  assert.equal(h.reloads, 0);
});
test('Failed rows are never green Valid or counted as Expired certificates', () => {
  assert.equal(helpers.validStatus(fixtureUnit({ status: 'maintenance', expiry_date: '2000-01-01' })), 'failed');
  assert.equal(helpers.isExpired(fixtureUnit({ status: 'maintenance', expiry_date: '2000-01-01' })), false);
  assert.equal(helpers.validStatus(fixtureUnit({ status: 'available', expiry_date: '2000-01-01' })), 'expired');
  assert.equal(helpers.validStatus(fixtureUnit({ status: 'available', expiry_date: '2090-01-01' })), 'valid');
});

const Link = props => React.createElement('a', props);
function rowComponents(hooks = {}) {
  return compile(`${helperSource}\n${extract(source, 'ChainHoistStatusField')}\n${extract(source, 'ChainHoistEditableRow')}\nexports.Row=ChainHoistEditableRow; exports.Status=ChainHoistStatusField;`,
    { ...React, ...icons, Link, ...hooks, isMultiLineSerialPaste: () => false, DamagePhotoThumb: () => null });
}
const components = rowComponents();
const rowProps = unit => ({ unit, validStatus: helpers.validStatus(unit), editable: true, workflowControlledStatus: true,
  allowDelete: false, allowUpload: false, onSave: async () => {}, onDelete: async () => {}, onUpload: async () => {},
  onOpenPhoto() {}, onDeleteDamagePhoto() {}, onBulkSerialPaste: async () => {} });
test('desktop/mobile/read-only rows hide dates on Failed, including legacy stored dates', () => {
  const unit = fixtureUnit({ status: 'maintenance' });
  for (const editable of [true, false]) {
    const html = renderToStaticMarkup(React.createElement(components.Row, { ...rowProps(unit), editable }));
    assert.ok(!html.includes('2026-08-14'));
    assert.ok(!html.includes('2027-08-14'));
    assert.ok(!html.includes('type="date"'));
    assert.ok(!html.includes('>Valid<'));
    assert.ok(html.includes('>Failed<'));
    assert.ok(html.includes('KEEP-SERIAL'));
  }
});
test('Available row retains editable certificate fields in both responsive layouts', () => {
  const html = renderToStaticMarkup(React.createElement(components.Row, rowProps(fixtureUnit())));
  assert.equal((html.match(/type="date"/g) || []).length, 2);
  assert.ok(html.includes('2026-08-14'));
  assert.ok(html.includes('2027-08-14'));
});
test('active movement and repair links remain locked, not an editable status select', () => {
  for (const status of ['in_use', 'in_ksa', 'maintenance']) {
    const html = renderToStaticMarkup(React.createElement(components.Status, {
      status, editable: true, workflowControlledStatus: true,
      movement: { listId: 'list-a', reference: 'MR-2026-0001', label: 'At Procom for Repair' }, onChange() {},
    }));
    assert.ok(html.includes('/inventory/lists/list-a'));
    assert.ok(html.includes('At Procom for Repair'));
    assert.ok(!html.includes('<select'));
  }
});
function elementNodes(node, predicate, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) { node.forEach(child => elementNodes(child, predicate, result)); return result; }
  if (predicate(node)) result.push(node);
  elementNodes(node.props?.children, predicate, result);
  return result;
}
function interactiveRow() {
  const states = [], refs = [], deps = [], cleanups = [], effects = [], timers = new Map(), saves = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, sequence = 0;
  const hooks = {
    useState(initial) { const index = stateIndex++; if (!(index in states)) states[index] = initial;
      return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
    useRef(initial) { const index = refIndex++; return refs[index] ||= { current: initial }; },
    useEffect(callback, nextDeps) { const index = effectIndex++; if (!deps[index] || nextDeps.some((d, i) => !Object.is(d, deps[index][i]))) {
      deps[index] = nextDeps; effects.push(() => { cleanups[index]?.(); cleanups[index] = callback(); });
    } },
    setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const { Row } = rowComponents(hooks);
  return { timers, saves,
    render(unit) { stateIndex = refIndex = effectIndex = 0; return Row({ ...rowProps(unit), onSave: async (id, patch) => saves.push([id, normalize(patch)]) }); },
    effects() { for (const effect of effects.splice(0)) effect(); },
    unmount() { cleanups.forEach(cleanup => cleanup?.()); },
  };
}
test('choosing Failed cancels delayed certificate saves and immediately blanks both layouts', () => {
  const h = interactiveRow(), unit = fixtureUnit();
  let tree = h.render(unit); h.effects();
  const date = elementNodes(tree, node => node.type === 'input' && node.props.type === 'date')[0];
  date.props.onChange({ target: { value: '2026-10-29' } });
  assert.equal(h.timers.size, 1);
  tree = h.render(unit);
  const status = elementNodes(tree, node => node.type?.name === 'ChainHoistStatusField')[0];
  status.props.onChange('maintenance');
  assert.equal(h.timers.size, 0);
  tree = h.render(unit);
  assert.equal(elementNodes(tree, node => node.type === 'input' && node.props.type === 'date').length, 0);
  assert.deepEqual(h.saves, [['unit-a', { status: 'maintenance' }]]);
});
test('server rollback restores editable dates and unmount cancels remaining timers', () => {
  const h = interactiveRow(), unit = fixtureUnit();
  h.render(unit); h.effects();
  h.render({ ...unit, status: 'maintenance', cert_date: null, expiry_date: null }); h.effects();
  h.render(unit); h.effects();
  const dates = elementNodes(h.render(unit), node => node.type === 'input' && node.props.type === 'date');
  assert.equal(dates.length, 2);
  assert.equal(dates[0].props.value, '2026-08-14');
  dates[0].props.onChange({ target: { value: '2026-10-29' } });
  assert.equal(h.timers.size, 1);
  h.unmount(); assert.equal(h.timers.size, 0);
});
test('header renders the entire escaped long name with smaller wrap-enabled text', () => {
  const header = read('components/ItemEditClientChainHoistUnits.tsx');
  const ast = ts.createSourceFile('header.tsx', header, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let title;
  function walk(node) { if (ts.isJsxElement(node) && node.openingElement.getText(ast).includes('data-chain-hoist-report-title')) title = node.getText(ast); ts.forEachChild(node, walk); }
  walk(ast); assert.ok(title);
  const name = 'ChainMaster D8 & D8+ electric chain hoist 1 ton / 18 metres - complete long model name';
  const Fixture = compile(`export default function Title(){ return (${title}); }`, { item: { name } }).default;
  const html = renderToStaticMarkup(React.createElement(Fixture));
  assert.ok(html.includes(name.replace('&', '&amp;')));
  for (const token of ['text-[12px]', 'sm:text-[15px]', 'xl:text-[17px]', 'whitespace-normal', 'break-words']) assert.ok(html.includes(token));
  assert.ok(!html.includes('truncate'));
  assert.ok(!html.includes('whitespace-nowrap'));
});
test('only Chain Hoist opts into the Failed filter label; other reports keep Maintenance', () => {
  const Filter = compile(read('components/UnitReportFilterBar.tsx')).default;
  const props = { query: '', status: 'all', resultCount: 1, totalCount: 1, onQueryChange() {}, onStatusChange() {} };
  const normal = renderToStaticMarkup(React.createElement(Filter, props));
  const chain = renderToStaticMarkup(React.createElement(Filter, { ...props, maintenanceLabel: 'Failed' }));
  assert.ok(normal.includes('value="maintenance">Maintenance'));
  assert.ok(chain.includes('value="maintenance">Failed'));
  assert.match(source, /maintenanceLabel="Failed"/);
  for (const file of ['SerializedRowsBlock', 'ProjectorRowsBlock']) assert.doesNotMatch(read(`components/${file}.tsx`), /maintenanceLabel="Failed"/);
});
test('Chain Hoist PDF uses Failed with blank dates, but retains repair labels', () => {
  const pdfSource = read('components/UnitReportPdfButton.tsx');
  const pdf = compile(['statusLabel', 'normalizePhotos', 'unitTable'].map(name => extract(pdfSource, name)).join('\n') + '\nexports.table=unitTable;');
  const failed = fixtureUnit({ status: 'maintenance' });
  const row = pdf.table('chain_hoist', [failed]).body[0];
  assert.equal(row[2], 'Failed'); assert.equal(row[3], ''); assert.equal(row[4], '');
  assert.equal(pdf.table('chain_hoist', [{ ...failed, repair_label: 'Received - Waiting Testing' }]).body[0][2], 'Received - Waiting Testing');
  assert.equal(pdf.table('chain_hoist', [fixtureUnit()]).body[0][3], '2026-08-14');
  for (const variant of ['serialized', 'projector']) assert.equal(pdf.table(variant, [failed]).body[0][2], 'Maintenance');
});

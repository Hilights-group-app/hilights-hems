// Read-only display tests; no Supabase session or database writes.
// Run: node --test tests/active-list-return-quantities.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const root = path.resolve(__dirname, '..');
function load(file, imports = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const exports = {};
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(compiled, { exports, require: name => imports[name] ?? require(name) }, { filename: file });
  return exports;
}
const helpers = load('lib/listReturnQuantities.ts');
const ActiveListQuantity = load('components/ActiveListQuantity.tsx', {
  '@/lib/listReturnQuantities': helpers,
}).default;
const quantities = items => ({ ...helpers.listReturnQuantities(items) });
const line = (patch = {}) => ({
  id: 'line-a', list_id: 'event-a', inventory_record_type: 'matrix_model', inventory_record_id: 'model-a',
  parent_record_id: null, display_name: 'Socapex', serial_number: null, block_name: null,
  requested_quantity: 2, approved_quantity: 2, returned_ok_quantity: 0, returned_maintenance_quantity: 0,
  metadata: { matrix_source: 'generic' }, created_at: '2026-10-26', ...patch,
});
const render = (items, props = {}) => renderToStaticMarkup(React.createElement(ActiveListQuantity, { items, ...props }));
const text = html => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

test('two dispatched cables start with two outside', () => {
  const result = quantities([line()]);
  assert.equal(result.sent, 2); assert.equal(result.received, 0); assert.equal(result.outside, 2);
});
test('receiving one of two cables leaves one outside', () => {
  const result = quantities([line({ returned_ok_quantity: 1 })]);
  assert.equal(result.sent, 2); assert.equal(result.received, 1); assert.equal(result.outside, 1);
});
test('receiving all cables leaves zero outside without losing the dispatched total', () => {
  const result = quantities([line({ returned_ok_quantity: 2 })]);
  assert.equal(result.sent, 2); assert.equal(result.received, 2); assert.equal(result.outside, 0);
});
test('a damaged return is received, not still outside', () => {
  const result = quantities([line({ returned_maintenance_quantity: 1 })]);
  assert.equal(result.received, 1); assert.equal(result.outside, 1);
});
test('serialized group quantity sums the remaining units, including hidden serial details', () => {
  const unit = patch => line({ inventory_record_type: 'unit', requested_quantity: 1, approved_quantity: 1, ...patch });
  const result = quantities([unit({ returned_ok_quantity: 1 }), unit({}), unit({ returned_maintenance_quantity: 1 }), unit({})]);
  assert.equal(result.sent, 4); assert.equal(result.received, 2); assert.equal(result.outside, 2);
});
test('each cable length uses its own return counters', () => {
  const first = line({ inventory_record_type: 'matrix_row', returned_ok_quantity: 1, metadata: { matrix_source: 'generic', row_label: '10m' } });
  const second = line({ inventory_record_type: 'matrix_row', requested_quantity: 5, approved_quantity: 5, metadata: { matrix_source: 'generic', row_label: '20m' } });
  assert.equal(quantities([first]).outside, 1); assert.equal(quantities([second]).outside, 5);
  assert.equal(quantities([first, second]).outside, 6);
});
test('over-return on one line cannot cancel another line that is still outside', () => {
  const result = quantities([line({ approved_quantity: 1, returned_ok_quantity: 5 }), line({ approved_quantity: 1 })]);
  assert.equal(result.sent, 2); assert.equal(result.received, 1); assert.equal(result.outside, 1);
});
test('active quantity is based on approved dispatch, not the original requested amount', () => {
  const result = quantities([line({ requested_quantity: 10, approved_quantity: 2, returned_ok_quantity: 1 })]);
  assert.equal(result.sent, 2); assert.equal(result.outside, 1);
});
test('supplemental dispatched additions are included in the new remaining quantity', () => {
  const result = quantities([line({ requested_quantity: 5, approved_quantity: 5, returned_ok_quantity: 1 })]);
  assert.equal(result.sent, 5); assert.equal(result.outside, 4);
});
test('null, malformed and negative counters cannot display NaN or negative quantities', () => {
  const result = quantities([line({ approved_quantity: null, returned_ok_quantity: 'bad' }), line({ approved_quantity: -1 })]);
  assert.equal(result.sent, 0); assert.equal(result.received, 0); assert.equal(result.outside, 0);
});
test('custom and non-inventory items do not gain tracked return quantities', () => {
  const result = quantities([line({ inventory_record_type: 'item' }), line({ metadata: { custom_item: true } })]);
  assert.equal(result.sent, 0); assert.equal(result.received, 0); assert.equal(result.outside, 0);
});
test('LED cabinets convert outstanding and received counts to SQM', () => {
  const result = quantities([line({ inventory_record_type: 'matrix_row', requested_quantity: 8, approved_quantity: 8,
    returned_ok_quantity: 3, metadata: { cabinet_area_sqm: 0.25, actual_sqm: 2 } })]);
  assert.equal(result.sentSquareMetres, 2); assert.equal(result.receivedSquareMetres, 0.75);
  assert.equal(result.outsideSquareMetres, 1.25); assert.equal(result.outside, 5);
});
test('LED conversion falls back to the stored area/requested ratio when cabinet area is missing', () => {
  const result = quantities([line({ inventory_record_type: 'matrix_row', returned_ok_quantity: 1, metadata: { actual_sqm: 0.5 } })]);
  assert.equal(result.sentSquareMetres, 0.5); assert.equal(result.receivedSquareMetres, 0.25);
  assert.equal(result.outsideSquareMetres, 0.25);
});
test('stored cabinet dimensions remain correct after additional dispatches', () => {
  const result = quantities([line({ inventory_record_type: 'matrix_row', requested_quantity: 10, approved_quantity: 10,
    returned_ok_quantity: 2, metadata: { cabinet_area_sqm: 0.25, actual_sqm: 2 } })]);
  assert.equal(result.sentSquareMetres, 2.5); assert.equal(result.outsideSquareMetres, 2);
});
test('generic cable rows do not become SQM because of unrelated metadata', () => {
  const result = quantities([line({ inventory_record_type: 'matrix_row', metadata: { matrix_source: 'generic', cabinet_area_sqm: 1 } })]);
  assert.equal(result.outside, 2); assert.equal(result.outsideSquareMetres, 0);
});
test('only active and partially returned Local Event lists opt in', () => {
  for (const status of ['active', 'partially_returned']) {
    assert.equal(helpers.showActiveReturnQuantities({ list_type: 'local_event', status }), true);
  }
  for (const status of ['draft', 'pending', 'closed', 'cancelled']) {
    assert.equal(helpers.showActiveReturnQuantities({ list_type: 'local_event', status }), false);
  }
  for (const list_type of ['dry_hire', 'transfer_out', 'transfer_in', 'maintenance', 'internal_use']) {
    assert.equal(helpers.showActiveReturnQuantities({ list_type, status: 'active' }), false);
  }
  assert.equal(helpers.showActiveReturnQuantities(null), false);
});
test('partial return markup displays both remaining and received quantities inline', () => {
  const html = render([line({ returned_ok_quantity: 1 })]);
  assert.ok(text(html).includes('1 Unit Out')); assert.ok(text(html).includes('1 / 2 Received'));
  assert.ok(html.includes('data-return-outside')); assert.ok(html.includes('data-return-received'));
  assert.ok(html.includes('Sent: 2 Units')); assert.ok(!html.includes('<button'));
});
test('fully received markup shows zero outside and the retained total', () => {
  const html = render([line({ returned_ok_quantity: 2 })]);
  assert.ok(text(html).includes('0 Units Out')); assert.ok(text(html).includes('2 / 2 Received'));
});
test('unreturned items do not add an unnecessary zero-received line', () => {
  const html = render([line()]);
  assert.ok(text(html).includes('2 Units Out')); assert.ok(!html.includes('data-return-received'));
});
test('compact cable rows retain the same counts without a new border or receipt button', () => {
  const html = render([line({ returned_ok_quantity: 1 })], { compact: true });
  assert.ok(text(html).includes('1 Unit Out')); assert.ok(text(html).includes('1 / 2 Received'));
  assert.ok(html.includes('text-[9px]')); assert.ok(!html.includes('border')); assert.ok(!html.includes('<button'));
});
test('LED partial return markup retains the SQM label', () => {
  const html = render([line({ inventory_record_type: 'matrix_row', returned_ok_quantity: 1,
    metadata: { cabinet_area_sqm: 0.25, actual_sqm: 0.5 } })], { squareMetres: true });
  assert.ok(text(html).includes('0.25 SQM Out')); assert.ok(text(html).includes('0.25 / 0.5 SQM Received'));
});
test('calculating a summary does not mutate list items or their metadata', () => {
  const input = [line({ returned_ok_quantity: 1 })]; const before = JSON.stringify(input);
  Object.freeze(input[0].metadata); Object.freeze(input[0]); Object.freeze(input);
  quantities(input); render(input); assert.equal(JSON.stringify(input), before);
});

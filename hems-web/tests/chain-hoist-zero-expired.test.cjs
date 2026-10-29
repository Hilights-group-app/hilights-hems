// JSX-only regression tests. No network, authentication or database writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const inventorySource = fs.readFileSync(path.join(root, 'components/SubcategoryClientChainHoist.tsx'), 'utf8');
const reportSource = fs.readFileSync(path.join(root, 'components/ItemEditClientChainHoistUnits.tsx'), 'utf8');

function compile(code, globals = {}) {
  const exports = {};
  const js = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(js, { exports, ...globals, require });
  return exports;
}
function find(source, predicate) {
  const ast = ts.createSourceFile('fixture.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function walk(node) { if (!found && predicate(node, ast)) found = node; ts.forEachChild(node, walk); }
  walk(ast); assert.ok(found, 'Could not locate production JSX');
  return { node: found, code: found.getText(ast) };
}
function classElement(source, className) {
  return find(source, node => ts.isJsxElement(node) && node.openingElement.attributes.properties.some(attr =>
    ts.isJsxAttribute(attr) && attr.name.text === 'className' && ts.isStringLiteral(attr.initializer) && attr.initializer.text === className)).code;
}
const statPill = find(inventorySource, node => ts.isFunctionDeclaration(node) && node.name?.text === 'StatPill').code;
const mobile = classElement(inventorySource, 'mt-2 hems-wide:hidden');
const desktop = classElement(inventorySource, 'mt-1 hidden hems-wide:block');
const report = classElement(reportSource, 'flex flex-wrap items-center gap-[2px] text-[5px] font-semibold sm:gap-2 sm:text-[8px]');
function render(code, st) {
  const Fixture = compile(`${statPill}\nexport default function Fixture(){return (${code});}`, { st, stats: st }).default;
  return renderToStaticMarkup(React.createElement(Fixture));
}
for (const [expired, maintenance, columns] of [[0, 0, 2], [0, 4, 3], [3, 0, 3], [3, 4, 4]]) {
  test(`mobile: expired=${expired}, maintenance=${maintenance} has ${columns} complete columns`, () => {
    const html = render(mobile, { total: 20, available: 13, expired, maintenance });
    assert.ok(html.includes(`grid-cols-${columns}`));
    assert.equal((html.match(/rounded-md/g) || []).length, columns);
    assert.equal(html.includes('Expired'), expired > 0);
    assert.equal(html.includes('Failed'), maintenance > 0);
    assert.ok(!html.includes('Maintenance'));
    assert.ok(html.includes('Total'));
    assert.ok(html.includes('Available'));
  });
}
for (const expired of [0, 3]) {
  test(`desktop quantity badge: expired=${expired}`, () => {
    const html = render(desktop, { total: 20, available: 13, expired, maintenance: 4 });
    assert.equal(html.includes('Expired:'), expired > 0);
    assert.ok(html.includes('Total Qty: 20'));
    assert.ok(html.includes('Available Qty: 13'));
    assert.ok(html.includes('Failed: 4'));
    if (expired > 0) assert.ok(html.includes('Expired: 3'));
  });
  test(`report header: expired=${expired}`, () => {
    const html = render(report, { total: 20, available: 13, expired, maintenance: 4 });
    assert.equal(html.includes('Expired:'), expired > 0);
    assert.ok(html.includes('Total Qty: 20'));
    assert.ok(html.includes('Available Qty: 13'));
    assert.ok(html.includes('Failed: 4'));
  });
}
test('zero total/available remain visible even when zero Expired is hidden', () => {
  const stats = { total: 0, available: 0, expired: 0, maintenance: 0 };
  for (const code of [mobile, desktop, report]) {
    const html = render(code, stats);
    assert.ok(html.includes('Total'));
    assert.ok(html.includes('Available'));
    assert.ok(!html.includes('Expired'));
  }
});
test('Chain Hoist PDF summary follows the same positive-only Expired rule', () => {
  const { node } = find(reportSource, node => ts.isJsxAttribute(node) && node.name.text === 'summary');
  const expression = node.initializer.expression.getText();
  for (const expired of [0, 3]) {
    const summary = compile(`exports.summary=${expression};`, { stats: { total: 20, available: 13, expired, maintenance: 4 } }).summary;
    assert.equal(summary.some(row => row.label === 'Expired'), expired > 0);
    assert.equal(summary.find(row => row.label === 'Failed').value, 4);
  }
});

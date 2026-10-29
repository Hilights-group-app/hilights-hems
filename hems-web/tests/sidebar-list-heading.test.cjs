// Presentation-only rendering tests. No network, auth session or stock writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'components/EquipmentListsSidebar.tsx'), 'utf8');
const ast = ts.createSourceFile('sidebar.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function compile(code, globals = {}) {
  const exports = {};
  const output = ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(output, { exports, ...globals, require });
  return exports;
}
const listApi = compile(fs.readFileSync(path.join(root, 'lib/equipmentLists.ts'), 'utf8'));
function productionFunction(name) {
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn, `Production function ${name} exists`);
  return fn.getText(ast);
}
const { Heading } = compile(['statusClass', 'sidebarStatusLabel', 'SidebarListHeading'].map(productionFunction).join('\n') +
  '\nexports.Heading=SidebarListHeading;', listApi);
const fixture = (patch = {}) => ({ id: 'event-1', reference: 'EV-2026-0011', list_type: 'local_event',
  status: 'draft', event_name: 'Book Fair Event', venue: 'Expo Sharjah', client_company: null,
  from_location_name: null, destination_name: null, repair_company: null, purpose: null, assigned_to: null, ...patch });
function descendants(tree, result = []) {
  if (React.isValidElement(tree)) {
    result.push(tree);
    React.Children.forEach(tree.props.children, child => descendants(child, result));
  }
  return result;
}
const marked = (tree, name) => descendants(tree).find(node => node.props[`data-sidebar-list-${name}`] !== undefined);
const textContent = tree => React.isValidElement(tree)
  ? React.Children.toArray(tree.props.children).map(textContent).join('') : String(tree ?? '');
function render(list, props = {}) { return Heading({ list, ...props }); }

for (const [status, label] of [['draft', 'Draft'], ['pending', 'Pending'], ['active', 'Active'], ['partially_returned', 'Partial Return']]) {
  test(`${status}: event and venue are above the smaller reference, with status retained`, () => {
    const tree = render(fixture({ status }));
    const title = marked(tree, 'title'), location = marked(tree, 'location'), reference = marked(tree, 'reference');
    assert.equal(textContent(title), 'Book Fair Event');
    assert.equal(textContent(location), 'Expo Sharjah');
    assert.equal(textContent(reference), 'EV-2026-0011');
    assert.match(title.props.className, /text-\[12px\].*font-bold/);
    assert.match(location.props.className, /text-\[11px\]/);
    assert.match(reference.props.className, /text-\[9px\]/);
    assert.doesNotMatch(reference.props.className, /font-bold/);
    const html = renderToStaticMarkup(tree);
    assert.ok(html.indexOf('Book Fair Event') < html.indexOf('Expo Sharjah'));
    assert.ok(html.indexOf('Expo Sharjah') < html.indexOf('EV-2026-0011'));
    assert.ok(textContent(tree).includes(label));
  });
}
test('event name and location each have their own wrapping line, including long names', () => {
  const event = 'International exhibition with a very long event name '.repeat(3);
  const location = 'Expo venue with a long hall location '.repeat(3);
  const tree = render(fixture({ event_name: event, venue: location }));
  for (const name of ['title', 'location']) {
    const node = marked(tree, name);
    assert.match(node.props.className, /\bblock\b.*\bbreak-words\b/);
    assert.doesNotMatch(node.props.className, /truncate|line-clamp|whitespace-nowrap/);
  }
  assert.equal(textContent(marked(tree, 'title')), event.trim());
  assert.equal(textContent(marked(tree, 'location')), location.trim());
});
test('blank event name uses its type label, never promotes the reference', () => {
  for (const event_name of [null, '', '   ']) {
    const tree = render(fixture({ event_name }));
    assert.equal(textContent(marked(tree, 'title')), 'Local Event');
    assert.equal(textContent(marked(tree, 'location')), 'Expo Sharjah');
    assert.equal(textContent(marked(tree, 'reference')), 'EV-2026-0011');
  }
});
test('missing location creates no empty line or duplicate combined event summary', () => {
  for (const venue of [null, '', '   ']) {
    const tree = render(fixture({ venue }));
    assert.equal(marked(tree, 'location'), undefined);
    assert.equal(textContent(marked(tree, 'title')), 'Book Fair Event');
    assert.doesNotMatch(textContent(tree), /·/);
  }
});
for (const [list_type, fields, title] of [
  ['dry_hire', { client_company: 'Eventum' }, 'Eventum'],
  ['transfer_out', { from_location_name: 'Dubai Warehouse', destination_name: 'KSA' }, 'Dubai Warehouse → KSA'],
  ['transfer_in', { from_location_name: 'KSA', destination_name: 'Dubai Warehouse' }, 'KSA → Dubai Warehouse'],
  ['maintenance', { repair_company: 'Procom' }, 'At Procom for Repair'],
  ['internal_use', { purpose: 'Workshop', assigned_to: 'Video team' }, 'Workshop · Video team'],
]) {
  test(`${list_type}: retains existing meaningful details as title, not unrelated event fields`, () => {
    const tree = render(fixture({ list_type, ...fields }));
    assert.equal(textContent(marked(tree, 'title')), title);
    assert.equal(marked(tree, 'location'), undefined);
    assert.equal(textContent(marked(tree, 'reference')), 'EV-2026-0011');
  });
}
test('empty non-event details fall back to the type rather than a large code', () => {
  const tree = render(fixture({ list_type: 'transfer_out' }));
  assert.equal(textContent(marked(tree, 'title')), 'Transfer Out');
});
test('folder-specific status labels and colors remain supported', () => {
  const tree = render(fixture({ list_type: 'maintenance', status: 'active' }), {
    badgeClassName: 'bg-amber-100 text-amber-800', badgeLabel: 'Repair',
  });
  const badge = descendants(tree).find(node => textContent(node) === 'Repair');
  assert.match(badge.props.className, /bg-amber-100 text-amber-800/);
  assert.doesNotMatch(textContent(tree), /Active Repair/);
});
test('untrusted names render as text rather than HTML or nested interactive controls', () => {
  const html = renderToStaticMarkup(render(fixture({ event_name: '<img src=x onerror=alert(1)>', venue: 'Hall & Stage' })));
  assert.match(html, /&lt;img/);
  assert.match(html, /Hall &amp; Stage/);
  assert.doesNotMatch(html, /<(?:a|button|img|script)\b/);
});
test('all five working sidebar card contexts reuse the same heading; archive is untouched', () => {
  const calls = [];
  function walk(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'SidebarListHeading') calls.push(node.getText(ast));
    ts.forEachChild(node, walk);
  }
  walk(ast);
  assert.equal(calls.length, 5);
  assert.ok(calls.some(text => /list=\{activeList\}/.test(text)));
  assert.ok(calls.some(text => /badgeLabel="Repair"/.test(text)));
  assert.ok(calls.some(text => /badgeLabel="Internal"/.test(text)));
  assert.ok(calls.some(text => /bg-blue-100 text-blue-800/.test(text)));
  assert.match(source, /isSharedEquipmentDraft\(list, currentUserId\)/);
  assert.match(source, /\{listDates\(list\)\}/);
  assert.match(source, /<ClosedListFolders key=\{currentUserId\}/);
});
test('heading is presentation-only with no new requests, navigation, storage or effects', () => {
  const fn = productionFunction('SidebarListHeading');
  assert.doesNotMatch(fn, /\b(?:useEffect|useState|fetch|localStorage|window|router|supabase)\b|\.(?:from|rpc|update|insert|delete)\(/);
});

// Presentation tests only: no login, Supabase connection or writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const styles = new Proxy({}, { get: (_, key) => String(key) });
function compile(source, globals = {}, imports = {}) {
  const exports = {};
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(js, { exports, ...globals, require: name => imports[name] ?? require(name) });
  return exports;
}
const helpers = compile(fs.readFileSync(path.join(root, 'lib/equipmentLists.ts'), 'utf8'));
const CompactListHeading = compile(fs.readFileSync(path.join(root, 'components/CompactListHeading.tsx'), 'utf8'), {}, {
  './EquipmentListHeader.module.css': { default: styles },
}).default;
const icons = require('lucide-react');
const ShareDraft = ({list}) => React.createElement('button', { 'aria-label': 'Share draft', title: 'Share draft' },
  React.createElement(icons.Users, { size: 13 }), React.createElement('span', null, 'Share draft'));

function renderHeader(type = 'dry_hire', status = 'pending', options = {}, sourceOverride) {
  const source = sourceOverride || fs.readFileSync(path.join(root, 'components/EquipmentListDetailsClient.tsx'), 'utf8');
  const ast = ts.createSourceFile('details.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const definitions = ['InfoCard', 'scheduleRows', 'formatDate', 'formatDateTime', 'statusClass', 'displayedStatusLabel'];
  const helperCode = ast.statements.filter(n => ts.isFunctionDeclaration(n) && definitions.includes(n.name?.text)).map(n => n.getText(ast)).join('\n');
  const marker = '<div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">';
  const start = source.indexOf(marker, source.indexOf('const dates = scheduleRows(list);'));
  const end = source.indexOf('\n      {list.list_type === "transfer_out"', start);
  if (start < 0 || end < 0) throw new Error('Header fixture could not locate production JSX');
  const list = { id: 'fixture-list', reference: 'DH-2026-0005', list_type: type, status,
    client_company: 'Eventum', event_name: 'Book Fair Event', venue: 'Expo Sharjah',
    from_location_name: 'Dubai Warehouse', destination_name: 'KSA', repair_company: 'Procom',
    purpose: 'Warehouse testing', assigned_to: 'Video team', shared_with: [],
    pickup_date: '2026-10-26', return_date: '2026-10-30', setup_date: '2026-10-26', dismantling_date: '2026-10-30',
    loading_date: '2026-10-26', receiving_date: '2026-10-30', maintenance_sent_date: '2026-10-26',
    created_by_name: 'Fixture user', created_at: '2026-10-26T12:41:00Z', submitted_at: '2026-10-26T12:41:00Z',
    ...options.list };
  const globals = { ...icons, ...helpers, React, CompactListHeading, headerStyles: styles,
    Link: props => React.createElement('a', props), EquipmentDraftShareButton: ShareDraft,
    list, isLocalEventList: type === 'local_event', isMaintenanceList: type === 'maintenance',
    localEventTitle: list.event_name, localEventMeta: `${list.reference} · ${list.venue}`,
    canShareDraft: status === 'draft', canDeleteDraft: status === 'draft', canSubmitDraft: status === 'draft', canReview: status === 'pending',
    sharedDraft: false, pdfAction: null, rackRowsLoading: false, deletingList: false, submitting: false,
    savingDraftOrder: false, pendingCustomEdits: 0, items: [{}], cancellingList: false, approving: false, ...options.globals };
  const fixture = compile(`${helperCode}\nconst dates = scheduleRows(list);\nexport default function Fixture(){return (${source.slice(start, end)});}`, globals);
  return renderToStaticMarkup(React.createElement(fixture.default));
}

for (const type of ['dry_hire', 'local_event', 'transfer_out', 'transfer_in', 'maintenance', 'internal_use']) {
  test(`${type} has reference, status, type and details in compact heading`, () => {
    const html = renderHeader(type);
    const mobile = html.slice(html.indexOf('data-compact-list-heading'), html.indexOf('class="desktopHeading"'));
    assert.match(mobile, /DH-2026-0005/);
    assert.ok(mobile.includes(helpers.equipmentListTypeLabel(type)));
    assert.match(mobile, /<h1/);
    assert.ok(!mobile.includes('grid-cols-2'));
    assert.ok(!mobile.includes('truncate'));
  });
}
test('event name stays primary, with type and venue retained below it', () => {
  assert.match(renderHeader('local_event'), /<h1 class="title">Book Fair Event<\/h1>/);
  assert.match(renderHeader('local_event'), /<p class="details">Expo Sharjah<\/p>/);
});
test('dry hire dates are inline labeled terms, not mobile grid cards', () => {
  const html = renderHeader();
  assert.match(html, /<h1 class="title">Dry Hire<\/h1>/);
  assert.match(html, /<p class="details">Eventum<\/p>/);
  assert.match(html, /<dt>Pickup:<\/dt>/);
  assert.match(html, /<dt>Return:<\/dt>/);
});
test('all action icons retain explicit accessible names and existing permission gates', () => {
  const pending = renderHeader();
  for (const name of ['Share PDF', 'Download PDF', 'Cancel List', 'Approve &amp; Dispatch']) {
    assert.ok(pending.includes(`aria-label="${name}"`));
  }
  assert.ok(!pending.includes('aria-label="Delete draft"'));
  const draft = renderHeader('dry_hire', 'draft');
  for (const name of ['Share draft', 'Delete draft', 'Submit for approval']) assert.ok(draft.includes(`aria-label="${name}"`));
  assert.ok(!draft.includes('aria-label="Cancel List"'));
  const viewer = renderHeader('dry_hire', 'active');
  assert.ok(!viewer.includes('aria-label="Cancel List"'));
  assert.ok(!viewer.includes('aria-label="Submit for approval"'));
});
test('busy and empty states continue to disable their actions', () => {
  const html = renderHeader('dry_hire', 'pending', {globals: {approving: true}});
  assert.match(html, /aria-label="Cancel List"[^>]+disabled=""/);
  const empty = renderHeader('dry_hire', 'draft', {globals: {items: []}});
  assert.match(empty, /aria-label="Submit for approval"[^>]+disabled=""/);
});
test('notes, audit and long text are retained without HTML injection', () => {
  const html = renderHeader('dry_hire', 'pending', {list: {notes: 'Keep all accessories\nReturn in cases', client_company: '<script>long client</script>'}});
  assert.ok(html.includes('Keep all accessories\nReturn in cases'));
  assert.ok(html.includes('Created by Fixture user'));
  assert.ok(html.includes('&lt;script&gt;long client&lt;/script&gt;'));
});
test('CSS is phone scoped and targets only direct action buttons, not share dialog controls', () => {
  const css = fs.readFileSync(path.join(root, 'components/EquipmentListHeader.module.css'), 'utf8');
  assert.match(css, /^\.mobileHeading\s*\{\s*display: none;/);
  assert.match(css, /@media \(max-width: 639px\)/);
  assert.match(css, /\.actions > button \{/);
  assert.ok(!css.includes('.actions button {'));
});

module.exports = { renderHeader };

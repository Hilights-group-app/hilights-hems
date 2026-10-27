// Read-only archive tests with fake time and fake requests. No database access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function harness() {
  let now = 100000, seq = 0, visible = true, owner = true;
  const timers = new Map(), calls = [], states = [], responses = [];
  class FakeDate extends Date { static now() { return now; } }
  const globals = { Date: FakeDate, setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, {at: now + ms, fn}); return id; }, clearTimeout: id => timers.delete(id) };
  function load(file, imports = {}) {
    const exports = {};
    const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText;
    vm.runInNewContext(source, {exports, ...globals, require: name => imports[name]});
    return exports;
  }
  const refresh = load('lib/workspaceRefresh.ts');
  const api = load('lib/closedListFolders.ts', {'./workspaceRefresh': refresh});
  const folder = api.CLOSED_LIST_FOLDERS[0];
  const pager = api.createClosedFolderController({folder,
    isCurrent: () => owner, isVisible: () => visible,
    publish: value => states.push(value),
    async read(offset, pageSize) { calls.push({offset, pageSize}); const next = responses.shift(); return typeof next === 'function' ? next() : next ?? []; },
  });
  return {api, folder, pager, calls, states, responses,
    get state() {return states.at(-1);}, visible: value => {visible = value;}, owner: value => {owner = value;},
    async tick(ms = 0) {const end = now + ms; for (let i = 0; i < 1000; i++) {await settle(); const next = [...timers.entries()].filter(([,v]) => v.at <= end).sort((a,b)=>a[1].at-b[1].at)[0]; if(!next){now=end;await settle();return;} now=next[1].at;timers.delete(next[0]);next[1].fn();}throw Error('Timer overflow');},
  };
}
const row = (id, patch = {}) => ({id: String(id), list_type: 'transfer_out', status: 'closed', ...patch});
const page = (start, n) => Array.from({length:n}, (_, i) => row(start+i));

test('four folders have the requested order and shipment includes both transfer directions', () => {
  const h=harness();
  assert.deepEqual(Array.from(h.api.CLOSED_LIST_FOLDERS, f=>f.label), ['Shipment','Local Event','Dry Hire','Maintenance']);
  assert.equal(h.api.belongsToClosedFolder(row(1),h.folder),true);
  assert.equal(h.api.belongsToClosedFolder(row(2,{list_type:'transfer_in'}),h.folder),true);
  for (const status of ['draft','pending','active','partially_returned','cancelled']) assert.equal(h.api.belongsToClosedFolder(row(1,{status}),h.folder),false);
  assert.equal(h.api.belongsToClosedFolder(row(1,{list_type:'local_event'}),h.folder),false);
});
test('closed folders make no requests on mount or while invalidated collapsed', async()=>{
  const h=harness();h.pager.invalidate();await h.tick(5000);assert.equal(h.calls.length,0);
  h.pager.setOpen(true);await h.tick();assert.equal(h.calls.length,1);
});
test('cached folder reopens without another request while fresh',async()=>{
  const h=harness();h.responses.push([row(1)]);h.pager.setOpen(true);await h.tick();
  h.pager.setOpen(false);h.pager.setOpen(true);await h.tick(5000);assert.equal(h.calls.length,1);assert.equal(h.state.rows.length,1);
});
test('pagination loads older closed lists beyond the recent sidebar hundred',async()=>{
  const h=harness();for(let i=0;i<4;i++)h.responses.push(page(i*30,31));h.responses.push(page(120,5));
  h.pager.setOpen(true);await h.tick();for(let i=0;i<4;i++){h.pager.loadMore();await h.tick(1000);}
  assert.equal(h.state.rows.length,125);assert.equal(h.state.hasMore,false);
  assert.deepEqual(h.calls.map(c=>c.offset),[0,30,60,90,120]);
  h.pager.loadMore();await h.tick(5000);assert.equal(h.calls.length,5);
});
test('duplicate IDs are not displayed twice across pages',async()=>{
  const h=harness();h.responses.push(page(0,31),[row(29),row(30)]);h.pager.setOpen(true);await h.tick();h.pager.loadMore();await h.tick(1000);assert.equal(h.state.rows.length,31);
});
test('a malformed response cannot put another status or type in archive',async()=>{
  const h=harness();h.responses.push([row(1),row(2,{status:'active'}),row(3,{list_type:'maintenance'})]);h.pager.setOpen(true);await h.tick();assert.deepEqual(Array.from(h.state.rows,r=>r.id),['1']);
});
test('live invalidations coalesce into one read and refresh page one',async()=>{
  const h=harness();h.responses.push(page(0,31),[row('new')]);h.pager.setOpen(true);await h.tick();for(let i=0;i<100;i++)h.pager.invalidate();await h.tick(1000);assert.equal(h.calls.length,2);assert.equal(h.calls[1].offset,0);assert.equal(h.state.rows[0].id,'new');
});
test('slow reads never overlap and outdated results cannot replace latest archive',async()=>{
  const h=harness(),pending=deferred();h.responses.push(()=>pending.promise,[row('new')]);h.pager.setOpen(true);await h.tick();h.pager.invalidate();await h.tick(5000);assert.equal(h.calls.length,1);pending.resolve([row('old')]);await h.tick();assert.equal(h.calls.length,2);assert.equal(h.state.rows[0].id,'new');assert.ok(!h.states.some(s=>s.rows.some(r=>r.id==='old')));
});
test('collapsing before a queued refresh stops background requests',async()=>{
  const h=harness();h.pager.setOpen(true);h.pager.setOpen(false);await h.tick(5000);assert.equal(h.calls.length,0);h.pager.setOpen(true);await h.tick();assert.equal(h.calls.length,1);
});
test('hidden tabs defer reads and wake with one catchup',async()=>{
  const h=harness();h.visible(false);h.pager.setOpen(true);await h.tick(5000);assert.equal(h.calls.length,0);h.visible(true);h.pager.wake();await h.tick();assert.equal(h.calls.length,1);
});
test('failed older page preserves rows and retries the same offset',async()=>{
  const h=harness();h.responses.push(page(0,31),()=>{throw Error('timeout');},[row(30)]);h.pager.setOpen(true);await h.tick();h.pager.loadMore();await h.tick(1000);assert.equal(h.state.rows.length,30);assert.ok(h.state.error);h.pager.retry();await h.tick(1000);assert.deepEqual(h.calls.map(c=>c.offset),[0,30,30]);assert.equal(h.state.rows.length,31);assert.equal(h.state.error,'');
});
test('account changes and unmount discard pending results',async()=>{
  for(const action of ['owner','dispose']){const h=harness(),pending=deferred();h.responses.push(()=>pending.promise);h.pager.setOpen(true);await h.tick();const count=h.states.length;if(action==='owner')h.owner(false);else h.pager.dispose();pending.resolve([row('private')]);await h.tick(5000);assert.equal(h.states.length,count);}
});
test('folder request is read-only, server filtered, stably sorted, paginated and uses existing client',()=>{
  const source=fs.readFileSync(path.join(root,'components/ClosedListFolders.tsx'),'utf8');
  assert.match(source,/\.eq\("status", "closed"\)\.in\("list_type",/);
  assert.match(source,/\.order\("created_at", \{ ascending: false \}\)\.order\("id", \{ ascending: false \}\)/);
  assert.match(source,/\.range\(offset, offset \+ pageSize\)/);
  assert.doesNotMatch(source,/\.(insert|update|delete|rpc|channel)\(/);
  assert.match(source,/owner === getUserId\(\)/);
});
test('working transfer-out folder excludes closed/cancelled and new archive is below working groups',()=>{
  const source=fs.readFileSync(path.join(root,'components/EquipmentListsSidebar.tsx'),'utf8');
  assert.match(source,/\(\) => visibleLists\.filter\(\(list\) => list\.list_type === "transfer_out"\)/);
  assert.ok(!source.includes('historyLists'));
  assert.ok(source.lastIndexOf('<ClosedListFolders')>source.lastIndexOf('internalUseLists.map'));
});

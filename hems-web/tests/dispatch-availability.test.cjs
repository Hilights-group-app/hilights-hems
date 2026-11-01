const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readDispatchUnitIssues, isSerialAvailabilityError } = require('../lib/dispatchAvailability.ts');
const item = (id, extra = {}) => ({ id: `line-${id}`, inventory_record_id: id,
  inventory_record_type: 'unit', display_name: 'Novastar VX1000', metadata: { unit_no: 2 }, ...extra });
function client(rows, failure = null) {
  const calls = [];
  return { calls, from(table) {
    assert.equal(table, 'units');
    return { select(columns) {
      assert.equal(columns, 'id,unit_no,serial,status');
      return { in(column, ids) { calls.push(ids); assert.equal(column, 'id');
        return { async abortSignal() { return { data: rows.filter(r => ids.includes(r.id)), error: failure }; } }; } };
    } };
  } };
}
test('only the specific serialized dispatch failure starts diagnostics', () => {
  assert.equal(isSerialAvailabilityError({message:'One or more selected serial numbers are no longer available. Review the list and try again.'}), true);
  for (const message of ['Failed to fetch', 'permission denied', 'Only 2 units are available', '']) {
    assert.equal(isSerialAvailabilityError({message}), false);
  }
});
test('in-use unit is named with its live ID and serial', async () => {
  const c = client([{ id:'a',unit_no:12,serial:'00123',status:'in_use' }]);
  assert.deepEqual(await readDispatchUnitIssues(c,[item('a')]), [{itemId:'line-a',name:'Novastar VX1000',label:'ID: 12 · Serial: 00123',status:'In use'}]);
});
test('available and legacy null status are not false conflicts', async () => {
  const c = client([{id:'a',status:'available'},{id:'b',status:null}]);
  assert.deepEqual(await readDispatchUnitIssues(c,[item('a'),item('b')]), []);
});
test('missing serial / Not Available serial does not mean unavailable', async () => {
  const c = client([{id:'a',serial:null,status:'available'},{id:'b',serial:'Not Available',status:'available'}]);
  assert.deepEqual(await readDispatchUnitIssues(c,[item('a'),item('b')]), []);
});
test('all conflicting units are returned, with KSA and maintenance labels', async () => {
  const c = client([{id:'a',status:'in_ksa'},{id:'b',status:'maintenance'}]);
  const result = await readDispatchUnitIssues(c,[item('a'),item('b')]);
  assert.deepEqual(result.map(r=>r.status), ['In KSA','Maintenance / Failed']);
});
test('unreadable unit does not assert that stock was deleted', async () => {
  const result = await readDispatchUnitIssues(client([]),[item('a')]);
  assert.match(result[0].status,/could not be read/);
});
test('network / RLS error throws instead of inventing conflicts', async () => {
  await assert.rejects(readDispatchUnitIssues(client([],new Error('denied')),[item('a')]),/denied/);
});
test('custom and quantity records require no unit read', async () => {
  const c=client([]);
  assert.deepEqual(await readDispatchUnitIssues(c,[item('a',{inventory_record_type:'matrix_row'}),item('b',{metadata:{custom_item:true}}),item('c',{metadata:{custom_item:'true'}})]),[]);
  assert.equal(c.calls.length,0);
});
test('80-ID batches avoid response caps for large lists and preserve all 201 issues', async () => {
  const items=Array.from({length:201},(_,i)=>item(String(i)));
  const c=client(items.map(i=>({id:i.inventory_record_id,status:'in_use'})));
  assert.equal((await readDispatchUnitIssues(c,items)).length,201);
  assert.deepEqual(c.calls.map(c=>c.length),[80,80,41]);
});
test('repeated IDs are read once but all corresponding lines are identified', async () => {
  const c=client([{id:'a',status:'in_use'}]);
  assert.equal((await readDispatchUnitIssues(c,[item('a'),item('a',{id:'other-line'})])).length,2);
  assert.deepEqual(c.calls,[['a']]);
});
test('unknown status is shown honestly', async () => {
  const result=await readDispatchUnitIssues(client([{id:'a',status:'reserved'}]),[item('a')]);
  assert.equal(result[0].status,'reserved');
});
test('only small-screen brand changes; other HEMS branding remains',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../components/TopBar.tsx'),'utf8');
  assert.match(source, /className="sm:hidden">EMS<\/span><span className="hidden sm:inline">HEMS/);
  assert.match(source, /text-gray-900">HEMS<\/span>/);
});
test('UI keeps atomic RPC, scopes diagnostics, and offers inline / jump targets',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../components/EquipmentListDetailsClient.tsx'),'utf8');
  assert.match(source, /"approve_and_dispatch_equipment_list"/);
  assert.match(source, /isSerialAvailabilityError\(approvalError\)/);
  assert.match(source, /readDispatchUnitIssues\(supabase, items, isOffline\)/);
  assert.match(source, /getUserId\(\) === actionOwner/);
  assert.match(source, /role="alert"/);
  assert.match(source, /id=\{`dispatch-unit-\$\{issue.itemId\}`\}/);
  assert.match(source, /setDispatchIssues\(\[\]\); \}, \[listId, items\]/);
});
test('offline cached statuses are never presented as live diagnostics', async () => {
  const c=client([{id:'a',status:'in_use'}]);
  await assert.rejects(readDispatchUnitIssues(c,[item('a')],()=>true),/online connection/);
  assert.equal(c.calls.length,0);
  let checks=0;
  await assert.rejects(readDispatchUnitIssues(c,[item('a')],()=>++checks > 1),/online connection/);
});

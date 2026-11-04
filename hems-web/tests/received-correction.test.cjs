const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module');
const {receiptProgress,correctionPreview,canCorrectReceived}=require('../lib/receivedCorrection.ts');
const {canAppendDispatchedList}=require('../lib/equipmentLists.ts');
const {showActiveReturnQuantities}=require('../lib/listReturnQuantities.ts');
const {createListSelectionCache}=require('../lib/listSelectionCache.ts');
const source=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const line=(more={})=>({id:'line',list_id:'list',inventory_record_id:'truss',inventory_record_type:'matrix_model',
  requested_quantity:9,approved_quantity:9,returned_ok_quantity:8,returned_maintenance_quantity:0,display_name:'Truss',metadata:{},...more});
const list=(more={})=>({id:'list',reference:'EV-test',list_type:'local_event',status:'partially_returned',...more});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function actualFunction(file,start,end,name,deps) {
  const src=source(file),from=src.indexOf(start),to=src.indexOf(end,from);
  assert.ok(from>=0&&to>from,'locate the actual component callback');
  const code=stripTypeScriptTypes(src.slice(from,to),{mode:'strip'});
  return new Function(...Object.keys(deps),`${code};return ${name};`)(...Object.values(deps));
}

test('9 sent, incorrect 8 Received -> correct 1 Received / 8 Out without inflating Sent',()=>{
  const before=line();
  assert.deepEqual(receiptProgress(before),{sent:9,received:8,outside:1});
  assert.deepEqual(correctionPreview(before,1),{sent:9,oldOk:8,newOk:1,maintenance:0,reinstated:7,outside:8});
  assert.equal(before.approved_quantity,9);assert.equal(before.returned_ok_quantity,8,'preview never mutates stock or receipt');
});
test('correction does not change returned-to-Maintenance quantities',()=>{
  assert.deepEqual(correctionPreview(line({approved_quantity:12,returned_maintenance_quantity:2}),1),
    {sent:12,oldOk:8,newOk:1,maintenance:2,reinstated:7,outside:9});
});
test('fractional, negative, same, larger, NaN and invalid over-receipts are rejected',()=>{
  for(const quantity of [-1,1.5,8,9,NaN,Infinity]) assert.throws(()=>correctionPreview(line(),quantity));
  assert.throws(()=>correctionPreview(line({approved_quantity:7}),1));
});
test('only real managers in active / partial Local Event or Dry Hire can correct',()=>{
  for(const type of ['local_event','dry_hire']) for(const status of ['active','partially_returned']) {
    assert.equal(canCorrectReceived(list({list_type:type,status}),line(),true),true);
    assert.equal(canCorrectReceived(list({list_type:type,status}),line(),false),false);
    assert.equal(showActiveReturnQuantities(list({list_type:type,status})),true);
  }
  for(const type of ['maintenance','transfer_in','transfer_out','internal_use']) assert.equal(canCorrectReceived(list({list_type:type}),line(),true),false);
  for(const status of ['draft','pending','closed','cancelled']) assert.equal(canCorrectReceived(list({status}),line(),true),false);
});
test('custom equipment and unreceived lines cannot expose a correction action',()=>{
  for(const custom of [true,'true']) assert.equal(canCorrectReceived(list(),line({metadata:{custom_item:custom}}),true),false);
  assert.equal(canCorrectReceived(list(),line({inventory_record_type:'item'}),true),false);
  assert.equal(canCorrectReceived(list(),line({returned_ok_quantity:0}),true),false);
  assert.equal(canCorrectReceived(list(),line({inventory_record_type:'unit',approved_quantity:1,requested_quantity:1,returned_ok_quantity:1}),true),true);
});

function correctionHarness(options={}) {
  let owner='manager';const state={},calls=[],events=[],busy={current:false};
  const item=line(),parent=list();const window=new EventTarget();
  for(const event of ['items','lists']) window.addEventListener(event,e=>events.push(e.detail));
  const deps={busy,blocked:false,valid:true,preview:correctionPreview(item,1),owner,
    getUserId:()=>owner,canCorrectReceived,canManageEquipmentLists:()=>options.manager!==false,
    list:parent,item,isOffline:()=>Boolean(options.offline),mounted:{current:true},reason:'Entered 8 instead of 1',
    setError:value=>{state.error=value;},setSaving:value=>{state.saving=value;},setBlocked:value=>{state.blocked=value;},
    createClient:()=>({rpc(name,args){calls.push({name,args});return options.response || Promise.resolve({data:{list_status:'partially_returned'},error:null});}}),
    window,EQUIPMENT_LIST_ITEMS_EVENT:'items',EQUIPMENT_LISTS_EVENT:'lists',onSaved:()=>{state.saved=true;}};
  const save=actualFunction('components/ReceivedCorrectionDialog.tsx','  async function save() {','\n  if (typeof document','save',deps);
  return {save,state,calls,events,busy,owner:value=>{owner=value;},unmount:()=>{deps.mounted.current=false;}};
}
test('actual correction callback sends old counters + new total + reason, never a fabricated addition',async()=>{
  const h=correctionHarness();await h.save();assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].name,'hems_correct_received_ok_quantity');
  assert.deepEqual(h.calls[0].args,{p_list_item_id:'line',p_expected_ok:8,p_expected_maintenance:0,p_expected_approved:9,p_corrected_ok:1,p_reason:'Entered 8 instead of 1'});
  assert.equal(h.state.saved,true);assert.equal(h.events.length,2);
});
test('a rapid double-tap starts only one correction RPC',async()=>{
  const d=deferred(),h=correctionHarness({response:d.promise});const first=h.save();await h.save();assert.equal(h.calls.length,1);
  d.resolve({data:{list_status:'partially_returned'},error:null});await first;assert.equal(h.busy.current,false);
});
test('offline / non-manager correction makes no request',async()=>{
  for(const options of [{offline:true},{manager:false}]) {const h=correctionHarness(options);await h.save();assert.equal(h.calls.length,0);assert.ok(h.state.error);}
});
test('stale receipt returns an inline error and requires refresh, not an automatic retry',async()=>{
  const h=correctionHarness({response:Promise.resolve({data:null,error:{code:'40001',message:'Receipt changed'}})});await h.save();
  assert.equal(h.calls.length,1);assert.equal(h.state.saved,undefined);assert.equal(h.state.blocked,true);assert.match(h.state.error,/Receipt changed/);assert.equal(h.events.length,0);
});
test('an unknown network outcome cannot be silently retried as another correction',async()=>{
  const d=deferred(),h=correctionHarness({response:d.promise});const save=h.save();d.reject(new TypeError('Failed to fetch'));await save;
  assert.equal(h.state.blocked,true);assert.match(h.state.error,/Refresh the list/);assert.equal(h.calls.length,1);
});
test('late correction results do not update another owner or an unmounted page',async()=>{
  for(const change of ['owner','unmount']) {
    const d=deferred(),h=correctionHarness({response:d.promise});const save=h.save();
    if(change==='owner')h.owner('another user');else h.unmount();
    d.resolve({data:{list_status:'partially_returned'},error:null});await save;
    assert.equal(h.state.saved,undefined);assert.equal(h.events.length,0);
  }
});

function additionHarness(options={}) {
  const state={},calls=[],updates=[],cacheWrites=[],cacheInvalidations=[],events=[],busy={current:false};
  const current=list({status:options.status||'partially_returned'}),existing=line();let owner='manager';
  const window=new EventTarget();window.addEventListener('items',e=>events.push(e.detail));
  const client={rpc(name,args){calls.push({name,args});return options.response||Promise.resolve({data:{...existing,requested_quantity:16,approved_quantity:16},error:null});},
    from(){const query={update(payload){updates.push(payload);return query;},insert(payload){updates.push(payload);return query;},eq(){return query;},select(){return query;},single(){return Promise.resolve({data:{...existing,requested_quantity:7,approved_quantity:0},error:null});}};return query;}};
  const deps={activeList:current,saveBusy:busy,lineReady:options.lineReady!==false,loading:false,
    maintenanceList:false,reservations:{ready:true},canAppendDispatchedList,canManageEquipmentLists:()=>true,
    isOffline:()=>Boolean(options.offline),qty:v=>Math.max(0,Math.floor(Number(v)||0)),requested:7,available:options.available??20,
    setError:v=>{state.error=v;},setSaving:v=>{state.saving=v;},getUserId:()=>owner,
    mounted:{current:true},selectionScope:{current:{listId:current.id,owner}},target:{id:'truss',recordType:'matrix_model',displayName:'Truss',parentId:null},
    category:'truss-and-rigging',subcategory:'truss',supabase:client,existingLine:existing,
    setExistingLine:v=>{state.line=v;},setRequested:v=>{state.requested=v;},writeMatrixLineCache:(...v)=>cacheWrites.push(v),
    window,EQUIPMENT_LIST_ITEMS_EVENT:'items',setMessage:v=>{state.message=v;},setTimeout:()=>0,setOpen:v=>{state.open=v;},
    matrixLinesCache:{invalidate:id=>cacheInvalidations.push(id)},setLineReady:v=>{state.ready=v;}};
  const save=actualFunction('components/EquipmentListMatrixQuantityAction.tsx','  async function saveQuantity(', '\n  async function decreaseQuantity(', 'saveQuantity',deps);
  return {save,state,calls,updates,cacheWrites,cacheInvalidations,events,busy,owner:v=>{owner=v;}};
}
test('actual active Add sends an additional delta, not historical Sent=9 selected',async()=>{
  const h=additionHarness();await h.save();assert.equal(h.calls.length,1);assert.equal(h.updates.length,0);
  const {name,args}=h.calls[0];assert.equal(name,'hems_add_active_matrix_quantity');
  assert.equal(args.p_quantity,7);assert.equal(args.p_expected_requested,9);assert.equal(h.state.line.requested_quantity,16);
  assert.equal(h.state.requested,1);assert.match(h.state.message,/7 additional units dispatched/);
});
test('Draft and Pending still update TOTAL quantities through their existing guarded path',async()=>{
  for(const status of ['draft','pending']) {const h=additionHarness({status});await h.save();assert.equal(h.calls.length,0);assert.equal(h.updates[0].requested_quantity,7);assert.equal(h.state.requested,7);}
});
test('double-tap active Add starts one additional dispatch',async()=>{
  const d=deferred(),h=additionHarness({response:d.promise});const save=h.save();await h.save();assert.equal(h.calls.length,1);
  d.resolve({data:line({requested_quantity:16,approved_quantity:16}),error:null});await save;assert.equal(h.busy.current,false);
});
test('insufficient extra free stock, offline, or unverified selected lines block Add',async()=>{
  for(const options of [{available:6},{offline:true},{lineReady:false}]) {const h=additionHarness(options);await h.save();assert.equal(h.calls.length,0);assert.equal(h.updates.length,0);}
});
test('failed / uncertain addition invalidates the quantity snapshot and requires rechecking',async()=>{
  const h=additionHarness({response:Promise.resolve({data:null,error:{code:'40001',message:'List quantity changed'}})});await h.save();
  assert.equal(h.state.ready,false);assert.deepEqual(h.cacheInvalidations,['list']);assert.equal(h.cacheWrites.length,0);assert.equal(h.events.length,0);
});

test('actual shared list reader totals separate deliveries and rechecks receipts after correction',async()=>{
  const cache=createListSelectionCache(),window=new EventTarget();let rows=[line(),line({id:'second',approved_quantity:2,requested_quantity:2,returned_ok_quantity:0})],calls=0;
  const reader=actualFunction('components/EquipmentListMatrixQuantityAction.tsx','async function loadMatrixLinesShared(', '\nfunction writeMatrixLineCache(', 'loadMatrixLinesShared',{
    matrixLinesCache:cache,getUserId:()=> 'manager',window,EQUIPMENT_LIST_ITEMS_EVENT:'items',matrixLineKey:(t,id)=>`${t}:${id}`,
  });
  const client={from(){const q={select(){return q;},eq(){return q;},in(){return q;},order(){return q;},async range(a,b){calls++;return {data:rows.slice(a,b+1),error:null};}};return q;}};
  const before=(await reader(client,'list')).get('matrix_model:truss');assert.deepEqual(receiptProgress(before),{sent:11,received:8,outside:3});
  rows=[line({returned_ok_quantity:1}),rows[1]];window.dispatchEvent(new CustomEvent('items',{detail:{listId:'list'}}));
  const readers=await Promise.all(Array.from({length:40},()=>reader(client,'list')));
  for(const snapshot of readers)assert.deepEqual(receiptProgress(snapshot.get('matrix_model:truss')),{sent:11,received:1,outside:10});
  assert.equal(calls,2,'one shared read after correction, not one request per inventory row');
});

test('SQL install only adds RPCs, validates live definitions and preserves existing return / reservation guards',()=>{
  const sql=source('supabase/correct-received-active-quantity.sql');
  assert.equal((sql.match(/create or replace function/gi)||[]).length,2);
  assert.doesNotMatch(sql,/create or replace function public\.(return_equipment_list_item|hems_dispatch_list_addition|hems_guard_shared_draft_items|hems_assert_outgoing_reservation)/i);
  assert.match(sql,/c9a067d3b03bb51223412744e1ed62a8/);assert.match(sql,/365375b99fb971ba0bc577a88e262176/);assert.match(sql,/c279b3e4f2ab41a2cf293983ddaea760/);
  assert.doesNotMatch(sql,/disable trigger|disable row level security|pg_sleep|delete from|truncate|alter table/i);
});
test('SQL correction requires real role, active scope, reason, expected counters, stock lock and unreserved capacity',()=>{
  const sql=source('supabase/correct-received-active-quantity.sql').split('-- Positive additions')[0];
  for(const part of ["auth.uid() is null",'public.is_equipment_list_manager() is not true',"('local_event','dry_hire')","('active','partially_returned')",
    'length(reason)<5','p_expected_ok is distinct from','p_expected_maintenance is distinct from','p_expected_approved is distinct from',
    'pg_advisory_xact_lock(742193,1)','perform public.hems_assert_outgoing_reservation','occupied<active_qty',"'40001'"]) assert.ok(sql.includes(part),part);
  assert.match(sql,/set returned_ok_quantity=p_corrected_ok,updated_at=at_time where id=line.id/);
  assert.doesNotMatch(sql,/set (requested_quantity|approved_quantity|returned_maintenance_quantity)=/);
  assert.match(sql,/received_quantity_corrected/);assert.match(sql,/'reason',reason/);
  assert.match(sql,/revoke all on function[\s\S]+from public,anon/);assert.match(sql,/grant execute[\s\S]+to authenticated/);
});
test('additional delta SQL checks stale totals before writing, uses existing dispatch trigger, verifies Approved advanced',()=>{
  const sql=source('supabase/correct-received-active-quantity.sql').split('-- Positive additions')[1];
  assert.ok(sql.indexOf('p_expected_requested is distinct from')<sql.indexOf('update public.equipment_list_items set requested_quantity='));
  assert.match(sql,/requested_quantity=previous_requested\+p_quantity/);
  assert.match(sql,/line.approved_quantity is distinct from previous_approved\+p_quantity/);
  assert.match(sql,/perform public.hems_assert_outgoing_reservation/);
  assert.match(sql,/Use the LED cabinet picker/);
  assert.doesNotMatch(sql,/update public\.(units|matrix_rows|matrix_models)/,'dispatch stock is changed only by existing verified trigger');
});
test('active compact UI shows only Add, Draft retains selected total, correction remains available',()=>{
  const matrix=source('components/EquipmentListMatrixQuantityAction.tsx'),details=source('components/EquipmentListDetailsClient.tsx');
  const start=matrix.indexOf('if (compact && additionalMode)');
  assert.ok(start>=0);
  const activeCompact=matrix.slice(start,matrix.indexOf('\n  if (compact) {',start));
  assert.doesNotMatch(activeCompact,/progress\.(outside|sent|received)|text-blue|Selected/);
  assert.match(activeCompact,/Add additional equipment/);
  assert.match(activeCompact,/\{quantityDialogPortal\}/);
  assert.match(matrix,/const currentQuantity = existingLine \? qty\(existingLine.requested_quantity\) : 0/);
  assert.match(matrix,/Additional quantity/);assert.match(matrix,/Add & Dispatch/);
  assert.doesNotMatch(matrix,/canAppendDispatchedList\(activeList, canManageEquipmentLists\(\)\) \? qty\(existingLine\?\.requested_quantity\) : 0/);
  assert.match(details,/<ReceivedCorrectionAction list=\{list\} items=\{group.items\}/);
  assert.match(source('components/ReceivedCorrectionAction.tsx'),/items.filter\(item => canCorrectReceived/);
  assert.match(source('components/ReceivedCorrectionDialog.tsx'),/createPortal/);
});

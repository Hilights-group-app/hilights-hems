const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module');
const crypto=require('node:crypto');
const {reservationIndex,availableAfterReservations,withReservedStats}=require('../lib/pendingReservations.ts');
const {isSerialAvailabilityError}=require('../lib/dispatchAvailability.ts');
const source=(f)=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const row=(id,quantity=1,type='unit',parent='item')=>({record_type:type,record_id:id,parent_id:parent,quantity});
const deferred=()=>{let resolve;const promise=new Promise(ok=>{resolve=ok});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};

test('Pending reservations subtract Available, not total/in-use/maintenance/KSA',()=>{
 const physical={total:40,available:30,inUse:5,maintenance:3,inKsa:2};
 assert.deepEqual(withReservedStats(physical,20),{...physical,available:10,reserved:20});
 assert.equal(physical.available,30,'never mutate the physical/cache snapshot');
});
test('Drafts do not reserve: an empty aggregate leaves stock unchanged',()=>{
 const index=reservationIndex([]);assert.equal(index.quantity('matrix_row','cable'),0);assert.equal(availableAfterReservations(30,0),30);
});
test('Editing own Pending 20 -> 10 can reuse its own reservation',()=>{
 assert.equal(availableAfterReservations(30,25,20),25);
 assert.equal(availableAfterReservations(30,25,0),5,'another list cannot reuse the same 20');
});
test('cancel removes the aggregate, all stock is available again',()=>{
 assert.equal(availableAfterReservations(30,20),10);assert.equal(availableAfterReservations(30,0),30);
});
test('dispatch does not deduct twice: 20 reserved -> 20 physically in use',()=>{
 const total=30;
 assert.equal(availableAfterReservations(total,20),10);
 assert.equal(availableAfterReservations(total-20,0),10);
});
test('same model and row UUIDs cannot collide; LED reservation counts stay cabinets',()=>{
 const index=reservationIndex([row('x',20,'matrix_row','led'),row('x',3,'matrix_model','model')]);
 assert.equal(index.quantity('matrix_row','x'),20);assert.equal(index.quantity('matrix_model','x'),3);
 assert.equal(index.parent('matrix_row','led')*0.5,10,'20 cabinets = 10sqm at 0.5sqm each');
});
test('a reserved unit that later failed is not subtracted from another Available unit',()=>{
 const index=reservationIndex([{...row('failed'),available_quantity:0},row('available')]);
 assert.equal(index.quantity('unit','failed'),1);assert.equal(index.parent('unit','item'),1);
});
test('quantities clamp below zero and cannot add phantom capacity from own reservation',()=>{
 assert.equal(availableAfterReservations(5,20),0);assert.equal(availableAfterReservations(5,1,10),5);
});

// Run the actual store source with network/auth/React boundaries stubbed.
function store(){
 let owner='alice',offline=false,calls=0,authCallback,queue=[],timers=new Map(),sequence=0;
 const win=new EventTarget(),doc=new EventTarget();doc.visibilityState='visible';
 const fakeClient={rpc(name){assert.equal(name,'hems_pending_reservations');calls++;const result=queue.shift()??Promise.resolve({data:[],error:null});return {abortSignal(){return result;}};},auth:{onAuthStateChange(cb){authCallback=cb;return {data:{subscription:{unsubscribe(){}}}};}}};
 const fakeSet=(fn)=>{const id=++sequence;timers.set(id,fn);return id;};
 const code=stripTypeScriptTypes(source('lib/usePendingReservations.ts'),{mode:'strip'})
  .replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
 const api=new Function('useSyncExternalStore','createClient','getUserId','isOffline','reservationIndex','window','document','setTimeout','clearTimeout',
   `${code};return {subscribe,refreshPendingReservations,invalidatePendingReservations,readVerifiedPendingReservations,state:()=>snapshot};`)
   ((sub,get)=>get(),()=>fakeClient,()=>owner,()=>offline,reservationIndex,win,doc,fakeSet,id=>timers.delete(id));
 return {...api,events:win,calls:()=>calls,respond:result=>queue.push(Promise.resolve(result)),pending:promise=>queue.push(promise),
  owner(value){owner=value;authCallback?.('SIGNED_IN',{user:{id:value}});},offline(v){offline=v;},
  async timers(){const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());await flush();}};
}
test('100 mounted rows share one RPC; no new Realtime channel or polling',async()=>{
 const s=store();s.respond({data:[row('a')],error:null});
 for(let i=0;i<100;i++)s.subscribe(()=>{});
 await flush();assert.equal(s.calls(),1);assert.equal(s.state().index.quantity('unit','a'),1);
 assert.doesNotMatch(source('lib/usePendingReservations.ts'),/\.channel\(|setInterval\(/);
});
test('a burst of list/item events coalesces to one refreshed aggregate',async()=>{
 const s=store();s.subscribe(()=>{});await flush();s.respond({data:[row('a')],error:null});
 for(let i=0;i<20;i++)s.events.dispatchEvent(new Event('hems:equipment-list-items-change'));
 assert.equal(s.calls(),1);await s.timers();assert.equal(s.calls(),2);assert.equal(s.state().ready,true);
});
test('auth owner changes cannot expose the previous owner reservation snapshot',async()=>{
 const s=store();s.respond({data:[row('private')],error:null});s.subscribe(()=>{});await flush();
 s.owner('bob');assert.equal(s.state().rows.length,0);assert.equal(s.state().ready,false);
 s.respond({data:[],error:null});await s.timers();assert.equal(s.state().owner,'bob');assert.equal(s.state().rows.length,0);
});
test('late response started before submit/cancel cannot restore stale reservation quantities',async()=>{
 const s=store(),old=deferred();s.pending(old.promise);s.subscribe(()=>{});
 s.events.dispatchEvent(new Event('hems:equipment-lists-change'));
 s.respond({data:[row('cable',10,'matrix_row')],error:null});old.resolve({data:[row('cable',20,'matrix_row')],error:null});
 await flush();await s.timers();assert.equal(s.state().index.quantity('matrix_row','cable'),10);assert.equal(s.calls(),2);
});
test('failed verification retains the last good counters but blocks further outgoing adds',async()=>{
 const s=store();s.respond({data:[row('a')],error:null});s.subscribe(()=>{});await flush();
 s.respond({data:null,error:{message:'500'}});await s.refreshPendingReservations();
 assert.equal(s.state().index.quantity('unit','a'),1);assert.equal(s.state().ready,false);assert.match(s.state().error,/could not be checked/);
});
test('an offline read does not convert stale cached availability into live verified stock',async()=>{
 const s=store();s.offline(true);s.subscribe(()=>{});await flush();assert.equal(s.calls(),0);assert.equal(s.state().ready,false);
 await assert.rejects(s.readVerifiedPendingReservations(),/verify reservations/);
});
test('missing SQL function / malformed response fails closed, not zero reserved',async()=>{
 const s=store();s.respond({data:{message:'not installed'},error:null});s.subscribe(()=>{});await flush();
 assert.equal(s.state().ready,false);assert.match(s.state().error,/could not be checked/);
});
test('events while no reservation consumers are mounted invalidate memory without RPC pressure',async()=>{
 const s=store();const stop=s.subscribe(()=>{});await flush();stop();
 s.events.dispatchEvent(new Event('hems:equipment-lists-change'));await s.timers();assert.equal(s.calls(),1);assert.equal(s.state().ready,false);
});

test('SQL preserves the physical stock semantics: reservations are derived from Pending only',()=>{
 const sql=source('supabase/pending-stock-reservations.sql');
 const block=sql.slice(sql.indexOf('create or replace function public.hems_pending_reserved_quantity'),sql.indexOf('create or replace function public.hems_outgoing_free_quantity'));
 assert.match(block,/l.status::text='pending'/);assert.match(block,/internal_use/);
 assert.doesNotMatch(block,/\b(update|insert into|delete from)\b/i);
 assert.doesNotMatch(sql,/alter type|disable trigger|disable row level security/i);
});
test('SQL atomically checks submit, Pending edits, dispatch, and supplemental active additions',()=>{
 const sql=source('supabase/pending-stock-reservations.sql');
 assert.match(sql,/zz_hems_pending_reservation before insert or update/);
 assert.match(sql,/zz_hems_reserved_list_item before insert or update/);
 assert.ok((sql.match(/perform public.hems_assert_outgoing_reservation/g)||[]).length>=4);
 assert.match(sql,/pg_advisory_xact_lock\(742193,1\)/);
 assert.match(sql,/current_setting\('transaction_isolation'\)/);
 assert.match(sql,/No.*|Own Pending reservation is excluded/);
});
test('RPC has no references/names/notes or unrestricted public execution',()=>{
 const sql=source('supabase/pending-stock-reservations.sql');
 const rpc=sql.slice(sql.indexOf('create or replace function public.hems_pending_reservations()'),sql.indexOf('-- Private helpers'));
 assert.doesNotMatch(rpc,/l\.reference|l\.client|full_name|i\.list_id as|l\.id as|notes/);
 assert.match(rpc,/auth.uid\(\) is null/);assert.match(sql,/revoke all on function public.hems_pending_reservations\(\) from public,anon/);
});
test('Migration refuses conflicting legacy Pending stock; preflight is read-only',()=>{
 const sql=source('supabase/pending-stock-reservations.sql'),pre=source('supabase/pending-reservations-preflight.sql');
 assert.match(sql,/Validate ALL existing Pending/);assert.match(sql,/line\.reference \|\| ' · ' \|\| line\.name/);
 assert.match(pre,/requested>physical_available/);assert.doesNotMatch(pre,/^\s*(update|delete|insert|create|alter|drop)\s/gim);
});
test('Custom inventory, Maintenance, Transfer In bypass outgoing reservation adjustments',()=>{
 const sql=source('supabase/pending-stock-reservations.sql');
 assert.match(sql,/if parent.list_type::text = 'transfer_in' then return new/);
 assert.match(sql,/parent.list_type::text='maintenance' then 0/);
 assert.match(sql,/inventory_record_type::text in \('unit','matrix_model','matrix_row'\)/);
});
test('All serialized pickers, matrix/cable and LED quantity actions guard verified state',()=>{
 for(const f of ['EquipmentListUnitPicker','EquipmentListMatrixQuantityAction','EquipmentListQuantityPicker']){
  const s=source('components/'+f+'.tsx');assert.match(s,/usePendingReservations/);assert.match(s,/reservations.ready/);assert.match(s,/reservations.index/);
 }
});
test('Inventory/report components show Reserved without a database status enum change',()=>{
 for(const f of ['SubcategoryClientLighting','SubcategoryClientSerialized','SubcategoryClientProjectors','SubcategoryClientChainHoist','SubcategoryClientMatrix','SubcategoryClientLedScreen','LedScreenReportClient']){
  assert.match(source('components/'+f+'.tsx'),/ReservedForStock|ReservedStockBadge/);
 }
 for(const f of ['SerializedRowsBlock','ProjectorRowsBlock','ChainHoistRowsBlock']){
  const s=source('components/'+f+'.tsx');assert.match(s,/Reserved · Pending/);assert.match(s,/reservations.index.quantity\("unit",unit.id\) === 0/);
  assert.doesNotMatch(s,/status: "reserved"|status: 'reserved'/);
 }
});

function deployedFunction(name) {
 const sql=source('supabase/pending-stock-reservations.sql');
 const start=sql.indexOf('CREATE OR REPLACE FUNCTION public.'+name+'(');
 assert.ok(start>=0);const body=sql.indexOf('AS $function$',start);
 const end=sql.indexOf('$function$',body+'AS $function$'.length);
 return sql.slice(start,end+'$function$'.length);
}
function originalHash(text){return crypto.createHash('md5').update(text.replace(/\r/g,'').replace(/^[ \n\t;]+|[ \n\t;]+$/g,'')).digest('hex');}
test('Dispatch preserves every original stock/KSA/maintenance operation, adding only reservation check',()=>{
 const hashes=require('./fixtures/reservation-original-function-hashes.json');
 const patched=deployedFunction('approve_and_dispatch_equipment_list');
 const start=patched.indexOf('  -- Own Pending reservation is excluded;');
 const end=patched.indexOf('  for v_line in\n    select inventory_record_type, inventory_record_id, metadata,',start);
 assert.ok(start>0&&end>start);
 assert.equal(originalHash(patched.slice(0,start)+patched.slice(end)),hashes.approve_and_dispatch_equipment_list);
});
test('Supplemental dispatch retains its exact original behavior except the new reservation check',()=>{
 const hashes=require('./fixtures/reservation-original-function-hashes.json');
 const patched=deployedFunction('hems_dispatch_list_addition');
 const insert="  if new.inventory_record_type::text in ('unit','matrix_model','matrix_row') then\n    perform public.hems_assert_outgoing_reservation(new.inventory_record_type::text,new.inventory_record_id,delta,parent.id,new.display_name);\n  end if;\n";
 assert.ok(patched.includes(insert));assert.equal(originalHash(patched.replace(insert,'')),hashes.hems_dispatch_list_addition);
});
test('Cancellation function, RLS and role permissions are not replaced',()=>{
 const sql=source('supabase/pending-stock-reservations.sql');
 assert.doesNotMatch(sql,/CREATE OR REPLACE FUNCTION public.hems_cancel_pending_list/i);
 assert.doesNotMatch(sql,/create policy|drop policy|alter policy|grant.*on.*(units|equipment_list_items|equipment_lists)\b/i);
});
test('Missing reservation setup cannot falsely submit and claim Reserved',()=>{
 const s=source('components/EquipmentListDetailsClient.tsx');
 assert.match(s,/!reservations.ready[\s\S]{0,180}before submitting/);
 assert.match(s,/Equipment is Reserved until warehouse dispatch or cancellation/);
});
test('new structured unit errors still trigger the existing red dispatch diagnostics',()=>{
 assert.equal(isSerialAvailabilityError({message:'Only 0 available for Unit 12',details:JSON.stringify({record_type:'unit',record_id:'serial-id',reserved:1,available:0})}),true);
 assert.equal(isSerialAvailabilityError({details:'not JSON'}),false);
 assert.equal(isSerialAvailabilityError({details:JSON.stringify({record_type:'matrix_row',record_id:'cable'})}),false);
});

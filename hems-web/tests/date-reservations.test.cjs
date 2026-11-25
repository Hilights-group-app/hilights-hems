// No network, credentials, or live DB writes. SQL invariants + actual client-store
// tests. Calendar examples below are a reference oracle, not a PostgreSQL run.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module');
const root=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const {reservationIndex,availableAfterReservations}=require('../lib/pendingReservations.ts');
const {reservationLabelIndex}=require('../lib/reservationLabels.ts');
const sql=read('supabase/date-based-pending-reservations.sql');
const day=s=>Date.parse(`${s}T00:00:00Z`)/86400000;
function peak(bookings,start,end){
 const deltas=new Map();for(const b of bookings){const lo=Math.max(start==null?-Infinity:day(start),b.start==null?-Infinity:day(b.start));const hi=Math.min(end==null?Infinity:day(end)+1,b.end==null?Infinity:day(b.end)+1);if(lo>=hi)continue;deltas.set(lo,(deltas.get(lo)||0)+b.qty);deltas.set(hi,(deltas.get(hi)||0)-b.qty);}
 let used=0,max=0;for(const [,delta]of [...deltas].sort((a,b)=>a[0]-b[0])){used+=delta;max=Math.max(max,used);}return max;
}
test('inclusive return day conflicts; next day can reuse the same stock',()=>{
 const b=[{start:'2026-11-25',end:'2026-11-28',qty:20}];assert.equal(peak(b,'2026-11-28','2026-11-30'),20);assert.equal(peak(b,'2026-11-29','2026-11-30'),0);
});
test('a long booking sees peak concurrent demand, not sum of disjoint bookings',()=>{
 const b=[{start:'2026-11-25',end:'2026-11-26',qty:20},{start:'2026-11-27',end:'2026-11-28',qty:30}];assert.equal(peak(b,'2026-11-25','2026-11-28'),30);b.push({start:'2026-11-26',end:'2026-11-27',qty:4});assert.equal(peak(b,'2026-11-25','2026-11-28'),34);
});
test('Transfer Out/Internal Use unbounded reservations still block dated bookings',()=>{
 assert.equal(peak([{start:null,end:null,qty:5},{start:'2026-12-01',end:'2026-12-03',qty:10}],'2026-12-02','2026-12-05'),15);
});
test('own Pending reservation can be reused without subtracting another date bucket',()=>{
 const own={start:'2026-11-25',end:'2026-11-30',qty:10};const b=[own,{start:'2026-11-25',end:'2026-11-26',qty:5},{start:'2026-11-27',end:'2026-11-28',qty:7}];assert.equal(availableAfterReservations(30,peak(b,own.start,own.end),10),23);
});
test('migration uses NEW dates in BEFORE guard and validates whole-period concurrent demand',()=>{
 assert.match(sql,/hems_reservation_period\(to_jsonb\(new\),true\)/);assert.match(sql,/sum\(delta\) over\(partition by kind,rid order by day/);assert.match(sql,/group by kind,rid,day/);assert.match(sql,/greatest\(0,max\(used\)\)/);assert.match(sql,/daterange\(first_day,last_day,'\[\]'\)/);
});
test('dispatched stock is not released by date; early dispatch also protects TODAY',()=>{
 assert.match(sql,/hems_outgoing_free_quantity\(p_type,p_record_id\)/);assert.doesNotMatch(sql,/update public\.(units|matrix_models|matrix_rows|equipment_lists|equipment_list_items)/i);assert.match(sql,/least\(lower\(span\),today\)/);assert.match(sql,/greatest\(upper\(span\),today\+1\)/);assert.match(sql,/hems_assert_dispatch_reservation/);
});
test('server clock is Dubai and RPC authorization cannot expose another list',()=>{
 assert.match(sql,/now\(\) at time zone 'Asia\/Dubai'/);assert.match(sql,/auth.uid\(\) is null/);assert.match(sql,/public.hems_can_view_equipment_list\(l.id\)/);assert.match(sql,/revoke all on function public.hems_pending_window_totals\(daterange,uuid,text,uuid\) from public,anon,authenticated/);assert.doesNotMatch(sql,/disable trigger|disable row level security|create policy|drop policy/i);
});
const settle=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
function store(){
 let owner='alice',selection='',offline=false,authCallback,calls=[],queue=[],timers=new Map(),seq=0;
 const win=new EventTarget(),doc=new EventTarget();doc.visibilityState='visible';
 const code=stripTypeScriptTypes(read('lib/usePendingReservations.ts'),{mode:'strip'}).replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
 const client={rpc(name,args){assert.equal(name,'hems_dated_pending_reservations');calls.push(args.p_list_id);const next=queue.shift()||Promise.resolve({data:{version:1,period:{start:'2026-11-25',end:'2026-11-25'},rows:[]},error:null});return{abortSignal:()=>next};},auth:{onAuthStateChange(cb){authCallback=cb;}}};
 const api=new Function('createClient','getUserId','isOffline','reservationIndex','window','document','setTimeout','clearTimeout','ACTIVE_EQUIPMENT_LIST_EVENT','ACTIVE_EQUIPMENT_LIST_KEY','localStorage','reservationLabelIndex',`${code}\nreturn{subscribeContext,refreshPendingReservations,invalidatePendingReservations,readVerifiedPendingReservations,state:id=>entryFor(id).snapshot,selected:()=>selectedId};`)
 (()=>client,()=>owner,()=>offline,reservationIndex,win,doc,(fn,delay)=>{const id=++seq;timers.set(id,{fn,delay});return id;},id=>timers.delete(id),'hems:active-equipment-list-change','hems:active-equipment-list-id',{getItem:()=>selection||null},reservationLabelIndex);
 return{...api,calls,queue,win,timers,select(id){selection=id;win.dispatchEvent(new Event('hems:active-equipment-list-change'));},auth(id){owner=id;authCallback('SIGNED_IN',null);},offline(v){offline=v;},async flush(){const jobs=[...timers].filter(([,t])=>t.delay<1000);for(const [id,t]of jobs){timers.delete(id);t.fn();}await settle();}};
}
const answer=(id,quantity=1)=>({data:{version:1,period:{start:'2026-11-25',end:'2026-11-28'},rows:[{record_type:'matrix_row',record_id:id,parent_id:'model',quantity}]},error:null});
test('100 rows share one request per list/date context, with distinct caches for two drafts',async()=>{
 const s=store();s.queue.push(Promise.resolve(answer('cable',20)));for(let i=0;i<100;i++)s.subscribeContext('event-A',()=>{});await settle();s.queue.push(Promise.resolve(answer('cable',5)));s.subscribeContext('event-B',()=>{});await settle();assert.deepEqual(s.calls,['event-A','event-B']);assert.equal(s.state('event-A').index.quantity('matrix_row','cable'),20);assert.equal(s.state('event-B').index.quantity('matrix_row','cable'),5);
});
test('dated API missing/invalid response blocks edits; never silently falls back to globally summed stock',async()=>{
 const s=store();s.queue.push(Promise.resolve({data:[],error:null}));s.subscribeContext('event',()=>{});await settle();assert.equal(s.state('event').ready,false);s.queue.push(Promise.resolve({data:null,error:{code:'22007'}}));await s.refreshPendingReservations('event');assert.match(s.state('event').error,/valid start and end dates/);
});
test('late response cannot restore quantities from before date edit/submit/cancel',async()=>{
 const s=store();let resolve;s.queue.push(new Promise(ok=>resolve=ok));s.subscribeContext('event',()=>{});s.invalidatePendingReservations();s.queue.push(Promise.resolve(answer('cable',10)));resolve(answer('cable',20));await settle();await s.flush();assert.equal(s.state('event').index.quantity('matrix_row','cable'),10);
});
test('selection changes route default refresh to the selected draft, not the prior one',async()=>{
 const s=store();s.subscribeContext('',()=>{});await settle();s.select('event-B');await s.refreshPendingReservations();assert.equal(s.calls.at(-1),'event-B');
});
test('auth change immediately clears all date-context snapshots',async()=>{
 const s=store();s.queue.push(Promise.resolve(answer('cable',5)));s.subscribeContext('event',()=>{});await settle();s.auth('bob');assert.equal(s.state('event').ready,false);assert.equal(s.state('event').rows.length,0);await s.flush();assert.equal(s.state('event').owner,'bob');
});
test('Dubai midnight schedules one bounded timeout, not a polling interval per item',async()=>{
 const s=store();s.subscribeContext('',()=>{});await settle();const midnight=[...s.timers.values()].find(t=>t.delay>1000);assert.ok(midnight&&midnight.delay<=86400100);midnight.fn();assert.equal(s.state('').ready,false);await s.flush();assert.equal(s.calls.length,2);assert.doesNotMatch(read('lib/usePendingReservations.ts'),/setInterval|\.channel\(/);
});
test('explicit list scope is used in detail quantity edits and both picker types',()=>{
 assert.match(read('components/EquipmentListDetailsClient.tsx'),/usePendingReservations\(listId\)/);for(const file of ['EquipmentListQuantityPicker','EquipmentListUnitPicker'])assert.match(read(`components/${file}.tsx`),/usePendingReservations\(list.id\)/);assert.match(read('components/EquipmentListMatrixQuantityAction.tsx'),/usePendingReservations\(activeList\?\.id\)/);
});

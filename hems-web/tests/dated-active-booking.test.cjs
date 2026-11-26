// Pure calendar oracle + real client index + SQL safety invariants.
// No credentials/network/live database changes. SQL execution is tested separately.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {reservationIndex}=require('../lib/pendingReservations.ts');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const sql=read('supabase/dated-active-booking-availability.sql');
test('every exported SQL function ends with its outer statement semicolon',()=>{
 const matches=[...sql.matchAll(/AS \$function\$[\s\S]*?\$function\$(.)/g)];
 assert.equal(matches.length,4);
 for(const match of matches)assert.equal(match[1],';','missing semicolon after function body');
});
const day=s=>Date.parse(s+'T00:00:00Z')/86400000;
function forecast({total=100,maintenance=0,ksa=0,inUse=0,bookings=[],start='2026-12-07',end='2026-12-12',today='2026-11-25',exclude=null}){
 const active=bookings.filter(b=>b.state==='active'),hold=active.reduce((n,b)=>n+b.qty,0);
 const missing=active.reduce((n,b)=>n+Math.min(b.qty,b.missing||0),0);
 const base=Math.max(0,total-maintenance-ksa-Math.max(0,inUse-hold)-missing);
 const events=new Map();for(const b of bookings){if(b.state==='pending'&&b.id===exclude)continue;
   const active=b.state==='active',lo0=b.start?day(b.start):-Infinity,hi0=b.end?day(b.end)+1:Infinity;
   const lo=Math.max(day(start),active?Math.min(lo0,day(today)):lo0);
   const hi=Math.min(day(end)+1,active?Math.max(hi0,day(today)+1):hi0);
   const q=b.qty-(active?Math.min(b.qty,b.missing||0):0);if(lo>=hi)continue;
   events.set(lo,(events.get(lo)||0)+q);events.set(hi,(events.get(hi)||0)-q);
 }
 let used=0,peak=0;for(const [,delta] of [...events].sort((a,b)=>a[0]-b[0])){used+=delta;peak=Math.max(peak,used);}
 return Math.max(0,base-peak);
}
const active={state:'active',start:'2026-11-22',end:'2026-11-26',qty:40};
test('Dry Hire 22–26 Nov is bookable 7–12 Dec without physically receiving it',()=>{
 assert.equal(forecast({inUse:40,bookings:[active]}),100);
 assert.equal(forecast({inUse:40,bookings:[active],start:'2026-11-26',end:'2026-11-27'}),60);
});
test('Local Event uses the same inclusive date overlap and can reuse next day',()=>{
 assert.equal(forecast({inUse:40,bookings:[active],start:'2026-11-27',end:'2026-12-01'}),100);
 assert.match(sql,/hems_reservation_period\(to_jsonb\(parent\),true\)/);
 assert.match(sql,/target->>'list_type' in \('local_event','dry_hire'\)/);
});
test('sum of separate Active and Pending peaks must not overbook OR double deduct',()=>{
 const a={...active,start:'2026-12-07',end:'2026-12-08',qty:40};
 const b={state:'pending',start:'2026-12-10',end:'2026-12-12',qty:50};
 assert.equal(forecast({inUse:40,bookings:[a,b]}),50);
 assert.equal(forecast({inUse:40,bookings:[a,{...b,start:'2026-12-08'}]}),10);
});
test('own Pending reservation is excluded, but not another booking',()=>{
 const own={state:'pending',id:'own',start:'2026-12-07',end:'2026-12-12',qty:20};
 const other={...own,id:'other',qty:10};
 assert.equal(forecast({bookings:[own,other]}),70);
 assert.equal(forecast({bookings:[own,other],exclude:'own'}),90);
});
test('unreturned overdue Active equipment remains held today, not automatically released',()=>{
 assert.equal(forecast({inUse:40,bookings:[active],today:'2026-12-08'}),60);
});
test('Missing, Maintenance, KSA, and unknown in-use stock are never forecast as returned',()=>{
 assert.equal(forecast({maintenance:5,ksa:20,inUse:45,bookings:[{...active,missing:3}]}),67);
 assert.equal(forecast({inUse:45,bookings:[]}),55);
});
test('undated transfers/internal use keep holding stock over all target periods',()=>{
 assert.equal(forecast({inUse:40,bookings:[{...active,start:null,end:null}]}),60);
});
test('real client planning index overrides physical zero, without changing stock counters',()=>{
 const physical={total:40,available:0,inUse:40};
 const index=reservationIndex([],{enabled:true,rows:[{record_type:'unit',record_id:'u',parent_id:'fixture',available:1,own_available:1,physical_available:0}]});
 assert.equal(index.available('unit','u',0),1);assert.equal(index.parentAdjustment('unit','fixture'),1);
 assert.deepEqual(physical,{total:40,available:0,inUse:40});
});
test('LED availability remains cabinets, conversion to sqm stays in the UI',()=>{
 const index=reservationIndex([],{enabled:true,rows:[{record_type:'matrix_row',record_id:'led',parent_id:'model',available:400,own_available:400,physical_available:120}]});
 assert.equal(index.available('matrix_row','led',120)*0.25,100);
 assert.match(sql,/case when r.item_id is not null then coalesce\(r.total_qty,0\) else coalesce\(r.qty,0\) end/);
});
test('own Pending edit uses verified server capacity, not blindly adding its quantity back',()=>{
 const index=reservationIndex([{record_type:'matrix_row',record_id:'cable',parent_id:'model',quantity:20}],{enabled:true,rows:[
 {record_type:'matrix_row',record_id:'cable',parent_id:'model',available:5,own_available:25,physical_available:0}]});
 assert.equal(index.available('matrix_row','cable',0),5);assert.equal(index.available('matrix_row','cable',0,true),25);
});
test('no selected dated Draft/Pending means physical availability, not forecast',()=>{
 const index=reservationIndex([],{enabled:false,rows:[{record_type:'unit',record_id:'u',available:1,own_available:1,physical_available:0}]});
 assert.equal(index.available('unit','u',0),0);assert.equal(index.planning,false);
 assert.equal(index.available('unit','unknown',0),0);
});
test('malformed planning counters cannot create NaN or negative availability',()=>{
 const index=reservationIndex([],{enabled:true,rows:[{record_type:'unit',record_id:'u',available:NaN,own_available:1,physical_available:0}]});
 assert.equal(index.available('unit','u',0),0);
});
test('migration does not alter Dispatch, active additions, inventory or historical rows',()=>{
 assert.doesNotMatch(sql,/create or replace function public\.(approve_and_dispatch_equipment_list|hems_assert_dispatch_reservation|hems_assert_outgoing_window|hems_dispatch_list_addition)\(/i);
 const planningOnly=sql.split('-- Include the previously requested Admin-only Dry Hire')[0];
 assert.doesNotMatch(planningOnly,/\b(update|delete from|insert into) public\.(units|matrix_models|matrix_rows|equipment_lists|equipment_list_items)\b/i);
 assert.doesNotMatch(sql,/\b(update|delete from|insert into) public\.(units|matrix_models|matrix_rows|equipment_list_items)\b/i);
 assert.match(sql,/pg_advisory_xact_lock\(742193,1\)/);assert.match(sql,/transaction_isolation/);
 assert.match(sql,/hems_outgoing_free_quantity\(p_type,p_record_id\)/);
});
test('migration retains authorization, private helpers, function guards, and dated labels',()=>{
 assert.match(sql,/hems_can_view_equipment_list\(l.id\)/);assert.match(sql,/auth.uid\(\) is null/);
 assert.match(sql,/revoke all on function public.hems_planning_stock\(daterange,uuid,text,uuid\) from public,anon,authenticated/);
 assert.match(sql,/md5\(btrim/);assert.match(sql,/Live function % changed/);
 assert.match(sql,/'labels',public.hems_pending_reservation_labels\(span\)/);
 assert.match(sql,/group by kind,rid,day/);assert.match(sql,/sum\(delta\) over\(partition by kind,rid order by day/);
 assert.match(sql,/u.expiry_date/);
});
test('six inventory pages and three quantity paths use planning values; reports stay physical',()=>{
 for(const name of ['Lighting','Serialized','Projectors','ChainHoist','Matrix','LedScreen']){
   const code=read(`components/SubcategoryClient${name}.tsx`);assert.match(code,/reservations.index\.(available|parentAdjustment)\(/);
 }
 for(const name of ['EquipmentListDetailsClient','EquipmentListMatrixQuantityAction','EquipmentListQuantityPicker','EquipmentListUnitPicker']){
   assert.match(read(`components/${name}.tsx`),/reservations.index.available\(/);
 }
 assert.match(read('components/EquipmentListUnitPicker.tsx'),/status.eq.available,status.is.null,status.eq.in_use/);
 assert.match(read('lib/usePendingReservations.ts'),/reservationIndex\(rows,data.planning\)/);
});

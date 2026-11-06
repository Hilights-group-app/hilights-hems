const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
const {canMarkMissing,missingCount,missingOutside,validateMissingQuantity,missingLineLabel,missingSearchPattern}=require('../lib/missingEquipment.ts');
const {listReturnQuantities}=require('../lib/listReturnQuantities.ts');
const {receiptProgress,correctionPreview}=require('../lib/receivedCorrection.ts');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const activeCode=stripTypeScriptTypes(read('lib/activeListLayout.ts'),{mode:'strip'}).replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
const {activeRowCounts,activeSerialStatus,canReceiveActiveItem}=new Function('listReturnQuantities',`${activeCode};return {activeRowCounts,activeSerialStatus,canReceiveActiveItem};`)(listReturnQuantities);
const line=(extra={})=>({id:'line',list_id:'event',inventory_record_type:'matrix_model',inventory_record_id:'stock',display_name:'Truss',metadata:{},requested_quantity:9,approved_quantity:9,returned_ok_quantity:1,returned_maintenance_quantity:0,missing_quantity:0,...extra});
const list=(extra={})=>({id:'event',reference:'EV-1',list_type:'local_event',status:'active',...extra});

test('Missing is distinct from Received, and is excluded from actionable Out',()=>{
 const item=line({missing_quantity:3});assert.equal(missingOutside(item),5);assert.deepEqual(receiptProgress(item),{sent:9,received:1,outside:5});
 const counts=activeRowCounts([item]);assert.deepEqual([counts.sent,counts.received,counts.outside],[9,1,5]);assert.equal(item.missing_quantity,3);
});
test('only managers on active Local Event / Dry Hire may report registered equipment',()=>{
 for(const type of ['local_event','dry_hire'])for(const status of ['active','partially_returned'])assert.equal(canMarkMissing(list({list_type:type,status}),line(),true),true);
 for(const type of ['maintenance','transfer_in','transfer_out','internal_use'])assert.equal(canMarkMissing(list({list_type:type}),line(),true),false);
 for(const status of ['draft','pending','closed','cancelled'])assert.equal(canMarkMissing(list({status}),line(),true),false);
 assert.equal(canMarkMissing(list(),line(),false),false);
 for(const item of [line({inventory_record_type:'item'}),line({metadata:{custom_item:true}}),line({metadata:{custom_item:'true'}}),line({missing_quantity:8})])assert.equal(canMarkMissing(list(),item,true),false);
});
test('missing serialized equipment has an explicit Missing status and cannot also be Received',()=>{
 const item=line({inventory_record_type:'unit',approved_quantity:1,returned_ok_quantity:0,missing_quantity:1});
 assert.equal(activeSerialStatus(item).label,'Missing');assert.equal(canReceiveActiveItem(item),false);assert.equal(canMarkMissing(list(),item,true),false);
 assert.match(missingLineLabel({...item,metadata:{unit_no:0},serial_number:'ABC'}),/ID 0 · Serial: ABC/);
});
test('LED active quantities exclude Missing cabinets using the same SQM geometry',()=>{
 const item=line({inventory_record_type:'matrix_row',approved_quantity:20,requested_quantity:20,returned_ok_quantity:2,missing_quantity:4,metadata:{cabinet_size:'500x1000'}});
 const counts=activeRowCounts([item],true);assert.deepEqual([counts.sent,counts.received,counts.outside,counts.squareMetres],[10,1,7,true]);
});
test('correcting a false receipt does not turn Missing into Out again',()=>{
 const item=line({returned_ok_quantity:5,missing_quantity:2});assert.equal(correctionPreview(item,1).outside,6);assert.equal(correctionPreview(item,1).reinstated,4);
});
test('quantities and literal search patterns are bounded; fractional/empty/over-limit edits fail',()=>{
 assert.equal(validateMissingQuantity('2',5),2);
 for(const value of ['',0,-1,1.5,6,NaN,Infinity])assert.throws(()=>validateMissingQuantity(value,5));
 assert.equal(missingCount(undefined),0);assert.equal(missingCount(-3),0);
 assert.equal(missingSearchPattern('  PAR_50%  '),'%PAR\\_50\\%%');assert.equal(missingSearchPattern('A'.repeat(300)).length,152);
});
test('exhaustive sent/received/missing combinations conserve visible stock; Missing is never Received',()=>{
 for(let sent=1;sent<40;sent++)for(let received=0;received<=sent;received++)for(let missing=0;missing<=sent-received;missing++){
   const counts=activeRowCounts([line({approved_quantity:sent,returned_ok_quantity:received,missing_quantity:missing})]);
   assert.equal(counts.sent,counts.received+counts.outside+missing);assert.equal(counts.received,received);assert.equal(missingOutside(line({approved_quantity:sent,returned_ok_quantity:received,missing_quantity:missing})),counts.outside);
 }
});

function dialog(props,options={}){
 const source=read('components/MissingEquipmentDialog.tsx'),start=source.indexOf('  async function save()'),end=source.indexOf('  if(typeof document',start),changes=[],rpc=[];
 const env={props,item:props.mode==='mark'?props.items[0]:undefined,amount:options.amount??1,note:options.note??'Lost during event',owner:'owner',valid:options.valid??true,blocked:false,
   busy:{current:false},mounted:{current:true},requestId:{current:''},request:{current:null},getUserId:()=>options.owner??'owner',canManageEquipmentLists:()=>options.manager??true,isOffline:()=>options.offline??false,
   canMarkMissing,missingCount,createBrowserId:()=> 'request-id',AbortController,clearTimeout,window:{setTimeout:()=>123,dispatchEvent:event=>changes.push(['event',event.type])},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},
   setError:value=>changes.push(['error',value]),setSaving:value=>changes.push(['saving',value]),setBlocked:value=>changes.push(['blocked',value]),EQUIPMENT_LISTS_EVENT:'lists',EQUIPMENT_LIST_ITEMS_EVENT:'items',MISSING_EQUIPMENT_EVENT:'missing',
   createClient:()=>({rpc(name,params){rpc.push({name,params});return{abortSignal:async signal=>{assert.ok(signal instanceof AbortSignal);return options.result??{data:{},error:null};}};}}),
 };
 const save=new Function(...Object.keys(env),stripTypeScriptTypes(source.slice(start,end),{mode:'strip'})+';return save;')(...Object.values(env));return{save,env,changes,rpc};
}
test('actual dialog submits exact expected counters and request ID; duplicate clicks cannot start two writes',async()=>{
 let saved=0;const d=dialog({mode:'mark',list:list(),items:[line({missing_quantity:2})],onSaved:()=>saved++},{amount:2});
 const first=d.save();await d.save();await first;assert.equal(d.rpc.length,1);assert.equal(d.rpc[0].name,'hems_mark_missing');assert.equal(d.rpc[0].params.p_expected_missing,2);assert.equal(d.rpc[0].params.p_quantity,2);assert.equal(d.rpc[0].params.p_request_id,'request-id');assert.equal(saved,1);assert.equal(d.changes.filter(c=>c[0]==='event').length,3);
});
test('actual dialog rejects offline / changed user / unauthorized role without issuing a mutation',async()=>{
 for(const options of [{offline:true},{owner:'other'},{manager:false},{valid:false}]){const d=dialog({mode:'mark',list:list(),items:[line()],onSaved:()=>assert.fail('must not save')},options);await d.save();assert.equal(d.rpc.length,0);}
});
test('actual recovery dialog uses the ledger expected counter, not the historical Sent total',async()=>{
 let saved=0;const d=dialog({mode:'recover',entry:{id:'loss',list_id:'event',recovered_quantity:2},onSaved:()=>saved++},{amount:3});await d.save();assert.equal(d.rpc[0].name,'hems_recover_missing');assert.equal(d.rpc[0].params.p_expected_recovered,2);assert.equal(d.rpc[0].params.p_quantity,3);assert.equal(saved,1);
});
test('unknown / stale RPC errors block edits until a refresh and never announce a false success',async()=>{
 for(const error of [{message:'Failed to fetch'},{code:'40001',message:'Stale'}]){
  const d=dialog({mode:'mark',list:list(),items:[line()],onSaved:()=>assert.fail('must not save')},{result:{error}});await d.save();assert.ok(d.changes.some(c=>c[0]==='blocked'&&c[1]===true));assert.ok(!d.changes.some(c=>c[0]==='event'));
 }
});
test('a late completion after unmount/user change does not touch the next screen',async()=>{
 const d=dialog({mode:'mark',list:list(),items:[line()],onSaved:()=>assert.fail('late success')});d.env.mounted.current=false;await d.save();assert.ok(!d.changes.some(c=>c[0]==='event'));
});

const sql=read('supabase/missing-equipment.sql');
test('SQL is transactional, guarded against changed live workflows and never silently disables RLS',()=>{
 assert.match(sql,/begin;[\s\S]*set local lock_timeout='5s'/);assert.match(sql,/notify pgrst, 'reload schema';\s*commit;/);
 for(const name of ['return_equipment_list_item','hems_correct_received_ok_quantity','hems_guard_shared_draft_items','hems_outgoing_free_quantity','hems_dispatch_list_addition'])assert.match(sql,new RegExp(`pg_get_functiondef\\(to_regprocedure\\('public\\.${name}`));
 assert.doesNotMatch(sql,/disable row level security|set_config\(|session_replication_role|truncate|drop table/i);
 assert.match(sql,/enable row level security/);assert.match(sql,/revoke all on public\.hems_missing_equipment from public,anon,authenticated/);assert.match(sql,/grant select on public\.hems_missing_equipment to authenticated/);
});
test('SQL Missing keeps existing occupied stock, snapshots attribution and protects historical references',()=>{
 const mark=sql.slice(sql.indexOf('create or replace function public.hems_mark_missing('),sql.indexOf('create table if not exists public.hems_missing_recoveries'));
 assert.doesNotMatch(mark,/update public\.(units|matrix_models|matrix_rows)\s+set/);
 for(const token of ['p_expected_approved','p_expected_ok','p_expected_maintenance','p_expected_missing','is_equipment_list_manager() is not true','parent.created_by_name','parent.created_at','parent.venue','line.serial_number','parent.event_name','jsonb_strip_nulls','already_saved'])assert.ok(mark.includes(token),token);
 assert.match(mark,/missing_quantity=missing_quantity\+p_quantity/);assert.match(mark,/remaining=0 then 'closed'/);assert.match(sql,/on delete restrict/);
 assert.doesNotMatch(mark,/avatar_url|photo_data|coalesce\(line.metadata,'\{\}'/);assert.match(mark,/length\(line.metadata->>'photo_url'\)<=2048/);
});
test('SQL recovery is optimistic, idempotent and releases ledger before physical stock, all atomically',()=>{
 const recover=sql.slice(sql.indexOf('create or replace function public.hems_recover_missing('));
 assert.match(recover,/p_expected_recovered is distinct from entry.recovered_quantity/);assert.match(recover,/receipt.missing_id<>entry.id/);assert.match(recover,/expected_hold:=public.hems_missing_expected_hold/);
 assert.ok(recover.indexOf('update public.hems_missing_equipment')<recover.indexOf('update public.units'));
 assert.match(recover,/missing_quantity=missing_quantity-p_quantity,returned_ok_quantity=coalesce\(returned_ok_quantity,0\)\+p_quantity/);
 assert.match(recover,/in_use_qty=in_use_qty-p_quantity/);assert.match(recover,/if changed<>1 then raise exception/);assert.match(recover,/insert into public.hems_missing_recoveries/);
 assert.doesNotMatch(recover.slice(0,recover.indexOf('revoke all')),/set status='active'/);
});
test('SQL guards prevent receive/delete/relink or stock release while unresolved Missing remains',()=>{
 assert.match(sql,/new.missing_quantity is distinct from held/);assert.match(sql,/new.returned_maintenance_quantity,0\)\+new.missing_quantity>coalesce\(new.approved_quantity,0\)/);
 assert.match(sql,/if new.status::text is distinct from 'in_use'/);assert.match(sql,/coalesce\(new.in_use_qty,0\)<held/);assert.match(sql,/before update of id,status or delete/);
 assert.match(sql,/stock includes % Missing/);assert.match(sql,/new.inventory_record_id is distinct from old.inventory_record_id/);
});
test('patched Receive preserves exported maintenance/photo/report logic; allocation/sharing functions are not replaced',()=>{
 const start=sql.indexOf('CREATE OR REPLACE FUNCTION public.return_equipment_list_item('),end=sql.indexOf('$function$',sql.indexOf('$function$',start)+10)+10;
 let definition=sql.slice(start,end);
 definition=definition.replace('v_remaining := greatest(0, v_approved - v_returned - coalesce(v_line.missing_quantity,0));','v_remaining := greatest(0, v_approved - v_returned);')
  .replace('approved_quantity - returned_ok_quantity - returned_maintenance_quantity - missing_quantity','approved_quantity - returned_ok_quantity - returned_maintenance_quantity')
  .replace("where list_id = v_list.id and inventory_record_type::text<>'item' and coalesce(metadata->>'custom_item','false')<>'true';",'where list_id = v_list.id;')
  .replace('  perform pg_catalog.pg_advisory_xact_lock(742193,1);\n\n','');
 const hash=crypto.createHash('md5').update(definition.replace(/\r/g,'').replace(/^[ \n\t;]+|[ \n\t;]+$/g,'')).digest('hex');assert.equal(hash,'c9a067d3b03bb51223412744e1ed62a8');
 for(const name of ['hems_outgoing_free_quantity','hems_dispatch_list_addition','hems_guard_shared_draft_items'])assert.doesNotMatch(sql,new RegExp('create or replace function public\\.'+name,'i'));
});
test('Missing page performs paginated scoped reads on demand, with no polling or new Realtime pressure',()=>{
 const page=read('components/MissingEquipmentClient.tsx');assert.match(page,/\.from\("hems_missing_equipment"\)/);assert.match(page,/PAGE_SIZE=50/);assert.match(page,/\.ilike\("search_text",missingSearchPattern\(search\)\)/);assert.match(page,/owner!==getUserId\(\)/);
 assert.doesNotMatch(page,/setInterval|\.channel\(|\.from\("profiles"\)|avatar_url|location\.reload|router\.refresh/);
 assert.match(page,/record.list_created_by_name/);assert.match(page,/record.reported_by_name/);assert.match(page,/record.location/);assert.match(page,/record.list_created_at/);
 assert.match(read('components/EquipmentListsSidebar.tsx'),/href="\/inventory\/missing"/);
});
test('the active table uses a compact Missing icon and includes lost quantities in PDF/history',()=>{
 const table=read('components/ActiveListEquipmentTable.tsx'),details=read('components/EquipmentListDetailsClient.tsx');
 assert.match(table,/items.filter\(item=>canMarkMissing\(list,item,manager\)\)/);assert.match(table,/props.onMissing\(missingEligible\)/);assert.match(table,/Missing<\/small>/);
 assert.match(details,/const LIST_ITEM_SELECT = `[\s\S]*missing_quantity,/);assert.match(details,/Missing \(unavailable; recorded in Missing Equipment\)/);assert.match(details,/mode="mark" list=\{list\} items=\{missingItems\}/);
});

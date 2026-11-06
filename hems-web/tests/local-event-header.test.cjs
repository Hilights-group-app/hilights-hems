const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
const {canEditLocalEventHeader,localEventHeaderInput}=require('../lib/localEventHeader.ts');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const list=(more={})=>({id:'event',list_type:'local_event',status:'draft',event_name:'Old event',venue:'Expo Sharjah',created_by:'owner',shared_with:['shared'],...more});
test('all roles can edit names/locations on their own or shared Local Event draft, but not unrelated drafts',()=>{
 for(const role of ['admin','warehouse_manager','head','viewer']){assert.equal(canEditLocalEventHeader(list(),'owner',role),true);assert.equal(canEditLocalEventHeader(list(),'shared',role),true);}
 assert.equal(canEditLocalEventHeader(list(),'other','viewer'),false);assert.equal(canEditLocalEventHeader(list(),'other','warehouse_manager'),false);assert.equal(canEditLocalEventHeader(list(),'other','admin'),true);assert.equal(canEditLocalEventHeader(list(),null,'admin'),false);
});
test('after Submit only Admin may rename; non Local Event and cancelled lists stay excluded',()=>{
 for(const status of ['pending','active','partially_returned','closed']){assert.equal(canEditLocalEventHeader(list({status}),'admin','admin'),true);for(const role of ['head','warehouse_manager','viewer'])assert.equal(canEditLocalEventHeader(list({status}),'owner',role),false);}
 for(const list_type of ['dry_hire','transfer_out','maintenance','internal_use','transfer_in'])assert.equal(canEditLocalEventHeader(list({list_type}),'owner','admin'),false);
 assert.equal(canEditLocalEventHeader(list({status:'cancelled'}),'owner','admin'),false);
});
test('draft fields trim and validate, submitted edits preserve exact existing location including null',()=>{
 assert.deepEqual(localEventHeaderInput(list(),'  Book Fair  ','  DWTC  '),{eventName:'Book Fair',venue:'DWTC'});
 for(const [name,location] of [['','DWTC'],['a'.repeat(201),'DWTC'],['Event',''],['Event','a'.repeat(301)]])assert.throws(()=>localEventHeaderInput(list(),name,location));
 assert.deepEqual(localEventHeaderInput(list({status:'pending'}),' New name ','Attempted location change'),{eventName:'New name',venue:'Expo Sharjah'});
 assert.equal(localEventHeaderInput(list({status:'active',venue:null}),'Event','new').venue,null);
});
function editor(options={}){
 const source=read('components/LocalEventHeaderEdit.tsx'),start=source.indexOf('  async function save()'),end=source.indexOf('  if(!allowed)',start),calls=[],changes=[];
 const env={busy:{current:false},blocked:false,owner:'owner',getUserId:()=>options.user??'owner',role:options.role??'head',list:list(options.list),snapshot:list(options.list),name:options.name??'New event',location:options.location??'New location',
  canEditLocalEventHeader,localEventHeaderInput,isOffline:()=>options.offline??false,mounted:{current:true},request:{current:null},AbortController,clearTimeout,
  window:{setTimeout:()=>123,dispatchEvent:event=>changes.push(['event',event])},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},EQUIPMENT_LISTS_EVENT:'lists',
  createClient:()=>({rpc(name,params){calls.push({name,params});return{abortSignal:async()=>options.result??{error:null,data:{}}};}}),
  setError:value=>changes.push(['error',value]),setSaving:value=>changes.push(['saving',value]),setOpen:value=>changes.push(['open',value]),setBlocked:value=>changes.push(['blocked',value]),onSaved:()=>changes.push(['saved']),
 };
 const save=new Function(...Object.keys(env),stripTypeScriptTypes(source.slice(start,end),{mode:'strip'})+';return save;')(...Object.values(env));return{save,env,calls,changes};
}
test('actual editor submits expected header/status values and prevents duplicate save clicks',async()=>{
 const d=editor();const first=d.save();await d.save();await first;assert.equal(d.calls.length,1);assert.equal(d.calls[0].name,'hems_edit_local_event_header');assert.deepEqual(d.calls[0].params,{p_list_id:'event',p_event_name:'New event',p_venue:'New location',p_expected_name:'Old event',p_expected_venue:'Expo Sharjah',p_expected_status:'draft'});assert.ok(d.changes.some(c=>c[0]==='saved'));
});
test('actual editor blocks offline, wrong user, unauthorized submitted user, and invalid fields without RPCs',async()=>{
 for(const options of [{offline:true},{user:'other'},{list:{status:'pending'}},{name:''},{location:''}]){const d=editor(options);await d.save();assert.equal(d.calls.length,0);assert.ok(!d.changes.some(c=>c[0]==='saved'));}
});
test('actual Admin submitted edit sends the original venue, never the editable input',async()=>{
 const d=editor({role:'admin',list:{status:'active'},location:'Not permitted'});await d.save();assert.equal(d.calls[0].params.p_venue,'Expo Sharjah');
});
test('unknown/stale responses require refresh; late unmounted callbacks never alter another page',async()=>{
 for(const error of [{message:'Failed to fetch'},{code:'40001',message:'Event changed'}]){const d=editor({result:{error}});await d.save();assert.ok(d.changes.some(c=>c[0]==='blocked'&&c[1]===true));assert.ok(!d.changes.some(c=>c[0]==='saved'));}
 const d=editor();d.env.mounted.current=false;await d.save();assert.ok(!d.changes.some(c=>c[0]==='saved'||c[0]==='event'));
});
test('Current List is a read-only grouped summary; Open List and the collapse control stay available',()=>{
 const sidebar=read('components/EquipmentListsSidebar.tsx');
 assert.doesNotMatch(sidebar,/Serial \/ Fixture ID|Unit without serial|listItemUnitLabel|removeListItem|removingListItemId/);
 const start=sidebar.indexOf('{activeList ? ('),end=sidebar.indexOf('{loading ? (',start),summary=sidebar.slice(start,end);
 assert.ok(start>0&&end>start);assert.match(summary,/groupQuantity/);assert.match(summary,/groupSquareMetres/);assert.match(summary,/group.displayName/);assert.match(summary,/Open List/);assert.match(summary,/onClick=\{clearActiveList\}/);assert.doesNotMatch(summary,/\.delete\(|Remove this unit/);
 assert.match(sidebar,/<WorkingListFolder/);assert.match(sidebar,/href="\/inventory\/missing"/);
 assert.match(read('components/EquipmentListDetailsClient.tsx'),/async function removeItem/);
});
const sql=read('supabase/local-event-header-edit.sql');
test('SQL uses a guarded body fingerprint and preserves existing Submit/Share ownership checks',()=>{
 assert.match(sql,/md5\(btrim\(replace\(body/);assert.match(sql,/Stop and export hems_guard_equipment_draft_sharing/);
 assert.match(sql,/to_jsonb\(new\)-'event_name'-'venue'-'updated_at'/);
 assert.match(sql,/Only the draft creator can change or submit this draft/);assert.match(sql,/Only the creator can share a draft/);
 const baseline=read('supabase/equipment-draft-sharing.sql').match(/create or replace function public.hems_guard_equipment_draft_sharing\(\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/i)[1];
 const patched=sql.match(/create or replace function public.hems_guard_equipment_draft_sharing\(\)[\s\S]*?as \$function\$([\s\S]*?)\$function\$;/i)[1];
 const start=patched.indexOf('    -- Scoped metadata-only exception'),end=patched.indexOf("    if old.list_type::text in ('dry_hire'",start);
 assert.ok(start>0&&end>start);assert.equal(patched.slice(0,start)+patched.slice(end),baseline);
 const digest=value=>crypto.createHash('md5').update(value.replace(/\r/g,'').trim()).digest('hex');assert.ok(sql.includes(digest(baseline)));assert.ok(sql.includes(digest(patched)));
});
test('SQL RPC validates access, exact expected fields and Admin-only post-submit names; no permissions/stock expansion',()=>{
 for(const token of ['caller is null','public.hems_can_view_equipment_list(id) for update',"parent.list_type::text<>'local_event'","role_name is distinct from 'admin'",'p_venue is distinct from parent.venue','p_expected_status','p_expected_name','p_expected_venue',"errcode='40001'",'old_event_name','new_event_name','old_location','new_location'])assert.ok(sql.includes(token),token);
 assert.match(sql,/update public.equipment_lists set event_name=event_title,venue=location_name,updated_at=now\(\) where id=parent.id/);
 assert.doesNotMatch(sql,/drop policy|disable row level security|grant update|update public\.(units|matrix_models|matrix_rows|equipment_list_items)|set_config\(/i);
 assert.match(sql,/revoke all on function public.hems_edit_local_event_header\(uuid,text,text,text,text,text\) from public,anon/);assert.match(sql,/notify pgrst, 'reload schema';\s*commit;/);
});

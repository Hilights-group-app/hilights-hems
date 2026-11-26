const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
const {canEditDryHireHeader,dryHireHeaderInput}=require('../lib/dryHireHeader.ts');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const list=(more={})=>({id:'hire',reference:'DH-2026-0005',list_type:'dry_hire',status:'pending',client_company:'Old client',pickup_date:'2026-11-25',return_date:'2026-11-28',...more});
test('only signed-in Admin can edit submitted Dry Hire, including active/closed; drafts and other types stay excluded',()=>{
 for(const status of ['pending','active','partially_returned','closed']){assert.equal(canEditDryHireHeader(list({status}),'admin','admin'),true);for(const role of ['warehouse_manager','head','viewer'])assert.equal(canEditDryHireHeader(list({status}),'creator',role),false);}
 for(const status of ['draft','cancelled'])assert.equal(canEditDryHireHeader(list({status}),'admin','admin'),false);
 for(const type of ['local_event','transfer_out','transfer_in','maintenance','internal_use'])assert.equal(canEditDryHireHeader(list({list_type:type}),'admin','admin'),false);
 assert.equal(canEditDryHireHeader(list(),null,'admin'),false);
});
test('input trims company, accepts inclusive same-day hire and validates actual calendar dates',()=>{
 assert.deepEqual(dryHireHeaderInput(' Mediapro ','2026-11-25','2026-11-25'),{client_company:'Mediapro',pickup_date:'2026-11-25',return_date:'2026-11-25'});
 assert.doesNotThrow(()=>dryHireHeaderInput('Client','2028-02-29','2028-03-01'));
 for(const args of [['','2026-11-25','2026-11-28'],['a'.repeat(201),'2026-11-25','2026-11-28'],['Client','','2026-11-28'],['Client','2026-11-25','2026-11-24'],['Client','2026-02-29','2026-03-01'],['Client','2026-11-31','2026-12-03']])assert.throws(()=>dryHireHeaderInput(...args));
});
function editor(options={}){
 const source=read('components/DryHireHeaderEdit.tsx'),start=source.indexOf('  async function save()'),end=source.indexOf('  if(!allowed)',start),calls=[],changes=[];
 const env={busy:{current:false},blocked:false,owner:'admin',role:options.role??'admin',getUserId:()=>options.user??'admin',list:list(options.list),snapshot:list(options.list),name:options.name??' Mediapro ',pickup:options.pickup??'2026-11-26',returned:options.returned??'2026-11-30',
 canEditDryHireHeader,dryHireHeaderInput,isOffline:()=>options.offline??false,mounted:{current:true},request:{current:null},AbortController,clearTimeout,
 window:{setTimeout:()=>1,dispatchEvent:event=>changes.push(['event',event])},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},EQUIPMENT_LISTS_EVENT:'lists',
 createClient:()=>({rpc(name,params){calls.push({name,params});return{abortSignal:async()=>options.result??{error:null,data:{id:'hire',client_company:'Mediapro',pickup_date:'2026-11-26',return_date:'2026-11-30'}}};}}),
 setError:value=>changes.push(['error',value]),setSaving:value=>changes.push(['saving',value]),setOpen:value=>changes.push(['open',value]),setBlocked:value=>changes.push(['blocked',value]),onSaved:value=>changes.push(['saved',value]),
 };
 const save=new Function(...Object.keys(env),stripTypeScriptTypes(source.slice(start,end),{mode:'strip'})+';return save;')(...Object.values(env));return{save,env,calls,changes};
}
test('actual editor sends exact old name/dates/status and serializes double Save clicks',async()=>{
 const d=editor();const first=d.save();await d.save();await first;assert.equal(d.calls.length,1);assert.deepEqual(d.calls[0],{name:'hems_edit_dry_hire_header',params:{p_list_id:'hire',p_client_company:'Mediapro',p_pickup_date:'2026-11-26',p_return_date:'2026-11-30',p_expected_name:'Old client',p_expected_pickup:'2026-11-25',p_expected_return:'2026-11-28',p_expected_status:'pending'}});assert.ok(d.changes.some(c=>c[0]==='saved'));assert.ok(d.changes.some(c=>c[0]==='event'));
});
test('actual editor prevents non-Admin, offline, other-user and invalid edits before RPC',async()=>{
 for(const options of [{role:'warehouse_manager'},{role:'head'},{offline:true},{user:'other'},{name:''},{returned:'2026-11-20'},{list:{status:'draft'}}]){const d=editor(options);await d.save();assert.equal(d.calls.length,0);assert.ok(!d.changes.some(c=>c[0]==='saved'));}
});
test('conflict/invalid dates allow correction; stale, denied and uncertain writes require refresh',async()=>{
 for(const code of ['23514','22007']){const d=editor({result:{error:{code,message:'Date conflict'}}});await d.save();assert.ok(d.changes.some(c=>c[0]==='blocked'&&c[1]===false));assert.ok(!d.changes.some(c=>c[0]==='saved'));}
 for(const result of [{error:{code:'40001',message:'Changed'}},{error:{code:'42501',message:'Admin only'}},{error:{message:'Failed to fetch'}},{data:{},error:null}]){const d=editor({result});await d.save();assert.ok(d.changes.some(c=>c[0]==='blocked'&&c[1]===true));assert.ok(!d.changes.some(c=>c[0]==='saved'));}
});
test('late response after unmount does not publish names or update another page',async()=>{
 const d=editor();d.env.mounted.current=false;await d.save();assert.ok(!d.changes.some(c=>c[0]==='saved'||c[0]==='event'));
});
test('new editor integrates beside Local Event editor, has phone icon and both date fields',()=>{
 const details=read('components/EquipmentListDetailsClient.tsx'),source=read('components/DryHireHeaderEdit.tsx');assert.ok(details.includes('<DryHireHeaderEdit'));assert.ok(details.includes('<LocalEventHeaderEdit'));assert.ok(source.includes('hidden hems-wide:inline'));assert.equal((source.match(/type="date"/g)||[]).length,2);assert.ok(source.includes('aria-modal="true"'));assert.ok(source.includes('createPortal'));assert.ok(details.includes('listReadVersion.current++;setList'));
});
const sql=read('supabase/dry-hire-admin-header-edit.sql');
test('SQL authorizes Admin server-side and also protects direct post-submit name/date updates',()=>{
 assert.match(sql,/caller is null or public.hems_current_user_role\(\) is distinct from 'admin'/);assert.match(sql,/old.list_type::text='dry_hire' and old.status::text<>'draft'/);for(const field of ['client_company','pickup_date','return_date'])assert.ok(sql.includes(`new.${field} is distinct from old.${field}`));assert.match(sql,/hems_can_view_equipment_list\(id\) for update/);assert.match(sql,/revoke all on function public.hems_edit_dry_hire_header\(uuid,text,date,date,text,date,date,text\) from public,anon/);assert.doesNotMatch(sql,/create policy|drop policy|disable row level security|disable trigger|set_config\(/i);
});
test('name-only bypass cannot bypass date, quantity, sharing or status validation',()=>{
 assert.match(sql,/to_jsonb\(new\)-'client_company'-'updated_at'/);assert.doesNotMatch(sql,/to_jsonb\(new\)-'client_company'-'pickup_date'/);assert.match(sql,/old.status::text='pending' and new.status::text='pending'/);assert.match(sql,/hems_check_dry_hire_header_dates\(to_jsonb\(new\)\)/);assert.match(sql,/hems_reservation_target_period\(p_list,true\)/);
});
test('date/stock checks are read-only; own dispatched stock stays deducted and overlapping Pending must fit remaining capacity',()=>{
 assert.match(sql,/hems_outgoing_free_quantity\(line.kind,line.inventory_record_id\)/);assert.match(sql,/hems_pending_window_totals\(span,target_list_id,line.kind,line.inventory_record_id\)/);assert.match(sql,/coalesce\(reserved,0\)>free/);assert.match(sql,/p_list->>'status' not in \('active','partially_returned'\)/);assert.doesNotMatch(sql,/update public\.(units|matrix_models|matrix_rows|equipment_list_items)/i);assert.match(sql,/set client_company=company,pickup_date=p_pickup_date,return_date=p_return_date,updated_at=now\(\)/);assert.match(sql,/old_client_company/);assert.match(sql,/old_pickup_date/);assert.match(sql,/old_return_date/);assert.match(sql,/p_expected_status/);
});
test('both modified trigger functions have matching source fingerprints and insertion anchors',()=>{
 const refs=[['supabase/local-event-header-edit.sql','hems_guard_equipment_draft_sharing',"  if tg_op = 'UPDATE' then"],['supabase/date-based-pending-reservations.sql','hems_guard_pending_reservation','  perform pg_catalog.pg_advisory_xact_lock(742193,1);']];
 for(const [file,name,needle]of refs){const m=read(file).match(new RegExp('create or replace function public\\.'+name+'\\s*\\([\\s\\S]*?\\bas\\s+(\\$[a-z_]*\\$)([\\s\\S]*?)\\1;','i'));assert.ok(m);const hash=crypto.createHash('md5').update(m[2].replace(/\r/g,'').trim()).digest('hex');assert.ok(sql.includes(hash));assert.equal(m[2].split(needle).length-1,1);}
 assert.match(sql,/do not bypass this guard/);assert.match(sql,/pg_advisory_xact_lock\(742193,1\)/);assert.match(sql,/errcode='40001'/);
});

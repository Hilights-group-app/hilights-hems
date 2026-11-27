const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {reservationLabelIndex,reservationDateLabel}=require('../lib/reservationLabels.ts');
const {reservationIndex}=require('../lib/pendingReservations.ts');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
const label=(extra={})=>({record_type:'unit',record_id:'serial-1',parent_id:'cobra',list_id:'hire-1',list_type:'dry_hire',label:'Mediapro',quantity:1,start_date:'2026-11-16',end_date:'2026-12-03',...extra});
test('15 serialized fixtures group into one company/date badge without changing stock',()=>{
 const rows=Array.from({length:15},(_,i)=>label({record_id:`serial-${i}`})),index=reservationLabelIndex(rows);
 assert.equal(index.details('unit','cobra',true).length,1);assert.equal(index.details('unit','cobra',true)[0].quantity,15);assert.equal(index.details('unit','serial-3')[0].quantity,1);
});
test('separate bookings for same equipment retain separate names, dates and quantities',()=>{
 const index=reservationLabelIndex([label(),label({list_id:'event-2',list_type:'local_event',label:'Book Fair · Expo Sharjah',quantity:4,start_date:'2026-12-05',end_date:'2026-12-10'})]);assert.equal(index.details('unit','cobra',true).length,2);assert.equal(index.details('matrix_row','serial-1').length,0);
});
test('calendar labels use Dubai dates and include years across year boundaries',()=>{
 assert.equal(reservationDateLabel('2026-11-16','2026-12-03','2026'),'16 Nov – 3 Dec');assert.equal(reservationDateLabel('2026-12-31','2027-01-02','2026'),'31 Dec 2026 – 2 Jan 2027');assert.equal(reservationDateLabel('2026-11-25','2026-11-25','2026'),'25 Nov');assert.equal(reservationDateLabel(null,null),'No date limit');assert.equal(reservationDateLabel('bad','2026-12-03'),'Dates unavailable');
});
test('LED labels stay cabinet-based in data; display converts to sqm once',()=>{
 const index=reservationLabelIndex([label({record_type:'matrix_row',record_id:'led',quantity:60})]);assert.equal(index.details('matrix_row','led')[0].quantity,60);assert.equal(index.details('matrix_row','led')[0].quantity*0.25,15);
});
test('hidden-list metadata never needs a label, list UUID or dates in the browser',()=>{
 const index=reservationLabelIndex([], [{record_type:'unit',record_id:'serial-1',parent_id:'cobra'}]);assert.equal(index.hidden('unit','serial-1'),true);assert.equal(index.hidden('unit','cobra',true),true);assert.deepEqual(index.details('unit','cobra',true),[]);
});
test('index does not mutate RPC rows and ignores invalid quantities',()=>{
 const rows=[Object.freeze(label()),label({quantity:NaN}),label({quantity:-2})];const i=reservationLabelIndex(rows);assert.equal(rows[0].quantity,1);assert.equal(i.details('unit','cobra',true)[0].quantity,1);
});
function compile(s){if(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES)return require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright/lib/transform/babelBundle.js').babelTransform(s,'Badge.tsx',false,[],[]).code;return require('typescript').transpileModule(s,{compilerOptions:{module:1,jsx:4,target:9}}).outputText;}
const jsx=(type,props)=>({type,props});let state;const moduleExports={};
new Function('require','exports',compile(read('components/ReservedStockBadge.tsx')))(name=>name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='@/lib/usePendingReservations'?{usePendingReservations:()=>state,refreshPendingReservations:()=>{}}:name==='@/lib/reservationLabels'?{reservationDateLabel}:assert.fail(name),moduleExports);
function resolve(v){if(v==null||typeof v!=='object')return v;if(Array.isArray(v))return v.map(resolve);if(typeof v.type==='function')return resolve(v.type(v.props));return{...v,props:{...v.props,children:resolve(v.props?.children)}};}
const text=v=>v==null||typeof v==='boolean'?'':typeof v!=='object'?String(v):Array.isArray(v)?v.map(text).join(''):text(v.props?.children);
function render(rows,quantity=0,props={},hidden=[]){state={index:reservationIndex(quantity?[{record_type:'unit',record_id:'serial-1',parent_id:'cobra',quantity}]:[]),labels:reservationLabelIndex(rows,hidden)};return resolve(moduleExports.ReservedForStock({type:'unit',id:'cobra',parent:true,...props}));}
test('actual inventory badge shows company, quantity and dates even for a future booking',()=>{
 const tree=render([label({quantity:15})]);assert.match(text(tree),/15 pcs · Reserved for Mediapro/);assert.match(text(tree),/16 Nov – 3 Dec/);assert.doesNotMatch(text(tree),/Reserved for checked period/);
});
test('actual badge shows each event separately and hides generic duplicate for authorized lists',()=>{
 const tree=render([label({quantity:15}),label({list_id:'event',label:'Book Fair · Expo Sharjah',quantity:4})],19);assert.match(text(tree),/15 pcs · Reserved for Mediapro/);assert.match(text(tree),/4 pcs · Reserved for Book Fair/);assert.doesNotMatch(text(tree),/19 pcs/);
});
test('aggregate remains anonymous for inaccessible Pending lists',()=>{
 assert.equal(text(render([],15)),'15 pcs · Reserved');const tree=render([label()],5,{},[{record_type:'unit',record_id:'serial-1',parent_id:'cobra'}]);assert.match(text(tree),/5 pcs · Reserved for checked period \(includes other lists\)/);assert.match(text(tree),/Mediapro/);
});
test('display has no stock action, nested anchor or button and handles zero/invalid LED area',()=>{
 const tree=render([label({quantity:60})],0,{area:0.25,unit:'sqm'});assert.match(text(tree),/15 sqm/);assert.equal(render([label()],0,{area:0}),null);assert.equal(render([label()],0,{area:NaN}),null);assert.doesNotMatch(read('components/ReservedStockBadge.tsx').slice(read('components/ReservedStockBadge.tsx').indexOf('export function ReservedForStock')),/<Link|<a\b|<button/);
});
test('SQL is display-only, permission-filtered and preserves original availability response',()=>{
 const sql=read('supabase/reserved-labels-and-dates.sql');assert.match(sql,/hems_can_view_equipment_list\(l.id\)/);assert.match(sql,/from facts where visible is true/);assert.match(sql,/auth.uid\(\) is null/);assert.match(sql,/revoke all on function public.hems_pending_reservation_labels\(daterange\) from public,anon,authenticated/);assert.match(sql,/l.status::text='pending'/);assert.match(sql,/upper\(c.span\)>today/);assert.doesNotMatch(sql,/update public|insert into public|delete from public|create policy|disable trigger|alter table/i);assert.match(sql,/'labels',public.hems_pending_reservation_labels\(span\)/);assert.doesNotMatch(sql,/create or replace function public.hems_(assert|pending_window|reservation_period)/);
});

const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),{stripTypeScriptTypes}=require('node:module');
const root=path.resolve(__dirname,'..');
function load(file,names,imports={}){
 const source=stripTypeScriptTypes(fs.readFileSync(path.join(root,file),'utf8'),{mode:'strip'})
   .replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
 return new Function(...Object.keys(imports),`${source};return {${names.join(',')}};`)(...Object.values(imports));
}
const {listReturnQuantities}=load('lib/listReturnQuantities.ts',['listReturnQuantities']);
const {localEventLedCabinetArea}=load('lib/activeListLayout.ts',['localEventLedCabinetArea'],{listReturnQuantities});
const {activePdfCounts,activePdfTable,showActivePdfColumns,filterActiveListGroups}=load('lib/activeListPdf.ts',[
 'activePdfCounts','activePdfTable','showActivePdfColumns','filterActiveListGroups',
],{localEventLedCabinetArea});
const list=(type='local_event',status='active')=>({list_type:type,status});
const line=(extra={})=>({id:'line',display_name:'Equipment',inventory_record_type:'matrix_model',inventory_record_id:'stock',requested_quantity:9,
 approved_quantity:9,returned_ok_quantity:1,returned_maintenance_quantity:0,missing_quantity:0,metadata:{},...extra});
test('9 Sent, 1 Received, 8 Out; not the requested draft total',()=>{
 assert.deepEqual(activePdfCounts(list(),[line({requested_quantity:99})]),{sent:'9',received:'1',out:'8'});
});
test('received includes repair returns; Missing is not Received or Out',()=>{
 assert.deepEqual(activePdfCounts(list(),[line({returned_ok_quantity:3,returned_maintenance_quantity:2,missing_quantity:1})]),{sent:'9',received:'5',out:'3'});
});
test('sum serials per line so over-return on one cannot cancel another Out unit',()=>{
 const a=line({inventory_record_type:'unit',approved_quantity:1,requested_quantity:1,returned_ok_quantity:7});
 const b=line({inventory_record_type:'unit',approved_quantity:1,requested_quantity:1,returned_ok_quantity:0});
 assert.deepEqual(activePdfCounts(list(),[a,b]),{sent:'2',received:'1',out:'1'});
});
test('LED uses actual geometry for all three amounts, even with old metadata',()=>{
 const led=line({inventory_record_type:'matrix_row',metadata:{cabinet_size:'500mm X 500mm'},approved_quantity:40,returned_ok_quantity:8});
 assert.deepEqual(activePdfCounts(list(),[led]),{sent:'10 SQM',received:'2 SQM',out:'8 SQM'});
 assert.deepEqual(activePdfCounts(list('dry_hire'),[led]),{sent:'10 SQM',received:'2 SQM',out:'8 SQM'});
});
test('unknown LED geometry is explicit, not guessed as 1 sqm per cabinet',()=>{
 assert.deepEqual(activePdfCounts(list(),[line({inventory_record_type:'matrix_row'})]),{sent:'Unknown SQM',received:'Unknown SQM',out:'Unknown SQM'});
});
test('custom equipment has Sent but no fictional warehouse receipt tracking',()=>{
 assert.deepEqual(activePdfCounts(list(),[line({inventory_record_type:'item',approved_quantity:0})]),{sent:'9',received:'-',out:'-'});
});
test('Maintenance reads physically received repair quantities, not tested quantities',()=>{
 assert.deepEqual(activePdfCounts(list('maintenance'),[line()], [{list_item_id:'line',quantity:9,received_quantity:4,tested_quantity:1}]),{sent:'9',received:'4',out:'5'});
});
test('Transfer Out includes destination receipts, without double-counting counters',()=>{
 assert.deepEqual(activePdfCounts(list('transfer_out'),[line({transfer_received_quantity:5,returned_ok_quantity:2})]),{sent:'9',received:'5',out:'4'});
});
test('all types use the three columns for Active/Partially Returned only',()=>{
 for(const type of ['local_event','dry_hire','transfer_out','transfer_in','maintenance','internal_use']){
  for(const status of ['active','partially_returned'])assert.equal(showActivePdfColumns(list(type,status)),true);
  for(const status of ['draft','pending','closed','cancelled'])assert.equal(activePdfTable(list(type,status),[]),null);
 }
});
test('cable lengths carry independent receipts, not a duplicated parent total',()=>{
 const a=line({metadata:{matrix_source:'generic'},inventory_record_type:'matrix_row',parent_record_id:'cable'});
 const b=line({id:'other',metadata:{matrix_source:'generic'},inventory_record_type:'matrix_row',parent_record_id:'cable',approved_quantity:4,returned_ok_quantity:4});
 const result=activePdfTable(list(),[
  [{rowKind:'item',content:'',quantityItems:[a,b],photoKey:'cable'},{content:''}],
  [{content:'25m',quantityItems:[a]},{content:'9 Units'}],
  [{content:'50m',quantityItems:[b]},{content:'4 Units'}],
 ]);
 assert.deepEqual(result.body[0].slice(1).map(c=>c.content),['','','']);
 assert.deepEqual(result.body[1].map(c=>c.content),['25m','9','1','8']);
 assert.deepEqual(result.body[2].map(c=>c.content),['50m','4','4','0']);
});
test('A4 table is 182mm wide; photos, category, description, serials remain',()=>{
 const row=line();const source=[
  [{content:'LIGHTING',colSpan:6,rowKind:'category'}],
  [{content:'',colSpan:5,rowKind:'item',photoKey:'photo',brandText:'Cyclops',quantityItems:[row],styles:{minCellHeight:12.5}},{content:'9 Units'}],
  [{content:'Description\nnext line',colSpan:5},{content:''}],
  [{content:'ID 1 / SN ABC',rowKind:'serial'},{content:''},{content:'ID 2 / SN DEF'},{content:''},{content:''},{content:''}],
 ];const before=JSON.stringify(source);const table=activePdfTable(list(),source);
 assert.equal(Object.values(table.columnStyles).reduce((n,c)=>n+c.cellWidth,0),182);
 assert.deepEqual(table.head[0].map(c=>c.content),['Equipment','Sent','Received','Out']);
 assert.equal(table.body[0][0].colSpan,8);assert.equal(table.body[1][0].photoKey,'photo');
 assert.equal(table.body[1][0].brandText,'Cyclops');assert.equal(table.body[1][0].styles.minCellHeight,12.5);
 assert.deepEqual(table.body[1].slice(1).map(cell=>cell.styles.textColor),[[23,32,46],[22,132,74],[34,84,215]]);
 assert.equal(table.body[2][0].colSpan,8);assert.equal(table.body[2][0].content,'Description\nnext line');
 assert.match(table.body[3][0].content,/ID 1.*ID 2/);assert.equal(table.body[3][0].colSpan,8);
 assert.equal(JSON.stringify(source),before,'must not mutate the draft/original rows');
});
test('invalid counters cannot yield NaN or negative Out',()=>{
 const counts=activePdfCounts(list(),[line({returned_ok_quantity:99,missing_quantity:99})]);
 assert.deepEqual(counts,{sent:'9',received:'9',out:'0'});
});
test('download and Share PDF both use the same exporter, with repeated column headings',()=>{
 const source=fs.readFileSync(path.join(root,'components/EquipmentListDetailsClient.tsx'),'utf8');
 assert.match(source,/activePdfTable\(list,body,pdfMaintenanceReceipts,pdfFilter\)/);
 assert.match(source,/showHead: activePdf \? "everyPage" : "never"/);
 assert.equal((source.match(/await createListPdf\(\)/g)||[]).length,2);
 assert.match(source,/quantityItems: group.items/);assert.match(source,/quantityItems: \[item\]/);
 assert.match(source,/\.eq\("source_type","maintenance"\)/);
});

test('page filter removes non-matching serials and empty groups without mutating data',()=>{
 const groups=[{key:'fixture',items:[line({id:'out',approved_quantity:1,returned_ok_quantity:0}),line({id:'back',approved_quantity:1,returned_ok_quantity:1}),line({id:'lost',approved_quantity:1,returned_ok_quantity:0,missing_quantity:1})]}, {key:'custom',items:[line({inventory_record_type:'item'})]}];
 const original=JSON.stringify(groups);
 for(const [filter,id] of [['out','out'],['received','back'],['missing','lost']]){
  const result=filterActiveListGroups(list(),groups,filter);assert.equal(result.length,1);assert.deepEqual(result[0].items.map(i=>i.id),[id]);
 }
 assert.equal(JSON.stringify(groups),original);assert.equal(filterActiveListGroups(list(),groups,'all').length,2);
});
test('partial matrix/cable line can match both Out and Received, with exact exported quantity',()=>{
 const items=[line({approved_quantity:10,returned_ok_quantity:4,missing_quantity:2})];
 for(const [filter,value,color] of [['out','4',[34,84,215]],['received','4',[22,132,74]],['missing','2',[199,37,54]]]){
  const groups=filterActiveListGroups(list(),[{items}],filter);assert.equal(groups.length,1);
  const table=activePdfTable(list(),[[{rowKind:'item',quantityItems:groups[0].items},{content:'10 Units'}]],[],filter);
  assert.equal(table.head[0].length,2);assert.equal(table.body[0][1].content,value);assert.deepEqual(table.body[0][1].styles.textColor,color);
  assert.equal(table.body[0].reduce((n,c)=>n+(c.colSpan||1),0),6);
 }
});
test('LED missing export is sqm, not cabinets; status-specific totals never include zero lines',()=>{
 const item=line({inventory_record_type:'matrix_row',approved_quantity:40,returned_ok_quantity:8,missing_quantity:4,metadata:{cabinet_size:'500x500'}});
 const table=activePdfTable(list(),[[{rowKind:'item',quantityItems:[item]},{content:'10 SQM'}]],[],'missing');
 assert.equal(table.body[0][1].content,'1 SQM');
 assert.deepEqual(filterActiveListGroups(list(),[{items:[line({returned_ok_quantity:9})]}],'out'),[]);
});
test('Draft/Pending/closed views are not filtered by active controls',()=>{
 const groups=[{items:[line()]}];for(const status of ['draft','pending','closed'])assert.deepEqual(filterActiveListGroups(list('local_event',status),groups,'missing'),groups);
});
test('one page filter drives visible rows, photo selection, filename and export columns',()=>{
 const source=fs.readFileSync(path.join(root,'components/EquipmentListDetailsClient.tsx'),'utf8');
 assert.match(source,/groups=\{visibleGroups\}/);assert.match(source,/groups: pdfGroups/);
 assert.match(source,/for \(const group of pdfGroups\)/);assert.match(source,/filterActiveListGroups\(list,sortedGroups,pdfFilter,pdfMaintenanceReceipts\)/);
 assert.match(source,/aria-label="Filter active equipment"/);assert.match(source,/setActiveListFilter\(filter\)/);
 assert.match(source,/No \$\{ACTIVE_LIST_FILTER_LABELS\[pdfFilter\]\} items match/);
});

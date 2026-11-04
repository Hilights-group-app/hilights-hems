const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
const {listReturnQuantities,showActiveReturnQuantities}=require('../lib/listReturnQuantities.ts');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const code=stripTypeScriptTypes(read('lib/activeListLayout.ts'),{mode:'strip'}).replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
const helpers=new Function('listReturnQuantities',`${code};return {isCustomActiveItem,activeGroupKind,activeRowCounts,activeQuantityText,activeLineOutside,canReceiveActiveItem,activeSerialReference,activeSerialStatus};`)(listReturnQuantities);
const {activeRowCounts,activeQuantityText,activeGroupKind,activeLineOutside,canReceiveActiveItem,activeSerialReference,activeSerialStatus}=helpers;
const line=(more={})=>({id:'line',list_id:'list',inventory_record_id:'12345678-abcd',inventory_record_type:'matrix_model',parent_record_id:null,
  display_name:'Truss',metadata:{},requested_quantity:9,approved_quantity:9,returned_ok_quantity:1,returned_maintenance_quantity:0,...more});
const group=items=>({key:'group',displayName:'Truss',blockName:null,items});

test('new Sent / Received / Out columns retain 9 / 1 / 8 after correction',()=>{
 const item=line();assert.deepEqual(activeRowCounts([item]),{sent:9,received:1,outside:8,maintenance:0,squareMetres:false,custom:false});
 assert.equal(item.requested_quantity,9);assert.equal(item.returned_ok_quantity,1);
});
test('Cat 6 lengths remain separate: 25m is 10 / 7 / 3 and 50m is 5 / 0 / 5',()=>{
 const lengths=[line({inventory_record_type:'matrix_row',parent_record_id:'cat6',metadata:{matrix_source:'generic',row_label:'25m'},approved_quantity:10,requested_quantity:10,returned_ok_quantity:7}),
  line({id:'second',inventory_record_type:'matrix_row',parent_record_id:'cat6',metadata:{matrix_source:'generic',row_label:'50m'},approved_quantity:5,requested_quantity:5,returned_ok_quantity:0})];
 assert.equal(activeGroupKind(group(lengths)),'lengths');
 assert.deepEqual(lengths.map(item=>{const q=activeRowCounts([item]);return[q.sent,q.received,q.outside];}),[[10,7,3],[5,0,5]]);
});
test('separate deliveries of the same inventory record aggregate without hiding returned quantities',()=>{
 const q=activeRowCounts([line(),line({id:'delivery2',approved_quantity:2,requested_quantity:2,returned_ok_quantity:0})]);
 assert.deepEqual([q.sent,q.received,q.outside],[11,1,10]);
});
test('received-to-Maintenance remains distinct and no longer Out',()=>{
 const item=line({inventory_record_type:'unit',approved_quantity:1,requested_quantity:1,returned_ok_quantity:0,returned_maintenance_quantity:1});
 assert.equal(activeSerialStatus(item).label,'Maintenance');assert.equal(activeLineOutside(item),0);assert.equal(canReceiveActiveItem(item),false);
 assert.deepEqual(activeRowCounts([item]),{sent:1,received:1,outside:0,maintenance:1,squareMetres:false,custom:false});
});
test('LED cabinet counts retain square metre display but return eligibility uses physical cabinets',()=>{
 const item=line({inventory_record_type:'matrix_row',approved_quantity:20,requested_quantity:20,returned_ok_quantity:4,metadata:{cabinet_area_sqm:.5,actual_sqm:10}});
 const q=activeRowCounts([item]);assert.deepEqual([q.sent,q.received,q.outside,q.squareMetres],[10,2,8,true]);
 assert.equal(activeQuantityText(q.outside,q.squareMetres),'8 SQM');assert.equal(activeLineOutside(item),16);
});
test('legacy LED area fallback is preserved rather than displaying zero square metres',()=>{
 const item=line({inventory_record_type:'matrix_row',approved_quantity:10,requested_quantity:10,returned_ok_quantity:2,metadata:{actual_sqm:5}});
 assert.equal(activeRowCounts([item]).outside,4);assert.equal(activeRowCounts([item]).squareMetres,true);
});
test('custom items stay visible but never expose a stock-receiving action',()=>{
 for(const metadata of [{},{custom_item:true},{custom_item:'true'}]) {
  const item=line({inventory_record_type:'item',approved_quantity:0,requested_quantity:3,metadata});
  assert.equal(activeGroupKind(group([item])),'custom');assert.equal(activeRowCounts([item]).sent,3);assert.equal(canReceiveActiveItem(item),false);
 }
});
test('serial rows retain exact ID / serial, including zero ID and missing serial fallback',()=>{
 assert.deepEqual(activeSerialReference(line({metadata:{unit_no:32},serial_number:'H05666'})),{id:'32',serial:'H05666'});
 assert.deepEqual(activeSerialReference(line({metadata:{unit_no:0},serial_number:null})),{id:'0',serial:'—'});
 assert.deepEqual(activeSerialReference(line({serial_number:'Not Available'})),{id:'12345678',serial:'Not Available'});
});
test('only still-out registered units are offered for receiving; returned history stays readable',()=>{
 const out=line({inventory_record_type:'unit',approved_quantity:1,requested_quantity:1,returned_ok_quantity:0});
 const returned={...out,id:'returned',returned_ok_quantity:1};
 assert.equal(activeGroupKind(group([out,returned])),'serial');assert.equal(canReceiveActiveItem(out),true);assert.equal(canReceiveActiveItem(returned),false);
 assert.equal(activeSerialStatus(out).label,'Out');assert.equal(activeSerialStatus(returned).label,'Received');
});
test('an over-return cannot mask another serial outside',()=>{
 const q=activeRowCounts([line({approved_quantity:1,returned_ok_quantity:5}),line({approved_quantity:1,returned_ok_quantity:0})]);
 assert.deepEqual([q.sent,q.received,q.outside],[2,1,1]);
});
test('calm quantity labels preserve precision and never show invalid negative counts',()=>{
 assert.equal(activeQuantityText(2.375,true),'2.375 SQM');assert.equal(activeQuantityText(17),'17');assert.equal(activeQuantityText(-2),'0');assert.equal(activeQuantityText(NaN),'0');
});
test('new layout is gated to active/partial Local Event / Dry Hire; other workflows retain their renderer',()=>{
 for(const type of ['local_event','dry_hire'])for(const status of ['active','partially_returned']) assert.equal(showActiveReturnQuantities({list_type:type,status}),true);
 for(const list_type of ['maintenance','transfer_in','transfer_out','internal_use']) assert.equal(showActiveReturnQuantities({list_type,status:'active'}),false);
 for(const status of ['draft','pending','closed','cancelled']) assert.equal(showActiveReturnQuantities({list_type:'local_event',status}),false);
 const src=read('components/EquipmentListDetailsClient.tsx');assert.match(src,/\) : showReturnQuantities \? \(/);
 assert.match(src,/if \(item.inventory_record_type === "unit"\) void receiveReturn\(item, 1\)/);
 assert.match(src,/else openQuantityReturn\(item\)/);assert.match(src,/onCorrect=\{setCorrectionItem\}/);
});
test('existing receive RPC/confirmation and legacy Draft/Pending renderer are byte-for-byte unchanged',()=>{
 const src=read('components/EquipmentListDetailsClient.tsx');
 const sha=string=>crypto.createHash('sha256').update(string).digest('hex');
 let start=src.indexOf('  async function receiveReturn('),end=src.indexOf('\n  async function receiveMaintenanceItem(',start);
 assert.equal(sha(src.slice(start,end)),'b5ad41f9683079f1eababca90fd3039a132528c304f988cd1cd66f5030679294');
 start=src.indexOf('          <div className="divide-y divide-gray-100 border-t border-gray-100">');end=src.indexOf('\n        {canSubmitDraft ?',start);
 assert.equal(sha(src.slice(start,end)),'eabbaa107608c6c5973e7b4d9b14ac11f73e2b775902ec29f3da13fca1851c91');
});
test('actual new parent callback preserves single-unit confirmation, quantity dialog and offline guard',()=>{
 const src=read('components/EquipmentListDetailsClient.tsx');
 const start=src.indexOf('onReceive={(item) => {')+'onReceive={'.length;
 const end=src.indexOf('}} onCorrect={setCorrectionItem}',start);
 assert.ok(start>0&&end>start);
 const arrow=src.slice(start,end+1),calls=[];let offline=false;
 const handler=new Function('isOffline','setError','receiveReturn','openQuantityReturn',`return ${arrow};`)(
  ()=>offline,message=>calls.push(['error',message]),(item,qty)=>calls.push(['serial',item.id,qty]),item=>calls.push(['quantity',item.id]));
 handler(line({id:'serial',inventory_record_type:'unit'}));handler(line({id:'truss'}));
 assert.deepEqual(calls,[['serial','serial',1],['quantity','truss']]);
 calls.length=0;offline=true;handler(line({inventory_record_type:'unit'}));assert.equal(calls.length,1);assert.equal(calls[0][0],'error');
});
test('new table is UI-only: no new Supabase reads, mutation RPCs, subscriptions or polling',()=>{
 const src=read('components/ActiveListEquipmentTable.tsx');assert.doesNotMatch(src,/createClient|\.rpc\(|\.from\(|\.channel\(|setInterval|fetch\(/);
 assert.match(src,/if \(!canReceive \|\| busy\) return/);assert.match(src,/eligible.length === 1\) onReceive\(eligible\[0\]\)/);
 assert.match(src,/setReceivingGroupKey\(null\); onReceive\(item\)/);
});
test('disclosure is independent from the existing per-user PDF serial preference',()=>{
 const src=read('components/ActiveListEquipmentTable.tsx');
 const toggle=src.slice(src.indexOf('  function toggleSerials('),src.indexOf('  function receiveGroup('));
 assert.match(toggle,/setExpanded/);assert.doesNotMatch(toggle,/onToggleSerialPdf|localStorage/);
 assert.match(src,/checked=\{!props.hiddenSerialPdfKeys.has\(group.key\)\}/);assert.match(src,/onChange=\{\(\) => props.onToggleSerialPdf\(group.key\)\}/);
 assert.match(src,/aria-expanded=\{open\}/);assert.match(src,/kind === "serial" && open \? serialTable/);
});
test('compact correction icons retain existing eligibility/chooser behavior and accessible labels',()=>{
 const src=read('components/ReceivedCorrectionAction.tsx');assert.match(src,/iconOnly = false/);assert.match(src,/items.filter\(item => canCorrectReceived/);
 assert.match(src,/iconOnly \? "sr-only"/);assert.match(src,/aria-label=\{`Correct Received/);
 assert.match(read('components/ActiveListEquipmentTable.tsx'),/onOpen=\{onCorrect\} iconOnly/);
});
test('layout has aligned columns, compact serial table and container-width phone adaptation',()=>{
 const src=read('components/ActiveListEquipmentTable.tsx'),css=read('components/ActiveListEquipmentTable.module.css');
 assert.match(src,/<th scope="col">Sent<\/th><th scope="col">Received<\/th><th scope="col">Out<\/th>/);
 assert.match(src,/data-serial-item=\{item.id\}/);assert.match(src,/data-active-length=\{item.id\}/);
 assert.match(css,/@container active-equipment \(max-width: 660px\)/);assert.match(css,/grid-template-columns: 30px 104px/);
 assert.match(css,/white-space: pre-wrap/);assert.match(css,/\.receiveButton > span \{ display: none/);
});

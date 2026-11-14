const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
const batch=require('../lib/serialBatchReceive.ts');
const {listReturnQuantities}=require('../lib/listReturnQuantities.ts');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const activeCode=stripTypeScriptTypes(read('lib/activeListLayout.ts'),{mode:'strip'}).replace(/^import .*;\n/gm,'').replace(/\bexport /g,'');
const active=new Function('listReturnQuantities',activeCode+';return {activeSerialReference,activeSerialStatus};')(listReturnQuantities);
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const list=(more={})=>({id:id(100),list_type:'local_event',status:'active',...more});
const unit=(n,more={})=>({id:id(n),list_id:id(100),inventory_record_type:'unit',inventory_record_id:id(n+1000),display_name:'Lighting fixture',approved_quantity:1,requested_quantity:1,returned_ok_quantity:0,returned_maintenance_quantity:0,missing_quantity:0,metadata:{unit_no:n},serial_number:`SER-${n}`,...more});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
test('bulk receipt is scoped to manager/admin active Local Events, not Draft/Pending/Dry Hire',()=>{
 for(const status of ['active','partially_returned'])assert.equal(batch.canBatchReceiveSerials(list({status}),true),true);
 for(const status of ['draft','pending','closed','cancelled'])assert.equal(batch.canBatchReceiveSerials(list({status}),true),false);
 for(const list_type of ['dry_hire','maintenance','transfer_out','transfer_in','internal_use'])assert.equal(batch.canBatchReceiveSerials(list({list_type}),true),false);
 assert.equal(batch.canBatchReceiveSerials(list(),false),false);
});
test('only exact outstanding single units are eligible; Received, Missing, repair and custom rows are excluded',()=>{
 assert.equal(batch.isOutstandingSerial(unit(1)),true);
 for(const extra of [{returned_ok_quantity:1},{returned_maintenance_quantity:1},{returned_ok_quantity:null},{returned_maintenance_quantity:null},{missing_quantity:1},{approved_quantity:2},{inventory_record_type:'matrix_row'},{metadata:{custom_item:true}},{metadata:{custom_item:'true'}}])assert.equal(batch.isOutstandingSerial(unit(1,extra)),false);
});
test('payload uses sorted exact line IDs and expected counters, without mutating original selection',()=>{
 const values=[unit(2),unit(1)],before=JSON.stringify(values),payload=batch.buildSerialReceiptPayload(id(100),values);
 assert.deepEqual(payload,[{id:id(1),approved:1,ok:0,maintenance:0,missing:0},{id:id(2),approved:1,ok:0,maintenance:0,missing:0}]);assert.equal(JSON.stringify(values),before);
});
test('empty/duplicate/stale/foreign/non-serial/oversized selection cannot create a receipt payload',()=>{
 for(const values of [[],[unit(1),unit(1)],[unit(1),unit(2,{inventory_record_id:id(1001)})],[unit(1,{missing_quantity:1})],[unit(1,{list_id:id(999)})],[unit(1,{id:'not-a-uuid'})],Array.from({length:1001},(_,i)=>unit(i+1))])assert.throws(()=>batch.buildSerialReceiptPayload(id(100),values));
 assert.throws(()=>batch.selectSerialReceiptLines([unit(1)],new Set([id(2)])));assert.throws(()=>batch.selectSerialReceiptLines([unit(1,{returned_ok_quantity:1})],new Set([id(1)])));
});

function parent(options={}){
 const source=read('components/EquipmentListDetailsClient.tsx'),start=source.indexOf('  async function receiveSerialBatch('),end=source.indexOf('  async function refreshSerialReceiptSelection(',start),calls=[],updates=[];
 const target=list(options.list),env={list:target,listId:target.id,currentUserId:'owner',returningItemId:null,canReceiveReturns:true,
  bulkReceiveBusy:{current:false},bulkReceiveRequest:{current:null},bulkReceiptScope:{current:0},dispatchContext:{current:{listId:target.id}},
  getUserId:()=>typeof options.user==='function'?options.user():options.user??'owner',canManageEquipmentLists:()=>options.manager??true,isOffline:()=>typeof options.offline==='function'?options.offline():options.offline??false,
  ...batch,AbortController,clearTimeout:()=>{},window:{confirm:message=>{updates.push(['confirm',message]);return options.confirm?.()??true;},setTimeout:()=>123,dispatchEvent:event=>updates.push(['event',event.type,event.detail])},
  CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},EQUIPMENT_LISTS_EVENT:'lists',EQUIPMENT_LIST_ITEMS_EVENT:'items',
  setBulkReceiving:value=>updates.push(['busy',value]),setError:value=>updates.push(['error',value]),setMessage:value=>updates.push(['message',value]),
  setItems:update=>updates.push(['items',update([unit(1),unit(2),unit(3)])]),setList:update=>updates.push(['list',update(target)]),
  refreshListAndItems:async cancelled=>{updates.push(['refresh']);assert.equal(typeof cancelled,'function');if(options.refreshPromise)await options.refreshPromise;if(options.refreshError)throw Error('refresh failed');updates.push(['refreshCancelled',cancelled()]);},
  supabase:{rpc(name,params){calls.push({name,params});return{abortSignal:signal=>{assert.ok(signal instanceof AbortSignal);return options.promise??Promise.resolve(options.result??{data:{received:params.p_lines.length},error:null});}};}},
 };
 const receive=new Function(...Object.keys(env),stripTypeScriptTypes(source.slice(start,end),{mode:'strip'})+';return receiveSerialBatch;')(...Object.values(env));return{receive,env,calls,updates};
}
test('actual parent issues ONE atomic RPC for all selected serials, then refreshes and emits one event pair',async()=>{
 const d=parent();assert.equal(await d.receive([unit(1),unit(2)]),true);assert.equal(d.calls.length,1);assert.equal(d.calls[0].name,'hems_receive_serial_batch');assert.equal(d.calls[0].params.p_lines.length,2);assert.equal(d.updates.filter(u=>u[0]==='refresh').length,1);assert.equal(d.updates.filter(u=>u[0]==='event').length,2);assert.match(d.updates.find(u=>u[0]==='confirm')[1],/Receive 2 selected serial units/);
});
test('cancelled confirmation makes no RPC; rapid duplicate click cannot submit a second batch',async()=>{
 const cancel=parent({confirm:()=>false});assert.equal(await cancel.receive([unit(1)]),false);assert.equal(cancel.calls.length,0);
 const gate=deferred(),d=parent({promise:gate.promise});const first=d.receive([unit(1)]);assert.equal(await d.receive([unit(1)]),false);gate.resolve({data:{received:1},error:null});assert.equal(await first,true);assert.equal(d.calls.length,1);
});
test('offline / wrong owner / role change / wrong list type and invalid serials stop before mutation',async()=>{
 for(const options of [{offline:true},{user:'other'},{manager:false},{list:{list_type:'dry_hire'}},{list:{status:'closed'}}]){const d=parent(options);await assert.rejects(()=>d.receive([unit(1)]));assert.equal(d.calls.length,0);}
 const d=parent();await assert.rejects(()=>d.receive([unit(1,{missing_quantity:1})]));assert.equal(d.calls.length,0);
 let offline=false;const changed=parent({offline:()=>offline,confirm:()=>{offline=true;return true;}});await assert.rejects(()=>changed.receive([unit(1)]));assert.equal(changed.calls.length,0);
});
test('database/stale/unknown failures never retry or announce success; uncertain responses demand Refresh',async()=>{
 for(const error of [{code:'40001',message:'Serial changed'},{message:'Failed to fetch'},{code:'PGRST202',message:'RPC missing'}]){
  const d=parent({result:{error}});await assert.rejects(()=>d.receive([unit(1)]));assert.equal(d.calls.length,1);assert.equal(d.updates.filter(u=>u[0]==='event').length,0);assert.ok(d.updates.some(u=>u[0]==='error'&&u[1]));assert.equal(d.env.bulkReceiveBusy.current,false);
 }
});
test('confirmed receipt with a failed readback stays Saved and never repeats the stock mutation',async()=>{
 const d=parent({refreshError:true});assert.equal(await d.receive([unit(1)]),true);assert.equal(d.calls.length,1);assert.ok(d.updates.some(u=>u[0]==='error'&&/batch was received/.test(u[1])));
});
test('confirmed all-received status and counters update immediately without waiting on a slow readback',async()=>{
 const gate=deferred(),d=parent({refreshPromise:gate.promise,result:{data:{received:2,list_status:'closed'},error:null}});
 assert.equal(await d.receive([unit(1),unit(2)]),true);assert.equal(d.updates.find(u=>u[0]==='list')[1].status,'closed');assert.deepEqual(d.updates.find(u=>u[0]==='items')[1].map(u=>u.returned_ok_quantity),[1,1,0]);assert.equal(d.env.bulkReceiveBusy.current,false);
 gate.resolve();await Promise.resolve();await Promise.resolve();assert.ok(d.updates.some(u=>u[0]==='refreshCancelled'&&u[1]===false));
});
test('a confirmed response after a connection change keeps the receipt visible, not overwritten by offline cache',async()=>{
 let offline=false;const gate=deferred(),d=parent({offline:()=>offline,promise:gate.promise});const task=d.receive([unit(1)]);offline=true;gate.resolve({data:{received:1,list_status:'partially_returned'},error:null});assert.equal(await task,true);assert.ok(d.updates.some(u=>u[0]==='items'&&u[1][0].returned_ok_quantity===1));assert.equal(d.updates.filter(u=>u[0]==='refresh').length,0);
});
test('late response after route/owner change does not update the next page or report a false confirmation',async()=>{
 const gate=deferred(),d=parent({promise:gate.promise});const task=d.receive([unit(1)]);d.env.dispatchContext.current.listId=id(999);gate.resolve({data:{received:1},error:null});assert.equal(await task,false);assert.equal(d.updates.filter(u=>u[0]==='event'||u[0]==='refresh').length,0);
});

function compile(source,file){
 if(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES){const b=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright/lib/transform/babelBundle.js');return b.babelTransform(source,path.resolve(__dirname,'..',file),false,[],[]).code;}
 const ts=require('typescript');return ts.transpileModule(source,{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
}
function modal(options={}){
 const hooks=[];let cursor=0,pending=[],unmounted=false,lateWrites=0,props={list:list(),title:'Lighting fixture',items:[unit(1),unit(2),unit(3,{returned_ok_quantity:1}),unit(4,{missing_quantity:1})],canReceive:true,busy:false,onClose:()=>{calls.close++;},onRefresh:()=>{calls.refresh++;},onConfirm:async chosen=>{calls.confirm.push(chosen);return options.promise??options.saved??true;},...options.props};
 const calls={close:0,refresh:0,confirm:[]};class Element{focus(){}}const previous=new Element();
 const React={useState(initial){const at=cursor++;if(!hooks[at])hooks[at]={value:typeof initial==='function'?initial():initial};return[hooks[at].value,update=>{if(unmounted)lateWrites++;hooks[at].value=typeof update==='function'?update(hooks[at].value):update;}];},useRef(initial){const at=cursor++;return hooks[at]??(hooks[at]={current:initial});},useEffect(fn,deps){const at=cursor++,old=hooks[at];if(!old||deps.some((v,i)=>v!==old.deps[i])){hooks[at]={deps,cleanup:old?.cleanup};pending.push(()=>{old?.cleanup?.();hooks[at].cleanup=fn();});}}};
 const jsx=(type,props)=>{const node={type,props};if(props?.ref){const el=new Element();el.indeterminate=false;el.querySelectorAll=()=>[];props.ref.current=el;}return node;};
 const styles=new Proxy({},{get:(_,key)=>String(key)}),exports={};
 const imports={'react':React,'react-dom':{createPortal:tree=>tree},'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':{Loader2:'Loader2',RotateCcw:'RotateCcw',X:'X'},'@/lib/activeListLayout':active,'@/lib/serialBatchReceive':batch,'./ActiveListEquipmentTable.module.css':{__esModule:true,default:styles}};
 // Playwright's Babel transform omits CSS imports; supply that boundary directly.
 new Function('require','exports','document','HTMLElement','styles',compile(read('components/SerialBatchReceiveDialog.tsx'),'components/SerialBatchReceiveDialog.tsx'))(name=>imports[name]??assert.fail('Unexpected import '+name),exports,{body:{},activeElement:previous},Element,styles);
 function render(extra={}){props={...props,...extra};cursor=0;pending=[];const view=exports.default(props);for(const run of pending)run();return view;}
 return{render,calls,unmount(){unmounted=true;for(const hook of hooks)hook?.cleanup?.();},get lateWrites(){return lateWrites;}};
}
function nodes(node,predicate,result=[]){if(Array.isArray(node)){for(const child of node)nodes(child,predicate,result);return result;}if(!node||typeof node!=='object')return result;if(predicate(node))result.push(node);nodes(node.props?.children,predicate,result);return result;}
const allBox=tree=>nodes(tree,n=>n.type==='input'&&'aria-checked' in n.props)[0];
const receiveButton=tree=>nodes(tree,n=>n.type==='button'&&n.props.className==='batchSubmit')[0];
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
test('actual dialog Select all chooses only Out serials; Received/Missing checkboxes stay disabled',()=>{
 const d=modal();let tree=d.render();assert.equal(receiveButton(tree).props.disabled,true);allBox(tree).props.onChange();tree=d.render();
 const boxes=nodes(tree,n=>n.type==='input'&&n.props['aria-label']);assert.deepEqual(boxes.map(n=>[n.props.checked,n.props.disabled]),[[true,false],[true,false],[false,true],[false,true]]);assert.equal(allBox(tree).props.checked,true);
 boxes[0].props.onChange();tree=d.render();assert.equal(allBox(tree).props['aria-checked'],'mixed');assert.equal(allBox(tree).props.ref.current.indeterminate,true);
 allBox(tree).props.onChange();tree=d.render();assert.equal(allBox(tree).props.checked,true);allBox(tree).props.onChange();tree=d.render();assert.equal(receiveButton(tree).props.disabled,true);
});
test('actual dialog passes the exact selected serials once; native confirmation cancellation preserves selection',async()=>{
 const d=modal({saved:false});let tree=d.render();allBox(tree).props.onChange();tree=d.render();receiveButton(tree).props.onClick();receiveButton(tree).props.onClick();await settle();assert.equal(d.calls.confirm.length,1);assert.deepEqual(d.calls.confirm[0].map(u=>u.id),[id(1),id(2)]);assert.equal(d.calls.close,0);assert.equal(allBox(d.render()).props.checked,true);
});
test('actual dialog closes on confirmed success; failures require refresh rather than permitting a duplicate retry',async()=>{
 const good=modal();let tree=good.render();allBox(tree).props.onChange();tree=good.render();receiveButton(tree).props.onClick();await settle();assert.equal(good.calls.close,1);
 const gate=deferred(),bad=modal({promise:gate.promise});tree=bad.render();allBox(tree).props.onChange();tree=bad.render();receiveButton(tree).props.onClick();gate.reject(Error('Refresh before retrying'));await settle();tree=bad.render();assert.ok(nodes(tree,n=>n.props?.role==='alert').some(n=>n.props.children==='Refresh before retrying'));assert.equal(allBox(tree).props.disabled,true);receiveButton(tree).props.onClick();assert.equal(bad.calls.refresh,1);assert.equal(bad.calls.confirm.length,1);
});
test('selected serial becoming Missing mid-dialog blocks submission until the selection is reviewed',()=>{
 const d=modal();let tree=d.render();allBox(tree).props.onChange();tree=d.render({items:[unit(1),unit(2,{missing_quantity:1})]});assert.equal(receiveButton(tree).props.disabled,true);allBox(tree).props.onChange();tree=d.render();assert.equal(allBox(tree).props.checked,true);assert.equal(receiveButton(tree).props.disabled,false);
});
test('dialog ignores a late completion after unmount and does not set state on an abandoned screen',async()=>{
 const gate=deferred(),d=modal({promise:gate.promise});let tree=d.render();allBox(tree).props.onChange();tree=d.render();receiveButton(tree).props.onClick();d.unmount();gate.resolve(true);await settle();assert.equal(d.calls.close,0);assert.equal(d.lateWrites,0);
});

const sql=read('supabase/receive-serial-batch.sql');
test('SQL installs only the batch RPC; existing Receive is fingerprinted and called, never rewritten',()=>{
 assert.match(sql,/begin;[\s\S]*notify pgrst, 'reload schema';\s*commit;/);assert.match(sql,/02904aeb2927855ef3da517a71b58820/);assert.match(sql,/result:=public.return_equipment_list_item\(line.id,1,0\)/);assert.doesNotMatch(sql,/create or replace function public.return_equipment_list_item|update public\.|delete from|disable row level security|drop policy/i);
 const source=read('supabase/missing-equipment.sql'),start=source.indexOf('CREATE OR REPLACE FUNCTION public.return_equipment_list_item('),end=source.indexOf('$function$',source.indexOf('$function$',start)+10)+10;
 assert.ok(start>0&&end>start);const hash=crypto.createHash('md5').update(source.slice(start,end).replace(/\r/g,'').replace(/^[ \n\t;]+|[ \n\t;]+$/g,'')).digest('hex');assert.equal(hash,'02904aeb2927855ef3da517a71b58820');
});
test('SQL validates all serials and stock before the first receipt, locks deterministically and never catches/continues partial errors',()=>{
 const firstMutation=sql.indexOf('result:=public.return_equipment_list_item');
 for(const token of ['is_equipment_list_manager() is not true',"parent.list_type::text<>'local_event'",'distinct_lines<>total','locked<>total','distinct_units<>total',"i.missing_quantity is distinct from 0",'e.approved is distinct from i.approved_quantity',"u.status::text is distinct from 'in_use'",'models<>1','m.remaining_quantity>0','other_line.list_id<>p_list_id'])assert.ok(sql.indexOf(token)>=0&&sql.indexOf(token)<firstMutation,token);
 assert.match(sql,/order by i.id for update/);assert.match(sql,/order by u.id for update of u/);assert.match(sql,/pg_advisory_xact_lock\(742193,1\)/);assert.doesNotMatch(sql,/exception when|savepoint|commit;[\s\S]+end; \$\$/i);
 assert.match(sql,/revoke all on function public.hems_receive_serial_batch\(uuid,jsonb\) from public,anon/);
});
test('UI wiring keeps PDF visibility and single-receive controls independent, and routes only Local Event serials to Select all',()=>{
 const table=read('components/ActiveListEquipmentTable.tsx'),dialog=read('components/SerialBatchReceiveDialog.tsx'),parent=read('components/EquipmentListDetailsClient.tsx');
 assert.match(table,/activeGroupKind\(receivingGroup\)==="serial"&&canBatchReceiveSerials\(list,manager&&canReceive\)/);assert.match(table,/onConfirm=\{props.onReceiveSerials\}/);assert.match(table,/checked=\{!props.hiddenSerialPdfKeys.has\(group.key\)\}/);
 assert.match(parent,/onReceiveSerials=\{receiveSerialBatch\}/);assert.match(parent,/missingItems \|\| bulkReceiving/);assert.match(parent,/if \(item.inventory_record_type === "unit"\) void receiveReturn\(item, 1\)/);
 assert.doesNotMatch(dialog,/createClient|\.rpc\(|\.from\(|setInterval|location\.reload/);assert.match(dialog,/querySelectorAll<HTMLElement>\('button:not\(\[disabled\]\),input:not\(\[disabled\]\)'\)/);
 const css=read('components/ActiveListEquipmentTable.module.css');assert.match(css,/\.pickerRows \{ min-height: 0; overflow-y: auto/);assert.match(css,/\.batchFooter \{[^}]*flex-shrink: 0/);
});

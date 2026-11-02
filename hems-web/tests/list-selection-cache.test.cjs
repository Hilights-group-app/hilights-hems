const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { createListSelectionCache } = require('../lib/listSelectionCache.ts');
const eventName = 'hems:equipment-list-items-change';
const emit = (target, detail) => target.dispatchEvent(new CustomEvent(eventName, {detail}));
const deferred = () => { let resolve, reject; const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject}; };

test('20 -> 10 in draft while inventory is unmounted is 10 on return',async()=>{
 const cache=createListSelectionCache(),events=new EventTarget();cache.watch(events,eventName);
 let quantity=20,calls=0;const load=async()=>{calls++;return quantity;};
 assert.equal(await cache.read('user','list',load),20);
 // No mounted row listener exists during this edit.
 quantity=10;emit(events,{listId:'list',status:'draft'});
 assert.equal(calls,1,'editing while unmounted must not fetch');
 assert.equal(await cache.read('user','list',load),10);
 assert.equal(calls,2);
});
test('40 inventory row readers join one list query after invalidation',async()=>{
 const cache=createListSelectionCache(),events=new EventTarget();cache.watch(events,eventName);
 let calls=0;const load=async()=>++calls;
 await cache.read('u','l',load);emit(events,{listId:'l',status:'pending'});
 assert.deepEqual(await Promise.all(Array.from({length:40},()=>cache.read('u','l',load))),Array(40).fill(2));
 assert.equal(calls,2);
});
test('repeated events while away do not make requests',async()=>{
 const cache=createListSelectionCache(),events=new EventTarget();cache.watch(events,eventName);
 let calls=0;const load=async()=>++calls;await cache.read('u','l',load);
 for(let i=0;i<30;i++)emit(events,{listId:'l'});
 assert.equal(calls,1);await cache.read('u','l',load);assert.equal(calls,2);
});
test('deletion returns empty selection rather than a cached quantity',async()=>{
 const cache=createListSelectionCache(),events=new EventTarget();cache.watch(events,eventName);
 await cache.read('u','l',async()=>new Map([['cable',20]]));emit(events,{listId:'l'});
 assert.equal((await cache.read('u','l',async()=>new Map())).size,0);
});
test('editing one list does not invalidate other list quantities',async()=>{
 const cache=createListSelectionCache(),events=new EventTarget();cache.watch(events,eventName);
 await cache.read('u','a',async()=>20);await cache.read('u','b',async()=>50);
 emit(events,{listId:'a'});assert.equal(cache.has('u','a'),false);assert.equal(cache.has('u','b'),true);
 assert.equal(await cache.read('u','b',async()=>{throw Error('extra read');}),50);
});
test('generic change without list ID invalidates all lists',async()=>{
 const cache=createListSelectionCache(),events=new EventTarget();cache.watch(events,eventName);
 await cache.read('u','a',async()=>20);await cache.read('u','b',async()=>50);emit(events,undefined);
 assert.equal(cache.has('u','a'),false);assert.equal(cache.has('u','b'),false);
});
test('same list has separate user cache and in-flight requests',async()=>{
 const cache=createListSelectionCache(),old=deferred();
 const a=cache.read('alice','l',()=>old.promise);
 assert.equal(await cache.read('bob','l',async()=>10),10);old.resolve(20);assert.equal(await a,20);
 assert.equal(await cache.read('bob','l',async()=>99),10);
});
test('late 20 read cannot overwrite a saved 10 after invalidation',async()=>{
 const cache=createListSelectionCache(),events=new EventTarget(),old=deferred();cache.watch(events,eventName);
 let calls=0;const load=()=>++calls===1?old.promise:Promise.resolve(10);
 const first=cache.read('u','l',load);await Promise.resolve();emit(events,{listId:'l'});
 const second=cache.read('u','l',load);old.resolve(20);
 assert.equal(await first,10);assert.equal(await second,10);assert.equal(calls,2);
});
test('late failed old read can join fresh read after invalidation',async()=>{
 const cache=createListSelectionCache(),old=deferred();let calls=0;
 const load=()=>++calls===1?old.promise:Promise.resolve(10);
 const first=cache.read('u','l',load);await Promise.resolve();cache.invalidate('l');old.reject(Error('old failure'));
 assert.equal(await first,10);assert.equal(calls,2);
});
test('local cached save is preserved without an unnecessary fetch',async()=>{
 const cache=createListSelectionCache(),events=new EventTarget();cache.watch(events,eventName);
 await cache.read('u','l',async()=>20);cache.update('u','l',()=>10);
 emit(events,{listId:'l',matrixLinesCached:true});
 assert.equal(await cache.read('u','l',async()=>{throw Error('unnecessary read');}),10);
});
test('local write supersedes pending stale response',async()=>{
 const cache=createListSelectionCache(),old=deferred();const pending=cache.read('u','l',()=>old.promise);
 await Promise.resolve();cache.update('u','l',()=>10);old.resolve(20);assert.equal(await pending,10);
});
test('incomplete row write does not mark an invalidated list complete',async()=>{
 const cache=createListSelectionCache();cache.update('u','l',()=>undefined);
 assert.equal(cache.has('u','l'),false);
 assert.equal(await cache.read('u','l',async()=>10),10);
});
test('failed read remains retryable, does not cache a false zero',async()=>{
 const cache=createListSelectionCache();await assert.rejects(cache.read('u','l',async()=>{throw Error('network');}));
 assert.equal(cache.has('u','l'),false);assert.equal(await cache.read('u','l',async()=>10),10);
});
test('one lifetime listener only, no repeated invalidation per rendered row',()=>{
 const cache=createListSelectionCache();let listeners=0;
 const target={addEventListener(){listeners++;}};
 for(let i=0;i<40;i++)cache.watch(target,eventName);assert.equal(listeners,1);
});
test('quantity controls display saved selection, not unsaved dialog input',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../components/EquipmentListMatrixQuantityAction.tsx'),'utf8');
 assert.match(src,/const currentQuantity = existingLine \? qty\(existingLine.requested_quantity\) : 0/);
 assert.match(src,/matrixLinesCache.watch\(window, EQUIPMENT_LIST_ITEMS_EVENT\)/);
 assert.match(src,/\.range\(offset, offset \+ 999\)/);
 assert.doesNotMatch(src,/matrixLinesRequests|loadExistingLine\(!detail/);
});

function realReader() {
 const src=fs.readFileSync(path.join(__dirname,'../components/EquipmentListMatrixQuantityAction.tsx'),'utf8');
 const start=src.indexOf('async function loadMatrixLinesShared(');
 const end=src.indexOf('\nfunction writeMatrixLineCache(',start);
 const code=stripTypeScriptTypes(src.slice(start,end),{mode:'strip'});
 const events=new EventTarget(),cache=createListSelectionCache();let owner='user';
 const read=new Function('matrixLinesCache','getUserId','window','EQUIPMENT_LIST_ITEMS_EVENT','matrixLineKey',`${code};return loadMatrixLinesShared;`)(cache,()=>owner,events,eventName,(t,id)=>`${t}:${id}`);
 let rows=[],calls=0;
 const client={from(table){assert.equal(table,'equipment_list_items');
  const q={select(){return q;},eq(){return q;},in(){return q;},order(){return q;},async range(a,b){calls++;return {data:rows.slice(a,b+1),error:null};}};return q;}};
 return {read:()=>read(client,'list'),events,setRows:r=>{rows=r;},calls:()=>calls,setOwner:u=>{owner=u;}};
}
test('actual matrix query + cache integration: return from draft shows 10 and shares one read',async()=>{
 const r=realReader();const row={id:'line',inventory_record_type:'matrix_row',inventory_record_id:'cable',requested_quantity:20};
 r.setRows([row]);assert.equal((await r.read()).get('matrix_row:cable').requested_quantity,20);
 r.setRows([{...row,requested_quantity:10}]);emit(r.events,{listId:'list',status:'draft'});
 const results=await Promise.all(Array.from({length:25},()=>r.read()));
 for(const result of results)assert.equal(result.get('matrix_row:cable').requested_quantity,10);
 assert.equal(r.calls(),2);
});
test('actual reader includes a selected cable beyond the first 1000 lines',async()=>{
 const r=realReader();r.setRows(Array.from({length:1001},(_,i)=>({id:`line${i}`,inventory_record_type:'matrix_row',inventory_record_id:String(i),requested_quantity:i+1})));
 const result=await r.read();assert.equal(result.get('matrix_row:1000').requested_quantity,1001);assert.equal(r.calls(),2);
});

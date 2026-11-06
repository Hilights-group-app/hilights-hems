const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module');
const {prepareListPdfPhotos}=require('../lib/pdfItemPhotos.ts');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const image=source=>({dataUrl:`jpeg:${source}`,width:240,height:240});
const line=(n,more={})=>({id:id(n+1000),inventory_record_type:'matrix_model',inventory_record_id:id(n),parent_record_id:null,metadata:{},...more});
const group=(n,items=[line(n)])=>({key:`group${n}`,displayName:`Equipment ${n}`,items});
function setup(groups,records={},loader=async source=>image(source)) {
 const reads=[],loads=[];
 const options={groups,readCatalog:async(table,ids)=>{reads.push({table,ids});return ids.flatMap(id=>records[table]?.[id]?[records[table][id]]:[]);},
  loadPhoto:async(source,fresh)=>{loads.push({source,fresh});return loader(source,fresh);}};
 return {run:()=>prepareListPdfPhotos(options),reads,loads,options};
}

test('valid list snapshots remain authoritative; zero catalog reads for normal exports',async()=>{
 const s=setup([group(1,[line(1,{metadata:{photo_url:'saved-photo'}})])]);const result=await s.run();
 assert.equal(result.photos.get('group1').dataUrl,'jpeg:saved-photo');assert.equal(s.reads.length,0);assert.deepEqual(result.unavailable,[]);
});
test('empty first snapshot can use another serial/length snapshot in the same group',async()=>{
 const s=setup([group(1,[line(1),line(1,{metadata:{photo_url:'later-line-photo'}})])]);const r=await s.run();
 assert.equal(r.photos.get('group1').dataUrl,'jpeg:later-line-photo');assert.equal(s.reads.length,0);
});
test('legacy metadata photo_data is supported without changing the stored metadata',async()=>{
 const item=line(1,{metadata:{photo_data:'legacy-data'}});const s=setup([group(1,[item])]);await s.run();assert.deepEqual(item.metadata,{photo_data:'legacy-data'});assert.equal(s.reads.length,0);
});
test('photo added to Matrix inventory AFTER draft creation appears in the PDF',async()=>{
 const s=setup([group(1)],{matrix_models:{[id(1)]:{id:id(1),photo_data:'current-photo'}}});const r=await s.run();
 assert.equal(r.photos.get('group1').dataUrl,'jpeg:current-photo');assert.deepEqual(s.reads,[{table:'matrix_models',ids:[id(1)]}]);
});
test('15 equipment rows / 8 saved photos + 7 current photos resolves all 15 with one catalog batch',async()=>{
 const groups=Array.from({length:15},(_,i)=>group(i+1,[line(i+1,{metadata:i<8?{photo_url:`saved${i}`}:{}})]));
 const records={matrix_models:Object.fromEntries(Array.from({length:7},(_,i)=>[id(i+9),{id:id(i+9),photo_data:`current${i}`}]))};
 const s=setup(groups,records),r=await s.run();assert.equal(r.photos.size,15);assert.deepEqual(r.unavailable,[]);assert.equal(s.reads.length,1);assert.equal(s.reads[0].ids.length,7);
});
test('generic cable row uses its exact Matrix parent photo, not another length or product name',async()=>{
 const item=line(2,{inventory_record_type:'matrix_row',parent_record_id:id(10),metadata:{matrix_source:'generic'}});
 const s=setup([group(2,[item])],{matrix_models:{[id(10)]:{id:id(10),photo_data:'cable-parent'}}});const r=await s.run();
 assert.equal(r.photos.get('group2').dataUrl,'jpeg:cable-parent');assert.deepEqual(s.reads,[{table:'matrix_models',ids:[id(10)]}]);
});
test('generic row with missing parent snapshot resolves item_id from its live row',async()=>{
 const s=setup([group(2,[line(2,{inventory_record_type:'matrix_row',metadata:{matrix_source:'generic'}})])],{
  matrix_rows:{[id(2)]:{id:id(2),item_id:id(10)}},matrix_models:{[id(10)]:{id:id(10),photo_data:'resolved-parent'}}});
 const r=await s.run();assert.equal(r.photos.get('group2').dataUrl,'jpeg:resolved-parent');assert.deepEqual(s.reads.map(q=>q.table),['matrix_rows','matrix_models']);
});
test('LED cabinet row photo takes priority over the screen model photo',async()=>{
 const s=setup([group(2,[line(2,{inventory_record_type:'matrix_row',parent_record_id:id(10)})])],{
  matrix_rows:{[id(2)]:{id:id(2),model_id:id(10),photo_data:'cabinet'}},matrix_models:{[id(10)]:{id:id(10),photo_data:'screen-model'}}});
 assert.equal((await s.run()).photos.get('group2').dataUrl,'jpeg:cabinet');
});
test('LED row missing its own photo can use its exact model photo',async()=>{
 const s=setup([group(2,[line(2,{inventory_record_type:'matrix_row'})])],{
  matrix_rows:{[id(2)]:{id:id(2),model_id:id(10)}},matrix_models:{[id(10)]:{id:id(10),photo_data:'screen-model'}}});
 assert.equal((await s.run()).photos.get('group2').dataUrl,'jpeg:screen-model');
});
test('serialized equipment uses the parent item photo, never a certificate/report photo',async()=>{
 const s=setup([group(2,[line(2,{inventory_record_type:'unit',parent_record_id:id(10)})])],{items:{[id(10)]:{id:id(10),photo_url:'item-photo'}}});
 assert.equal((await s.run()).photos.get('group2').dataUrl,'jpeg:item-photo');assert.deepEqual(s.reads.map(q=>q.table),['items']);
});
test('old serial snapshot without item id resolves the parent in two bounded batches',async()=>{
 const s=setup([group(2,[line(2,{inventory_record_type:'unit'})])],{units:{[id(2)]:{id:id(2),item_id:id(10)}},items:{[id(10)]:{id:id(10),photo_url:'unit-parent'}}});
 assert.equal((await s.run()).photos.get('group2').dataUrl,'jpeg:unit-parent');assert.deepEqual(s.reads.map(q=>q.table),['units','items']);
});
test('custom equipment intentionally without photos causes no catalog query or warning',async()=>{
 const s=setup([group(1,[line(1,{inventory_record_type:'item',metadata:{custom_item:true}})])]);const r=await s.run();
 assert.equal(r.photos.size,0);assert.equal(s.reads.length,0);assert.deepEqual(r.unavailable,[]);
});
test('broken/expired saved URL falls back to a new current URL first',async()=>{
 const s=setup([group(1,[line(1,{metadata:{photo_url:'expired'}})])],{matrix_models:{[id(1)]:{id:id(1),photo_data:'new'}}},async source=>source==='expired'?null:image(source));
 assert.equal((await s.run()).photos.get('group1').dataUrl,'jpeg:new');assert.deepEqual(s.loads,[{source:'expired',fresh:false},{source:'new',fresh:false}]);
});
test('a transient failed source is retried once uncached, with concurrent duplicate retries shared',async()=>{
 const groups=[1,2,3].map(n=>group(n,[line(n,{metadata:{photo_url:'transient'}})]));
 const s=setup(groups,{},async(source,fresh)=>fresh?image(source):null);const r=await s.run();
 assert.equal(r.photos.size,3);assert.deepEqual(s.loads,[{source:'transient',fresh:false},{source:'transient',fresh:true}]);
});
test('multiple groups sharing an image decode/resize it only once',async()=>{
 const s=setup([1,2,3,4,5].map(n=>group(n,[line(n,{metadata:{photo_url:'same'}})])));assert.equal((await s.run()).photos.size,5);assert.equal(s.loads.length,1);
});
test('decoding is capped at four concurrent photos, not Promise.all over the full inventory',async()=>{
 let active=0,peak=0;const s=setup(Array.from({length:20},(_,i)=>group(i+1,[line(i+1,{metadata:{photo_url:`photo${i}`}})])),{},async source=>{
  active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));active--;return image(source);
 });await s.run();assert.ok(peak<=4);assert.equal(peak,4);
});
test('201 missing photos use ID-filtered batches capped at 50, never one query per item',async()=>{
 const s=setup(Array.from({length:201},(_,i)=>group(i+1)));await s.run();assert.deepEqual(s.reads.map(q=>q.ids.length),[50,50,50,50,1]);assert.ok(s.reads.every(q=>q.table==='matrix_models'));
});
test('a catalog/RLS/network failure retains working photos and reports exact unresolved names',async()=>{
 const s=setup([group(1,[line(1,{metadata:{photo_url:'working'}})]),group(2)]);s.options.readCatalog=async()=>{throw Error('network');};
 const r=await s.run();assert.equal(r.photos.size,1);assert.deepEqual(r.unavailable,['Equipment 2']);
});
test('two equipment records with the same display name cannot exchange photos',async()=>{
 const a=group(1),b=group(2);b.displayName=a.displayName;
 const s=setup([a,b],{matrix_models:{[id(1)]:{id:id(1),photo_data:'A'},[id(2)]:{id:id(2),photo_data:'B'}}});const r=await s.run();
 assert.equal(r.photos.get('group1').dataUrl,'jpeg:A');assert.equal(r.photos.get('group2').dataUrl,'jpeg:B');
});
test('unrelated catalog rows cannot be matched by array index or name',async()=>{
 const s=setup([group(1)]);s.options.readCatalog=async()=>[{id:id(999),photo_data:'wrong-equipment'}];const r=await s.run();assert.equal(r.photos.size,0);assert.deepEqual(r.unavailable,['Equipment 1']);
});
test('invalid metadata IDs do not poison a valid batch, and UUID case is normalized',async()=>{
 const bad=line(1,{inventory_record_type:'unit',parent_record_id:null,metadata:{item_id:'not-a-uuid'}});
 const uppercase='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 const s=setup([group(1,[bad]),group(2,[line(2,{inventory_record_type:'unit',parent_record_id:uppercase.toUpperCase()})])],{items:{[uppercase]:{id:uppercase,photo_url:'valid'}}});
 const r=await s.run();assert.equal(r.photos.get('group2').dataUrl,'jpeg:valid');assert.ok(s.reads.every(q=>q.ids.every(id=>id!=='not-a-uuid')));
});
test('component uses exact minimal columns, group photo keys, timeouts, and visible missing-photo warnings',()=>{
 const src=read('components/EquipmentListDetailsClient.tsx');
 for(const fields of ['items: "id,photo_url"','matrix_models: "id,photo_data"','matrix_rows: "id,item_id,model_id,photo_data"','units: "id,item_id"'])assert.ok(src.includes(fields));
 assert.match(src,/\.in\("id", ids\)\.abortSignal/);assert.match(src,/photoKey: hasItemPhoto \? photoKey/);assert.match(src,/itemPhotos.get\(raw.photoKey\)/);
 assert.doesNotMatch(src,/itemPhotos.get\(raw.photoUrl\)/);assert.match(src,/pdfPhotoWarnings.length > 0/);assert.match(src,/fresh \? "no-store" : "force-cache"/);
 assert.doesNotMatch(read('lib/pdfItemPhotos.ts'),/\.update\(|\.insert\(|\.delete\(|setInterval|\.channel\(/);
});

test('actual PDF builder places all 15 recovered group photos, with existing JPEG box/layout geometry',async()=>{
 const src=read('components/EquipmentListDetailsClient.tsx');
 const from=src.indexOf('  async function createListPdf() {'),to=src.indexOf('\n  async function downloadPdf(',from);
 const code=stripTypeScriptTypes(src.slice(from,to),{mode:'strip'})
  .replace('import("jspdf")','Promise.resolve(jspdfModule)').replace('import("jspdf-autotable")','Promise.resolve(tableModule)');
 const groups=Array.from({length:15},(_,i)=>({key:`equipment${i}`,displayName:`Scaffold ${i}`,blockName:null,
  items:[{...line(i+1),display_name:`Scaffold ${i}`,requested_quantity:i+1,metadata:{category:'rigging',item_type:'unit',...(i<8?{photo_url:`saved${i}`}:{})}}]}));
 const records=Object.fromEntries(Array.from({length:7},(_,i)=>[id(i+9),{id:id(i+9),photo_data:`current${i}`}]))
 const drawn=[],queries=[],states=[];let tableBody;
 const pdf=new Proxy({}, {get:(_,key)=>key==='getNumberOfPages'?()=>1:key==='splitTextToSize'?value=>[String(value)]:key==='getTextWidth'?value=>String(value).length:
  key==='addImage'?(...args)=>drawn.push(args):()=>{}});
 function PDF(){return pdf;}
 const deps={list:{id:'list',reference:'EV-fixture',list_type:'local_event',status:'draft',venue:'DWTC',created_by_name:'Test',notes:null},
  getUserId:()=> 'owner',dispatchContext:{current:{listId:'list'}},setPdfPhotoWarnings:value=>states.push(value),
  jspdfModule:{jsPDF:PDF},tableModule:{autoTable(_pdf,options){tableBody=options.body;let y=60;for(const cells of options.body){
   for(const raw of cells)if(raw.rowKind)options.didDrawCell({cell:{raw,x:14,y,width:156,height:raw.styles?.minCellHeight||8}});y+=13;
  }}},loadPdfLogo:async()=>null,prepareListPdfPhotos,sortedGroups:groups,loadPdfItemPhoto:async source=>image(source),
  PDF_PHOTO_COLUMNS:{matrix_models:'id,photo_data'},window:{setTimeout:()=>1,clearTimeout(){}},AbortController,
  supabase:{from(table){queries.push(table);let ids=[];return{select(){return this;},in(_field,next){ids=next;return this;},abortSignal(){return Promise.resolve({data:ids.map(id=>records[id]).filter(Boolean),error:null});}};}},
  displayedStatusLabel:()=> 'Draft',pdfHeading:()=> 'Scaffolding',equipmentListSummary:()=> 'DWTC',scheduleRows:()=>[],
  categoryLabel:()=> 'Rigging',metadataText:(item,key)=>typeof item.metadata?.[key]==='string'?item.metadata[key]:'',
  equipmentDisplayParts:(_item,name)=>({brand:'',model:name,primaryName:name,cabinetDetail:''}),rackRowsByModel:{},hiddenUnitGroupKeys:new Set(),
  draftDescriptions:{},draftDescriptionKey:item=>item.id,pdfUnitLabel:()=>'',formatUnitQuantity:q=>`${q} Units`,formatSquareMetres:q=>`${q} SQM`,pdfFileName:()=> 'fixture.pdf'};
 const build=new Function(...Object.keys(deps),`${code};return createListPdf;`)(...Object.values(deps));
 assert.equal((await build()).fileName,'fixture.pdf');assert.equal(drawn.length,15);
 assert.deepEqual(queries,['matrix_models']);assert.deepEqual(states.at(-1),[]);
 const rows=tableBody.filter(cells=>cells[0]?.rowKind==='item');assert.equal(rows.length,15);assert.ok(rows.every(cells=>cells[0].photoKey));
 assert.deepEqual(rows.map(cells=>cells[1].content),Array.from({length:15},(_,i)=>`${i+1} Units`),'quantities remain unchanged');
 assert.ok(drawn.every(call=>call[1]==='JPEG'&&call[4]<=7.8+.00001&&call[5]<=7.8+.00001),'same image box, no text/qty overlap');
});

// Execute the actual browser conversion function with image/canvas boundaries stubbed.
function browserLoader(options={}) {
 const src=read('components/EquipmentListDetailsClient.tsx'),start=src.indexOf('async function loadPdfItemPhoto('),end=src.indexOf('\nfunction pdfHeading(',start);
 const code=stripTypeScriptTypes(src.slice(start,end),{mode:'strip'}),timers=new Map(),events={fetches:[],canvas:[]};let sequence=0;
 const win={setTimeout(fn){const id=++sequence;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);}};
 class Reader{readAsDataURL(){this.result='data:image/png;base64,decoded';queueMicrotask(()=>this.onload?.());}abort(){this.onabort?.();}}
 class Img{constructor(){this.naturalWidth=options.width??800;this.naturalHeight=options.height??400;}set src(value){this.source=value;if(!options.hangImage)queueMicrotask(()=>options.badImage?this.onerror?.():this.onload?.());}removeAttribute(){events.cancelledImage=true;}}
 const document={createElement(tag){assert.equal(tag,'canvas');return{width:0,height:0,getContext(){return options.noContext?null:{fillStyle:'',fillRect(){},drawImage(...args){events.canvas.push(args.slice(-2));}};},toDataURL(type,quality){events.encoding={type,quality};return 'data:image/jpeg;base64,small';}};}};
 const fetch=async(source,init)=>{events.fetches.push({source,...init});if(options.hangFetch)return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted'))));return{ok:!options.httpError,blob:async()=>({})};};
 const load=new Function('window','FileReader','Image','document','fetch','AbortController',`${code};return loadPdfItemPhoto;`)(win,Reader,Img,document,fetch,AbortController);
 return{load,timers,events,fire(id){const fn=timers.get(id);timers.delete(id);fn?.();}};
}
test('actual browser image converter keeps JPEG compression and 240px aspect-ratio resizing',async()=>{
 const b=browserLoader(),r=await b.load('data:image/png;base64,photo');assert.deepEqual(r,{dataUrl:'data:image/jpeg;base64,small',width:240,height:120});
 assert.equal(b.events.fetches.length,0);assert.deepEqual(b.events.encoding,{type:'image/jpeg',quality:.82});assert.equal(b.timers.size,0);
});
test('fresh retry bypasses stale image HTTP cache while keeping the normal first read cached',async()=>{
 const b=browserLoader();await b.load('https://example.test/photo');await b.load('https://example.test/photo',true);
 assert.deepEqual(b.events.fetches.map(r=>r.cache),['force-cache','no-store']);assert.equal(b.timers.size,0);
});
test('HTTP, decode and missing canvas failures return null, not an empty PDF image slot',async()=>{
 for(const options of [{httpError:true},{badImage:true},{noContext:true},{width:0,height:0}]){const b=browserLoader(options);assert.equal(await b.load('https://example.test/photo'),null);assert.equal(b.timers.size,0);}
});
test('hanging image requests are aborted and do not block export forever',async()=>{
 const b=browserLoader({hangFetch:true}),pending=b.load('https://example.test/photo');b.fire(1);assert.equal(await pending,null);assert.equal(b.events.fetches[0].signal.aborted,true);assert.equal(b.timers.size,0);
});
test('hanging image decoding is stopped and cleaned up',async()=>{
 const b=browserLoader({hangImage:true}),pending=b.load('data:image/png;base64,photo');b.fire(2);assert.equal(await pending,null);assert.equal(b.events.cancelledImage,true);assert.equal(b.timers.size,0);
});

test('CORS-blocked saved photos recover via the read-only server callback without catalog reads',async()=>{
 const source='https://duscaff.com/_next/image?url=%2Fassets%2Fimages%2Fproducts%2Flistings%2Fbase-jacks.png&w=3840&q=75';
 const groups=Array.from({length:7},(_,i)=>group(i+1,[line(i+1,{metadata:{photo_url:source}})]));
 const s=setup(groups,{},async()=>{throw new TypeError('Failed to fetch');}),server=[];
 s.options.loadServerPhoto=async(source,lineId)=>{server.push({source,lineId});return image(source);};
 const r=await s.run();assert.equal(r.photos.size,7);assert.deepEqual(r.unavailable,[]);assert.equal(server.length,1);assert.equal(s.reads.length,0);
 assert.equal(server[0].lineId,groups[0].items[0].id);assert.equal(s.loads.length,1,'one browser attempt per source');
});
test('server fallback selects the actual later line that owns the saved source',async()=>{
 const s=setup([group(1,[line(1),line(2,{metadata:{photo_url:'https://supplier.com/photo.png'}})])],{},async()=>null);let requested;
 s.options.loadServerPhoto=async(source,lineId)=>{requested=lineId;return image(source);};
 assert.equal((await s.run()).photos.size,1);assert.equal(requested,id(1002));
});
test('working photos never invoke the server and inline data never goes to that route',async()=>{
 const s=setup([group(1,[line(1,{metadata:{photo_url:'https://supplier.com/works'}})]),group(2,[line(2,{metadata:{photo_url:'data:image/png;base64,bad'}})])],{},async source=>source.includes('works')?image(source):null);
 s.options.loadServerPhoto=async()=>{throw Error('must not be called');};assert.equal((await s.run()).photos.size,1);
});
test('server failure is deduplicated and preserves partial PDF plus exact unresolved names',async()=>{
 const s=setup([group(1,[line(1,{metadata:{photo_url:'https://supplier.com/missing'}})]),group(2,[line(2,{metadata:{photo_url:'saved'}})])],{},async source=>source==='saved'?image(source):null);let calls=0;
 s.options.loadServerPhoto=async()=>{calls++;throw Error('host refused');};const r=await s.run();
 assert.equal(calls,1);assert.equal(r.photos.size,1);assert.deepEqual(r.unavailable,['Equipment 1']);
});
test('current inventory photo can use the same server recovery when old snapshots are empty',async()=>{
 const source='https://supplier.com/current',s=setup([group(1)],{matrix_models:{[id(1)]:{id:id(1),photo_data:source}}},async()=>null);
 const calls=[];s.options.loadServerPhoto=async(url,lineId)=>{calls.push({url,lineId});return image(url);};
 assert.equal((await s.run()).photos.size,1);assert.deepEqual(calls,[{url:source,lineId:id(1001)}]);
});
test('actual browser converter uses a same-origin POST for the server image, not the Admin optimizer',async()=>{
 const b=browserLoader(),body={listId:id(1),lineId:id(2),imageUrl:'https://supplier.com/photo.png'};
 const result=await b.load(body.imageUrl,true,body);assert.ok(result);const request=b.events.fetches[0];
 assert.equal(request.source,'/api/equipment-list-pdf-photo');assert.equal(request.method,'POST');assert.equal(request.credentials,'same-origin');
 assert.equal(request.cache,'no-store');assert.deepEqual(JSON.parse(request.body),body);assert.equal(b.timers.size,0);
 const src=read('components/EquipmentListDetailsClient.tsx');assert.match(src,/loadServerPhoto: \(source, lineId\)/);assert.match(src,/if \(isOffline\(\)/);
 assert.doesNotMatch(src,/fetch\("\/api\/optimize-image"/);
});
test('seven distinct CORS-blocked supplier photos recover with a maximum of four server conversions at once',async()=>{
 const groups=Array.from({length:7},(_,i)=>group(i+1,[line(i+1,{metadata:{photo_url:`https://supplier.com/ringlock-${i}.png`}})]));
 const s=setup(groups,{},async()=>null);let active=0,peak=0,total=0;
 s.options.loadServerPhoto=async source=>{active++;total++;peak=Math.max(peak,active);await new Promise(setImmediate);active--;return image(source);};
 const result=await s.run();assert.equal(result.photos.size,7);assert.deepEqual(result.unavailable,[]);assert.equal(total,7);assert.equal(peak,4);assert.equal(s.reads.length,0);
});

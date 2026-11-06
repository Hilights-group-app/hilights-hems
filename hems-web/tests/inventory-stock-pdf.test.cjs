const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module');
const {buildInventoryStock,readInventoryStock,stockDates,stockFileName,stockCabinetArea}=require('../lib/inventoryStockData.ts');
const {prepareStockPhotos}=require('../lib/inventoryStockPdf.ts');
const {PdfPhotoDownloadError}=require('../lib/pdfPhotoDownload.ts');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=new Date('2026-11-04T21:30:00Z');
const base=(more={})=>({title:'Lighting Fixtures',category:'Lighting',type:'fixture_units',items:[],units:[],models:[],matrixRows:[],reservations:[],now,...more});
const item=(n,more={})=>({id:id(n),name:`Brand - Model ${n}`,fixture_type:'Block',...more});
const qty=(more={})=>({total:10,available:10,reserved:0,out:0,ksa:0,repair:0,expired:0,...more});
const photo={recordType:'item',recordId:id(1),imageUrl:'https://supplier.com/photo.png'};
test('filename/date use Dubai calendar day, sanitize names and include the Stock suffix',()=>{
 assert.equal(stockDates(now).date,'05 Nov 2026');assert.equal(stockDates(now).day,'2026-11-05');assert.match(stockDates(now).timestamp,/Dubai$/);
 assert.equal(stockFileName('Lighting Fixtures','05 Nov 2026'),'Lighting Fixtures Stock - 05 Nov 2026.pdf');assert.doesNotMatch(stockFileName('A/B:Test','05 Nov 2026'),/[/:]/);assert.throws(()=>stockDates(new Date('bad')));
});
test('serialized families count physical statuses, preserve full descriptions, and subtract Pending reservations',()=>{
 const s=buildInventoryStock(base({items:[item(1,{description:'6 x socapex out\n2 x 32A 3ph out'})],units:['available','available','in_use','in_ksa','maintenance'].map(status=>({item_id:id(1),status})),reservations:[{record_type:'unit',record_id:id(99),parent_id:id(1),quantity:1,available_quantity:1}]}));
 assert.deepEqual(s.rows[0].counts,qty({total:5,available:1,reserved:1,out:1,ksa:1,repair:1}));assert.equal(s.rows[0].description,'6 x socapex out\n2 x 32A 3ph out');
});
test('reserved units already out do not get subtracted a second time',()=>{
 const s=buildInventoryStock(base({items:[item(1)],units:[{item_id:id(1),status:'available'},{item_id:id(1),status:'in_use'}],reservations:[{record_type:'unit',record_id:id(2),parent_id:id(1),quantity:1,available_quantity:0}]}));assert.equal(s.rows[0].counts.available,1);assert.equal(s.rows[0].counts.reserved,0);
});
test('Lighting fixture blocks retain their defined order; unassigned blocks stay last',()=>{
 const s=buildInventoryStock(base({type:'lighting',items:[item(1,{fixture_type:'Moving Head Wash'}),item(2,{fixture_type:null}),item(3,{fixture_type:'Moving Head Spot'})]}));assert.deepEqual(s.rows.map(r=>r.block),['Moving Head Spot','Moving Head Wash','Unassigned']);
});
test('Chain Hoist uses Failed counts and excludes failed hoists from expiry/available',()=>{
 const s=buildInventoryStock(base({type:'chain_hoist_units',items:[item(1)],units:[{item_id:id(1),status:'available',expiry_date:'2026-01-01'},{item_id:id(1),status:'maintenance',expiry_date:'2026-01-01'},{item_id:id(1),status:'in_use',expiry_date:'2026-01-01'},{item_id:id(1),status:'available',expiry_date:'2027-01-01'}]}));
 assert.deepEqual(s.rows[0].counts,qty({total:4,available:1,repair:1,out:1,expired:2}));assert.ok(s.notes.some(s=>s.includes('overlap')));
});
test('unknown physical status is not silently exported as Available',()=>{
 const s=buildInventoryStock(base({items:[item(1)],units:[{item_id:id(1),status:'unknown'}]}));assert.equal(s.rows[0].counts.total,1);assert.equal(s.rows[0].counts.available,0);assert.match(s.rows[0].detail,/unrecognized/);
});
test('Matrix uses the shared block/item order, not current search results or alphabetical IDs',()=>{
 const s=buildInventoryStock(base({type:'matrix',models:[item(1,{block_name:'A',total_qty:5}),item(2,{block_name:'B',total_qty:8}),item(3,{block_name:'B',total_qty:4})],order:{block_order:['B','A'],item_order_by_block:{B:[id(3),id(2)]}}}));assert.deepEqual(s.rows.map(r=>r.key),['model:'+id(3),'model:'+id(2),'model:'+id(1)]);
});
test('Matrix stock accounts for all occupied/repair/KSA and reserved quantities',()=>{
 const s=buildInventoryStock(base({type:'matrix',models:[item(1,{total_qty:20,in_use_qty:3,in_ksa_qty:4,maintenance_qty:2})],reservations:[{record_type:'matrix_model',record_id:id(1),quantity:5}]}));assert.deepEqual(s.rows[0].counts,qty({total:20,available:6,reserved:5,out:3,ksa:4,repair:2}));
});
test('cable length rows carry their own stock, stay under their parent name and are not double-counted',()=>{
 const s=buildInventoryStock(base({type:'matrix',models:[item(1,{item_type:'cable',total_qty:0,photo_data:'photo'})],matrixRows:[{id:id(2),item_id:id(1),cable_length:'25m',total_qty:10,in_use_qty:2},{id:id(3),item_id:id(1),cable_length:'5m',total_qty:6}],reservations:[{record_type:'matrix_row',record_id:id(2),quantity:3}]}));
 assert.equal(s.rows[0].counts,null);assert.deepEqual(s.rows.slice(1).map(r=>r.name),['5m','25m']);assert.equal(s.rows[2].counts.available,5);assert.equal(s.rows[2].child,true);assert.equal(s.rows[0].photo.recordType,'matrix_model');assert.equal(s.rows[2].photo,undefined);
});
test('rack contents are labeled per rack and do not masquerade as separately available stock',()=>{
 const s=buildInventoryStock(base({type:'matrix',models:[item(1,{item_type:'rack',total_qty:2})],matrixRows:[{id:id(2),item_id:id(1),cable_length:'Power cable',total_qty:4}]}));assert.equal(s.rows[0].counts.total,2);assert.equal(s.rows[1].counts,null);assert.equal(s.rows[1].detail,'4 per rack');
});
test('LED cabinet geometry converts every stock counter to SQM with explicit unit support',()=>{
 for(const size of ['500x1000','500mm x 1000mm','50cm × 100cm','0.5 x 1m'])assert.equal(stockCabinetArea(size),.5,size);
 const s=buildInventoryStock(base({type:'led_screen_units',models:[item(1)],matrixRows:[{id:id(2),model_id:id(1),size:'500x1000',cabinet_model:'NT2.6',qty:20,in_use_qty:4,in_ksa_qty:2,maintenance_qty:2,photo_data:'cabinet'}],reservations:[{record_type:'matrix_row',record_id:id(2),quantity:2}]}));
 assert.equal(s.rows[0].counts,null);assert.deepEqual(s.rows[1].counts,qty({total:10,available:5,reserved:1,out:2,ksa:1,repair:1}));assert.equal(s.rows[1].unit,'SQM');assert.equal(s.rows[1].photo.recordType,'matrix_row');
});
test('unknown LED dimensions are cabinets, never a fabricated 1 SQM per cabinet',()=>{
 const s=buildInventoryStock(base({type:'led_screen_units',models:[item(1)],matrixRows:[{id:id(2),model_id:id(1),size:'unknown',qty:20}]}));assert.equal(stockCabinetArea('unknown'),0);assert.equal(s.rows[1].unit,'cab');assert.equal(s.rows[1].counts.total,20);assert.match(s.rows[1].detail,/not SQM/);
});

function db(options={}){
 const subcategory={id:id(100),name:'Lighting Fixtures',category_id:id(101),slug:'lighting-fixtures',type:'fixture_units',...options.subcategory};
 const tables={subcategories:[subcategory],categories:[{id:id(101),name:'Lighting',slug:'lighting'}],items:[],units:[],matrix_models:[],matrix_rows:[],matrix_manual_orders:[],...options.tables},queries=[];
 const client={from(table){const q={table,filters:[],after:'',size:500};queries.push(q);const chain={select(columns){q.columns=columns;return chain;},eq(field,value){q.filters.push([field,[value]]);return chain;},in(field,values){q.filters.push([field,values]);return chain;},order(value){q.order=value;return chain;},limit(size){q.size=size;return chain;},gt(field,value){assert.equal(field,'id');q.after=value;return chain;},abortSignal(signal){q.signal=signal;return chain;},maybeSingle:async()=>execute(true),then(resolve,reject){return Promise.resolve(execute(false)).then(resolve,reject);}};
 function execute(single){if(options.error?.(q))return{data:null,error:{message:'failed'}};const rows=(tables[table]??[]).filter(row=>q.filters.every(([field,values])=>values.includes(row[field]))&&(!q.after||row.id>q.after)).sort((a,b)=>a.id?.localeCompare(b.id)).slice(0,q.size);return{data:single?rows[0]??null:rows,error:null};}return chain;},rpc(name){queries.push({rpc:name});return{abortSignal:async()=>({data:options.reservations??[],error:options.rpcError??null})};}};
 return{client,queries,run:()=>readInventoryStock(client,id(100),new AbortController().signal,now)};
}
test('a stale route cannot export a different subcategory',async()=>{
 const d=db();await assert.rejects(()=>readInventoryStock(d.client,id(100),new AbortController().signal,now,'/inventory/lighting/other'),/page is still changing/);assert.equal(d.queries.some(q=>q.table==='items'||q.rpc),false);
});
test('fresh export pages beyond 1,000 units using stable keyset pagination and minimal fields',async()=>{
 const d=db({tables:{items:[item(1,{subcategory_id:id(100)})],units:Array.from({length:1005},(_,i)=>({id:id(i+1000),item_id:id(1),status:'available'}))}}),stock=await d.run();assert.equal(stock.rows[0].counts.total,1005);const pages=d.queries.filter(q=>q.table==='units');assert.equal(pages.length,3);assert.ok(pages.slice(1).every(q=>q.after));assert.ok(pages.every(q=>q.columns==='id,item_id,status'&&q.order==='id'));assert.equal(d.queries.filter(q=>q.rpc).length,1);
});
test('parent IDs are batched at 100 and source reads are scoped to the selected subcategory',async()=>{
 const models=Array.from({length:101},(_,i)=>item(i+1,{subcategory_id:id(100),item_type:'cable',total_qty:0}));
 const d=db({subcategory:{type:'matrix',slug:'cables'},tables:{matrix_models:models}});await d.run();assert.equal(d.queries.filter(q=>q.table==='matrix_rows').length,2);assert.ok(d.queries.filter(q=>q.table==='matrix_rows').every(q=>q.filters[0][1].length<=100));assert.ok(d.queries.filter(q=>q.table==='matrix_models').every(q=>q.filters[0][0]==='subcategory_id'));assert.ok(!d.queries.some(q=>q.table==='profiles'));
});
test('query/RLS/reservation failures fail the export instead of creating partial stock or false Available counts',async()=>{
 const opts={tables:{items:[item(1,{subcategory_id:id(100)})]}};
 await assert.rejects(db({...opts,error:q=>q.table==='units'}).run(),/No partial stock PDF/);
 await assert.rejects(db({...opts,rpcError:{message:'timeout'}}).run(),/Reservations could not be verified/);
 await assert.rejects(db({tables:{subcategories:[]}}).run(),/unavailable/);
 await assert.rejects(db({subcategory:{type:'matrix'},error:q=>q.table==='matrix_manual_orders'}).run(),/saved Matrix order/);
});
test('empty subcategories remain exportable and unsupported inventory types do not silently export zero stock',async()=>{
 assert.equal((await db().run()).rows.length,0);await assert.rejects(db({subcategory:{type:'future_unknown'}}).run(),/not supported/);
});

test('stock photo loading deduplicates browser/server reads, recovers CORS failures and remains read-only',async()=>{
 const rows=Array.from({length:8},(_,i)=>({key:'row'+i,name:'Item '+i,photo})),calls=[];
 const r=await prepareStockPhotos(rows,new AbortController().signal,async(source,signal,request)=>{calls.push({source,request});return request?{dataUrl:'jpeg',width:100,height:100}:null;});
 assert.equal(r.photos.size,8);assert.equal(r.missing.length,0);assert.equal(calls.length,2);assert.deepEqual(calls[1].request,{photo});
});
test('photo concurrency is four, blocked supplier photos are named, and an abort starts no new server reads',async()=>{
 let active=0,peak=0;const rows=Array.from({length:9},(_,i)=>({key:'row'+i,name:'Item '+i,photo:{...photo,imageUrl:'https://supplier.com/'+i}}));
 const r=await prepareStockPhotos(rows,new AbortController().signal,async()=>{active++;peak=Math.max(active,peak);await new Promise(setImmediate);active--;return null;});assert.equal(peak,4);assert.equal(r.missing.length,9);
 const controller=new AbortController();controller.abort();let server=0;await prepareStockPhotos(rows,controller.signal,async(s,signal,request)=>{if(request)server++;return null;});assert.equal(server,0);
});

function pdfBuilder(stock){
 const draws=[],texts=[],tables=[];let pages=1,font='normal',size=8,current=1;
 const pdf={setFont(_name,style){font=style;},setFontSize(value){size=value;},getTextWidth(text){return String(text).length*size*.15*(font==='bold'?1.06:1);},splitTextToSize(text,width){const limit=Math.max(1,Math.floor(width/(size*.15*1.06))),out=[];for(const line of String(text).split('\n')){if(!line)out.push('');for(let i=0;i<line.length;i+=limit)out.push(line.slice(i,i+limit));}return out;},text(text,x,y){texts.push({text,x,y,font,size,page:current});},addImage(...args){draws.push(args);},getNumberOfPages(){return pages;},setPage(n){current=n;},setTextColor(){},setDrawColor(){},setFillColor(){},line(){},rect(){},roundedRect(){}};
 const autoTable=(_pdf,options)=>{tables.push(options);let y=options.startY;for(const cells of options.body){const h=Math.max(7,...cells.map(c=>c.styles?.minCellHeight??0));if(y+h>281){pages++;current=pages;y=14;}let x=14;for(let i=0;i<cells.length;i++){const cell=cells[i],w=cell.colSpan?182:options.columnStyles[i].cellWidth;options.didDrawCell({column:{index:i},cell:{raw:cell,x,y,width:w,height:h}});x+=w;}y+=h;}};
 const src=read('lib/inventoryStockPdf.ts'),a=src.indexOf('export async function makeInventoryStockPdf('),code=stripTypeScriptTypes(src.slice(a),{mode:'strip'}).replace('export async function','async function').replace('import("jspdf")','Promise.resolve({jsPDF:PDF})').replace('import("jspdf-autotable")','Promise.resolve({autoTable:mockTable})');
 const build=new Function('PDF','mockTable','imageData','prepareStockPhotos',`${code};return makeInventoryStockPdf;`)(function(){return pdf;},autoTable,async()=>null,async rows=>({photos:new Map(rows.filter(r=>r.photo).map(r=>[r.key,{dataUrl:'jpeg',width:120,height:60}])),missing:[]}));
 return{run:()=>build(stock,new AbortController().signal),tables,draws,texts};
}
test('actual PDF builder produces dated branding, compact columns, photos, brand-bold/model-normal and multiline descriptions',async()=>{
 const stock=buildInventoryStock(base({items:[item(1,{name:'Ringlock - Base jack',description:'Line one\nLine two',photo_url:photo.imageUrl})],units:[{item_id:id(1),status:'available'}]})),p=pdfBuilder(stock),r=await p.run();
 assert.equal(r.fileName,'Lighting Fixtures Stock - 05 Nov 2026.pdf');assert.equal(p.draws.length,1);assert.deepEqual(p.tables[0].head[0],['Equipment','Total','Available']);assert.ok(p.texts.some(t=>t.text==='Ringlock'&&t.font==='bold'));assert.ok(p.texts.some(t=>t.text.includes('Base')&&t.font==='normal'));assert.ok(p.texts.some(t=>t.text==='Line two'&&t.size===6.3));
 assert.equal(Object.values(p.tables[0].columnStyles).reduce((s,c)=>s+c.cellWidth,0),182);assert.ok(p.draws.every(d=>d[4]<=7.800001&&d[5]<=7.800001));assert.ok(p.texts.some(t=>t.text.includes('Page 1 of')));
});
test('actual PDF has SQM on LED counters, length rows aligned with item text, and dynamic Failed/Expired columns',async()=>{
 const led=buildInventoryStock(base({type:'led_screen_units',models:[item(1)],matrixRows:[{id:id(2),model_id:id(1),size:'500x1000',qty:20,in_ksa_qty:4}]})),p=pdfBuilder(led);await p.run();assert.ok(p.tables[0].body.some(cells=>cells.some(c=>c.content==='10 SQM')));assert.ok(p.tables[0].head[0].includes('In KSA'));
 const chain=buildInventoryStock(base({type:'chain_hoist_units',items:[item(1)],units:[{item_id:id(1),status:'maintenance'},{item_id:id(1),status:'available',expiry_date:'2026-01-01'}]})),q=pdfBuilder(chain);await q.run();assert.ok(q.tables[0].head[0].includes('Failed'));assert.ok(q.tables[0].head[0].includes('Expired'));assert.ok(!q.tables[0].head[0].includes('Maintenance'));
 const empty=pdfBuilder(buildInventoryStock(base()));await empty.run();assert.ok(empty.texts.some(t=>t.text==='No equipment in this subcategory.'));
});
test('long descriptions are fully split into bounded continuation rows without duplicated stock or repeated photos',async()=>{
 const desc=Array.from({length:110},(_,i)=>'Description line '+i).join('\n'),stock=buildInventoryStock(base({items:[item(1,{description:desc,photo_url:photo.imageUrl})],units:[{item_id:id(1),status:'available'}]})),p=pdfBuilder(stock);await p.run();const rows=p.tables[0].body.filter(c=>c[0].kind==='item');assert.ok(rows.length>1);assert.ok(rows.every(c=>c[0].rich.length+c[0].small.length<=40));assert.ok(rows.slice(1).every(c=>c.slice(1).every(cell=>cell.content==='—')));assert.equal(p.draws.length,1);assert.ok(p.texts.some(t=>t.text==='Description line 109'));
});
test('header wiring covers all routed subcategory types without touching their forms, and PDF imports are click-only',()=>{
 const router=read('components/SubcategoryRouterClient.tsx'),shell=read('components/SubcategoryShellClient.tsx'),button=read('components/InventoryStockPdfButton.tsx');assert.match(router,/stockSubcategoryId=\{subcategoryId\}/);assert.match(shell,/InventoryStockPdfButton key=\{`\$\{stockSubcategoryId\}:\$\{stockPath\}`\}/);
 assert.match(button,/running.current/);assert.match(button,/getUserId\(\)!==owner/);assert.match(button,/isOffline\(\)/);assert.match(button,/request.current\?\.abort\(\)/);assert.match(button,/aria-busy=\{busy\}/);
 assert.ok(button.indexOf('import("@/lib/inventoryStockData")')>button.indexOf('async function download()'));assert.doesNotMatch(read('lib/inventoryStockData.ts'),/\.insert\(|\.update\(|\.delete\(|\.channel\(|setInterval/);
});

// Exercise the actual read-only API; Supabase/network/encoder boundaries mocked.
const optimizer=stripTypeScriptTypes(read('lib/optimizeInventoryPhoto.ts'),{mode:'strip'}).replace(/^import .*;\s*$/gm,'').replace(/\bexport (?=const|async function)/g,'');
const {readImportImageUrl}=new Function('sharp',`${optimizer};return {readImportImageUrl};`)(()=>{});
class Reply extends Response{static json(value,options){return new Reply(JSON.stringify(value),{...options,headers:{'Content-Type':'application/json',...options?.headers}});}}
function imageRoute(options={}){
 const queries=[],downloads=[];const client={auth:{getUser:async()=>({data:{user:options.anonymous?null:{id:'viewer'}},error:null})},from(table){queries.push(table);return{select(){return this;},eq(){return this;},abortSignal(){return this;},maybeSingle:async()=>({data:options.hidden?null:{id:id(1),photo_url:options.mismatch?'other':photo.imageUrl,photo_data:options.mismatch?'other':photo.imageUrl},error:options.dbError??null})};}};
 const src=stripTypeScriptTypes(read('app/api/inventory-pdf-photo/route.ts'),{mode:'strip'}).replace(/^import .*;\s*$/gm,'').replace(/\bexport (?=const|async function)/g,'');
 const post=new Function('NextResponse','createClient','downloadPublicPdfPhoto','PdfPhotoDownloadError','optimizeInventoryPhoto','readImportImageUrl',`${src};return POST;`)(Reply,async()=>client,async source=>{downloads.push(source);if(options.hostError)throw new PdfPhotoDownloadError('PHOTO_HOST_ERROR','The photo host returned HTTP 403.');return Buffer.from('raster');},PdfPhotoDownloadError,async()=>Buffer.from('webp'),readImportImageUrl);
 const run=(kind='item',headers={})=>post(new Request('https://app.com/api/inventory-pdf-photo',{method:'POST',headers:{'Content-Type':'application/json','x-hems-photo-type':kind,'x-hems-photo-id':id(1),...headers},body:JSON.stringify({imageUrl:photo.imageUrl})}));return{run,queries,downloads};
}
test('inventory PDF image route allows normal RLS readers, proves the exact current photo, and never writes Storage',async()=>{
 for(const [kind,table] of [['item','items'],['matrix_model','matrix_models'],['matrix_row','matrix_rows']]){const r=imageRoute(),result=await r.run(kind);assert.equal(result.status,200);assert.equal(result.headers.get('content-type'),'image/webp');assert.match(result.headers.get('cache-control'),/private, no-store/);assert.deepEqual(r.queries,[table]);assert.equal(r.downloads.length,1);}
 const source=read('app/api/inventory-pdf-photo/route.ts');assert.doesNotMatch(source,/supabaseAdmin|\.storage|\.upload\(|from\("profiles"\)|\.update\(|\.insert\(|\.delete\(/);
});
test('inventory photo route denies anonymous, hidden, mismatched, arbitrary-type and cross-site requests before fetching',async()=>{
 for(const [options,kind,headers,status] of [[{anonymous:true},'item',{},401],[{hidden:true},'item',{},404],[{mismatch:true},'item',{},403],[{},'profiles',{},400],[{},'item',{'sec-fetch-site':'cross-site'},403],[{},'item',{'Content-Type':'text/plain'},415],[{dbError:{message:'timeout'}},'item',{},503]]){const r=imageRoute(options),result=await r.run(kind,headers);assert.equal(result.status,status);assert.equal(r.downloads.length,0);}
 const host=imageRoute({hostError:true}),result=await host.run();assert.equal(result.status,502);assert.match((await result.json()).error,/HTTP 403/);assert.equal(host.downloads.length,1);
});

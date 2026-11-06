const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module');
const {createImportPhotoResolver,isInventoryStoragePhoto}=require('../lib/inventoryImportPhotos.ts');
const {PdfPhotoDownloadError}=require('../lib/pdfPhotoDownload.ts');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const project='https://example-project.supabase.co',stored=project+'/storage/v1/object/public/equipment-photos/items/thumbs/photo.webp';
const external='https://supplier.com/photo.png';
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function resolverWith(reply){const requests=[];const resolver=createImportPhotoResolver(project,async(url,init)=>{requests.push({url,init});return typeof reply==='function'?reply():reply;});return{...resolver,requests};}

test('resolver calls the existing Admin-only optimizer and accepts only our Storage URL',async()=>{
 const r=resolverWith(response({url:stored}));assert.deepEqual(await r.resolve(external),{url:stored});
 const req=r.requests[0];assert.equal(req.url,'/api/optimize-image');assert.equal(req.init.method,'POST');assert.equal(req.init.credentials,'same-origin');assert.equal(req.init.cache,'no-store');assert.deepEqual(JSON.parse(req.init.body),{imageUrl:external});
});
test('repeated photo URLs share one upload per import run, including simultaneous resolutions',async()=>{
 const r=resolverWith(()=>response({url:stored}));const results=await Promise.all(Array.from({length:10},()=>r.resolve(' '+external+' ')));
 assert.equal(r.requests.length,1);assert.ok(results.every(r=>r.url===stored));
 const fresh=resolverWith(response({url:stored}));await fresh.resolve(external);assert.equal(fresh.requests.length,1,'no global cross-user cache');
});
test('blank photos need no request and unsupported/huge URLs never become database photos',async()=>{
 const r=resolverWith(()=>{throw Error('must not be called');});for(const blank of ['',null,undefined,'   '])assert.deepEqual(await r.resolve(blank),{url:null});
 for(const bad of ['file:///etc/passwd','ftp://supplier.com/a','data:image/png;base64,aaa','https://supplier.com/'+('a'.repeat(5000))]){const result=await r.resolve(bad);assert.equal(result.url,null);assert.ok(result.error);}
 assert.equal(r.requests.length,0);
});
test('failed download/upload has a named-ready error and never falls back to the external link',async()=>{
 for(const reply of [response({error:'The photo host returned HTTP 403.'},502),response({error:'Storage failed'},500),new Response('not JSON',{status:502})]){const r=resolverWith(reply),result=await r.resolve(external);assert.equal(result.url,null);assert.ok(result.error);assert.equal(result.permissionDenied,false);}
 const r=resolverWith(()=>{throw Error('network');});assert.equal((await r.resolve(external)).url,null);await r.resolve(external);assert.equal(r.requests.length,1,'failure is cached, not retried for every row');
});
test('only API auth denial is fatal; an upstream photo-host 403 remains a recoverable photo failure',async()=>{
 for(const status of [401,403])assert.equal((await resolverWith(response({error:'Sign in as Admin'},status)).resolve(external)).permissionDenied,true);
 assert.equal((await resolverWith(response({error:'The photo host returned HTTP 403.'},502)).resolve(external)).permissionDenied,false);
});
test('resolver rejects foreign project URLs, non-Storage URLs and deceptive hostname prefixes',async()=>{
 for(const bad of [external,'https://example-project.supabase.co.evil.com/storage/v1/object/public/equipment-photos/items/thumbs/a.webp',project+'/storage/v1/object/public/equipment-photos/avatars/a.webp','https://other.supabase.co/storage/v1/object/public/equipment-photos/items/thumbs/a.webp',stored+'?token=private','https://user:pass@example-project.supabase.co/storage/v1/object/public/equipment-photos/items/thumbs/a.webp']){
  assert.equal(isInventoryStoragePhoto(bad,project),false);assert.equal((await resolverWith(response({url:bad})).resolve(external)).url,null);
 }
 assert.equal(isInventoryStoragePhoto(stored,project),true);assert.equal(isInventoryStoragePhoto(stored,''),false);
});

// Execute actual import methods, with only database/network boundaries mocked.
function database(initial={}){
 const tables={items:[],units:[],matrix_models:[],matrix_rows:[],...structuredClone(initial)},writes=[];let sequence=0;
 const client={from(table){let operation='select',payload,filters=[];const q={
  select(){return q;},eq(field,value){filters.push([field,value]);return q;},insert(value){operation='insert';payload=value;return q;},update(value){operation='update';payload=value;return q;},
  single(){return Promise.resolve(execute(true));},then(resolve,reject){return Promise.resolve(execute(false)).then(resolve,reject);}
 };
 function execute(single){let rows=tables[table].filter(row=>filters.every(([field,value])=>row[field]===value));
  if(operation==='insert'){rows=(Array.isArray(payload)?payload:[payload]).map(row=>({id:`new-${++sequence}`,...structuredClone(row)}));tables[table].push(...rows);writes.push({table,operation,payload:structuredClone(payload)});}
  if(operation==='update'){for(const row of rows)Object.assign(row,structuredClone(payload));writes.push({table,operation,payload:structuredClone(payload)});}
  return{data:single?rows[0]:structuredClone(rows),error:null};
 }return q;
 }};return{client,tables,writes};
}
const importedRow=(kind='matrix-items',more={})=>({sheet:'Rigging',rowNumber:6,kind,values:{brand:'Ringlock',model:'Pin',item_type:'unit',quantity:'4',photo_url:external,...more},errors:[]});
const component=read('components/InventoryImportClient.tsx');
function actualHelpers(){const a=component.indexOf('function clean('),b=component.indexOf('export default function',a);return stripTypeScriptTypes(component.slice(a,b),{mode:'strip'});}
function actualMethods(db){const a=component.indexOf('  async function importUnitRow('),b=component.indexOf('  async function confirmImport(',a);const code=stripTypeScriptTypes(component.slice(a,b),{mode:'strip'});
 return new Function('supabase','resolveLocation',`${actualHelpers()}\n${code};return {importUnitRow,importLedRow,importMatrixRow};`)(db.client,()=>({category:{id:'category'},subcategory:{id:'subcategory'}}));
}
test('new generic Matrix item saves the Storage URL and preserves all physical quantity fields',async()=>{
 const db=database(),m=actualMethods(db);await m.importMatrixRow(importedRow(),async()=>stored);
 assert.deepEqual(db.tables.matrix_models[0],{id:'new-1',category_id:'category',subcategory_id:'subcategory',name:'Ringlock - Pin',item_type:'unit',block_name:'Ringlock',photo_data:stored,total_qty:4,in_use_qty:0,maintenance_qty:0,in_ksa_qty:0});
});
test('new cable/rack models use saved photos without creating spurious cable length rows',async()=>{
 for(const type of ['cable','rack']){const db=database();await actualMethods(db).importMatrixRow(importedRow('matrix-items',{item_type:type,cable_rack_name:'Custom '+type,quantity:'0'}),async()=>stored);assert.equal(db.tables.matrix_models[0].photo_data,stored);assert.equal(db.tables.matrix_models[0].name,'Custom '+type);assert.equal(db.tables.matrix_models[0].total_qty,0);assert.equal(db.tables.matrix_rows.length,0);}
});
test('serialized/lighting/projector/hoist rows keep serial creation and type-specific report fields',async()=>{
 for(const kind of ['serialized','lighting','projectors','chain-hoists']){
  const db=database();await actualMethods(db).importUnitRow(importedRow(kind,{quantity:'2',fixture_type:'Atmospheric Effect/SFX',block_name:'Rigging'}),async()=>stored);
  assert.equal(db.tables.items[0].photo_url,stored);assert.equal(db.tables.units.length,2);assert.deepEqual(db.tables.units.map(u=>u.unit_no),[1,2]);assert.ok(db.tables.units.every(u=>u.status==='available'));
  if(kind==='chain-hoists')assert.ok(db.tables.units.every(u=>u.cert_date===null&&u.expiry_date===null&&u.damage_photos.length===0));
  if(kind==='projectors')assert.ok(db.tables.units.every(u=>u.lamp_hours===0&&u.notes===''));
 }
});
test('new LED cabinet rows save the Storage URL while all cabinet counters remain unchanged',async()=>{
 const db=database();await actualMethods(db).importLedRow(importedRow('led-screens',{cabinet_size:'500x1000',cabinet_model:'NT2.6',quantity:'20'}),async()=>stored);
 assert.equal(db.tables.matrix_rows[0].photo_data,stored);assert.equal(db.tables.matrix_rows[0].qty,20);assert.equal(db.tables.matrix_rows[0].available_qty,20);assert.equal(db.tables.matrix_rows[0].in_use_qty,0);assert.equal(db.tables.matrix_rows[0].in_ksa_qty,0);
});
test('a failed photo does not stop equipment/quantity import and never saves the supplier URL',async()=>{
 for(const kind of ['serialized','matrix-items','led-screens']){const db=database(),methods=actualMethods(db),method=kind==='serialized'?'importUnitRow':kind==='matrix-items'?'importMatrixRow':'importLedRow';
  await methods[method](importedRow(kind,{cabinet_size:'500x500',cabinet_model:'P2.6'}),async()=>null);
  const record=kind==='serialized'?db.tables.items[0]:kind==='matrix-items'?db.tables.matrix_models[0]:db.tables.matrix_rows[0];assert.equal(record[kind==='serialized'?'photo_url':'photo_data'],null);assert.ok(!JSON.stringify(db.writes).includes(external));
 }
});
test('existing serialized and Matrix photos are not overwritten or migrated when adding stock',async()=>{
 const photo='https://old-supplier.com/original.png',base={id:'existing',subcategory_id:'subcategory',name:'Ringlock - Pin'};
 const units=database({items:[{...base,photo_url:photo}],units:[{id:'unit',item_id:'existing',unit_no:7,serial:'A'}]});
 await actualMethods(units).importUnitRow(importedRow('serialized',{quantity:'2'}),async()=>{throw Error('existing photo must not be touched');});
 assert.equal(units.tables.items[0].photo_url,photo);assert.deepEqual(units.tables.units.map(u=>u.unit_no),[7,8,9]);
 const matrix=database({matrix_models:[{...base,photo_data:photo,total_qty:9,item_type:'unit',in_use_qty:3}]});await actualMethods(matrix).importMatrixRow(importedRow(),async()=>{throw Error('existing photo must not be touched');});
 assert.equal(matrix.tables.matrix_models[0].photo_data,photo);assert.equal(matrix.tables.matrix_models[0].total_qty,13);assert.equal(matrix.tables.matrix_models[0].in_use_qty,3);
});
test('LED import fills an empty photo only; populated cabinet images are preserved',async()=>{
 for(const photo of [null,'https://old-supplier.com/led.png']){
  const db=database({matrix_models:[{id:'model',subcategory_id:'subcategory',name:'Ringlock - Pin'}],matrix_rows:[{id:'cabinet',model_id:'model',size:'500x500',cabinet_model:'P2.6',qty:9,available_qty:6,in_use_qty:3,photo_data:photo}]});let calls=0;
  await actualMethods(db).importLedRow(importedRow('led-screens',{cabinet_size:'500x500',cabinet_model:'P2.6',quantity:'4'}),async()=>{calls++;return stored;});
  assert.equal(calls,photo?0:1);assert.equal(db.tables.matrix_rows[0].photo_data,photo??stored);assert.equal(db.tables.matrix_rows[0].qty,13);assert.equal(db.tables.matrix_rows[0].available_qty,10);assert.equal(db.tables.matrix_rows[0].in_use_qty,3);
 }
});

function actualRun(rows,outcomes,offline=()=>false){
 const states={warnings:[],results:[],open:[],events:[],errors:[]},importingRef={current:false},completedFileRef={current:false};
 const rowImport=async(row,resolve)=>{const url=await resolve(row);states.events.push({row:row.rowNumber,url});return true;};
 const deps={editable:true,importingRef,completedFileRef,importing:false,result:null,rows,isOffline:offline,setImporting(){},setResult:value=>states.results.push(value),setPhotoWarnings:value=>states.warnings=value,setProgress(){},
  createImportPhotoResolver:()=>({resolve:async url=>outcomes[url]??{url:null}}),process:{env:{NEXT_PUBLIC_SUPABASE_URL:project}},
  importLedRow:rowImport,importMatrixRow:rowImport,importUnitRow:rowImport,setParseError:value=>states.errors.push(value),sessionStorage:{removeItem(){throw Error('storage unavailable');}},console:{error(){}}};
 const a=component.indexOf('  async function confirmImport('),b=component.indexOf('\n  const invalidCount',a),code=stripTypeScriptTypes(component.slice(a,b),{mode:'strip'});
 const run=new Function(...Object.keys(deps),`${actualHelpers()}\n${code};return confirmImport;`)(...Object.values(deps));return{states,run,completedFileRef,importingRef};
}
test('actual import loop reports item/sheet/row failures, continues after a blocked photo host, and cannot replay the file',async()=>{
 const rows=[importedRow(),{...importedRow('serialized',{photo_url:'https://supplier.com/blocked.jpg'}),rowNumber:7}];
 const r=actualRun(rows,{[external]:{url:stored},'https://supplier.com/blocked.jpg':{url:null,error:'The photo host returned HTTP 403.'}});await r.run();
 assert.deepEqual(r.states.results.at(-1),{imported:2,skipped:0,failed:0});assert.deepEqual(r.states.events.map(e=>e.url),[stored,null]);
 assert.deepEqual(r.states.warnings,[{sheet:'Rigging',rowNumber:7,name:'Ringlock - Pin',error:'The photo host returned HTTP 403.'}]);assert.equal(r.completedFileRef.current,true);assert.equal(r.importingRef.current,false);
 await r.run();assert.equal(r.states.events.length,2,'completed-file ref blocks duplicate quantities even before a rerender');
});
test('actual import loop stops on Admin authorization failure instead of continuing privileged actions',async()=>{
 const r=actualRun([importedRow(),importedRow(),importedRow()],{[external]:{url:null,error:'Only Admin can save photos.',permissionDenied:true}});await r.run();assert.equal(r.states.events.length,0);assert.deepEqual(r.states.results.at(-1),{imported:0,skipped:2,failed:1});assert.match(r.states.errors[0],/Admin access/);
});
test('offline mode blocks a new import and stops remaining rows if connectivity is lost',async()=>{
 const first=actualRun([importedRow()],{[external]:{url:stored}},()=>true);await first.run();assert.equal(first.states.events.length,0);assert.equal(first.states.results.length,0);assert.match(first.states.errors[0],/App offline/);assert.equal(first.importingRef.current,false);
 let checks=0;const midway=actualRun([importedRow(),importedRow(),importedRow()],{[external]:{url:stored}},()=>++checks>2);await midway.run();assert.equal(midway.states.events.length,1);assert.deepEqual(midway.states.results.at(-1),{imported:1,skipped:2,failed:0});assert.match(midway.states.errors[0],/stopped offline/);
});
test('UI keeps failed image names visible and does not offer Confirm Import again after completion',()=>{
 assert.match(component,/rows.length > 0 && result === null/);assert.match(component,/photoWarnings.map/);assert.match(component,/\{warning.name\}/);assert.match(component,/\{warning.sheet\} row \{warning.rowNumber\}/);
 assert.match(component,/\{result \? <button[^\n]+Done<\/button> : <button/);assert.match(component,/Do not import the same workbook again/);assert.match(component,/if \(importingRef.current\) return/);
 assert.doesNotMatch(component,/photo_(?:url|data): row.values.photo_url/);assert.doesNotMatch(component,/window.alert\(message\)/);
});

const sharp=require(require.resolve('sharp',{paths:[path.join(__dirname,'..'),process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean)}));
const optimizerSource=read('lib/optimizeInventoryPhoto.ts');
function optimizerWith(lib=sharp){const code=stripTypeScriptTypes(optimizerSource,{mode:'strip'}).replace(/^import .*;\s*$/gm,'').replace(/\bexport (?=const|async function)/g,'');return new Function('sharp',`${code};return {optimizeInventoryPhoto,readImportImageUrl,INVENTORY_PHOTO_MAX_BYTES};`)(lib);}
const real=optimizerWith();
test('real Sharp creates a small 260px WebP, rather than uploading a large original',async()=>{
 const png=await sharp({create:{width:1600,height:800,channels:4,background:{r:180,g:40,b:20,alpha:.5}}}).png().toBuffer();
 const output=await real.optimizeInventoryPhoto(png),meta=await sharp(output).metadata();assert.equal(meta.format,'webp');assert.equal(meta.width,260);assert.equal(meta.height,130);assert.ok(output.length<=80*1024);
});
test('oversized conversion tries smaller/lower quality thumbnails and never returns an uncompressed original',async()=>{
 const attempts=[];function oversized(_input,settings){const call={settings};attempts.push(call);const api={rotate(){return this;},resize(side){call.side=side;return this;},webp(opts){call.quality=opts.quality;return this;},timeout(){return this;},async toBuffer(){return Buffer.alloc(90*1024);}};return api;}
 await assert.rejects(optimizerWith(oversized).optimizeInventoryPhoto(Buffer.from('input')),/still too large/);assert.equal(attempts.length,6);assert.equal(attempts[0].side,260);assert.ok(attempts.at(-1).side<=106);assert.ok(attempts.at(-1).quality>=45);assert.ok(attempts.every(a=>a.settings.limitInputPixels===32*1024*1024&&a.settings.pages===1));
});
test('image request body rejects malformed, huge, cancelled and non-HTTP image inputs',async()=>{
 const request=body=>new Request('https://app.com/api/optimize-image',{method:'POST',body}),signal=new AbortController().signal;
 assert.equal(await real.readImportImageUrl(request(JSON.stringify({imageUrl:external})),signal),external);
 for(const value of ['broken JSON','x'.repeat(13000),JSON.stringify({imageUrl:'file:///secret'}),JSON.stringify({imageUrl:'https://supplier.com/'+('x'.repeat(5000))})])await assert.rejects(real.readImportImageUrl(request(value),signal));
 const controller=new AbortController();controller.abort();await assert.rejects(real.readImportImageUrl(request('{}'),controller.signal));await assert.rejects(real.optimizeInventoryPhoto(Buffer.from('a'),controller.signal));
});

class Reply extends Response{static json(value,options){return new Reply(JSON.stringify(value),{...options,headers:{'Content-Type':'application/json',...options?.headers}});}}
function route(options={}){
 const queries=[],downloads=[],uploads=[],conversions=[];
 const userClient={auth:{getUser:async()=>({data:{user:options.noUser?null:{id:'admin'}},error:options.authError??null})},from(table){const q={table};queries.push(q);return{select(fields){q.fields=fields;return this;},eq(field,value){q.filter=[field,value];return this;},abortSignal(){return this;},maybeSingle:async()=>({data:{role:options.role??'admin'},error:options.profileError??null})};}};
 const admin={storage:{from(bucket){assert.equal(bucket,'equipment-photos');return{async upload(file,bytes,settings){uploads.push({file,bytes,settings});return{error:options.uploadError??null};},getPublicUrl(file){return{data:{publicUrl:project+'/storage/v1/object/public/equipment-photos/'+file}};}};}}};
 const download=async(...args)=>{downloads.push(args);if(options.downloadError)throw options.downloadError;return options.bytes??Buffer.alloc(20);};
 const optimize=async(...args)=>{conversions.push(args);if(options.optimizeError)throw options.optimizeError;return options.realSharp?real.optimizeInventoryPhoto(...args):Buffer.alloc(100);};
 const src=read('app/api/optimize-image/route.ts'),code=stripTypeScriptTypes(src,{mode:'strip'}).replace(/^import .*;\s*$/gm,'').replace(/\bexport (?=const|async function)/g,'');
 const post=new Function('NextResponse','createServerSupabase','supabaseAdmin','randomUUID','downloadPublicPdfPhoto','PdfPhotoDownloadError','isInventoryStoragePhoto','optimizeInventoryPhoto','readImportImageUrl','INVENTORY_PHOTO_MAX_BYTES','process',`${code};return POST;`)(Reply,async()=>userClient,admin,()=> 'fixed-uuid',download,PdfPhotoDownloadError,isInventoryStoragePhoto,optimize,real.readImportImageUrl,80*1024,{env:{NEXT_PUBLIC_SUPABASE_URL:project}});
 const run=(body={imageUrl:external},headers={})=>post(new Request('https://app.com/api/optimize-image',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)}));
 return{run,queries,downloads,uploads,conversions};
}
test('actual optimizer denies unauthenticated/non-Admin users before reading/downloading/uploading',async()=>{
 for(const [settings,status] of [[{noUser:true},401],[{role:'warehouse_manager'},403],[{role:'head'},403],[{role:'viewer'},403],[{profileError:{message:'db'}},503]]){const r=route(settings),reply=await r.run('bad JSON');assert.equal(reply.status,status);assert.equal(r.downloads.length,0);assert.equal(r.uploads.length,0);assert.ok(r.queries.every(q=>q.table==='profiles'&&q.fields==='role'));}
});
test('actual optimizer denies cross-site/form requests and oversized bodies without any external action',async()=>{
 for(const [body,headers,status] of [[{imageUrl:external},{'sec-fetch-site':'cross-site'},403],[{imageUrl:external},{'Content-Type':'text/plain'},415],['x'.repeat(13000),{},400],[{imageUrl:'file:///secret'},{},400]]){const r=route(),reply=await r.run(body,headers);assert.equal(reply.status,status);assert.equal(r.downloads.length,0);assert.equal(r.uploads.length,0);}
});
test('actual optimizer uploads a bounded WebP once under a unique item thumbnail path and returns its public URL',async()=>{
 const r=route(),reply=await r.run();assert.equal(reply.status,200);assert.match(reply.headers.get('cache-control'),/no-store/);assert.equal(r.downloads[0][0],external);assert.equal(r.uploads.length,1);
 const upload=r.uploads[0];assert.equal(upload.file,'items/thumbs/fixed-uuid.webp');assert.equal(upload.settings.contentType,'image/webp');assert.equal(upload.settings.upsert,false);assert.equal(upload.settings.cacheControl,'31536000');assert.deepEqual(await reply.json(),{url:stored.replace('photo.webp','fixed-uuid.webp')});
});
test('actual optimizer reuses an existing managed thumbnail only after download/conversion succeeds',async()=>{
 const r=route(),reply=await r.run({imageUrl:stored});assert.equal(reply.status,200);assert.deepEqual(await reply.json(),{url:stored});assert.equal(r.downloads.length,1);assert.equal(r.conversions.length,1);assert.equal(r.uploads.length,0);
});
test('actual optimizer reports 403 from the supplier without bypass/retry and never uploads failed conversion bytes',async()=>{
 for(const [options,status] of [[{downloadError:new PdfPhotoDownloadError('PHOTO_HOST_ERROR','The photo host returned HTTP 403.')},502],[{optimizeError:Error('decode')},422],[{uploadError:{message:'private storage details'}},500]]){const r=route(options),reply=await r.run();assert.equal(reply.status,status);assert.ok((await reply.json()).error);assert.equal(r.downloads.length,1);assert.equal(r.uploads.length,options.uploadError?1:0);}
});
test('real optimizer route stores only the compressed bytes, preserving the Admin gate and response contract',async()=>{
 const png=await sharp({create:{width:1200,height:600,channels:4,background:{r:30,g:70,b:200,alpha:1}}}).png().toBuffer();const r=route({bytes:png,realSharp:true}),reply=await r.run();assert.equal(reply.status,200);
 const meta=await sharp(r.uploads[0].bytes).metadata();assert.equal(meta.width,260);assert.equal(meta.height,130);assert.equal(meta.format,'webp');assert.ok(r.uploads[0].bytes.length<=80*1024);
 const src=read('app/api/optimize-image/route.ts');assert.match(src,/profile\?\.role !== "admin"/);assert.doesNotMatch(src,/\.from\("(?:items|units|matrix_models|matrix_rows)"\)/);assert.doesNotMatch(src,/\.remove\(|upsert: true/);
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {stripTypeScriptTypes}=require('node:module');
const {parsePdfPhotoRequest,readPdfPhotoRequest,isPdfPhotoAllowed}=require('../lib/pdfPhotoAccess.ts');
const {isPublicPhotoAddress,parsePublicPhotoUrl,downloadPublicPdfPhoto,PdfPhotoDownloadError,isRasterPhoto,MAX_PDF_PHOTO_BYTES}=require('../lib/pdfPhotoDownload.ts');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const url='https://duscaff.com/_next/image?url=%2Fassets%2Fimages%2Fproducts%2Flistings%2Fbase-jacks.png&w=3840&q=75';
const input=()=>({listId:id(1),lineId:id(2),imageUrl:url});
const line=(more={})=>({id:id(2),inventory_record_type:'matrix_model',inventory_record_id:id(3),parent_record_id:null,metadata:{},...more});
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(24)]);
const source=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('request parser only accepts bounded HTTP(S) sources with valid list/line UUIDs',()=>{
 assert.deepEqual(parsePdfPhotoRequest(input()),input());
 for(const bad of [null,[],{...input(),listId:'wrong'},{...input(),lineId:'bad'},{...input(),imageUrl:'file:///etc/passwd'},{...input(),imageUrl:'data:image/png;base64,a'},{...input(),imageUrl:'https://host.com/'+('a'.repeat(5000))}])assert.throws(()=>parsePdfPhotoRequest(bad));
});
test('stream body is checked even without Content-Length; malformed JSON is rejected',async()=>{
 assert.deepEqual(await readPdfPhotoRequest(new Request('https://app.com/api',{method:'POST',body:JSON.stringify(input())})),input());
 await assert.rejects(readPdfPhotoRequest(new Request('https://app.com/api',{method:'POST',body:'x'.repeat(13000)})),/too large/);
 await assert.rejects(readPdfPhotoRequest(new Request('https://app.com/api',{method:'POST',body:'{bad'})));
 await assert.rejects(readPdfPhotoRequest({body:null}));
});
test('a stalled request body is cancelled when the route deadline or client abort fires',async()=>{
 const controller=new AbortController();let cancelled=false;
 const body=new ReadableStream({cancel(){cancelled=true;}}),pending=readPdfPhotoRequest({body},controller.signal);
 controller.abort();await assert.rejects(pending);assert.ok(cancelled);
 await assert.rejects(readPdfPhotoRequest({body:new ReadableStream()},controller.signal));
});

function access(item,records={}){
 const reads=[];return{reads,run:()=>isPdfPhotoAllowed(item,url,async(table,id,columns)=>{reads.push({table,id,columns});return records[table]?.[id]??null;})};
}
test('saved image URLs are matched exactly; they require no current catalog query',async()=>{
 const a=access(line({metadata:{photo_url:url}}));assert.equal(await a.run(),true);assert.equal(a.reads.length,0);
 const b=access(line({metadata:{photo_data:url}}));assert.equal(await b.run(),true);
 assert.equal(await access(line({metadata:{photo_url:url+'x'}})).run(),false);
});
test('current Matrix photos authorize only the exact record id and source',async()=>{
 const a=access(line(),{matrix_models:{[id(3)]:{photo_data:url}}});assert.equal(await a.run(),true);
 assert.deepEqual(a.reads,[{table:'matrix_models',id:id(3),columns:'id,photo_data'}]);
 assert.equal(await access(line(),{matrix_models:{[id(99)]:{photo_data:url}}}).run(),false);
});
test('serialized current photos are parent item photos, never unit report or certificate URLs',async()=>{
 const a=access(line({inventory_record_type:'unit',parent_record_id:id(4)}),{items:{[id(4)]:{photo_url:url}}});assert.equal(await a.run(),true);
 assert.deepEqual(a.reads.map(r=>r.table),['items']);
 const b=access(line({inventory_record_type:'unit'}),{units:{[id(3)]:{item_id:id(4)}},items:{[id(4)]:{photo_url:url}}});assert.equal(await b.run(),true);assert.deepEqual(b.reads.map(r=>r.table),['units','items']);
});
test('generic cable and LED cabinet photos use their own documented parent fields',async()=>{
 const a=access(line({inventory_record_type:'matrix_row',metadata:{matrix_source:'generic'}}),{matrix_rows:{[id(3)]:{item_id:id(4)}},matrix_models:{[id(4)]:{photo_data:url}}});assert.equal(await a.run(),true);assert.equal(a.reads[0].columns,'id,item_id');
 const b=access(line({inventory_record_type:'matrix_row'}),{matrix_rows:{[id(3)]:{model_id:id(4),photo_data:url}}});assert.equal(await b.run(),true);assert.equal(b.reads[0].columns,'id,model_id,photo_data');assert.equal(b.reads.length,1);
 const c=access(line({inventory_record_type:'matrix_row'}),{matrix_rows:{[id(3)]:{model_id:id(4)}},matrix_models:{[id(4)]:{photo_data:url}}});assert.equal(await c.run(),true);
});
test('custom rows allow only their own saved photo; unrecognized source types never query arbitrary tables',async()=>{
 const a=access(line({metadata:{custom_item:true}}),{matrix_models:{[id(3)]:{photo_data:url}}});assert.equal(await a.run(),false);assert.equal(a.reads.length,0);
 assert.equal(await access(line({metadata:{custom_item:true,photo_url:url}})).run(),true);
 const b=access(line({inventory_record_type:'profiles'}));assert.equal(await b.run(),false);assert.equal(b.reads.length,0);
});

test('public IPv4 guard rejects loopback, private, link local, CGNAT, metadata, reserved and IPv6 addresses',()=>{
 for(const address of ['0.0.0.1','10.5.2.1','100.64.0.1','127.0.0.1','169.254.169.254','172.31.255.255','192.0.0.170','192.168.8.199','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(isPublicPhotoAddress(address),false,address);
 assert.equal(isPublicPhotoAddress('93.184.216.34'),true);assert.equal(isPublicPhotoAddress('8.8.8.8'),true);
});
test('URL guard rejects unsafe protocols, ports, credentials, local names and alternate loopback encodings',()=>{
 assert.equal(parsePublicPhotoUrl(url).href,url);
 for(const bad of ['file:///etc/passwd','ftp://public.com/a','https://admin:secret@public.com/a','https://public.com:8443/a','https://localhost/a','http://local/a','http://server.internal/a','http://x.local/a','http://127.1/a','http://2130706433/a','http://0x7f000001/a','http://[::1]/a','http://[::ffff:127.0.0.1]/a','https://public.com/a#fragment','https://public.com/a\nb','https://public.com./a'])assert.throws(()=>parsePublicPhotoUrl(bad),bad);
});

function network(replies=[{}],addresses=['93.184.216.34']){
 const calls=[],resolves=[],requests=[];let index=0;
 const deps={resolve:async host=>{resolves.push(host);return typeof addresses==='function'?addresses(host):addresses;},request(target,options,callback){
  calls.push({url:target.href,options});const req=new EventEmitter(),reply=replies[index++]??{};requests.push(req);
  let response;req.destroy=function(error){this.destroyed=true;if(error)queueMicrotask(()=>this.emit('error',error));response?.destroy();};
  req.setTimeout=function(ms,fn){this.timeoutMs=ms;this.fireTimeout=fn;return this;};
  req.end=()=>queueMicrotask(()=>{
   if(reply.hang){options.signal.addEventListener('abort',()=>req.destroy(Error('aborted')),{once:true});return;}
   response=new PassThrough();response.statusCode=reply.status??200;response.headers={'content-type':'image/png',...reply.headers};
   callback(response);if(response.destroyed)return;
   if(reply.aborted){response.emit('aborted');response.destroy();return;}
   for(const chunk of reply.chunks??[reply.body??png])if(!response.destroyed)response.write(chunk);
   if(!response.destroyed)response.end();
  });return req;
 }};
 return{deps,calls,resolves,requests,run:(source=url,signal=new AbortController().signal)=>downloadPublicPdfPhoto(source,signal,deps)};
}
test('the exact supplied Duscaff optimizer URL and query are preserved; TCP uses the checked IP, Host and TLS SNI',async()=>{
 const n=network();assert.deepEqual(await n.run(),png);assert.equal(n.calls.length,1);
 const {options}=n.calls[0];assert.equal(options.hostname,'93.184.216.34');assert.equal(options.headers.Host,'duscaff.com');assert.equal(options.servername,'duscaff.com');
 assert.equal(options.path,'/_next/image?url=%2Fassets%2Fimages%2Fproducts%2Flistings%2Fbase-jacks.png&w=3840&q=75');
 assert.equal(options.agent,false);assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);assert.equal(n.requests[0].timeoutMs,7000);
});
test('DNS private/mixed results fail before any outbound image connection, preventing rebinding',async()=>{
 for(const addresses of [[],['127.0.0.1'],['169.254.169.254'],['93.184.216.34','10.0.0.1']]){const n=network([{}],addresses);await assert.rejects(n.run(),{code:'SOURCE_NOT_ALLOWED'});assert.equal(n.calls.length,0);}
 const n=network([{}],()=>{throw Error('DNS unavailable');});await assert.rejects(n.run());assert.equal(n.calls.length,0);
});
test('redirects are manually re-resolved and private destinations never receive a request',async()=>{
 const n=network([{status:302,headers:{location:'https://cdn.supplier.com/photo.png'}},{}]);assert.deepEqual(await n.run(),png);assert.deepEqual(n.resolves,['duscaff.com','cdn.supplier.com']);assert.equal(n.calls[1].options.headers.Host,'cdn.supplier.com');
 for(const target of ['http://127.0.0.1/private','https://169.254.169.254/latest','https://admin:secret@public.com/a','file:///etc/passwd','http://public.com/a']){const bad=network([{status:302,headers:{location:target}}]);await assert.rejects(bad.run());assert.equal(bad.calls.length,1,target);}
 const rebound=network([{status:302,headers:{location:'https://other.com/a'}}],host=>host==='duscaff.com'?['93.184.216.34']:['10.0.0.1']);await assert.rejects(rebound.run());assert.equal(rebound.calls.length,1);
});
test('relative redirects work and redirect chains have a hard maximum of three hops',async()=>{
 const n=network([{status:307,headers:{location:'/image.png'}},{}]);assert.deepEqual(await n.run(),png);assert.equal(n.calls[1].options.path,'/image.png');
 const loop=network(Array.from({length:5},()=>({status:302,headers:{location:'/loop'}})));await assert.rejects(loop.run(),{code:'TOO_MANY_REDIRECTS'});assert.equal(loop.calls.length,4);
});
test('HTTP denial/rate limits are not bypassed by trying another path, identity, or original asset',async()=>{
 for(const status of [401,403,404,429,500]){const n=network([{status}]);await assert.rejects(n.run(),{code:'PHOTO_HOST_ERROR'});assert.equal(n.calls.length,1);}
});
test('response size is bounded from both declared length and streamed bytes',async()=>{
 for(const reply of [{headers:{'content-length':String(MAX_PDF_PHOTO_BYTES+1)}},{chunks:[Buffer.alloc(MAX_PDF_PHOTO_BYTES),Buffer.alloc(1)]}]){const n=network([reply]);await assert.rejects(n.run(),{code:'PHOTO_TOO_LARGE'});}
});
test('HTML, SVG, XML and unsupported bytes are rejected even with a fake image Content-Type',async()=>{
 for(const reply of [{headers:{'content-type':'text/html'},body:png},{headers:{'content-type':'image/svg+xml'},body:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')},{body:Buffer.from('<svg>not a raster image</svg>')},{body:Buffer.from('<html>denied</html>')}]){const n=network([reply]);await assert.rejects(n.run(),{code:'NOT_AN_IMAGE'});}
 assert.equal(isRasterPhoto(Buffer.from('tiny')),false);
});
test('binary or missing MIME is accepted only for genuine raster signatures',async()=>{
 for(const mime of ['application/octet-stream','']){assert.deepEqual(await network([{headers:{'content-type':mime}}]).run(),png);await assert.rejects(network([{headers:{'content-type':mime},body:Buffer.from('<html>not a photo</html>')}]).run(),{code:'NOT_AN_IMAGE'});}
});
test('client abort, network inactivity, and interrupted bodies stop the download',async()=>{
 const controller=new AbortController(),n=network([{hang:true}]),pending=n.run(url,controller.signal);await new Promise(setImmediate);controller.abort();await assert.rejects(pending);
 const timed=network([{hang:true}]),p=timed.run();await new Promise(setImmediate);timed.requests[0].fireTimeout();await assert.rejects(p,{code:'PHOTO_TIMEOUT'});
 await assert.rejects(network([{aborted:true}]).run(),{code:'PHOTO_INTERRUPTED'});
});
test('deadline during DNS prevents any later connection after DNS finishes',async()=>{
 const controller=new AbortController();let finish;const n=network([{}],()=>new Promise(resolve=>finish=resolve));
 const pending=n.run(url,controller.signal);controller.abort();await assert.rejects(pending,{code:'PHOTO_TIMEOUT'});finish(['93.184.216.34']);await new Promise(setImmediate);assert.equal(n.calls.length,0);
});

class Reply extends Response {static json(value,options){return new Reply(JSON.stringify(value),{...options,headers:{'Content-Type':'application/json',...options?.headers}});}}
function route(options={}) {
 const queries=[],downloads=[],conversions=[];
 const rows={equipment_lists:{id:id(1)},equipment_list_items:line({metadata:{photo_url:url}}),...options.rows};
 const client={auth:{getUser:async()=>({data:{user:options.noUser?null:{id:id(9)}},error:options.authError??null})},from(table){
  const query={table,filters:[]};queries.push(query);return{select(fields){query.fields=fields;return this;},eq(field,value){query.filters.push([field,value]);return this;},abortSignal(signal){query.signal=signal;return this;},maybeSingle:async()=>({data:rows[table]??null,error:options.errors?.[table]??null})};
 }};
 const download=async(...args)=>{downloads.push(args);if(options.downloadError)throw options.downloadError;return options.bytes??png;};
 const fakeSharp=(...args)=>{conversions.push(args);const pipeline={rotate(){return this;},resize(...args){conversions.push(['resize',...args]);return this;},flatten(){return this;},jpeg(){return this;},timeout(){return this;},async toBuffer(){if(options.decodeError)throw Error('bad file');return Buffer.from('jpeg-result');}};return pipeline;};
 const code=stripTypeScriptTypes(source('app/api/equipment-list-pdf-photo/route.ts'),{mode:'strip'}).replace(/^import .*;\s*$/gm,'').replace(/\bexport (?=const|async function)/g,'');
 const handler=new Function('NextResponse','createClient','isPdfPhotoAllowed','readPdfPhotoRequest','downloadPublicPdfPhoto','PdfPhotoDownloadError','sharp',`${code};return POST;`)(Reply,async()=>client,isPdfPhotoAllowed,readPdfPhotoRequest,download,PdfPhotoDownloadError,options.sharp??fakeSharp);
 const run=(body=input(),headers={})=>handler(new Request('https://app.com/api/equipment-list-pdf-photo',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)}));
 return{run,queries,downloads,conversions};
}
test('actual route rejects anonymous users before reading the body or querying/downloading photos',async()=>{
 const r=route({noUser:true}),reply=await r.run('not JSON');assert.equal(reply.status,401);assert.equal(r.queries.length,0);assert.equal(r.downloads.length,0);
});
test('actual route rejects cross-site callers and invalid input before list queries',async()=>{
 for(const [body,headers,status] of [[input(),{'sec-fetch-site':'cross-site'},403],[input(),{'Content-Type':'text/plain'},415],[{...input(),lineId:'bad'},{},400],['x'.repeat(13000),{},400]]){const r=route(),reply=await r.run(body,headers);assert.equal(reply.status,status);assert.equal(r.queries.length,0);assert.equal(r.downloads.length,0);}
});
test('actual route denies hidden/deleted lists and list lines; it honors database errors rather than serving stale access',async()=>{
 for(const [options,status] of [[{rows:{equipment_lists:null}},404],[{rows:{equipment_list_items:null}},404],[{errors:{equipment_lists:{message:'db'}}},503],[{errors:{equipment_list_items:{message:'db'}}},503]]){const r=route(options),reply=await r.run();assert.equal(reply.status,status);assert.equal(r.downloads.length,0);}
});
test('actual route binds the line to the RLS-visible list and does not fetch an arbitrary submitted URL',async()=>{
 const r=route({rows:{equipment_list_items:line({metadata:{photo_url:url+'wrong'}})}}),reply=await r.run();assert.equal(reply.status,403);assert.equal(r.downloads.length,0);
 const q=r.queries.find(q=>q.table==='equipment_list_items');assert.deepEqual(q.filters,[['id',id(2)],['list_id',id(1)]]);
});
test('actual route works for normal list readers, without an Admin/profile check or a Storage write',async()=>{
 const r=route(),reply=await r.run();assert.equal(reply.status,200);assert.equal(reply.headers.get('content-type'),'image/jpeg');assert.match(reply.headers.get('cache-control'),/private, no-store/);assert.equal(reply.headers.get('x-content-type-options'),'nosniff');
 assert.equal(await reply.text(),'jpeg-result');assert.equal(r.downloads[0][0],url);assert.deepEqual(r.queries.map(q=>q.table),['equipment_lists','equipment_list_items']);
 assert.equal(r.conversions[0][1].limitInputPixels,32*1024*1024);assert.deepEqual(r.conversions.find(c=>c[0]==='resize'),['resize',240,240,{fit:'inside',withoutEnlargement:true}]);
 const src=source('app/api/equipment-list-pdf-photo/route.ts');assert.doesNotMatch(src,/supabaseAdmin|\.storage\b|\.upload\(|\.insert\(|\.update\(|\.delete\(|from\("profiles"\)/);
});
test('actual route reports safe host/decoder failure codes without URLs, tokens or stack traces',async()=>{
 const failed=route({downloadError:new PdfPhotoDownloadError('PHOTO_HOST_ERROR','The photo host returned HTTP 403.')}),reply=await failed.run();assert.equal(reply.status,502);assert.deepEqual(await reply.json(),{error:'The photo host returned HTTP 403.',code:'PHOTO_HOST_ERROR'});
 const decoding=await route({decodeError:true}).run();assert.equal(decoding.status,422);assert.equal((await decoding.json()).code,'PHOTO_DECODE_FAILED');
 const raw=await route({downloadError:Error('secret signed URL/token here')}).run();assert.equal(raw.status,502);assert.doesNotMatch(await raw.text(),/secret|token here|https:/);
});
test('actual route with real Sharp yields a small JPEG thumbnail, not a new uploaded original',async()=>{
 const sharp=require(require.resolve('sharp',{paths:[path.join(__dirname,'..'),process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES].filter(Boolean)}));
 const bytes=await sharp({create:{width:800,height:400,channels:4,background:{r:200,g:20,b:30,alpha:.5}}}).png().toBuffer();
 const r=route({bytes,sharp}),reply=await r.run();assert.equal(reply.status,200);const jpeg=Buffer.from(await reply.arrayBuffer()),meta=await sharp(jpeg).metadata();
 assert.equal(meta.format,'jpeg');assert.equal(meta.width,240);assert.equal(meta.height,120);assert.equal(meta.hasAlpha,false);assert.ok(jpeg.length<80*1024);
});

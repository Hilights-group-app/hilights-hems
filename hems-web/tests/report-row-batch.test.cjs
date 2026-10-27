// Tests use mock inserts only. They never add equipment to Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const root = path.resolve(__dirname,'..');
function compile(source,globals={},imports={}){
  const exports={};const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(compiled,{exports,...globals,require:name=>imports[name]??require(name)});return exports;
}
const batch=compile(fs.readFileSync(path.join(root,'lib/reportRowBatch.ts'),'utf8'));
const testing=compile(fs.readFileSync(path.join(root,'lib/reportTestingDate.ts'),'utf8'));
function extract(file,name){const source=fs.readFileSync(path.join(root,file),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let result;function walk(n){if(ts.isFunctionDeclaration(n)&&n.name?.text===name)result=n.getText(ast);ts.forEachChild(n,walk);}walk(ast);if(!result)throw Error('Missing function '+name);return result;}
const files=['SerializedRowsBlock.tsx','ProjectorRowsBlock.tsx','ChainHoistRowsBlock.tsx'];
function harness(file,options={}){
  const units=[{id:'old-2',unit_no:2,serial:'KEEP-2',status:'maintenance',testing_date:'2026-10-27'}, {id:'old-9',unit_no:'9',serial:'KEEP-9',status:'in_ksa',testing_date:'2026-10-27'}];
  const calls=[],logs=[],updates=[],addingRowsRef={current:false},unitsRef={current:units};
  let loadCount=0;
  const globals={...batch,...testing,itemId:'item-a',itemName:'Example',activityLink:'/report',
    editable:true,allowAdd:true,bulkPasting:false,showTestingDate:true,
    PROJECTOR_SELECT_WITH_TESTING:'with-testing',PROJECTOR_SELECT_WITHOUT_TESTING:'without-testing',
    getUserName:()=> 'Test editor',addingRowsRef,unitsRef,loadedItemRef:{current:'item-a'},currentItemRef:{current:'item-a'},
    setUnits:value=>updates.push(value),setTransientMessage:()=>{},loadUnits:async()=>{loadCount++;},
    logActivity:async value=>{logs.push(value);if(options.logError)throw Error('log failed');},
    console:{error(){}},
    supabase:{from(table){return{insert(payload){calls.push({table,payload});return{select(selection){calls.at(-1).selection=selection;if(options.pending)return options.pending;if(options.error)return Promise.resolve({data:null,error:{message:options.error}});return Promise.resolve({error:null,data:options.incomplete?[]:payload.map((row,index)=>({...row,id:'new-'+index})).reverse()});}};}};}},
    ...options.globals,
  };
  const add=compile(extract('components/'+file,'addRow')+'\nexports.addRow=addRow;',globals).addRow;
  return{add,calls,logs,updates,unitsRef,addingRowsRef,get loadCount(){return loadCount;}};
}

test('row count accepts 1 through 100 and rejects missing/invalid/oversized quantities',()=>{
  for(const value of [1,'1',' 100 ',100,'050'])assert.ok(batch.reportRowCount(value)>=1);
  for(const value of ['',0,-1,101,1.5,'1.5','1e2','abc',Infinity,NaN])assert.throws(()=>batch.reportRowCount(value));
});
test('numbering uses the highest existing full-report unit number, not count or filtered rows',()=>{
  const units=[{unit_no:1},{unit_no:'27'},{unit_no:'invalid'},{unit_no:null},{unit_no:-10}];
  const original=JSON.stringify(units);const result=batch.buildReportRowBatch({itemId:'x',count:100,units,kind:'serialized'});
  assert.equal(result.length,100);assert.equal(result[0].unit_no,28);assert.equal(result[99].unit_no,127);assert.equal(JSON.stringify(units),original);
});
test('empty reports begin at one and malformed numbers never yield NaN or unsafe IDs',()=>{
  const result=batch.buildReportRowBatch({itemId:'x',count:1,units:[],kind:'serialized'});assert.equal(result[0].unit_no,1);
  assert.throws(()=>batch.buildReportRowBatch({itemId:'x',count:1,units:[{unit_no:Number.MAX_SAFE_INTEGER}],kind:'serialized'}));
});
test('hoist batches have string numbers and no fabricated certificate dates',()=>{
  const rows=batch.buildReportRowBatch({itemId:'x',count:100,units:[],kind:'chain_hoist'});
  assert.equal(rows[99].unit_no,'100');for(const row of rows){assert.equal(row.cert_date,null);assert.equal(row.expiry_date,null);assert.equal(row.serial,'');assert.equal(row.status,'available');}
});
test('projector batches have zero lamp hours, editor metadata and optional shared testing date',()=>{
  const options={itemId:'x',count:2,units:[],kind:'projector',testingDate:'2026-10-27',editorName:'Editor'};
  const rows=batch.buildReportRowBatch(options);assert.equal(rows[0].lamp_hours,0);assert.equal(rows[0].updated_by,'Editor');assert.equal(rows[0].updated_at,rows[1].updated_at);assert.equal(rows[0].testing_date,'2026-10-27');
  assert.ok(!('testing_date' in batch.buildReportRowBatch({...options,includeTestingDate:false})[0]));
});
for(const file of files){
  test(`${file}: 100 rows use one batch insert, one UI update and one activity`,async()=>{
    const h=harness(file);assert.equal(await h.add(100),100);assert.equal(h.calls.length,1);assert.equal(h.calls[0].table,'units');assert.equal(h.calls[0].payload.length,100);assert.equal(h.updates.length,1);assert.equal(h.unitsRef.current.length,102);assert.equal(h.logs.length,1);
    assert.equal(Number(h.unitsRef.current[2].unit_no),10);assert.equal(Number(h.unitsRef.current.at(-1).unit_no),109);
    assert.equal(h.unitsRef.current[0].serial,'KEEP-2');assert.equal(h.unitsRef.current[1].status,'in_ksa');assert.equal(h.calls[0].payload[0].testing_date,'2026-10-27');
  });
  test(`${file}: normal single Add Row remains available`,async()=>{const h=harness(file);assert.equal(await h.add(),1);assert.equal(h.calls[0].payload.length,1);});
  test(`${file}: invalid counts, read-only permission, serial paste and unloaded reports never insert`,async()=>{
    const permission=file==='ChainHoistRowsBlock.tsx'?'allowAdd':'editable';
    for(const globals of [{[permission]:false},{bulkPasting:true},{loadedItemRef:{current:'other-item'}}]){const h=harness(file,{globals});await assert.rejects(()=>h.add(100));assert.equal(h.calls.length,0);}
    const h=harness(file);await assert.rejects(()=>h.add(101));assert.equal(h.calls.length,0);
  });
  test(`${file}: failures preserve rows and release busy lock`,async()=>{const h=harness(file,{error:'Permission denied'});await assert.rejects(()=>h.add(100),/Permission denied/);assert.equal(h.updates.length,0);assert.equal(h.unitsRef.current.length,2);assert.equal(h.addingRowsRef.current,false);assert.equal(h.logs.length,0);});
  test(`${file}: repeated click cannot start another insert in flight`,async()=>{
    let resolve;const pending=new Promise(r=>{resolve=r;});const h=harness(file,{pending});const first=h.add(100);await assert.rejects(()=>h.add(100),/Another row operation/);assert.equal(h.calls.length,1);resolve({data:h.calls[0].payload.map((r,i)=>({...r,id:'new-'+i})),error:null});assert.equal(await first,100);assert.equal(h.addingRowsRef.current,false);
  });
  test(`${file}: partial/unconfirmed response refreshes rather than fabricating report counts`,async()=>{const h=harness(file,{incomplete:true});await assert.rejects(()=>h.add(100),/fully confirmed/);assert.equal(h.loadCount,1);assert.equal(h.updates.length,0);assert.equal(h.logs.length,0);});
  test(`${file}: notification failure cannot turn a completed insert into a failed retry`,async()=>{const h=harness(file,{logError:true});assert.equal(await h.add(100),100);assert.equal(h.updates.length,1);});
  test(`${file}: a completed old-report batch cannot populate a different report`,async()=>{
    let resolve;const pending=new Promise(r=>{resolve=r;}),currentItemRef={current:'item-a'};
    const h=harness(file,{pending,globals:{currentItemRef}});const result=h.add(100);currentItemRef.current='item-b';
    resolve({data:h.calls[0].payload.map((r,i)=>({...r,id:'new-'+i})),error:null});assert.equal(await result,100);
    assert.equal(h.updates.length,0);assert.equal(h.calls[0].payload[0].item_id,'item-a');
  });
}
test('shared add control is labeled, defaults to one and can be disabled while serial paste runs',()=>{
  const Control=compile(fs.readFileSync(path.join(root,'components/ReportAddRows.tsx'),'utf8'),{}, {'@/lib/reportRowBatch':batch}).default;
  const html=renderToStaticMarkup(React.createElement(Control,{onAdd:async n=>n,disabled:true}));
  assert.ok(html.includes('Number of rows'));assert.ok(html.includes('value="1"'));assert.ok(html.includes('inputMode="numeric"'));assert.ok(html.includes('1–100 rows per batch.'));assert.match(html,/<button[^>]*disabled=""/);
});
test('lighting routes to the shared serialized report, and all three row blocks use the same add control',()=>{
  const router=fs.readFileSync(path.join(root,'components/ItemEditRouterClient.tsx'),'utf8');assert.ok(router.includes('<ItemEditClientSerializedUnits'));
  for(const file of files){const source=fs.readFileSync(path.join(root,'components',file),'utf8');assert.ok(source.includes('<ReportAddRows key={itemId} onAdd={addRow} disabled={bulkPasting} />'));assert.ok(source.includes('addingRowsRef.current) return;'));}
});

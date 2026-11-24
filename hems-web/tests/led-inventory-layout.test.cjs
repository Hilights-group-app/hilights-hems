const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync(path.join(__dirname,'../components/SubcategoryClientLedScreen.tsx'),'utf8');
const rowSource=source.slice(source.indexOf('function LedCabinetInventoryItem('));
function compile(s){
 if(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES)return require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright/lib/transform/babelBundle.js').babelTransform(s,'LedRow.tsx',false,[],[]).code;
 const ts=require('typescript');return ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
}
function helper(name){const start=source.indexOf('function '+name+'('),end=source.indexOf('\nfunction ',start+1);return stripTypeScriptTypes(source.slice(start,end),{mode:'strip'});}
const pure=new Function(['clampQty','rowAvailableFromTotal','existingMovementQuantity','movementAllocationQuantity','parseCabinetArea','toSqm','formatSqm'].map(helper).join('\n')+';return {clampQty,rowAvailableFromTotal,existingMovementQuantity,movementAllocationQuantity,toSqm,formatSqm};')();
const jsx=(type,props)=>({type,props});
function render(extra={},reserved=0,layout='desktop'){
 const props={row:{id:'cabinet',size:'500mm X 500mm',cabinet_model:'Standard',qty:40,in_use_qty:8,in_ksa_qty:4,maintenance_qty:2},brand:'Absen',modelName:'NT2.6',searchName:'Absen NT2.6',editable:true,selected:false,onSelect:()=>{},reportHref:'/report/cabinet',allocations:[{listId:'event',quantity:8,listType:'local_event',status:'active',label:'Event'}],activeDraftList:null,onAddToList:()=>{},...extra};
 const env={document:{documentElement:{dataset:{hemsLayout:layout}}},...pure,PhotoBox:'PhotoBox',Link:'Link',InventoryQuantitySummary:'InventoryQuantitySummary',ReservedForStock:'ReservedForStock',usePendingReservations:()=>({index:{quantity:()=>reserved}})};
 const fn=new Function('require',...Object.keys(env),compile(rowSource)+'\n;return LedCabinetInventoryItem;')(name=>{assert.equal(name,'react/jsx-runtime');return{jsx,jsxs:jsx};},...Object.values(env));return fn(props);
}
function nodes(v){if(!v||typeof v!=='object')return[];return[v,...[v.props?.children].flat(Infinity).flatMap(nodes)];}
function text(v){if(v==null||typeof v==='boolean')return'';if(typeof v!=='object')return String(v);return[v.props?.children].flat(Infinity).map(text).join('');}
test('one responsive cabinet view replaces spreadsheet headers and duplicate mobile/desktop views',()=>{
 const group=source.slice(source.indexOf('function LedModelCard('),source.indexOf('function SortableCabinetRow('));
 assert.ok(!group.includes('Cabinet Model</div>'));assert.ok(!group.includes('modelMovementMap'));assert.equal((group.match(/<LedCabinetInventoryItem /g)||[]).length,1);assert.ok(group.includes('onRowsReorder'));assert.ok(group.includes('data-hems-block-header'));
});
test('brand/model use exactly the Lighting Fixture typography; only brand is bold',()=>{const v=render(),name=nodes(v).find(n=>n.type==='div'&&text(n)==='Absen NT2.6');assert.equal(name.props.className,'block break-words text-[10px] text-gray-900 hems-wide:text-[11px]');assert.equal(name.props.children[0].props.className,'font-bold');assert.equal(name.props.children[1].props.className,undefined);});
test('LED uses the same under-name stock summary as Lighting, with sqm and unchanged calculations',()=>{const v=render({},6),summary=nodes(v).find(n=>n.type==='InventoryQuantitySummary');assert.equal(summary.props.total,10);assert.equal(summary.props.available,5);assert.equal(summary.props.maintenance,0.5);assert.equal(summary.props.inKsa,1);assert.equal(summary.props.unit,'sqm');assert.equal(summary.props.search,'Absen NT2.6');assert.ok(text(v).includes('2 sqm · Event'));const src=rowSource;assert.ok(src.indexOf('<InventoryQuantitySummary')>src.indexOf('row.cabinet_model,row.size'));assert.ok(!src.includes('variant="led"'));});
test('zero maintenance and movement chips are hidden; report still uses its original route',()=>{const v=render({row:{id:'cabinet',size:'500x1000',qty:10,in_use_qty:0,in_ksa_qty:0,maintenance_qty:0},allocations:[]});assert.ok(!text(v).includes('Maintenance'));assert.ok(!text(v).includes('Existing movement'));assert.ok(nodes(v).filter(n=>n.type==='Link').every(n=>n.props.href==='/report/cabinet'));});
test('active-list and repair links remain valid and quantities convert using cabinet size',()=>{const v=render({allocations:[{listId:'repair',quantity:2,listType:'maintenance',status:'active',label:'Procom'}]});const link=nodes(v).find(n=>n.props?.href==='/inventory/lists/repair');assert.equal(text(link),'0.50 sqm · Procom');});
test('draft + calls existing picker, hides tools, and is absent without a selected list',()=>{let added=0;const v=render({activeDraftList:{reference:'EV-TEST'},onAddToList:()=>added++});const button=nodes(v).find(n=>n.props?.['data-hems-mobile-add']);button.props.onClick();assert.equal(added,1);assert.ok(!nodes(v).some(n=>n.props?.['aria-label']?.startsWith('Open ')));assert.ok(!nodes(render()).some(n=>n.props?.['data-hems-mobile-add']));});
test('tools retain row selection and respect view-only permissions',()=>{let selected=0;const v=render({onSelect:()=>selected++});nodes(v).find(n=>n.props?.['aria-label']?.startsWith('Open ')).props.onClick();assert.equal(selected,1);assert.ok(!nodes(render({editable:false})).some(n=>n.props?.['aria-label']?.startsWith('Open ')));});
test('desktop body click selects cabinet; interactive controls and phone body never select',()=>{
 let selected=0,stopped=0;const props={onSelect:()=>selected++};const click=interactive=>({target:{closest:()=>interactive},stopPropagation:()=>stopped++});
 render(props).props.onClick(click(null));assert.equal(selected,1);assert.equal(stopped,1);
 render(props).props.onClick(click({}));render(props,0,'compact').props.onClick(click(null));render({...props,editable:false}).props.onClick(click(null));render({...props,activeDraftList:{reference:'EV'}}).props.onClick(click(null));assert.equal(selected,1);
});
test('only Report button links to report; mobile Tools hidden on desktop; keyboard selection works',()=>{
 let selected=0;const v=render({onSelect:()=>selected++});assert.equal(nodes(v).filter(n=>n.props?.href==='/report/cabinet').length,1);
 assert.ok(nodes(v).find(n=>n.props?.['aria-label']?.startsWith('Open ')).props.className.includes('hems-wide:hidden'));
 const target={};v.props.onKeyDown({key:'Enter',target,currentTarget:target,preventDefault(){},stopPropagation(){}});assert.equal(selected,1);
});

const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {stripTypeScriptTypes}=require('node:module');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
function mount(props){
 let open=false;const exports={};
 const jsx=(type,props)=>({type,props});
 const requireMock=name=>name==='react'?{useId:()=> 'folder-region',useState:()=>[open,update=>{open=typeof update==='function'?update(open):update;}]}:name==='react/jsx-runtime'?{jsx,jsxs:jsx}:name==='lucide-react'?{Folder:'FolderIcon',ChevronDown:'ChevronIcon'}:assert.fail('Unexpected dependency: '+name);
 let compiled;
 if(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES){
   const babel=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright/lib/transform/babelBundle.js');
   compiled=babel.babelTransform(read('components/WorkingListFolder.tsx'),path.resolve(__dirname,'../components/WorkingListFolder.tsx'),false,[],[]).code;
 }else{
   const ts=require('typescript');
   compiled=ts.transpileModule(read('components/WorkingListFolder.tsx'),{fileName:'WorkingListFolder.tsx',compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 }
 new Function('require','exports',compiled)(requireMock,exports);
 return {render:extra=>exports.default({...props,...extra})};
}
for(const kind of ['pending','active'])test(`${kind} folder toggles without navigation, keeps count and children, and retains state across row refreshes`,()=>{
 const children={equipment:'unchanged row controls'},app=mount({kind,title:kind==='pending'?'Pending Lists':'Active Lists',count:3,children});
 let view=app.render(),[button,region]=view.props.children;
 assert.equal(view.props['data-working-list-folder'],kind);assert.equal(button.props.type,'button');assert.equal(button.props['aria-expanded'],false);assert.equal(region.props.hidden,true);assert.equal(region.props.id,button.props['aria-controls']);assert.equal(region.props.children,children);
 assert.equal(button.props.children[1].props.children[0].props.children,3);
 button.props.onClick();[button,region]=app.render({count:5}).props.children;assert.equal(button.props['aria-expanded'],true);assert.equal(region.props.hidden,false);assert.equal(button.props.children[1].props.children[0].props.children,5);assert.equal(region.props.children,children);
 button.props.onClick();assert.equal(app.render().props.children[1].props.hidden,true);
});
test('Draft remains a plain section, not a collapsed folder',()=>{
 const children={draft:true},view=mount({kind:'draft',title:'Drafts',count:2,children}).render();
 assert.equal(view.props['data-working-list-folder'],undefined);assert.equal(view.props.children[0].type,'div');assert.equal(view.props.children[0].props.children[0].props.children,'Drafts');assert.equal(view.props.children[1],children);
});
test('folder wrapper adds no fetch, storage, polling, auth or mutations',()=>{
 assert.doesNotMatch(read('components/WorkingListFolder.tsx'),/createClient|\.from\(|\.rpc\(|fetch\(|setInterval|localStorage|sessionStorage|useEffect|router\./);
});
test('sidebar keeps status buckets, nonempty sections, Missing link and original selection handlers',()=>{
 const source=read('components/EquipmentListsSidebar.tsx');
 assert.match(source,/section.rows.length > 0/);assert.match(source,/<WorkingListFolder key=\{section.key\} kind=\{section.key\} title=\{section.title\} count=\{section.rows.length\}>/);
 assert.match(source,/onClick=\{\(\) => chooseActiveList\(list\)\}/);assert.match(source,/href="\/inventory\/missing" onClick=\{handleListLinkClick\}/);
 const start=source.indexOf('  const sections = useMemo('),end=source.indexOf('  function updateForm',start);
 const code=stripTypeScriptTypes(source.slice(start,end),{mode:'strip'});
 const rows=[{id:'draft',status:'draft'},{id:'pending',status:'pending'},{id:'active',status:'active'},{id:'partial',status:'partially_returned'},{id:'repair',status:'active',list_type:'maintenance'},{id:'closed',status:'closed'}];
 const sections=new Function('useMemo','workflowLists',code+';return sections;')(fn=>fn(),rows);
 assert.deepEqual(sections.map(section=>[section.key,section.rows.map(row=>row.id)]),[['draft',['draft']],['pending',['pending']],['active',['active','partial']]]);
});

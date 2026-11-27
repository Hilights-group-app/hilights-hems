const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
test('desktop workspace fits the measured topbar rather than a fixed 48px guess',()=>{
 const shell=read('components/AppShellClient.tsx'),css=read('app/globals.css');
 assert.match(shell,/data-hems-workspace/);assert.doesNotMatch(shell,/hems-desktop:h-\[calc\(100vh-48px\)\]/);
 assert.match(css,/height: calc\(100dvh - var\(--hems-topbar-height, 48px\)\)/);
 assert.match(css,/box-sizing: border-box/);
});
test('outer document scroll is locked only for desktop workspace, not login/mobile/print',()=>{
 const css=read('app/globals.css');
 const block=css.slice(css.indexOf('/* Desktop has three independent scrollports'),css.indexOf('@media print'));
 assert.match(block,/@media screen/);assert.match(block,/html\[data-hems-layout="desktop"\]:has\(\[data-hems-workspace\]\) body/);
 assert.doesNotMatch(block,/data-hems-layout="compact"/);
 assert.match(block,/overflow: hidden/);
});
test('main and sidebars keep separate scrolling and do not chain into the document',()=>{
 const css=read('app/globals.css');
 assert.match(css,/\[data-hems-workspace\] > main,/);assert.match(css,/\[data-hems-workspace\] > aside/);
 assert.match(css,/min-height: 0;\s*overflow-y: auto;\s*overscroll-behavior-y: contain/);
});
test('PDF uses exact page colors and overrides old black quantity styles',()=>{
 const code=read('lib/activeListPdf.ts'),page=read('components/ActiveListEquipmentTable.module.css');
 assert.match(page,/\.received \{ color: #16844a/);assert.match(page,/\.out \{ color: #2254d7/);
 assert.match(code,/sent:\[23,32,46\],received:\[22,132,74\],out:\[34,84,215\]/);
 assert.match(code,/quantityCell\(value,styles,tones\[index\]\)/);
 assert.match(code,/cellPadding:[^\n]+\n\s*textColor,/);
 assert.match(code,/type PdfRgb = \[number, number, number\]/);
 assert.match(code,/textColor:PdfRgb/);
 assert.doesNotMatch(code,/textColor:number\[\]/);
});

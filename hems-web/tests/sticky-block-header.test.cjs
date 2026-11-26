const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const css=read('app/globals.css');
test('block header never paints an absolute cap above its card/selection outline',()=>{
 assert.doesNotMatch(css,/\[data-hems-block-header\]::(?:before|after)/);
 assert.doesNotMatch(css,/top:\s*-24px/);
});
test('sticky behavior remains opaque and flush on desktop with existing phone offset',()=>{
 assert.match(css,/\[data-hems-block-header\]\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*30;[^}]*background:\s*#fff;/);
 assert.match(css,/background:\s*#fff !important/);
 assert.match(css,/top:\s*calc\(var\(--hems-topbar-height, calc\(116px \+ env\(safe-area-inset-top\)\)\) - 1px\)/);
 assert.match(css,/@media print\s*\{\s*\[data-hems-block-header\] \{ position: static; \}/);
});
test('only block inventory scrollports lose their upper padding; no absolute mask returns',()=>{
 assert.match(css,/html\[data-hems-layout="desktop"\] \[data-hems-main\]:has\(\[data-hems-block-header\]\)\s*\{\s*padding-top: 0;/);
 assert.doesNotMatch(css,/\[data-hems-block-header\]::(?:before|after)/);
 const bar=read('components/TopBar.tsx');assert.ok(bar.includes('`${bar.getBoundingClientRect().height}px`'));assert.ok(!bar.includes('Math.ceil(bar.getBoundingClientRect().height)'));assert.ok(bar.includes('observer?.observe(bar)'));
});
test('horizontal coverage stays inside matching card padding on all breakpoints',()=>{
 assert.match(css,/margin-left: calc\(-1 \* var\(--hems-block-padding, 1.5rem\)\)/);
 assert.match(css,/margin-right: calc\(-1 \* var\(--hems-block-padding, 1.5rem\)\)/);
 for(const type of ['matrix','projectors','ledscreen'])assert.match(css,new RegExp(`data-hems-padded-block="${type}"`));
});
test('fix reaches every inventory block without removing selection, drag or report actions',()=>{
 for(const page of ['Lighting','Serialized','Projectors','ChainHoist','Matrix','LedScreen'])assert.ok(read(`components/SubcategoryClient${page}.tsx`).includes('data-hems-block-header'));
 const led=read('components/SubcategoryClientLedScreen.tsx');assert.ok(led.includes('border-black ring-2 ring-black'));assert.ok(led.includes('onRowsReorder'));assert.ok(led.includes('getReportHref'));assert.ok(led.includes('data-led-cabinet-row'));
});

(function () {
  'use strict';
  const S = window.HEMSOffline, $ = id => document.getElementById(id);
  let confirmedOffline = navigator.onLine === false;
  let user = S.owner(), data = [], drafts = [], selected = null, view = 'inventory', busy = false, loadVersion = 0, tableData = {}, visibleCounts = [];
  const embedded = new URLSearchParams(location.search).has('embedded');
  // A standalone fallback page must not survive an online login/navigation.
  // The embedded version remains available from the Online/Offline pill.
  if (!embedded && navigator.onLine) {
    setTimeout(() => location.replace('/'), 0);
  }
  const categories = ['lighting','video','rigging','audio','power','other'];
  const typeNames = {dry_hire:'Dry Hire',local_event:'Local Event',transfer_out:'Transfer Out',transfer_in:'Transfer In',maintenance:'Send for Maintenance',internal_use:'Internal Use'};
  const tableNames = {items:'Equipment',units:'Serial numbers',matrix_models:'Matrix models',matrix_rows:'Matrix stock',
    equipment_lists:'Lists',equipment_list_items:'List equipment',maintenance_requests:'Repair workflow',repair_status:'Repair status',ksa_stock:'Equipment in KSA',ksa_units:'KSA serials',led_maintenance_logs:'LED issue history',led_issue_repairs:'LED repair history'};
  const text = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  function el(tag, value, className) { const node = document.createElement(tag); if(value != null)node.textContent = text(value); if(className)node.className = className; return node; }
  function button(label, callback, quiet) { const node = el('button', label, quiet ? 'quiet' : ''); node.type='button'; node.onclick = () => Promise.resolve(callback()).catch(error => message(error.message)); return node; }
  function message(value) { $('message').textContent = value || ''; }
  const clone = value => JSON.parse(JSON.stringify(value));
  function safePhoto(source) { return typeof source==='string' && (source.startsWith('data:image/') || source.startsWith('https://') || source.startsWith('/')) ? source : ''; }
  function photo(source) { const url=safePhoto(source); if(!url)return null; const img=el('img',null,'photo');img.src=url;img.alt='Equipment photo';img.loading='lazy';img.onerror=()=>img.remove();
    if(url.startsWith('https://'))void S.get(user,`photo:${url}`).then(saved=>{if(saved?.blob&&img.isConnected){const blobURL=URL.createObjectURL(saved.blob);img.src=blobURL;img.onload=()=>URL.revokeObjectURL(blobURL);}}).catch(()=>{});
    return img; }
  const role = () => localStorage.getItem('hems:user_role') || 'viewer';
  const canEdit = draft => S.editable(draft,user,role());
  function offlineMessage() { message('App offline. Only local draft editing is available. Submit, inventory edits, Receive and Tested require an online connection.'); }
  function status() {
    $('connection').textContent=!confirmedOffline && navigator.onLine ? 'Online' : 'Offline'; $('connection').classList.toggle('online',!confirmedOffline && navigator.onLine);
    $('notice').textContent = !confirmedOffline && navigator.onLine ? 'Saved workspace · data may be out of date. Sync drafts, then return to the online app for current stock and Submit.' : 'Offline · last saved data on this device · inventory and reports are read-only';
    $('sync').disabled=confirmedOffline || !navigator.onLine || busy;
  }
  async function load() {
    const version=++loadVersion, owner=S.owner();
    if(!owner){user='';data=[];drafts=[];selected=null;$('records').replaceChildren(el('p','No saved workspace. Sign in online on this device first.','empty'));$('draft-list').replaceChildren();$('draft-editor').replaceChildren();$('drafts').hidden=true;$('sync').disabled=true;return;}
    const [savedData,savedDrafts]=await Promise.all([S.all(owner,'page:'),S.all(owner,'draft:')]);
    if(S.owner()!==owner||version!==loadVersion)return;
    user=owner;data=savedData;drafts=savedDrafts;tableData=S.flatten(data);
    const last=await S.get(user,'last');
    $('saved-at').textContent=last ? `Last saved ${new Date(last).toLocaleString()} · this device` : 'Open inventory pages online to save their data on this device.';
    $('pending').textContent=drafts.filter(d=>d.dirty).length ? `(${drafts.filter(d=>d.dirty).length} unsynced)` : '';
    const old=$('pages').value;
    const pages=[...new Set(data.map(entry=>entry.page))].sort();
    $('pages').replaceChildren(...pages.map(path=>{const option=el('option',decodeURIComponent(path).replace('/inventory/','').replaceAll('/',' / '));option.value=path;return option;}));
    if(pages.includes(old))$('pages').value=old;
    else {const requested=new URLSearchParams(location.search).get('path')||location.pathname;const target=requested.startsWith('/inventory') ? requested : '';if(pages.includes(target))$('pages').value=target;}
    renderInventory();renderDrafts();status();
  }
  function displayRow(row, table) {
    const card=el('article',null,'card'),rowNode=el('div',null,'row'),body=el('div',null,'content');
    const image=photo(row.photo_url||row.photo_data||row.metadata?.photo_url);if(image)rowNode.append(image);
    const name=row.display_name||row.name||row.reference||row.cabinet_model||row.row_label||row.serial||row.problem_type?.replaceAll('_',' ')||tableNames[table]||table;
    body.append(el('h3',name));
    const fields=['label','reference','phase','awaiting_test','unit_no','serial','serial_number','block_name','size','length','type','status','list_type','requested_quantity','total_qty','qty','available_qty','in_use_qty','in_ksa_qty','maintenance_qty','stock_quantity','repaired_quantity','quantity','tested_quantity','repair_company','team_name','event_name','event_date','note','notes','testing_date','repaired_at','actor_name','created_at'];
    const count=table==='items'?visibleCounts.find(count=>count.id===row.id):null;
    const movements=(tableData.repair_status||[]).filter(repair=>repair.inventory_record_id===row.id);
    const parts=fields.filter(key=>row[key]!=null && row[key]!=='').map(key=>`${key.replaceAll('_',' ')}: ${text(row[key])}`);
    if(count)parts.push(`Total: ${count.total} · Available: ${count.available} · In Use: ${count.in_use} · Maintenance: ${count.maintenance} · In KSA: ${count.in_ksa}`);
    if(movements.length){const statusIndex=parts.findIndex(part=>part.startsWith('status:'));if(statusIndex>=0)parts.splice(statusIndex,1);for(const movement of movements)parts.push(`${movement.reference}: ${movement.label}`);}
    if(row.metadata?.notes)parts.push(`note: ${row.metadata.notes}`);
    body.append(el('div',parts.join('\n'),'meta'));
    const photos=[...(row.damage_photos||[]),...(row.photo_data_list||[])].filter(source=>typeof source==='string').slice(0,6);
    if(photos.length){const gallery=el('div',null,'line-actions');for(const source of photos){const img=photo(source);if(img)gallery.append(img);}body.append(gallery);}
    rowNode.append(body);card.append(rowNode);return card;
  }
  function renderInventory() {
    const page=$('pages').value, records=data.filter(entry=>entry.page===page), merged=S.flatten(records), search=$('search').value.trim().toLowerCase();
    visibleCounts=merged.unit_counts||[];
    const holder=$('records');holder.replaceChildren();
    if(!records.length){holder.append(el('p','This page has not been saved on this device. Open it online first.','empty'));return;}
    const at=Math.max(...records.map(r=>r.at));holder.append(el('p',`Saved ${new Date(at).toLocaleString()} · only data already viewed online is available.`));
    for(const [table,rows] of Object.entries(merged)) {
      if(!tableNames[table])continue;
      const visible=rows.filter(row=>JSON.stringify(row).toLowerCase().includes(search));
      if(!visible.length)continue;
      const section=el('details');section.open=table==='items'||table==='matrix_models'||table==='matrix_rows'||page.includes('/lists/')||Object.keys(merged).filter(k=>tableNames[k]).length===1;
      section.append(el('summary',`${tableNames[table]} · ${visible.length}`));
      const grid=el('div',null,'grid');
      for(const row of visible) {
        const card=displayRow(row,table);
        if(['items','units','matrix_models','matrix_rows'].includes(table)) {
          const actions=el('div',null,'line-actions');actions.append(button('Edit',offlineMessage,true));
          if(table!=='items')actions.append(button('+ Draft',()=>pickTarget(table,row),true));
          card.append(actions);
        }
        grid.append(card);
      }
      section.append(grid);holder.append(section);
    }
    if(!holder.querySelector('details'))holder.append(el('p','No saved equipment matches. Serial details are saved when their report or serial picker is opened online.','empty'));
  }
  function changeView(next) {view=next;$('inventory').hidden=view!=='inventory';$('drafts').hidden=view!=='drafts';document.querySelectorAll('[data-view]').forEach(node=>node.setAttribute('aria-current',String(node.dataset.view===view)));message('');}
  function renderDrafts() {
    const holder=$('draft-list');holder.replaceChildren();
    for(const draft of drafts.sort((a,b)=>b.at-a.at)) {
      const card=el('div',null,'card');card.append(button(`${draft.list.reference||'Local draft'} · ${typeNames[draft.list.list_type]||'Draft'} · ${draft.items.length} lines${draft.dirty?' · Saved on device':''}`,()=>openDraft(draft.id),true));
      if(draft.error)card.append(el('p',draft.error));if(!canEdit(draft))card.append(el('p','Read-only saved draft.'));holder.append(card);
    }
    if(!drafts.length)holder.append(el('p','No drafts saved yet. Open a draft online to prepare it, or create a local draft here.','empty'));
    if(selected){const fresh=drafts.find(d=>d.id===selected.id);if(fresh && fresh.revision!==selected.revision){selected=clone(fresh);renderEditor();}}
  }
  async function openDraft(id) {selected=clone(await S.get(user,`draft:${id}`));changeView('drafts');renderEditor();$('draft-editor').scrollIntoView({behavior:'smooth',block:'start'});}
  async function commit(next) {
    if(!canEdit(selected))throw new Error('This draft is read-only. Open it online to check your access.');
    selected=await S.saveDraft(user,next,selected.revision);await load();renderEditor();
  }
  function renderEditor() {
    const holder=$('draft-editor');holder.replaceChildren();if(!selected)return;
    const card=el('div',null,'card');card.append(el('h2',`${selected.list.reference||'Local draft'} · ${typeNames[selected.list.list_type]}`));
    card.append(el('p',selected.error|| (selected.dirty?'Saved on this device · waiting to sync':'Saved online snapshot')));
    const actions=el('div',null,'line-actions');
    if(canEdit(selected)) {
      actions.append(button('+ Inventory item',()=>inventoryPicker()),button('+ Customer item',()=>customForm()));
      actions.append(button('Submit',()=>message('Submit requires an online connection. Sync this draft, then open it in the online app to submit.'),true));
    }
    actions.append(button('Export local copy',()=>exportDraft(selected),true));
    if(selected.dirty) actions.append(button('Discard local changes',async()=>{
      if(!confirm('Discard this device’s unsynced changes? The online draft will not be changed.'))return;
      await S.discardDraft(user,selected.id,selected.revision);
      selected=null;await load();renderEditor();
    },true));
    card.append(actions);
    selected.items.forEach((item,index)=>{
      const line=displayRow(item,'equipment_list_items');
      if(canEdit(selected)){
        const tools=el('div',null,'line-actions');
        tools.append(button('Qty',()=>quantityForm(index),true));
        if(item.metadata?.custom_item)tools.append(button('Edit name / note',()=>customForm(index),true));
        tools.append(button('↑',async()=>{if(!index)return;const next=clone(selected);[next.items[index-1],next.items[index]]=[next.items[index],next.items[index-1]];await commit(next);},true));
        tools.append(button('↓',async()=>{if(index===selected.items.length-1)return;const next=clone(selected);[next.items[index+1],next.items[index]]=[next.items[index],next.items[index+1]];await commit(next);},true));
        tools.append(button('× Remove',async()=>{const next=clone(selected);next.items.splice(index,1);await commit(next);},true));line.append(tools);
      }card.append(line);
    });holder.append(card);
  }
  function field(form,label,name,value='',type='text',required=false) {
    const node=el('label',label),input=el(type==='textarea'?'textarea':'input');input.name=name;if(type!=='textarea')input.type=type;input.value=value||'';input.required=required;
    if(type==='number'){input.min='1';input.step='1';input.max='1000000';}node.append(input);form.append(node);return input;
  }
  function choice(form,label,name,values,value) {
    const node=el('label',label),input=el('select');input.name=name;
    for(const [id,title] of values){const option=el('option',title);option.value=id;input.append(option);}if(value)input.value=value;node.append(input);form.append(node);return input;
  }
  function modal(title,build,save) {
    $('modal-body').replaceChildren(el('h2',title));build($('modal-body'));
    $('modal-form').onsubmit=async event=>{
      event.preventDefault();if(busy)return;busy=true;
      try{await save(new FormData($('modal-form')));$('modal').close();message('Draft saved on this device. Sync online before Submit.');}
      catch(error){message(error.message);$('modal').close();}
      finally{busy=false;status();}
    };$('modal').showModal();
  }
  function customForm(index) {
    const old=index==null?null:selected.items[index];
    modal(old?'Edit customer item':'New customer item',form=>{
      field(form,'Name','name',old?.display_name,'text',true);choice(form,'Category','category',categories.map(c=>[c,c]),old?.draft_category||old?.metadata?.category||'other');
      field(form,'Quantity','qty',old?.requested_quantity||1,'number',true);field(form,'Note','notes',old?.metadata?.notes||'','textarea');
    },async form=>{
      const qty=Number(form.get('qty'));if(!Number.isSafeInteger(qty)||qty<1)throw new Error('Enter a valid quantity.');
      const next=clone(selected),item=old?next.items[index]:{id:S.uuid(),list_id:next.id,inventory_record_type:'item',inventory_record_id:S.uuid(),parent_record_id:null,approved_quantity:0,metadata:{custom_item:true}};
      item.display_name=String(form.get('name')).trim();item.requested_quantity=qty;
      item.draft_category=next.list.list_type==='maintenance'?null:String(form.get('category'));
      item.metadata={...item.metadata,category:String(form.get('category')),notes:String(form.get('notes')).trim()};
      if(!old)next.items.push(item);await commit(next);
    });
  }
  function quantityForm(index) {
    const item=selected.items[index];if(item.inventory_record_type==='unit'){message('Each serial is one unit. Add or remove serials instead.');return;}
    modal('Draft quantity',form=>field(form,'Quantity','qty',item.requested_quantity,'number',true),async form=>{
      const qty=Number(form.get('qty'));if(!Number.isSafeInteger(qty)||qty<1)throw new Error('Enter a valid quantity.');
      const next=clone(selected);next.items[index].requested_quantity=qty;
      const area=Number(next.items[index].metadata?.cabinet_area_sqm)||0;
      if(area)next.items[index].metadata={...next.items[index].metadata,requested_sqm:qty*area,actual_sqm:qty*area};
      await commit(next);
    });
  }
  function createDraft() {
    if(!user){message('Sign in online first.');return;}
    const allowed=Object.entries(typeNames).filter(([type])=>type!=='internal_use'||['admin','warehouse_manager'].includes(role())).filter(([type])=>type!=='maintenance'||['admin','warehouse_manager','head'].includes(role()));
    modal('Create local draft',form=>{
      choice(form,'List type','list_type',allowed,'dry_hire');
      field(form,'Customer / Event / Purpose','title','','text',true);
      field(form,'Venue / Destination / Repair company / Assigned to','place');
      field(form,'Pickup / Setup / Loading / Receiving / Send date','date','','date',true);
      field(form,'Return / Dismantling date','end','','date');field(form,'Notes','notes','','textarea');
    },async form=>{
      const type=String(form.get('list_type')),id=S.uuid(),title=String(form.get('title')).trim(),place=String(form.get('place')).trim(),date=String(form.get('date')),end=String(form.get('end'));
      if(['dry_hire','local_event'].includes(type)&&!end)throw new Error('A return or dismantling date is required.');
      if(['local_event','transfer_out','maintenance','internal_use'].includes(type)&&!place)throw new Error('Complete the venue, destination, repair company or assigned user.');
      const list={id,list_type:type,status:'draft',created_by:user,created_by_name:localStorage.getItem('hems:user_name')||'',notes:String(form.get('notes')),reference:'',
        client_company:type==='dry_hire'?title:null,event_name:type==='local_event'?title:null,venue:type==='local_event'?place:null,
        purpose:type==='internal_use'?title:null,assigned_to:type==='internal_use'?place:null,
        from_location_name:type==='transfer_out'?'Dubai Warehouse':type==='transfer_in'?'KSA':null,
        destination_name:type==='transfer_in'?'Dubai Warehouse':type==='transfer_out'?place:null,
        repair_company:type==='maintenance'?place:null,pickup_date:type==='dry_hire'?date:null,return_date:type==='dry_hire'?end:null,
        setup_date:type==='local_event'?date:null,dismantling_date:type==='local_event'?end:null,loading_date:type==='transfer_out'?date:null,
        receiving_date:type==='transfer_in'?date:null,maintenance_sent_date:type==='maintenance'?date:null};
      const draft=await S.saveDraft(user,{id,list,items:[],baseline:null,canEdit:true,revision:0},0);selected=draft;await load();renderEditor();
    });
  }
  function cabinetArea(size) {
    const value=String(size).toLowerCase().replace(/,/g,'.').replace(/[×*]/g,'x').replace(/\s+/g,' ').trim();
    const match=value.match(/(\d+(?:\.\d+)?)\s*(mm|cm|m)?\s*x\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)?/);
    if(!match)return 0;
    const metres=(n,u)=>u==='mm'?n/1000:u==='cm'?n/100:u==='m'?n:n>100?n/1000:n>2?n/100:n;
    return metres(Number(match[1]),match[2]||match[4]||'')*metres(Number(match[3]),match[4]||match[2]||'');
  }
  function cachedInventory() {
    const merged=S.flatten(data),items=new Map((merged.items||[]).map(r=>[r.id,r])),models=new Map((merged.matrix_models||[]).map(r=>[r.id,r])),choices=[];
    for(const row of merged.units||[]){const item=items.get(row.item_id);if(!item||!row.status)continue;choices.push({table:'units',row,item,label:`${item.name} · ${row.serial||'No serial'} · #${row.unit_no||''} · ${row.status}`});}
    for(const row of merged.matrix_rows||[]){const model=models.get(row.item_id||row.model_id);if(model)choices.push({table:'matrix_rows',row,item:model,label:`${model.name} · ${row.size||row.row_label||row.label||row.id}`});}
    for(const row of merged.matrix_models||[]){if((merged.matrix_rows||[]).some(r=>(r.item_id||r.model_id)===row.id))continue;if(row.total_qty!=null)choices.push({table:'matrix_models',row,item:row,label:row.name});}
    if(selected?.list.list_type==='transfer_in') {
      const incoming=[];
      for(const row of merged.ksa_stock||[])if(row.record_type!=='unit')incoming.push({table:'ksa_stock',row,item:row,label:`${row.display_name} · ${row.selectable_quantity} unreserved in KSA`,ksa:true});
      for(const row of merged.ksa_units||[])if(row.selectable){const group=(merged.ksa_stock||[]).find(g=>g.parent_record_id===row.item_id&&g.record_type==='unit');if(group)incoming.push({table:'ksa_units',row,item:group,label:`${group.display_name} · ${row.serial||row.unit_no} · KSA`,ksa:true});}
      return incoming;
    }
    return choices;
  }
  function inventoryPicker() {
    const choices=cachedInventory();
    if(!choices.length){message('No serial or Matrix details saved yet. Open the serial picker or report online first.');return;}
    modal('Add saved equipment',form=>{
      const search=field(form,'Search equipment / serial','find','','search');
      const select=choice(form,'Equipment','record',choices.map((r,i)=>[String(i),r.label]));
      search.oninput=()=>{const value=search.value.toLowerCase();for(const option of select.options)option.hidden=!option.textContent.toLowerCase().includes(value);const first=[...select.options].find(o=>!o.hidden);if(first)select.value=first.value;};
      field(form,'Quantity (serial = 1)','qty',1,'number',true);
      form.append(el('p','Snapshot only. Availability, KSA reservations and your permissions are checked again during sync.'));
    },async form=>addChoice(choices[Number(form.get('record'))],Number(form.get('qty'))));
  }
  async function pickTarget(table,row) {
    if(!selected||!canEdit(selected)){changeView('drafts');message('Open or create an editable draft first, then choose + Inventory item.');return;}
    const choice=cachedInventory().find(c=>c.table===table&&c.row.id===row.id);
    if(!choice){message('Open the serial picker or report online first to save this item’s details.');return;}
    modal('Add to draft',form=>{form.append(el('p',choice.label));field(form,'Quantity','qty',1,'number',true);},async form=>addChoice(choice,Number(form.get('qty'))));
  }
  async function addChoice(choice,qty) {
    if(!choice||!Number.isSafeInteger(qty)||qty<1)throw new Error('Choose equipment and a valid quantity.');
    const {table,row,item}=choice,type=choice.ksa?(table==='ksa_units'?'unit':row.record_type):table==='units'?'unit':table==='matrix_models'?'matrix_model':'matrix_row';
    if(choice.ksa&&table==='ksa_stock'&&qty>Number(row.selectable_quantity))throw new Error('Quantity exceeds the saved unreserved KSA stock.');
    const statusName=String(row.status||(choice.ksa?'in_ksa':'')).toLowerCase().replaceAll(' ','_').replaceAll('-','_');
    if(type==='unit'&&qty!==1)throw new Error('A serial can only have quantity 1.');
    if(type==='unit') {
      const expected=selected.list.list_type==='maintenance'?'maintenance':selected.list.list_type==='transfer_in'?'in_ksa':'available';
      if(statusName!==expected)throw new Error(`The saved serial status must be ${expected.replaceAll('_',' ')}.`);
    }
    const recordId=choice.ksa&&table==='ksa_stock'?row.record_id:row.id;
    const next=clone(selected),old=next.items.find(i=>i.inventory_record_type===type&&i.inventory_record_id===recordId);
    if(old&&type==='unit')throw new Error('This serial is already in the draft.');
    const metadata={category:'other',subcategory:'',photo_url:item.photo_url||row.photo_data||null};
    const catalog=S.flatten(data),sub=(catalog.subcategories||[]).find(s=>s.id===item.subcategory_id),category=(catalog.categories||[]).find(c=>c.id===sub?.category_id);
    if(category)metadata.category=category.slug;if(sub)metadata.subcategory=sub.slug;
    if(type==='unit'){metadata.item_id=item.id;metadata.unit_no=row.unit_no;metadata.fixture_type=item.fixture_type||null;}
    else if(!row.item_id && (row.cabinet_model||row.size)){
      const area=cabinetArea(row.size||'');
      metadata.cabinet_model=row.cabinet_model||null;metadata.cabinet_size=row.size||null;metadata.model_id=row.model_id;metadata.matrix_row_id=row.id;
      if(area>0){metadata.cabinet_area_sqm=area;metadata.requested_sqm=qty*area;metadata.actual_sqm=qty*area;}
    }else{metadata.matrix_source='generic';metadata.item_id=item.id;metadata.row_id=type==='matrix_row'?row.id:null;metadata.row_label=row.row_label||row.label||null;metadata.item_type=item.item_type||null;}
    const line=old||{id:S.uuid(),list_id:next.id,inventory_record_type:type,inventory_record_id:recordId,parent_record_id:choice.ksa?item.parent_record_id:type==='unit'?item.id:type==='matrix_row'?(row.item_id||row.model_id):null,approved_quantity:0};
    if(choice.ksa)Object.assign(metadata,item.metadata||{},{transfer_source:'ksa'});
    Object.assign(line,{display_name:item.display_name||item.name,serial_number:row.serial||null,block_name:row.block_name||item.block_name||null,requested_quantity:qty,metadata});
    if(!old)next.items.push(line);await commit(next);
  }
  function exportDraft(draft) {
    const blob=new Blob([JSON.stringify({list:draft.list,items:draft.items,saved_at:new Date(draft.at).toISOString()},null,2)],{type:'application/json'});
    const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${draft.list.reference||'local-draft'}-${draft.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  }
  $('back').onclick=()=>{if(!navigator.onLine){offlineMessage();return;}if(embedded)parent.postMessage({type:'hems:close-offline'},location.origin);else location.replace('/');};
  $('sync').onclick=()=>{if(!navigator.onLine){offlineMessage();return;}if(embedded)parent.postMessage({type:'hems:sync-drafts'},location.origin);else location.href='/?offlineSync=1';};
  $('new').onclick=createDraft;$('modal-close').onclick=()=>$('modal').close();
  $('pages').onchange=renderInventory;$('search').oninput=renderInventory;
  document.querySelectorAll('[data-view]').forEach(node=>node.onclick=()=>changeView(node.dataset.view));
  window.addEventListener('online',()=>{if(!embedded){confirmedOffline=false;location.replace('/');return;}status();});
  window.addEventListener('offline',()=>{confirmedOffline=true;status();});
  window.addEventListener('message',event=>{if(embedded&&event.origin===location.origin&&event.source===parent&&event.data?.type==='hems:connection-state'){confirmedOffline=event.data.offline===true;status();}});
  let refreshTimer;
  function refresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(!$('modal').open&&!busy)void load().catch(error=>message(error.message));},300);}
  window.addEventListener('hems:offline-data',refresh);
  window.addEventListener('focus',refresh);
  $('modal').addEventListener('close',refresh);
  window.addEventListener('storage',event=>{if(event.key==='hems:offline:owner')location.reload();});
  status();changeView('inventory');void load().catch(error=>message(`Offline storage unavailable: ${error.message}`));
})();

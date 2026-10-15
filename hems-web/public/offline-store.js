/* Shared by the live app and the standalone offline workspace. No credentials. */
(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const DB = 'hems-offline-v1', OWNER = 'hems:offline:owner';
  let opening;
  const channel = typeof root.BroadcastChannel === 'function' ? new root.BroadcastChannel('hems-offline-data') : null;
  const notify = () => root.dispatchEvent && root.dispatchEvent(new Event('hems:offline-data'));
  if (channel) channel.onmessage = notify;
  const listeners = () => { notify(); channel?.postMessage('changed'); };
  function owner() { try { return localStorage.getItem(OWNER) || ''; } catch { return ''; } }
  function open() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Offline storage unavailable.'));
    }).catch(error => { opening = null; throw error; });
    return opening;
  }
  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', mode), store = tx.objectStore('records');
      let result; const request = action(store);
      if (request) request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('Could not save offline data.'));
    });
  }
  const key = (user, suffix) => `${user}:${suffix}`;
  async function get(user, suffix) { return (await transaction('readonly', s => s.get(key(user, suffix))))?.value; }
  async function put(user, suffix, value) {
    if (!user || owner() !== user) throw new Error('The signed-in user changed.');
    await transaction('readwrite', s => s.put({ key: key(user, suffix), value })); listeners(); return value;
  }
  async function putNewer(user, suffix, value) {
    if (owner() !== user) return false;
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx=db.transaction('records','readwrite'), store=tx.objectStore('records'); let saved=false;
      const request=store.get(key(user,suffix));
      request.onsuccess=()=>{ if(owner()===user && (!request.result || (request.result.value.order || 0) <= value.order)) {
        store.put({key:key(user,suffix),value});saved=true;
      }};
      tx.oncomplete=()=>{if(saved)listeners();resolve(saved);};
      tx.onabort=tx.onerror=()=>reject(tx.error || new Error('Could not save offline data.'));
    });
  }
  async function all(user, prefix) {
    const start = key(user, prefix);
    const rows = await transaction('readonly', s => s.getAll(IDBKeyRange.bound(start, start + '\uffff')));
    return rows.filter(row => row.key.startsWith(key(user, prefix))).map(row => row.value);
  }
  async function remove(user, suffix) { await transaction('readwrite', s => s.delete(key(user, suffix))); listeners(); }
  async function purge() {
    try { localStorage.removeItem(OWNER); } catch {}
    await transaction('readwrite', s => s.clear()); listeners();
  }
  async function setOwner(user) {
    if (!user) return purge();
    if (owner() && owner() !== user) await purge();
    localStorage.setItem(OWNER, user);
  }
  function uuid() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  function rows(data) { return Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []; }
  // Do not save account management, profiles, notifications, JWTs or request headers.
  const TABLES = new Set(['categories','subcategories','items','units','matrix_models','matrix_rows',
    'equipment_lists','equipment_list_items','maintenance_requests','led_maintenance_logs','led_issue_repairs','inventory_locations']);
  const READ_RPCS = new Set(['hems_repair_status','hems_ksa_inventory_groups','hems_ksa_unit_choices',
    'hems_offline_draft_snapshot','is_equipment_list_manager','hems_maintenance_user_access','hems_action_notifications']);
  function readOnly(method, path) {
    if (path.startsWith('/rest/v1/rpc/')) return ['GET','HEAD','POST'].includes(method) && READ_RPCS.has(path.split('/').pop());
    return method === 'GET' || method === 'HEAD';
  }
  function queryKey(url, accept, range) { return `query:${url.pathname}${url.search}|${accept || ''}|${range || ''}`; }
  function contextualRows(url, data) {
    return rows(data).map(row => {
      const copy = { ...row };
      for (const field of ['item_id','model_id','list_id','matrix_row_id']) {
        const filter = url.searchParams.get(field);
        if (!copy[field] && filter?.startsWith('eq.')) copy[field] = filter.slice(3);
      }
      return copy;
    });
  }
  async function capture(user, urlText, accept, range, data, page, order = Date.now() * 1000) {
    const url = new URL(urlText), table = url.pathname.split('/').pop();
    if (!TABLES.has(table) || !page.startsWith('/inventory')) return;
    const at = Date.now(), q = queryKey(url, accept, range);
    const fields = (url.searchParams.get('select') || '').split(',').map(field => field.trim());
    const stats = table === 'units' && !fields.includes('id') && fields.includes('item_id') && fields.includes('status');
    let displayTable=table, entries=contextualRows(url,data);
    if (stats) {
      const first = Number(url.searchParams.get('offset') || (range || '0').split('-')[0]) === 0;
      const epoch = await get(user, `stats-epoch:${page}`);
      if (epoch?.order > order) return;
      if (first) {
        await putNewer(user, `stats-epoch:${page}`, {order});
        const old = await all(user, `page:${page}:`);
        for (const record of old) if (record.table === 'unit_counts' && record.order < order) await remove(user, `page:${page}:${record.query}`);
      }
      const totals = new Map();
      for (const row of entries) {
        if (!row.item_id) continue;
        const total=totals.get(row.item_id) || {id:row.item_id,total:0,available:0,in_use:0,maintenance:0,in_ksa:0};
        total.total++;
        const state=String(row.status||'').toLowerCase().replaceAll(' ','_');
        if (state in total && state !== 'id') total[state]++;
        totals.set(row.item_id,total);
      }
      displayTable='unit_counts';entries=[...totals.values()];
    }
    // Independent records avoid lost updates when parallel page reads complete together.
    const saved = await putNewer(user, q, { data, at, order });
    if (!saved) return;
    await putNewer(user, `page:${page}:${q}`, { page, table:displayTable, query:q, at, order, rows:entries });
    await put(user, 'last', at);
    if (table === 'equipment_lists') {
      for (const row of rows(data)) if (row.id && row.status && row.status !== 'draft') await invalidateDraft(user, row.id, 'This list is no longer a draft.');
      const filter = url.searchParams.get('id');
      if (!rows(data).length && filter?.startsWith('eq.')) await invalidateDraft(user, filter.slice(3), 'This list was deleted or your access changed.');
    }
  }
  async function captureRPC(user, rpc, args, result, page, order = Date.now() * 1000) {
    const table = { hems_repair_status: 'repair_status', hems_ksa_inventory_groups: 'ksa_stock', hems_ksa_unit_choices: 'ksa_units' }[rpc];
    if (!table || !page.startsWith('/inventory')) return;
    let entries = rows(result);
    if (rpc === 'hems_ksa_inventory_groups') entries = result?.items || [];
    if (rpc === 'hems_ksa_unit_choices') entries = (result?.units || []).map(row => ({ ...row, item_id: args.p_item_id }));
    if (table === 'ksa_stock') entries = entries.map(row => ({ ...row, id: `${row.record_type}:${row.record_id || row.parent_record_id}`, in_ksa_qty: row.in_ksa_quantity }));
    await putNewer(user, `page:${page}:rpc:${rpc}:${JSON.stringify(args)}`, { page, table, at: Date.now(), order, rows: entries });
  }
  async function savePhoto(user, source) {
    if (!source?.startsWith('https://') || owner() !== user) return;
    const suffix = `photo:${source}`;
    if (await get(user, suffix)) return;
    try {
      const response = await fetch(source, { credentials: 'omit', mode: 'cors' });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return;
      const blob = await response.blob();
      if (blob.size > 1000000 || owner() !== user) return;
      const images = (await all(user, 'photo:')).sort((a,b) => a.at-b.at);
      let size = images.reduce((n, photo) => n + photo.blob.size, 0);
      while (images.length >= 80 || size + blob.size > 40000000) {
        const first=images.shift(); if (!first) break;
        size -= first.blob.size; await remove(user, `photo:${first.source}`);
      }
      await put(user, suffix, { source, blob, at: Date.now() });
    } catch { /* Some third-party image servers do not permit offline downloads. */ }
  }
  async function snapshot(user, result, startedAt = Date.now()) {
    if (!result?.list?.id || result.list.status !== 'draft') return;
    return changeDraft(user, result.list.id, old => !old?.dirty && !(old?.invalidatedAt > startedAt) && JSON.stringify(old?.baseline) !== JSON.stringify(result) ? {
      id: result.list.id, list: copy(result.list), items: copy(result.items || []), baseline: copy(result),
      canEdit: result.can_edit === true, dirty: false, at: Date.now(), revision: (old?.revision || 0) + 1,
    } : null);
  }
  async function invalidateDraft(user, id, reason) {
    return changeDraft(user, id, old => old ? { ...old, canEdit: false, list: { ...old.list, status: 'unavailable' }, error: reason, invalidatedAt: Date.now(), revision: old.revision + 1 } : null);
  }
  function editable(draft, user, role) {
    if (!draft || draft.list.status !== 'draft') return false;
    if (draft.baseline) return draft.canEdit === true;
    return draft.list.created_by === user && (draft.list.list_type !== 'internal_use' || ['admin','warehouse_manager'].includes(role));
  }
  const DELETE = Symbol('delete-draft');
  async function changeDraft(user, id, update) {
    if (owner() !== user) throw new Error('The signed-in user changed.');
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite'), store = tx.objectStore('records');
      let result, reason;
      const read = store.get(key(user, `draft:${id}`));
      read.onsuccess = () => {
        try { if (owner() !== user) throw new Error('The signed-in user changed.'); result = update(read.result?.value); if (result === DELETE) store.delete(key(user, `draft:${id}`)); else if (result) store.put({ key: key(user, `draft:${id}`), value: result }); }
        catch (error) { reason = error; tx.abort(); }
      };
      tx.oncomplete = () => { listeners(); resolve(result); };
      tx.onerror = tx.onabort = () => reject(reason || tx.error || new Error('Could not save draft.'));
    });
  }
  async function saveDraft(user, draft, expectedRevision) {
    return changeDraft(user, draft.id, current => {
      if (current && (current.list.status !== 'draft' || current.canEdit === false)) throw new Error('This draft is no longer editable. Your local copy was kept.');
      if (current?.syncLock > Date.now()) throw new Error('This draft is syncing. Wait before editing.');
      if (current && current.revision !== expectedRevision) throw new Error('This draft changed in another tab. Open it again before editing.');
      return { ...draft, dirty: true, error: '', syncLock: 0,
        revision: (current?.revision || 0) + 1, syncId: uuid(), at: Date.now() };
    });
  }
  async function discardDraft(user, id, expectedRevision) {
    return changeDraft(user, id, current => {
      if (!current) return null;
      if (current.syncLock > Date.now()) throw new Error('This draft is syncing. Wait before discarding changes.');
      if (current.revision !== expectedRevision) throw new Error('This draft changed in another tab. Open it again.');
      if (!current.baseline) return DELETE;
      return { ...current, list: copy(current.invalidatedAt ? current.list : current.baseline.list), items: copy(current.baseline.items),
        dirty: false, error: current.invalidatedAt ? current.error : '', canEdit: !current.invalidatedAt && current.baseline.can_edit === true, revision: current.revision + 1 };
    });
  }
  async function beginSync(user, id) {
    return changeDraft(user, id, current => current?.dirty && !(current.syncLock > Date.now())
      ? { ...current, syncLock: Date.now() + 180000 } : null);
  }
  async function syncFailed(user, sent, message) {
    return changeDraft(user, sent.id, current => current?.syncId === sent.syncId
      ? { ...current, syncLock: 0, error: message } : null);
  }
  async function completeSync(user, sent, result) {
    return changeDraft(user, sent.id, current => current?.syncId === sent.syncId ? {
      id: sent.id, list: copy(result.list), items: copy(result.items || []), baseline: copy(result),
      canEdit: result.can_edit === true, dirty: false, at: Date.now(), revision: current.revision + 1,
    } : null);
  }
  function flatten(records) {
    const byTable = {};
    for (const entry of [...records].sort((a,b) => a.at - b.at)) {
      const byId = byTable[entry.table] || (byTable[entry.table] = new Map());
      for (const row of entry.rows) if (row.id) {
        if(entry.table === 'unit_counts' && byId.has(row.id)) {
          const old=byId.get(row.id), next={...row};
          for(const field of ['total','available','in_use','maintenance','in_ksa'])next[field]=(old[field]||0)+(row[field]||0);
          byId.set(row.id,next);
        } else byId.set(row.id, { ...byId.get(row.id), ...row });
      }
    }
    return Object.fromEntries(Object.entries(byTable).map(([name, map]) => [name, [...map.values()]]));
  }
  root.HEMSOffline = { owner, setOwner, purge, get, put, all, remove, uuid, rows, readOnly, queryKey,
    capture, captureRPC, savePhoto, snapshot, invalidateDraft, editable, saveDraft, discardDraft, beginSync, syncFailed, completeSync, flatten, contextualRows };
})(globalThis);

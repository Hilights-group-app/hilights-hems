// Local permission/route tests use mocked clients; SQL checks below are static
// contracts, NOT live PostgreSQL integration tests. No network or real writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function compile(name, imports = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(read(name), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  vm.runInNewContext(code, { exports, ...globals, require(id) {
    if (!(id in imports)) throw new Error(`Unexpected import ${id} in ${name}`);
    return imports[id];
  } }, { filename: name });
  return exports;
}

function auth(role, department = '') {
  const values = new Map();
  if (role != null) values.set('hems:user_role', role);
  if (department) values.set('hems:user_department', department);
  values.set('hems:user_id', 'warehouse-fixture');
  return compile('lib/authStore.ts', {
    '@/lib/offline': { offlineStore: async () => ({ purge() {} }) },
    '@/lib/supabase/client': { createClient() { throw new Error('Unexpected client call'); } },
  }, { window: {}, localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } });
}
const lists = compile('lib/equipmentLists.ts');

for (const role of ['warehouse_manager', 'head', 'viewer', null, '', 'unknown']) {
  test(`${String(role)} cannot directly edit Inventory`, () => {
    const permissions = auth(role);
    assert.equal(permissions.canEditInventory(), false);
    assert.equal(permissions.canReorderInventory(), false);
    assert.equal(permissions.canImportInventory(), false);
  });
}
test('Admin retains Inventory, import, reorder and Settings permissions', () => {
  const permissions = auth('admin');
  for (const name of ['canEditInventory', 'canReorderInventory', 'canImportInventory', 'canAccessSettings']) {
    assert.equal(permissions[name](), true, name);
  }
});
test('Warehouse Manager remains a manager with List creation and report viewing', () => {
  const permissions = auth('warehouse_manager');
  for (const name of ['isWarehouseManager', 'canManageEquipmentLists', 'canCreateEquipmentLists',
    'canCreateMaintenanceLists', 'canAccessReports']) assert.equal(permissions[name](), true, name);
  assert.equal(permissions.canAccessSettings(), false);
  for (const department of ['lighting', 'video', 'rigging']) {
    assert.equal(permissions.canEditReportForDepartment(department), false);
  }
});
test('Heads retain editing only within their own report department', () => {
  for (const department of ['lighting', 'video', 'rigging']) {
    const permissions = auth('head', department);
    for (const other of ['lighting', 'video', 'rigging']) {
      assert.equal(permissions.canEditReportForDepartment(other), department === other);
    }
  }
});
for (const type of ['dry_hire', 'local_event', 'transfer_out', 'transfer_in', 'maintenance', 'internal_use']) {
  test(`Warehouse Manager can still edit its own ${type} Draft`, () => {
    const draft = { id: 'list', created_by: 'warehouse-fixture', status: 'draft', list_type: type };
    const manager = auth('warehouse_manager').canManageEquipmentLists();
    assert.equal(lists.canEditEquipmentDraft(draft, 'warehouse-fixture', manager), true);
    assert.equal(lists.canEditWorkingEquipmentList(draft, 'warehouse-fixture', manager), true);
    assert.equal(lists.canAddToEquipmentList(draft, 'warehouse-fixture', manager), type !== 'transfer_in');
  });
}
test('Warehouse can add to/review Pending and append eligible dispatched Lists', () => {
  const manager = auth('warehouse_manager').canManageEquipmentLists();
  for (const type of ['dry_hire', 'local_event', 'transfer_out', 'maintenance']) {
    const pending = { created_by: 'head-fixture', status: 'pending', list_type: type };
    assert.equal(lists.canEditWorkingEquipmentList(pending, 'warehouse-fixture', manager), true);
    assert.equal(lists.canAddToEquipmentList(pending, 'warehouse-fixture', manager), true);
  }
  for (const type of ['dry_hire', 'local_event', 'transfer_out']) {
    assert.equal(lists.canAppendDispatchedList({ list_type: type, status: 'active' }, manager), true);
    assert.equal(lists.canAppendDispatchedList({ list_type: type, status: 'partially_returned' }, manager), true);
  }
  assert.equal(lists.canAppendDispatchedList({ list_type: 'transfer_out', status: 'closed' }, manager), true);
});
test('Private drafts do not become editable just because Warehouse manages Lists', () => {
  const draft = { created_by: 'someone-else', status: 'draft', list_type: 'local_event', shared_with: [] };
  assert.equal(lists.canEditEquipmentDraft(draft, 'warehouse-fixture', true), false);
  assert.equal(lists.canEditEquipmentDraft({ ...draft, shared_with: ['warehouse-fixture'] }, 'warehouse-fixture', true), true);
  assert.equal(lists.canShareEquipmentDraft({ ...draft, shared_with: ['warehouse-fixture'] }, 'warehouse-fixture'), false);
});
test('all six Inventory pages and item headers use the central edit capability', () => {
  for (const suffix of ['Lighting', 'Serialized', 'Projectors', 'ChainHoist', 'Matrix', 'LedScreen']) {
    assert.match(read(`components/SubcategoryClient${suffix}.tsx`), /const editable = canEditInventory\(\)/);
  }
  for (const suffix of ['Serialized', 'Projector', 'ChainHoist']) {
    assert.match(read(`components/ItemEditClient${suffix}Units.tsx`), /const inventoryEditable = canEditInventory\(\)/);
  }
});
test('List item actions are independent of Inventory editing permission', () => {
  for (const file of ['EquipmentListAddUnitsAction', 'EquipmentListMatrixQuantityAction', 'EquipmentListUnitPicker', 'EquipmentListQuantityPicker']) {
    assert.doesNotMatch(read(`components/${file}.tsx`), /\bcanEditInventory\b/);
  }
  assert.match(read('components/EquipmentListDetailsClient.tsx'), /const canSubmitDraft = Boolean\(canEditDraft && !isInternalUse && isOwner\)/);
});

function routeHarness(role, options = {}) {
  const calls = { profile: 0, body: 0, fetch: 0, upload: 0, sharp: 0 };
  const client = {
    auth: { async getUser() { return { data: { user: options.signedOut ? null : { id: 'server-user' } }, error: options.authError || null }; } },
    from(table) {
      assert.equal(table, 'profiles'); calls.profile++;
      const query = {
        select(columns) { assert.equal(columns, 'role'); return query; },
        eq(column, value) { assert.equal(column, 'id'); assert.equal(value, 'server-user'); return query; },
        async maybeSingle() { return { data: options.missingProfile ? null : { role }, error: options.profileError || null }; },
      };
      return query;
    },
  };
  const sharp = () => {
    calls.sharp++;
    const pipeline = {
      resize(width, height) { assert.equal(width, 260); assert.equal(height, 260); return pipeline; },
      webp({ quality }) { assert.equal(quality, 72); return pipeline; },
      async toBuffer() { return Buffer.from('compressed-fixture'); },
    };
    return pipeline;
  };
  const imports = {
    'next/server': { NextResponse: { json(body, options = {}) { return { status: options.status || 200, body }; } } },
    '@/lib/supabase/server': { createClient: async () => client },
    '@/lib/supabase/admin': { supabaseAdmin: { storage: { from(bucket) {
      assert.equal(bucket, 'equipment-photos');
      return {
        async upload(name, data, options) {
          calls.upload++; assert.match(name, /^items\/thumbs\/.*\.webp$/);
          assert.equal(data.toString(), 'compressed-fixture'); assert.equal(options.contentType, 'image/webp');
          return { error: null };
        },
        getPublicUrl(name) { return { data: { publicUrl: `https://storage.example/${name}` } }; },
      };
    } } } },
    sharp,
  };
  const globals = { Buffer, URL, AbortSignal, process: { env: { SERPAPI_KEY: 'test-key-not-real' } },
    console: { error() {} }, fetch: async () => {
      calls.fetch++;
      return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(4); },
        async json() { return { images_results: [{ title: 'Test item', original: 'https://images.example/item.webp' }] }; } };
    } };
  return {
    calls,
    google: compile('app/api/google-image/route.ts', imports, globals),
    optimize: compile('app/api/optimize-image/route.ts', imports, globals),
    request: {
      nextUrl: new URL('https://app.example/api/google-image?q=Item'),
      async json() { calls.body++; return { imageUrl: options.emptyImage ? '' : 'https://images.example/item.webp' }; },
    },
  };
}
for (const role of ['warehouse_manager', 'head', 'viewer', '', 'unknown']) {
  test(`${role || 'empty role'} cannot search/upload Inventory photos through server routes`, async () => {
    const harness = routeHarness(role);
    assert.equal((await harness.google.GET(harness.request)).status, 403);
    assert.equal((await harness.optimize.POST(harness.request)).status, 403);
    for (const key of ['body', 'fetch', 'upload', 'sharp']) assert.equal(harness.calls[key], 0, key);
  });
}
for (const [label, options, status] of [
  ['signed out', { signedOut: true }, 401],
  ['auth error', { authError: { message: 'session expired' } }, 401],
  ['missing profile', { missingProfile: true }, 403],
  ['profile read error', { profileError: { message: 'timeout' } }, 403],
]) {
  test(`photo routes fail closed on ${label}`, async () => {
    const harness = routeHarness('admin', options);
    assert.equal((await harness.google.GET(harness.request)).status, status);
    assert.equal((await harness.optimize.POST(harness.request)).status, status);
    assert.equal(harness.calls.fetch, 0);
    assert.equal(harness.calls.upload, 0);
    assert.equal(harness.calls.body, 0);
  });
}
test('Admin can still search photos and upload optimized thumbnails', async () => {
  const harness = routeHarness('admin');
  const images = await harness.google.GET(harness.request);
  assert.equal(images.status, 200);
  assert.equal(images.body[0].image, 'https://images.example/item.webp');
  const result = await harness.optimize.POST(harness.request);
  assert.equal(result.status, 200);
  assert.match(result.body.url, /^https:\/\/storage\.example\/items\/thumbs\//);
  assert.equal(harness.calls.fetch, 2);
  assert.equal(harness.calls.upload, 1);
});
test('Admin upload still validates an empty URL before download', async () => {
  const harness = routeHarness('admin', { emptyImage: true });
  assert.equal((await harness.optimize.POST(harness.request)).status, 400);
  assert.equal(harness.calls.fetch, 0);
  assert.equal(harness.calls.upload, 0);
});

const sql = read('supabase/warehouse-inventory-view-only.sql').replace(/--[^\n]*/g, '');
test('SQL installs metadata atomically without changing stored equipment or Lists', () => {
  assert.match(sql, /^\s*begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /set local lock_timeout = '5s';/);
  const installOnly = sql.replace(/as \$\$[\s\S]*?\$\$;/g, '').replace(/do \$\$[\s\S]*?\$\$;/g, '');
  assert.doesNotMatch(installOnly, /\b(?:insert into|update|delete from|truncate)\s+public\./i);
  assert.doesNotMatch(sql, /(?:disable|force|enable) row level security|session_replication_role/i);
});
test('guard is SECURITY INVOKER and rejects only direct Warehouse writes', () => {
  const body = sql.match(/create or replace function public\.hems_guard_warehouse_inventory_write\(\)[\s\S]*?\$\$;/)[0];
  assert.match(body, /security invoker\s+set search_path = ''/);
  assert.match(body, /current_user in \('authenticated', 'anon'\)/);
  assert.match(body, /hems_current_user_role\(\)[\s\S]*?= 'warehouse_manager'/);
  assert.match(body, /errcode = '42501'/);
  assert.doesNotMatch(body, /security definer/i);
  assert.match(sql, /before insert or update or delete[\s\S]*?for each statement/);
  assert.match(sql, /revoke all on function public\.hems_guard_warehouse_inventory_write\(\) from public, anon, authenticated/);
});
test('SQL protects an explicit Inventory allowlist, not operational tables', () => {
  const allowlist = sql.match(/select \* from \(values([\s\S]*?)\) as targets/)[1];
  const names = [...allowlist.matchAll(/\('([^']+)', (?:true|false)\)/g)].map(m => m[1]);
  assert.deepEqual(names, ['items', 'units', 'matrix_models', 'matrix_rows', 'led_maintenance_logs',
    'categories', 'subcategories', 'inventory_locations', 'matrix_manual_orders', 'led_issue_repairs']);
  for (const name of ['equipment_lists', 'equipment_list_items', 'maintenance_requests', 'profiles', 'notifications']) {
    assert.equal(names.includes(name), false);
  }
  assert.match(sql, /if target\.required then\s+raise exception/);
});
test('workflow preflight rejects an incompatible schema without replacing stock RPCs', () => {
  for (const name of ['approve_and_dispatch_equipment_list', 'return_equipment_list_item',
    'receive_maintenance_list_item', 'hems_receive_transfer_in_item', 'hems_archive_transfer_out', 'hems_dispatch_list_addition']) {
    assert.ok(sql.includes(`'${name}'`));
    assert.doesNotMatch(sql, new RegExp(`create or replace function public\\.${name}\\b`, 'i'));
  }
  assert.match(sql, /p\.prosecdef and r\.rolname not in \('authenticated', 'anon'\)/);
});
test('LED date SECURITY DEFINER RPC allows Admin/Video Head, not Warehouse', () => {
  const body = sql.match(/create or replace function public\.hems_set_led_report_testing_date[\s\S]*?\$\$;/)[0];
  assert.match(body, /security definer\s+set search_path = ''/);
  assert.match(body, /auth\.uid\(\) is null/);
  assert.match(body, /coalesce\(v_role, ''\) = 'admin'/);
  assert.match(body, /coalesce\(v_role, ''\) = 'head' and coalesce\(v_department, ''\) = 'video'/);
  assert.doesNotMatch(body, /warehouse_manager/);
});
test('Storage guards restrict writes only; read policies and avatar access are preserved', () => {
  assert.equal((sql.match(/create policy/g) || []).length, 3);
  assert.equal((sql.match(/as restrictive/g) || []).length, 3);
  assert.match(sql, /as restrictive for insert to authenticated/);
  assert.match(sql, /as restrictive for update to authenticated/);
  assert.match(sql, /as restrictive for delete to authenticated/);
  assert.doesNotMatch(sql, /create policy[^;]*\bfor select\b/);
  assert.equal((sql.match(/bucket_id <> 'equipment-photos'/g) || []).length, 4);
  assert.equal((sql.match(/\(storage\.foldername\(name\)\)\[1\] = 'avatars'/g) || []).length, 4);
  assert.equal((sql.match(/<> 'warehouse_manager'/g) || []).length, 4);
});

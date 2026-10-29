-- HEMS: Warehouse Manager can view Inventory, but cannot edit it directly.
-- Run in Supabase SQL Editor as postgres, then install/deploy the matching UI.
-- Re-runnable. No stock, reports, photos or list data are deleted or changed.
-- Lists, draft selection, Approve/Dispatch, Received and KSA workflows are kept.
begin;
set local lock_timeout = '5s';

-- Fail safely on an unexpected old/custom installation rather than break an
-- inventory-changing list workflow. Do not silently replace those workflows.
do $$
declare
  writer text;
begin
  foreach writer in array array[
    'approve_and_dispatch_equipment_list',
    'return_equipment_list_item',
    'receive_maintenance_list_item',
    'hems_receive_transfer_in_item',
    'hems_archive_transfer_out',
    'hems_dispatch_list_addition'
  ] loop
    if not exists (
      select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles r on r.oid = p.proowner
      where n.nspname = 'public' and p.proname = writer
        and p.prosecdef and r.rolname not in ('authenticated', 'anon')
    ) then
      raise exception 'List workflow public.% needs review before applying Inventory view-only. No changes were committed.', writer;
    end if;
  end loop;
end;
$$;

-- SECURITY INVOKER is intentional. A direct Data API write runs as
-- authenticated; the existing authorized SECURITY DEFINER list workflows run
-- as their owner and can still update stock. Do NOT make this SECURITY DEFINER.
-- A statement trigger also protects older clients without changing SELECT/RLS
-- behavior or depending on which legacy inventory policies are installed.
create or replace function public.hems_guard_warehouse_inventory_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon')
    and lower(btrim(coalesce(public.hems_current_user_role(), ''))) = 'warehouse_manager' then
    raise exception 'Warehouse Manager has view-only access to Inventory. Use Lists for dispatch and receipt.'
      using errcode = '42501';
  end if;
  return null; -- Statement triggers do not return a row.
end;
$$;
revoke all on function public.hems_guard_warehouse_inventory_write() from public, anon, authenticated;

do $$
declare
  target record;
  relation regclass;
begin
  -- Explicit allowlist only: never attach to lists, list items, maintenance
  -- requests, profiles or notifications. Optional tables differ across installs.
  for target in
    select * from (values
      ('items', true),
      ('units', true),
      ('matrix_models', true),
      ('matrix_rows', true),
      ('led_maintenance_logs', true),
      ('categories', true),
      ('subcategories', true),
      ('inventory_locations', false),
      ('matrix_manual_orders', false),
      ('led_issue_repairs', false)
    ) as targets(table_name, required)
  loop
    relation := pg_catalog.to_regclass(pg_catalog.format('public.%I', target.table_name));
    if relation is null then
      if target.required then
        raise exception 'Required inventory table public.% is missing. No permission changes were committed.', target.table_name;
      end if;
      continue;
    end if;
    execute pg_catalog.format(
      'drop trigger if exists hems_warehouse_inventory_read_only on public.%I', target.table_name);
    execute pg_catalog.format(
      'create trigger hems_warehouse_inventory_read_only before insert or update or delete on public.%I for each statement execute function public.hems_guard_warehouse_inventory_write()',
      target.table_name);
  end loop;
end;
$$;

-- The existing LED testing-date RPC is SECURITY DEFINER, so it needs its own
-- authorization check. Its former Warehouse exception is deliberately removed;
-- Admin and Head of Video keep their existing testing-date access.
create or replace function public.hems_set_led_report_testing_date(p_row_id uuid, p_testing_date date)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_department text;
  v_date date;
begin
  if auth.uid() is null then raise exception 'Sign in to update this report.' using errcode = '42501'; end if;
  select lower(btrim(coalesce(p.role::text, ''))), lower(btrim(coalesce(p.department::text, '')))
    into v_role, v_department from public.profiles p where p.id = auth.uid();
  if not (coalesce(v_role, '') = 'admin'
      or (coalesce(v_role, '') = 'head' and coalesce(v_department, '') = 'video')) then
    raise exception 'You do not have permission to edit this LED report.' using errcode = '42501';
  end if;
  if p_testing_date is null then raise exception 'Choose a testing date.'; end if;
  update public.matrix_rows set testing_date = p_testing_date
    where id = p_row_id returning testing_date into v_date;
  if not found then raise exception 'LED report not found.'; end if;
  return v_date;
end;
$$;
revoke all on function public.hems_set_led_report_testing_date(uuid, date) from public, anon;
grant execute on function public.hems_set_led_report_testing_date(uuid, date) to authenticated;

-- Leave all existing photo read policies intact. Restrictive write guards
-- prevent older clients from uploading/replacing/removing equipment photos.
-- Avatar paths and unrelated buckets keep their existing permissions.
drop policy if exists hems_warehouse_inventory_photo_insert on storage.objects;
create policy hems_warehouse_inventory_photo_insert on storage.objects
as restrictive for insert to authenticated
with check (
  bucket_id <> 'equipment-photos'
  or lower(btrim(coalesce((select public.hems_current_user_role()), ''))) <> 'warehouse_manager'
  or (storage.foldername(name))[1] = 'avatars'
);
drop policy if exists hems_warehouse_inventory_photo_update on storage.objects;
create policy hems_warehouse_inventory_photo_update on storage.objects
as restrictive for update to authenticated
using (
  bucket_id <> 'equipment-photos'
  or lower(btrim(coalesce((select public.hems_current_user_role()), ''))) <> 'warehouse_manager'
  or (storage.foldername(name))[1] = 'avatars'
)
with check (
  bucket_id <> 'equipment-photos'
  or lower(btrim(coalesce((select public.hems_current_user_role()), ''))) <> 'warehouse_manager'
  or (storage.foldername(name))[1] = 'avatars'
);
drop policy if exists hems_warehouse_inventory_photo_delete on storage.objects;
create policy hems_warehouse_inventory_photo_delete on storage.objects
as restrictive for delete to authenticated
using (
  bucket_id <> 'equipment-photos'
  or lower(btrim(coalesce((select public.hems_current_user_role()), ''))) <> 'warehouse_manager'
  or (storage.foldername(name))[1] = 'avatars'
);

notify pgrst, 'reload schema';
commit;

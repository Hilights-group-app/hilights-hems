-- Apply after the existing sharing, ordering, KSA and maintenance migrations.
-- Offline edits are drafts only. No workflow/stock status is changed by this RPC.
begin;
set local lock_timeout = '15s';

create table if not exists public.hems_offline_sync_receipts (
  actor_id uuid not null references auth.users(id) on delete cascade,
  sync_id uuid not null,
  list_id uuid not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  primary key (actor_id, sync_id)
);
alter table public.hems_offline_sync_receipts enable row level security;
revoke all on public.hems_offline_sync_receipts from public, anon, authenticated;

-- All ordinary item writes take the same parent lock as sync before checking
-- the baseline. A concurrent editor is serialized or gets a transaction error,
-- never silently overwritten. Existing RLS and guards remain installed.
create or replace function public.hems_offline_lock_draft_parent()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  target := case when tg_op = 'DELETE' then old.list_id else new.list_id end;
  perform 1 from public.equipment_lists where id=target for no key update;
  if tg_op='UPDATE' and old.list_id is distinct from new.list_id then
    raise exception 'Move an item by removing and adding it to the other list.';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.hems_offline_lock_draft_parent() from public,anon,authenticated;
drop trigger if exists aaa_hems_offline_parent_lock on public.equipment_list_items;
create trigger aaa_hems_offline_parent_lock before insert or update or delete on public.equipment_list_items
for each row execute function public.hems_offline_lock_draft_parent();

create or replace function public.hems_offline_draft_snapshot(p_list_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare parent public.equipment_lists%rowtype; entries jsonb;
begin
  if auth.uid() is null or not public.hems_can_view_equipment_list(p_list_id) then
    raise exception 'Draft is no longer shared with you or is unavailable.' using errcode='42501';
  end if;
  select * into parent from public.equipment_lists where id=p_list_id for share;
  if not found or parent.status::text <> 'draft' then return null; end if;
  select coalesce(jsonb_agg(to_jsonb(i) order by i.id), '[]'::jsonb) into entries
    from public.equipment_list_items i where i.list_id=p_list_id;
  return jsonb_build_object('list',to_jsonb(parent),'items',entries,
    'can_edit',public.hems_can_edit_equipment_list(p_list_id));
end;
$$;
revoke all on function public.hems_offline_draft_snapshot(uuid) from public,anon;
grant execute on function public.hems_offline_draft_snapshot(uuid) to authenticated;

create or replace function public.hems_sync_offline_draft(
  p_list_id uuid, p_sync_id uuid, p_expected_list jsonb, p_expected_items jsonb,
  p_header jsonb, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid(); parent public.equipment_lists%rowtype;
  header public.equipment_lists%rowtype; entry public.equipment_list_items%rowtype;
  raw jsonb; current_items jsonb; expected_items jsonb; request jsonb; request_hash text; receipt public.hems_offline_sync_receipts%rowtype;
  result jsonb; role_name text; stock jsonb; equipment jsonb; cat text; subcat text; status_name text;
  ordinal integer := 0; changed boolean; actual_name text;
begin
  if caller is null then raise exception 'Sign in online before syncing.' using errcode='42501'; end if;
  if p_list_id is null or p_sync_id is null or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_typeof(p_expected_items) is distinct from 'array' or jsonb_array_length(p_items)>2000 then
    raise exception 'Invalid offline draft.';
  end if;
  request := jsonb_build_object('id',p_list_id,'expected',p_expected_list,'expected_items',p_expected_items,'header',p_header,'items',p_items);
  request_hash:=encode(sha256(convert_to(request::text,'UTF8')),'hex');
  -- Same lock used by dispatch / KSA reservations; acquire it before parent/unit locks.
  perform pg_advisory_xact_lock(742193,1);
  select * into receipt from public.hems_offline_sync_receipts where actor_id=caller and sync_id=p_sync_id;
  if found then
    if receipt.request_hash is distinct from request_hash then raise exception 'This sync ID belongs to a different change.'; end if;
    if not public.hems_can_view_equipment_list(receipt.list_id) then raise exception 'List access has changed.' using errcode='42501'; end if;
    -- Replay never applies writes again, even if the first reply was lost.
    select * into parent from public.equipment_lists where id=receipt.list_id for share;
    select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) into current_items
      from public.equipment_list_items i where i.list_id=receipt.list_id;
    return jsonb_build_object('list',to_jsonb(parent),'items',current_items,
      'can_edit',parent.status::text='draft' and public.hems_can_edit_equipment_list(parent.id));
  end if;
  select lower(trim(p.role::text)) into role_name from public.profiles p where p.id=caller;
  if role_name is null then raise exception 'Your user profile is unavailable.' using errcode='42501'; end if;
  select * into parent from public.equipment_lists where id=p_list_id for update;
  if found then
    if parent.status::text <> 'draft' or not public.hems_can_edit_equipment_list(parent.id) then
      raise exception 'This list is no longer an editable draft. Your local copy was kept.' using errcode='42501';
    end if;
    select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) into current_items
      from public.equipment_list_items i where i.list_id=p_list_id;
    select coalesce(jsonb_agg(value order by value->>'id'),'[]'::jsonb) into expected_items
      from jsonb_array_elements(p_expected_items);
    if p_expected_list is null or to_jsonb(parent) is distinct from p_expected_list or current_items is distinct from expected_items then
      raise exception 'Conflict: this draft changed online. Your local changes were kept. Compare the online list before syncing.' using errcode='40001';
    end if;
  else
    if p_expected_list is not null then raise exception 'This draft was deleted. Your local copy was kept.'; end if;
    header := jsonb_populate_record(null::public.equipment_lists,p_header);
    if header.list_type is null or header.list_type::text not in ('dry_hire','local_event','transfer_out','transfer_in','maintenance','internal_use')
      or (header.list_type::text='internal_use' and role_name not in ('admin','warehouse_manager'))
      or (header.list_type::text='maintenance' and role_name not in ('admin','warehouse_manager','head')) then
      raise exception 'You cannot create this list type.' using errcode='42501';
    end if;
    if (header.list_type::text='dry_hire' and (nullif(trim(header.client_company),'') is null or header.pickup_date is null or header.return_date is null))
      or (header.list_type::text='local_event' and (nullif(trim(header.event_name),'') is null or nullif(trim(header.venue),'') is null or header.setup_date is null or header.dismantling_date is null))
      or (header.list_type::text='transfer_out' and (nullif(trim(header.destination_name),'') is null or header.loading_date is null))
      or (header.list_type::text='transfer_in' and header.receiving_date is null)
      or (header.list_type::text='maintenance' and (nullif(trim(header.repair_company),'') is null or header.maintenance_sent_date is null)) then
      raise exception 'Complete the required draft details before syncing.';
    end if;
    insert into public.equipment_lists(id,list_type,status,created_by,created_by_name,
      client_company,event_name,venue,purpose,assigned_to,from_location_name,destination_name,
      pickup_date,return_date,setup_date,dismantling_date,loading_date,receiving_date,repair_company,maintenance_sent_date,notes)
    values(p_list_id,header.list_type,'draft',caller,
      (select p.full_name from public.profiles p where p.id=caller),
      header.client_company,header.event_name,header.venue,header.purpose,header.assigned_to,
      case when header.list_type::text='transfer_out' then 'Dubai Warehouse' when header.list_type::text='transfer_in' then 'KSA' else header.from_location_name end,
      case when header.list_type::text='transfer_in' then 'Dubai Warehouse' else header.destination_name end,
      header.pickup_date,header.return_date,header.setup_date,header.dismantling_date,header.loading_date,header.receiving_date,header.repair_company,header.maintenance_sent_date,header.notes)
    returning * into parent;
    if not public.hems_can_edit_equipment_list(parent.id) then raise exception 'Draft creation is not permitted.' using errcode='42501'; end if;
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) e group by e->>'id' having count(*)>1) then raise exception 'Duplicate draft line.'; end if;
  -- Atomic replacement. No stock tables are written. Existing item guards also
  -- recheck Matrix capacity, KSA reservations, maintenance and role permissions.
  delete from public.equipment_list_items where list_id=p_list_id;
  for raw in select value from jsonb_array_elements(p_items) loop
    entry := jsonb_populate_record(null::public.equipment_list_items,raw);
    if entry.id is null or entry.inventory_record_id is null or entry.requested_quantity is null
      or entry.requested_quantity<=0 or entry.requested_quantity<>trunc(entry.requested_quantity)
      or entry.requested_quantity>1000000 or nullif(trim(entry.display_name),'') is null then raise exception 'Invalid equipment quantity or name.'; end if;
    entry.metadata := coalesce(entry.metadata,'{}'::jsonb);
    if entry.metadata->>'custom_item' = 'true' then
      if entry.inventory_record_type::text <> 'item' then raise exception 'Invalid custom item.'; end if;
      entry.parent_record_id:=null; entry.serial_number:=null;
    else
      equipment:=null; stock:=null; cat:=null; subcat:=null;
      if entry.inventory_record_type::text='unit' then
        select to_jsonb(u) into stock from public.units u where u.id=entry.inventory_record_id for update;
        if stock is null then raise exception 'A selected serial no longer exists.'; end if;
        if entry.requested_quantity<>1 then raise exception 'A serial can only be selected once.'; end if;
        entry.parent_record_id:=(stock->>'item_id')::uuid;
        select to_jsonb(i) into equipment from public.items i where i.id=entry.parent_record_id;
        entry.serial_number:=stock->>'serial'; entry.display_name:=coalesce(equipment->>'name',entry.display_name);
        status_name:=lower(replace(replace(stock->>'status',' ','_'),'-','_'));
        if (parent.list_type::text='maintenance' and status_name is distinct from 'maintenance')
          or (parent.list_type::text='transfer_in' and status_name is distinct from 'in_ksa')
          or (parent.list_type::text not in ('maintenance','transfer_in') and status_name is distinct from 'available') then
          raise exception 'Serial % is no longer available for this draft type.',coalesce(entry.serial_number,entry.inventory_record_id::text);
        end if;
        if parent.list_type::text not in ('maintenance','transfer_in') and exists (
          select 1 from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
          where i.inventory_record_type='unit' and i.inventory_record_id=entry.inventory_record_id
            and l.list_type::text<>'maintenance' and l.status::text in ('active','partially_returned')
            and greatest(i.approved_quantity,i.requested_quantity)>coalesce(i.returned_ok_quantity,0)+coalesce(i.returned_maintenance_quantity,0)
        ) then raise exception 'A selected serial has an active movement. Refresh its inventory report.'; end if;
        entry.metadata:=entry.metadata || jsonb_build_object('item_id',entry.parent_record_id,'unit_no',stock->'unit_no','fixture_type',equipment->'fixture_type');
        if exists(select 1 from public.equipment_list_items i where i.list_id=p_list_id and i.inventory_record_type='unit' and i.inventory_record_id=entry.inventory_record_id) then
          raise exception 'A serial was selected twice.';
        end if;
      elsif entry.inventory_record_type::text='matrix_model' then
        select to_jsonb(m) into stock from public.matrix_models m where m.id=entry.inventory_record_id for update;
        equipment:=stock; entry.metadata:=entry.metadata || jsonb_build_object('matrix_source','generic');
      elsif entry.inventory_record_type::text='matrix_row' then
        select to_jsonb(r) into stock from public.matrix_rows r where r.id=entry.inventory_record_id for update;
        entry.parent_record_id:=coalesce(nullif(stock->>'item_id',''),nullif(stock->>'model_id',''))::uuid;
        select to_jsonb(m) into equipment from public.matrix_models m where m.id=entry.parent_record_id;
        entry.metadata:=entry.metadata || jsonb_build_object('matrix_source',case when nullif(stock->>'item_id','') is null then 'led' else 'generic' end);
      else raise exception 'Select inventory units or Matrix stock.';
      end if;
      if stock is null or equipment is null then raise exception 'A selected stock record is unavailable.'; end if;
      select c.slug,s.slug into cat,subcat from public.subcategories s join public.categories c on c.id=s.category_id
        where s.id=(equipment->>'subcategory_id')::uuid;
      if cat is null then raise exception 'The equipment category is unavailable. Open its inventory page online.'; end if;
      entry.metadata:=entry.metadata || jsonb_build_object('category',cat,'subcategory',subcat);
    end if;
    if not public.hems_can_edit_list_item(p_list_id,entry.metadata) then
      raise exception 'You no longer have permission to edit this equipment.' using errcode='42501';
    end if;
    insert into public.equipment_list_items(id,list_id,inventory_record_type,inventory_record_id,parent_record_id,
      display_name,serial_number,block_name,requested_quantity,approved_quantity,returned_ok_quantity,returned_maintenance_quantity,
      metadata,draft_sort_order,draft_category)
    values(entry.id,p_list_id,entry.inventory_record_type,entry.inventory_record_id,entry.parent_record_id,
      trim(entry.display_name),entry.serial_number,entry.block_name,entry.requested_quantity,0,0,0,
      entry.metadata,case when parent.list_type::text='maintenance' then null else ordinal end,
      case when parent.list_type::text='maintenance' then null else entry.draft_category end);
    ordinal:=ordinal+1;
  end loop;
  result:=public.hems_offline_draft_snapshot(p_list_id);
  insert into public.hems_offline_sync_receipts(actor_id,sync_id,list_id,request_hash)
    values(caller,p_sync_id,p_list_id,request_hash);
  return result;
end;
$$;
revoke all on function public.hems_sync_offline_draft(uuid,uuid,jsonb,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.hems_sync_offline_draft(uuid,uuid,jsonb,jsonb,jsonb,jsonb) to authenticated;
commit;

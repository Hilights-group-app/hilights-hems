-- Run after equipment-draft-sharing.sql. Existing RLS policies stay in place.
-- A separate nullable column prevents metadata edits overwriting the saved order.
begin;
alter table public.equipment_list_items add column if not exists draft_sort_order integer;
alter table public.equipment_list_items add column if not exists draft_category text;
-- Replace the old two-argument signature; defaults keep older clients compatible.
drop function if exists public.hems_reorder_draft_items(uuid, uuid[]);
create or replace function public.hems_reorder_draft_items(p_list_id uuid, p_item_ids uuid[], p_custom_item_ids uuid[] default '{}'::uuid[], p_category text default null)
returns setof public.equipment_list_items
language plpgsql security definer set search_path = ''
as $$
declare
  parent public.equipment_lists%rowtype;
  actual_count bigint;
  changed_count bigint;
begin
  if auth.uid() is null then
    raise exception 'Sign in to reorder a draft.' using errcode = '42501';
  end if;
  -- Same lock as shared-draft item edits; Submit cannot race this operation.
  select * into parent from public.equipment_lists where id = p_list_id for no key update;
  if not found or parent.list_type::text = 'maintenance'
    or parent.status::text not in ('draft', 'pending')
    or (parent.status::text = 'draft' and not public.hems_can_edit_equipment_list(p_list_id))
    or (parent.status::text = 'pending' and parent.created_by is distinct from auth.uid()
      and not public.is_equipment_list_manager()) then
    raise exception 'You cannot reorder this draft.' using errcode = '42501';
  end if;
  select count(*) into actual_count from public.equipment_list_items where list_id = p_list_id;
  if p_item_ids is null or cardinality(p_item_ids) = 0
    or cardinality(p_item_ids) <> actual_count
    or array_position(p_item_ids, null) is not null
    or (select count(distinct id) from unnest(p_item_ids) as requested(id)) <> actual_count
    or exists (
      select 1 from unnest(p_item_ids) as requested(id)
      where not exists (
        select 1 from public.equipment_list_items i where i.id = requested.id and i.list_id = p_list_id
      )
    ) then
    raise exception 'The draft items changed. Refresh the list and try again.' using errcode = '40001';
  end if;
  if parent.status::text <> 'draft' and coalesce(cardinality(p_custom_item_ids), 0) > 0 then
    raise exception 'After Submit, only equipment order can be changed.' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_custom_item_ids), 0) > 0 then
    if p_category is null or p_category not in ('lighting', 'video', 'rigging', 'audio', 'power', 'other')
      or array_position(p_custom_item_ids, null) is not null
      or exists (
        select 1 from unnest(p_custom_item_ids) as requested(id)
        where not exists (
          select 1 from public.equipment_list_items i where i.id = requested.id
          and i.list_id = p_list_id and i.inventory_record_type::text = 'item' and i.metadata ->> 'custom_item' = 'true'
        )
      ) then
      raise exception 'Only custom items can be moved into another category.' using errcode = '42501';
    end if;
  end if;
  update public.equipment_list_items as i
    set draft_sort_order = (requested.rank - 1)::integer,
      draft_category = case when i.id = any(coalesce(p_custom_item_ids, '{}'::uuid[])) then p_category else i.draft_category end
    from unnest(p_item_ids) with ordinality as requested(id, rank)
    where i.id = requested.id and i.list_id = p_list_id;
  get diagnostics changed_count = row_count;
  if changed_count <> actual_count then
    raise exception 'The order could not be saved for all draft items.' using errcode = '42501';
  end if;
  return query select i.* from public.equipment_list_items i
    where i.list_id = p_list_id order by i.draft_sort_order;
end;
$$;
revoke all on function public.hems_reorder_draft_items(uuid, uuid[], uuid[], text) from public, anon;
grant execute on function public.hems_reorder_draft_items(uuid, uuid[], uuid[], text) to authenticated;
-- Also guard direct API writes to the order column.
create or replace function public.hems_guard_draft_item_order()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  parent public.equipment_lists%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.draft_sort_order is not distinct from old.draft_sort_order
      and new.draft_category is not distinct from old.draft_category then return new; end if;
  elsif new.draft_sort_order is null and new.draft_category is null then return new;
  end if;
  select * into parent from public.equipment_lists where id = new.list_id for no key update;
  if auth.uid() is not null and (
    not found or parent.list_type::text = 'maintenance'
    or parent.status::text not in ('draft', 'pending')
    or (parent.status::text = 'draft' and not public.hems_can_edit_equipment_list(new.list_id))
    or (parent.status::text = 'pending' and parent.created_by is distinct from auth.uid()
      and not public.is_equipment_list_manager())
  ) then
    raise exception 'Only draft editors can change the equipment order.' using errcode = '42501';
  end if;
  if parent.status::text = 'pending' then
    if tg_op <> 'UPDATE' then
      raise exception 'After Submit, only equipment order can be changed.' using errcode = '42501';
    end if;
    if (to_jsonb(new) - 'draft_sort_order' - 'updated_at') is distinct from
       (to_jsonb(old) - 'draft_sort_order' - 'updated_at') then
      raise exception 'After Submit, only equipment order can be changed.' using errcode = '42501';
    end if;
  end if;
  if new.draft_category is not null and (
    new.draft_category not in ('lighting', 'video', 'rigging', 'audio', 'power', 'other')
    or new.inventory_record_type::text <> 'item'
    or coalesce(new.metadata ->> 'custom_item', 'false') <> 'true'
  ) then
    raise exception 'Only custom items can use a draft category.' using errcode = '42501';
  end if;
  if new.draft_sort_order < 0 then
    raise exception 'Equipment order must be non-negative.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.hems_guard_draft_item_order() from public, anon, authenticated;
drop trigger if exists hems_draft_item_order_guard on public.equipment_list_items;
create trigger hems_draft_item_order_guard
before insert or update on public.equipment_list_items
for each row execute function public.hems_guard_draft_item_order();
-- Merge a custom item's name/note without replacing category/order/quantity.
create or replace function public.hems_edit_custom_draft_item(p_item_id uuid, p_name text, p_notes text)
returns setof public.equipment_list_items
language plpgsql security definer set search_path = ''
as $$
declare
  target_list_id uuid;
  parent public.equipment_lists%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in to edit a custom item.' using errcode = '42501';
  end if;
  select i.list_id into target_list_id from public.equipment_list_items i where i.id = p_item_id;
  if not found then raise exception 'Custom item not found.' using errcode = '42501'; end if;
  select * into parent from public.equipment_lists where id = target_list_id for no key update;
  if not found or parent.status::text <> 'draft' or parent.list_type::text = 'maintenance'
    or not public.hems_can_edit_equipment_list(target_list_id) then
    raise exception 'You cannot edit this draft.' using errcode = '42501';
  end if;
  if nullif(btrim(p_name), '') is null then
    raise exception 'Enter an item name.' using errcode = '23514';
  end if;
  return query update public.equipment_list_items as i
    set display_name = btrim(p_name),
      metadata = coalesce(i.metadata, '{}'::jsonb) || jsonb_build_object('notes', nullif(btrim(p_notes), ''))
    where i.id = p_item_id and i.list_id = target_list_id
      and i.inventory_record_type::text = 'item' and i.metadata ->> 'custom_item' = 'true'
    returning i.*;
  if not found then
    raise exception 'Only custom items can be edited here.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.hems_edit_custom_draft_item(uuid, text, text) from public, anon;
grant execute on function public.hems_edit_custom_draft_item(uuid, text, text) to authenticated;

-- Preserve sharing guards while allowing rank-only Pending owner writes.
create or replace function public.hems_guard_shared_draft_items()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  target_list uuid;
  target_record uuid;
  target_type text;
  parent public.equipment_lists%rowtype;
begin
  if caller is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'DELETE' then
    target_list := old.list_id;
  else
    target_list := new.list_id;
  end if;
  select * into parent from public.equipment_lists where id = target_list for no key update;
  if not found or parent.list_type::text not in ('dry_hire', 'local_event', 'transfer_out') then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  -- Pending creators may reorder only; all other item fields remain locked.
  if tg_op = 'UPDATE' and parent.status::text = 'pending' and caller = parent.created_by then
    if (to_jsonb(new) - 'draft_sort_order' - 'updated_at') is not distinct from
       (to_jsonb(old) - 'draft_sort_order' - 'updated_at') then return new; end if;
  end if;
  if parent.status::text = 'draft' then
    if caller is distinct from parent.created_by and not (parent.shared_with @> array[caller]) then
      raise exception 'This draft is not shared with you.' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.list_id is distinct from old.list_id then
      raise exception 'Equipment lines cannot be moved to another list.' using errcode = '42501';
    end if;
    if tg_op <> 'DELETE' and caller is distinct from parent.created_by then
      if (tg_op = 'INSERT' and (coalesce(new.approved_quantity, 0) <> 0
        or coalesce(new.returned_ok_quantity, 0) <> 0
        or coalesce(new.returned_maintenance_quantity, 0) <> 0))
        or (tg_op = 'UPDATE' and (
          new.approved_quantity is distinct from old.approved_quantity
          or new.returned_ok_quantity is distinct from old.returned_ok_quantity
          or new.returned_maintenance_quantity is distinct from old.returned_maintenance_quantity)) then
        raise exception 'Shared draft editing cannot approve or return equipment.' using errcode = '42501';
      end if;
    end if;
    if tg_op <> 'DELETE' then
      target_record := new.inventory_record_id;
      target_type := new.inventory_record_type::text;
      if exists (
        select 1 from public.equipment_list_items i
        where i.list_id = target_list and i.inventory_record_type::text = target_type
          and i.inventory_record_id = target_record and i.id is distinct from new.id
      ) then
        raise exception 'This equipment is already in the draft. Refresh the list.' using errcode = '23505';
      end if;
    end if;
  elsif not public.is_equipment_list_manager() then
    raise exception 'The draft has been submitted; equipment editing is closed.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;
commit;

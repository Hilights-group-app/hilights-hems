-- Run after equipment-draft-sharing.sql. Existing RLS policies stay in place.
-- A separate nullable column prevents metadata edits overwriting the saved order.
begin;
alter table public.equipment_list_items add column if not exists draft_sort_order integer;
create or replace function public.hems_reorder_draft_items(p_list_id uuid, p_item_ids uuid[])
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
  if not found or parent.status::text <> 'draft' or parent.list_type::text = 'maintenance'
    or not public.hems_can_edit_equipment_list(p_list_id) then
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
  update public.equipment_list_items as i
    set draft_sort_order = (requested.rank - 1)::integer
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
revoke all on function public.hems_reorder_draft_items(uuid, uuid[]) from public, anon;
grant execute on function public.hems_reorder_draft_items(uuid, uuid[]) to authenticated;
-- Also guard direct API writes to the order column.
create or replace function public.hems_guard_draft_item_order()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  parent public.equipment_lists%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.draft_sort_order is not distinct from old.draft_sort_order then return new; end if;
  elsif new.draft_sort_order is null then return new;
  end if;
  select * into parent from public.equipment_lists where id = new.list_id for no key update;
  if auth.uid() is not null and (
    not found or parent.status::text <> 'draft' or parent.list_type::text = 'maintenance'
    or not public.hems_can_edit_equipment_list(new.list_id)
  ) then
    raise exception 'Only draft editors can change the equipment order.' using errcode = '42501';
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
commit;

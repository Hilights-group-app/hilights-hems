-- Prevent Matrix draft/pending quantities above current available stock.
-- Run after the existing equipment list / maintenance workflow SQL.
begin;
create or replace function public.hems_guard_draft_matrix_quantity()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  parent public.equipment_lists%rowtype;
  stock jsonb;
  capacity numeric;
  occupied numeric;
  active_quantity numeric;
  available_quantity numeric;
  sibling_quantity numeric;
  requested_quantity numeric;
begin
  if new.inventory_record_type::text not in ('matrix_model', 'matrix_row') then return new; end if;
  if tg_op = 'UPDATE' then
    if new.requested_quantity is not distinct from old.requested_quantity
      and new.list_id is not distinct from old.list_id
      and new.inventory_record_type is not distinct from old.inventory_record_type
      and new.inventory_record_id is not distinct from old.inventory_record_id
      and (new.metadata ->> 'matrix_source') is not distinct from (old.metadata ->> 'matrix_source') then
      return new;
    end if;
  end if;
  select * into parent from public.equipment_lists where id = new.list_id for no key update;
  if not found then raise exception 'Equipment list not found.'; end if;
  -- Transfer In has its own KSA reservation guard in ksa-transfer-workflow.sql.
  if parent.list_type::text = 'transfer_in' then return new; end if;
  if parent.status::text not in ('draft', 'pending') then return new; end if;
  if new.inventory_record_type::text = 'matrix_model' then
    select to_jsonb(m) into stock from public.matrix_models m where m.id = new.inventory_record_id for share;
  else
    select to_jsonb(m) into stock from public.matrix_rows m where m.id = new.inventory_record_id for share;
  end if;
  if stock is null then raise exception 'This Matrix item no longer exists.' using errcode = '23514'; end if;
  if parent.list_type::text = 'maintenance' then
    capacity := greatest(0, coalesce((stock ->> 'maintenance_qty')::numeric, 0));
    select coalesce(sum(greatest(0, request.quantity - request.tested_quantity)), 0)
      into occupied from public.maintenance_requests request
      where request.inventory_record_type = new.inventory_record_type
        and request.inventory_record_id = new.inventory_record_id
        and request.source_type = 'maintenance' and request.status in ('sent', 'received');
  else
    capacity := greatest(0,
      coalesce((case when new.inventory_record_type::text = 'matrix_model'
        or new.metadata ->> 'matrix_source' = 'generic' then stock ->> 'total_qty' else stock ->> 'qty' end)::numeric, 0)
      - coalesce((stock ->> 'maintenance_qty')::numeric, 0));
    occupied := greatest(0, coalesce((stock ->> 'in_use_qty')::numeric, 0) + coalesce((stock ->> 'in_ksa_qty')::numeric, 0));
    select coalesce(sum(greatest(0,
      (case when i.approved_quantity > 0 then i.approved_quantity else i.requested_quantity end)
      - coalesce(i.returned_ok_quantity, 0) - coalesce(i.returned_maintenance_quantity, 0))), 0)
      into active_quantity
      from public.equipment_list_items i join public.equipment_lists l on l.id = i.list_id
      where i.inventory_record_type = new.inventory_record_type and i.inventory_record_id = new.inventory_record_id
        and l.status::text in ('active', 'partially_returned') and l.list_type::text not in ('maintenance','transfer_in')
        and i.list_id <> new.list_id;
    occupied := greatest(occupied, active_quantity);
  end if;
  available_quantity := greatest(0, capacity - occupied);
  select coalesce(sum(i.requested_quantity), 0) into sibling_quantity
    from public.equipment_list_items i where i.list_id = new.list_id
      and i.inventory_record_type = new.inventory_record_type and i.inventory_record_id = new.inventory_record_id
      and i.id is distinct from new.id;
  requested_quantity := coalesce(new.requested_quantity, 0) + sibling_quantity;
  if requested_quantity > available_quantity then
    raise exception 'Only % unit(s) are available for %. Requested: %.', available_quantity, new.display_name, requested_quantity
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.hems_guard_draft_matrix_quantity() from public, anon, authenticated;
drop trigger if exists hems_draft_matrix_quantity_guard on public.equipment_list_items;
create trigger hems_draft_matrix_quantity_guard
before insert or update on public.equipment_list_items
for each row execute function public.hems_guard_draft_matrix_quantity();
commit;

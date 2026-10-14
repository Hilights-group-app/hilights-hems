-- Run once in Supabase SQL Editor. Safe to re-run.
-- Keeps the current KSA dispatch/sharing functions; replaces only repair Receive/Test.
begin;

-- Minimal stock metadata, shared by inventory badges and all unit/LED reports.
create or replace function public.hems_unit_has_open_repair(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.maintenance_requests r
    join public.equipment_lists l on l.id=r.list_id
    where r.inventory_record_type='unit' and r.inventory_record_id=p_unit_id
      and r.source_type='maintenance' and r.status in ('sent','received')
      and r.quantity>r.tested_quantity and l.list_type='maintenance' and l.status='active'
  );
$$;
revoke all on function public.hems_unit_has_open_repair(uuid) from public,anon;
grant execute on function public.hems_unit_has_open_repair(uuid) to authenticated;

-- Binding/stock checks used both for safe legacy repair and Receive/Test.
-- Does not guess when a unit belongs to another movement or has a changed identity.
create or replace function public.hems_repair_unit_is_consistent(p_request_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
 select exists (
  select 1 from public.maintenance_requests r
  join public.units u on u.id=r.inventory_record_id
  join public.equipment_list_items i on i.id=r.list_item_id
  where r.id=p_request_id and r.inventory_record_type='unit' and r.quantity=1
    and i.list_id=r.list_id and i.inventory_record_type='unit'
    and i.inventory_record_id=u.id
    and (r.parent_record_id is null or r.parent_record_id=u.item_id)
    and (nullif(btrim(r.serial_number),'') is null or btrim(r.serial_number)=btrim(u.serial))
    and u.status in ('available','maintenance')
    and not exists (
      select 1 from public.maintenance_requests other
      join public.equipment_lists ol on ol.id=other.list_id
      where other.id<>r.id and other.inventory_record_type='unit'
        and other.inventory_record_id=u.id and other.source_type='maintenance'
        and other.status in ('sent','received') and other.quantity>other.tested_quantity
        and ol.status='active' and ol.list_type='maintenance'
    )
    and not exists (
      select 1 from public.equipment_list_items mi
      join public.equipment_lists ml on ml.id=mi.list_id
      where mi.inventory_record_type='unit' and mi.inventory_record_id=u.id
        and ml.list_type<>'maintenance' and ml.status in ('active','partially_returned')
        and coalesce(mi.approved_quantity,0)>
          coalesce(mi.returned_ok_quantity,0)+coalesce(mi.returned_maintenance_quantity,0)
    )
 );
$$;
revoke all on function public.hems_repair_unit_is_consistent(uuid) from public,anon,authenticated;

create or replace function public.hems_lock_repair_unit(p_request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
 select inventory_record_id into v_id from public.maintenance_requests where id=p_request_id;
 perform 1 from public.units where id=v_id for update;
 if not found then raise exception 'The repair unit no longer exists. Please review this list.'; end if;
 if public.hems_repair_unit_is_consistent(p_request_id) is not true then
  raise exception 'Repair / stock mismatch. Check the serial and other active movements before receiving or testing this unit.';
 end if;
end;
$$;
revoke all on function public.hems_lock_repair_unit(uuid) from public,anon,authenticated;

create or replace function public.hems_open_repair_quantity(p_type text,p_id uuid)
returns integer language sql stable security definer set search_path='' as $$
 select coalesce(sum(r.quantity-r.tested_quantity),0)::integer
 from public.maintenance_requests r join public.equipment_lists l on l.id=r.list_id
 where r.inventory_record_type=p_type and r.inventory_record_id=p_id
  and r.source_type='maintenance' and r.status in ('sent','received')
  and r.quantity>r.tested_quantity and l.status='active' and l.list_type='maintenance';
$$;
revoke all on function public.hems_open_repair_quantity(text,uuid) from public,anon;
grant execute on function public.hems_open_repair_quantity(text,uuid) to authenticated;

create or replace function public.hems_repair_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
 if auth.uid() is null then raise exception 'You must be signed in.' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
   'id',r.id,'list_id',r.list_id,'parent_record_id',r.parent_record_id,
   'inventory_record_type',r.inventory_record_type,'inventory_record_id',r.inventory_record_id,
   'reference',l.reference,'quantity',r.quantity-r.tested_quantity,
   'phase',case when r.status='received' and r.received_quantity>r.tested_quantity then 'received' else 'sent' end,
   'label',case when r.status='received' and r.received_quantity>r.tested_quantity
     then 'Received · Awaiting Testing'
     else 'At '||coalesce(nullif(btrim(l.repair_company),''),nullif(btrim(r.metadata->>'repair_company'),''),'External Company')||' for Repair' end,
   'stock_conflict',case when r.inventory_record_type='unit' then
     not public.hems_repair_unit_is_consistent(r.id)
     or not exists(select 1 from public.units u where u.id=r.inventory_record_id and u.status='maintenance')
     when r.inventory_record_type='matrix_model' then not exists(select 1 from public.matrix_models m
       where m.id=r.inventory_record_id and coalesce(m.maintenance_qty,0)>=public.hems_open_repair_quantity('matrix_model',m.id))
     else not exists(select 1 from public.matrix_rows mr
       where mr.id=r.inventory_record_id and coalesce(mr.maintenance_qty,0)>=public.hems_open_repair_quantity('matrix_row',mr.id)) end
 ) order by r.created_at,r.id)
 from public.maintenance_requests r join public.equipment_lists l on l.id=r.list_id
 where r.source_type='maintenance' and r.status in ('sent','received')
   and r.quantity>r.tested_quantity and l.status='active' and l.list_type='maintenance'),'[]'::jsonb);
end;
$$;
revoke all on function public.hems_repair_status() from public,anon;
grant execute on function public.hems_repair_status() to authenticated;

-- Direct report saves cannot override a unit's workflow status.
-- SECURITY INVOKER is intentional: trusted workflow RPCs execute as their owner.
create or replace function public.hems_guard_repair_unit_status()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
 if current_user in ('authenticated','anon') and new.status is distinct from old.status
    and public.hems_unit_has_open_repair(old.id) then
   raise exception 'This unit has an active repair. Use Received, then Tested, to change its status.';
 end if;
 return new;
end;
$$;
revoke all on function public.hems_guard_repair_unit_status() from public,anon,authenticated;
drop trigger if exists hems_guard_repair_unit_status on public.units;
create trigger hems_guard_repair_unit_status before update of status on public.units
for each row execute function public.hems_guard_repair_unit_status();

-- Also reject selecting a legacy incorrectly-Available repair unit into an outgoing draft.
create or replace function public.hems_guard_repair_outgoing_item()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_type text;
begin
 if tg_op='UPDATE' then
  if new.inventory_record_type is not distinct from old.inventory_record_type
    and new.inventory_record_id is not distinct from old.inventory_record_id
    and new.list_id is not distinct from old.list_id
    and new.requested_quantity is not distinct from old.requested_quantity then return new; end if;
 end if;
 select list_type::text into v_type from public.equipment_lists where id=new.list_id;
 if new.inventory_record_type='unit' and v_type not in ('maintenance','transfer_in') then
  perform 1 from public.units where id=new.inventory_record_id for update;
  if public.hems_unit_has_open_repair(new.inventory_record_id) then
   raise exception 'This unit is at repair or awaiting testing. It cannot be added to an outgoing list.';
  end if;
 end if;
 return new;
end;
$$;
revoke all on function public.hems_guard_repair_outgoing_item() from public,anon,authenticated;
drop trigger if exists hems_guard_repair_outgoing_item on public.equipment_list_items;
create trigger hems_guard_repair_outgoing_item before insert or update on public.equipment_list_items
for each row execute function public.hems_guard_repair_outgoing_item();

create or replace function public.hems_guard_repair_quantity()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_type text;
begin
 if current_user in ('authenticated','anon') then
  v_type:=case when tg_table_name='matrix_models' then 'matrix_model' else 'matrix_row' end;
  if coalesce(new.maintenance_qty,0)<public.hems_open_repair_quantity(v_type,old.id) then
   raise exception 'This quantity is in an active repair. Use Received, then Tested.';
  end if;
 end if;
 return new;
end;
$$;
revoke all on function public.hems_guard_repair_quantity() from public,anon,authenticated;
drop trigger if exists hems_guard_repair_quantity on public.matrix_models;
create trigger hems_guard_repair_quantity before update of maintenance_qty on public.matrix_models
for each row execute function public.hems_guard_repair_quantity();
drop trigger if exists hems_guard_repair_quantity on public.matrix_rows;
create trigger hems_guard_repair_quantity before update of maintenance_qty on public.matrix_rows
for each row execute function public.hems_guard_repair_quantity();

-- Preserve the physical record while its external repair is still open.
create or replace function public.hems_guard_open_repair_delete()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.maintenance_requests r join public.equipment_lists l on l.id=r.list_id
   where r.source_type='maintenance' and r.status in ('sent','received') and r.quantity>r.tested_quantity
    and l.status='active' and l.list_type='maintenance'
    and ((tg_table_name='units' and r.inventory_record_type='unit' and r.inventory_record_id=old.id)
      or (tg_table_name='matrix_rows' and r.inventory_record_type='matrix_row' and r.inventory_record_id=old.id)
      or (tg_table_name='matrix_models' and (r.parent_record_id=old.id or (r.inventory_record_type='matrix_model' and r.inventory_record_id=old.id)))
      or (tg_table_name='items' and r.inventory_record_type='unit' and r.parent_record_id=old.id))) then
  raise exception 'This equipment has an active repair. Receive and test it before deleting its stock record.';
 end if;
 return old;
end;
$$;
revoke all on function public.hems_guard_open_repair_delete() from public,anon,authenticated;
drop trigger if exists hems_guard_open_repair_delete on public.units;
create trigger hems_guard_open_repair_delete before delete on public.units
for each row execute function public.hems_guard_open_repair_delete();
drop trigger if exists hems_guard_open_repair_delete on public.items;
create trigger hems_guard_open_repair_delete before delete on public.items
for each row execute function public.hems_guard_open_repair_delete();
drop trigger if exists hems_guard_open_repair_delete on public.matrix_models;
create trigger hems_guard_open_repair_delete before delete on public.matrix_models
for each row execute function public.hems_guard_open_repair_delete();
drop trigger if exists hems_guard_open_repair_delete on public.matrix_rows;
create trigger hems_guard_open_repair_delete before delete on public.matrix_rows
for each row execute function public.hems_guard_open_repair_delete();

-- A direct request edit must not bypass the stock transition in the action RPC.
create or replace function public.hems_guard_repair_request_update()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if current_user in ('authenticated','anon') and (old.source_type='maintenance' or new.source_type='maintenance') then
  raise exception 'Use the maintenance Received/Tested actions to update this repair request.';
 end if;
 return new;
end;
$$;
revoke all on function public.hems_guard_repair_request_update() from public,anon,authenticated;
drop trigger if exists hems_guard_repair_request_update on public.maintenance_requests;
create trigger hems_guard_repair_request_update before update on public.maintenance_requests
for each row execute function public.hems_guard_repair_request_update();

-- Repair existing safe Available flags only. In Use/KSA/missing/mismatched records are untouched.
update public.units u set status='maintenance'
where u.status='available' and exists (
 select 1 from public.maintenance_requests r join public.equipment_lists l on l.id=r.list_id
 where r.inventory_record_type='unit' and r.inventory_record_id=u.id
   and r.source_type='maintenance' and r.status in ('sent','received')
   and r.quantity>r.tested_quantity and l.status='active' and l.list_type='maintenance'
   and public.hems_repair_unit_is_consistent(r.id)
);

-- Track unresolved stock per LED issue separately from the historical issue quantity.
-- This prevents a notes/photo edit from restoring already-tested Maintenance stock.
alter table public.led_maintenance_logs add column if not exists stock_quantity integer;
with ordered as (
 select x.id,x.qty,r.maintenance_qty,
 coalesce(sum(case when x.problem_type not in ('damaged_housing','hub_card_problem') then greatest(0,x.qty) else 0 end)
 over(partition by x.matrix_row_id order by x.created_at,x.id rows between unbounded preceding and 1 preceding),0) as prior_qty,
 x.problem_type
 from public.led_maintenance_logs x join public.matrix_rows r on r.id=x.matrix_row_id
)
update public.led_maintenance_logs x set stock_quantity=case
 when o.problem_type in ('damaged_housing','hub_card_problem') then 0
 else greatest(0,least(o.qty,coalesce(o.maintenance_qty,0)-o.prior_qty)) end
from ordered o where x.id=o.id and x.stock_quantity is null;
alter table public.led_maintenance_logs alter column stock_quantity set default 0;
alter table public.led_maintenance_logs alter column stock_quantity set not null;

-- Atomic report stock changes. Preserve In Use/KSA; prevent consuming active repair stock.
create or replace function public.hems_led_issue_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_row uuid; v_old integer:=0;v_new integer:=0;v_delta integer;v_floor integer;
 v_stock public.matrix_rows%rowtype;v_old_qty integer:=0;v_new_qty integer:=0;
begin
 if tg_op<>'INSERT' then v_row:=old.matrix_row_id;v_old:=old.stock_quantity;
  if old.problem_type not in ('damaged_housing','hub_card_problem') then v_old_qty:=greatest(0,old.qty); end if;
 end if;
 if tg_op<>'DELETE' then
  if tg_op='UPDATE' and new.matrix_row_id is distinct from old.matrix_row_id then
   raise exception 'An LED issue cannot be moved to a different stock row.';
  end if;
  v_row:=new.matrix_row_id;
  if new.problem_type not in ('damaged_housing','hub_card_problem') then v_new_qty:=greatest(0,new.qty); end if;
  -- Internal Tested updates only stock_quantity, never historical problem qty.
  if tg_op='UPDATE' and new.stock_quantity is distinct from old.stock_quantity then
   if current_setting('hems.testing_led_stock',true)='on' then return new; end if;
  end if;
  v_new:=greatest(0,v_old+v_new_qty-v_old_qty);
  new.stock_quantity:=v_new;
 end if;
 v_delta:=v_new-v_old;
 if v_delta<>0 then
  select * into v_stock from public.matrix_rows where id=v_row for update;
  if not found then
   if tg_op='DELETE' then return old; end if;
   raise exception 'The LED stock row no longer exists.';
  end if;
  select coalesce(sum(r.quantity-r.tested_quantity),0)::integer into v_floor
   from public.maintenance_requests r join public.equipment_lists l on l.id=r.list_id
   where r.inventory_record_type='matrix_row' and r.inventory_record_id=v_row
    and r.source_type='maintenance' and r.status in ('sent','received') and l.status='active';
  if coalesce(v_stock.maintenance_qty,0)+v_delta<v_floor then
   raise exception 'This LED quantity is in an active repair. Use Received, then Tested.';
  end if;
  if v_delta>0 and v_delta>greatest(0,coalesce(v_stock.qty,0)-coalesce(v_stock.in_use_qty,0)-coalesce(v_stock.in_ksa_qty,0)-coalesce(v_stock.maintenance_qty,0)) then
   raise exception 'The report quantity exceeds the available LED stock.';
  end if;
  update public.matrix_rows set maintenance_qty=greatest(0,coalesce(maintenance_qty,0)+v_delta),
    available_qty=greatest(0,coalesce(qty,0)-coalesce(in_use_qty,0)-coalesce(in_ksa_qty,0)-greatest(0,coalesce(maintenance_qty,0)+v_delta))
  where id=v_row;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
revoke all on function public.hems_led_issue_stock() from public,anon,authenticated;
drop trigger if exists hems_led_issue_stock on public.led_maintenance_logs;
create trigger hems_led_issue_stock before insert or update or delete on public.led_maintenance_logs
for each row execute function public.hems_led_issue_stock();

create or replace function public.receive_maintenance_list_item(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests%rowtype;l public.equipment_lists%rowtype;
 v_list_id uuid;v_now timestamptz:=now();v_name text;
begin
 if auth.uid() is null then raise exception 'You must be signed in.' using errcode='42501'; end if;
 if public.is_equipment_list_manager() is not true then
  raise exception 'Only Warehouse or Admin can receive repaired equipment.' using errcode='42501'; end if;
 select list_id into v_list_id from public.maintenance_requests where id=p_request_id and source_type='maintenance';
 if not found then raise exception 'Maintenance request not found.' using errcode='P0002'; end if;
 -- Parent before request: sibling Receive/Test operations serialize without opposite lock order.
 select * into l from public.equipment_lists where id=v_list_id for update;
 select * into r from public.maintenance_requests where id=p_request_id and list_id=v_list_id for update;
 if not found then raise exception 'Maintenance request not found.'; end if;
 if r.status='resolved' then return jsonb_build_object('request_id',r.id,'status',r.status,'received_quantity',r.received_quantity); end if;
 if l.list_type<>'maintenance' or l.status<>'active' or r.status not in ('sent','received') then
  raise exception 'This maintenance list is not Active.'; end if;
 if r.inventory_record_type='unit' then
  perform public.hems_lock_repair_unit(r.id);
  update public.units set status='maintenance' where id=r.inventory_record_id and status='available';
 end if;
 if r.status='received' and r.received_quantity=r.quantity then
  return jsonb_build_object('request_id',r.id,'status',r.status,'received_quantity',r.received_quantity);
 end if;
 update public.maintenance_requests set received_quantity=quantity,received_at=coalesce(received_at,v_now),
  received_by=auth.uid(),status='received',updated_at=v_now where id=r.id;
 select nullif(btrim(full_name),'') into v_name from public.profiles where id=auth.uid();
 insert into public.equipment_list_activity(list_id,action,message,actor_id,actor_name,details)
 values(l.id,'maintenance_received',r.display_name||' received from repair; awaiting test',auth.uid(),coalesce(v_name,'Warehouse Manager'),
  jsonb_build_object('maintenance_request_id',r.id,'quantity',r.quantity));
 return jsonb_build_object('request_id',r.id,'status','received','received_quantity',r.quantity);
end;
$$;

create or replace function public.test_maintenance_list_item(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.maintenance_requests%rowtype;l public.equipment_lists%rowtype;
 v_list_id uuid;v_qty integer;v_floor integer;v_now timestamptz:=now();v_name text;v_status text;
 v_model public.matrix_models%rowtype;v_row public.matrix_rows%rowtype;
 v_log record;v_left integer;v_take integer;v_remaining boolean;
begin
 if auth.uid() is null then raise exception 'You must be signed in.' using errcode='42501'; end if;
 select list_id into v_list_id from public.maintenance_requests where id=p_request_id and source_type='maintenance';
 if not found then raise exception 'Maintenance request not found.' using errcode='P0002'; end if;
 select * into l from public.equipment_lists where id=v_list_id for update;
 select * into r from public.maintenance_requests where id=p_request_id and list_id=v_list_id for update;
 if not found then raise exception 'Maintenance request not found.'; end if;
 if public.can_complete_maintenance_request(r.department) is not true then
  raise exception 'Only Admin or the relevant department Head can confirm testing.' using errcode='42501'; end if;
 if r.status='resolved' then return jsonb_build_object('request_id',r.id,'status',r.status,'tested_quantity',r.tested_quantity,'list_status',l.status); end if;
 if l.list_type<>'maintenance' or l.status<>'active' then raise exception 'This maintenance list is not Active.'; end if;
 if r.status<>'received' then raise exception 'Warehouse must mark this item Received before testing.'; end if;
 v_qty:=r.received_quantity-r.tested_quantity;
 if v_qty<=0 then raise exception 'There is no received quantity waiting for test.'; end if;
 if r.inventory_record_type='unit' then
  perform public.hems_lock_repair_unit(r.id);
  update public.units set status='available' where id=r.inventory_record_id and status='maintenance';
 else
  if r.inventory_record_type='matrix_model' then
   select * into v_model from public.matrix_models where id=r.inventory_record_id for update;
   if not found then raise exception 'The Matrix item no longer exists.'; end if;
  else
   -- Issue edits lock their log before the stock row; use the same order here.
   perform 1 from public.led_maintenance_logs where matrix_row_id=r.inventory_record_id order by created_at,id for update;
   select * into v_row from public.matrix_rows where id=r.inventory_record_id for update;
   if not found then raise exception 'The Matrix row no longer exists.'; end if;
  end if;
  select coalesce(sum(m.quantity-m.tested_quantity),0)::integer into v_floor
   from public.maintenance_requests m join public.equipment_lists ml on ml.id=m.list_id
   where m.source_type='maintenance' and m.status in ('sent','received') and ml.status='active'
    and m.inventory_record_type=r.inventory_record_type and m.inventory_record_id=r.inventory_record_id;
  if (case when r.inventory_record_type='matrix_model' then coalesce(v_model.maintenance_qty,0) else coalesce(v_row.maintenance_qty,0) end)<v_floor then
   raise exception 'Repair / stock mismatch. Maintenance quantity is lower than outstanding repair quantities. Please review the stock.';
  end if;
  if r.inventory_record_type='matrix_model' then
   update public.matrix_models set maintenance_qty=maintenance_qty-v_qty where id=r.inventory_record_id;
  else
   update public.matrix_rows set maintenance_qty=maintenance_qty-v_qty,
    available_qty=case when coalesce(r.metadata#>>'{equipment_metadata,matrix_source}','')='generic' then available_qty
      else greatest(0,coalesce(qty,0)-coalesce(in_use_qty,0)-coalesce(in_ksa_qty,0)-(maintenance_qty-v_qty)) end
   where id=r.inventory_record_id;
   -- Historical LED issues remain visible; only their unresolved stock portion is consumed.
   v_left:=v_qty;
   perform pg_catalog.set_config('hems.testing_led_stock','on',true);
   for v_log in select id,stock_quantity from public.led_maintenance_logs
     where matrix_row_id=r.inventory_record_id and stock_quantity>0 order by created_at,id for update
   loop
    exit when v_left<=0;
    v_take:=least(v_left,v_log.stock_quantity);
    update public.led_maintenance_logs set stock_quantity=stock_quantity-v_take where id=v_log.id;
    v_left:=v_left-v_take;
   end loop;
   perform pg_catalog.set_config('hems.testing_led_stock','off',true);
  end if;
 end if;
 v_status:=case when r.received_quantity>=r.quantity then 'resolved' else 'sent' end;
 update public.maintenance_requests set tested_quantity=received_quantity,tested_at=v_now,tested_by=auth.uid(),
  status=v_status,resolved_at=case when v_status='resolved' then v_now else null end,updated_at=v_now where id=r.id;
 select exists(select 1 from public.maintenance_requests where list_id=l.id and source_type='maintenance' and status<>'resolved') into v_remaining;
 if not v_remaining then update public.equipment_lists set status='closed',closed_at=v_now,updated_at=v_now where id=l.id; end if;
 select nullif(btrim(full_name),'') into v_name from public.profiles where id=auth.uid();
 insert into public.equipment_list_activity(list_id,action,message,actor_id,actor_name,details)
 values(l.id,'maintenance_tested',r.display_name||' tested and returned to Available',auth.uid(),coalesce(v_name,'Department Head'),
  jsonb_build_object('maintenance_request_id',r.id,'quantity',v_qty,'list_closed',not v_remaining));
 return jsonb_build_object('request_id',r.id,'status',v_status,'tested_quantity',r.received_quantity,'list_status',case when v_remaining then 'active' else 'closed' end);
end;
$$;
revoke all on function public.receive_maintenance_list_item(uuid) from public,anon;
revoke all on function public.test_maintenance_list_item(uuid) from public,anon;
grant execute on function public.receive_maintenance_list_item(uuid) to authenticated;
grant execute on function public.test_maintenance_list_item(uuid) to authenticated;

-- Live phase updates also work if the earlier notification migration was not applied.
do $$
declare v_table text;
begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  foreach v_table in array array['maintenance_requests','equipment_lists'] loop
   if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=v_table) then
    execute format('alter publication supabase_realtime add table public.%I',v_table);
   end if;
  end loop;
 end if;
end;
$$;

notify pgrst,'reload schema';
commit;

-- Remaining mismatches are deliberately not forced Available or Maintenance.
select l.reference as list,r.inventory_record_id as unit_id,u.status as stock_status,
 r.status as repair_phase,r.serial_number as repair_serial,u.serial as stock_serial
from public.maintenance_requests r join public.equipment_lists l on l.id=r.list_id
left join public.units u on u.id=r.inventory_record_id
where r.source_type='maintenance' and r.inventory_record_type='unit'
 and r.status in ('sent','received') and r.quantity>r.tested_quantity
 and l.status='active' and l.list_type='maintenance'
 and (not public.hems_repair_unit_is_consistent(r.id) or u.status is distinct from 'maintenance');

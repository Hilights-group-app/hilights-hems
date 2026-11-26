-- Dated planning for Local Event and Dry Hire, including dispatched bookings.
-- Run this file ONLY. Does not receive, dispatch or rewrite inventory/history.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
lock table public.equipment_lists, public.equipment_list_items in share row exclusive mode;

do $guard$ declare f record; actual text; begin
  for f in select * from (values
    ('public.hems_assert_outgoing_reservation(text,uuid,bigint,uuid,text)','56e8e623cb22ac2c3f19eaa6d4007520'),
    ('public.hems_assert_outgoing_window(text,uuid,bigint,uuid,text,daterange)','91eb3dc3c5960d62ff530e02d62c5762'),
    ('public.hems_dated_pending_reservations(uuid)','45c5b844d7d9622d082c38dee4f0ffe1'),
    ('public.hems_guard_draft_matrix_quantity()','9755de4576726414100eab4e804c3594'),
    ('public.hems_guard_pending_reservation()','4beb66d37813fcfcc7068b9bbb29f91e'),
    ('public.hems_guard_reserved_list_item()','4300d7ec6a6fa7b598a47516bfec2762'),
    ('public.approve_and_dispatch_equipment_list(uuid)','d11529ce3ad8a63763a35be8321fa2c3'),
    ('public.hems_dispatch_list_addition()','4877cf82f22199887394fa5f72230cc9')
  ) as expected(signature,hash) loop
    select md5(btrim(replace(p.prosrc,chr(13),''),E' \n\t')) into actual
      from pg_proc p where p.oid=to_regprocedure(f.signature);
    if actual is distinct from f.hash then
      raise exception 'Live function % changed. Stop and export it; do not bypass this guard.',f.signature;
    end if;
  end loop;
  if to_regprocedure('public.hems_assert_dispatch_reservation(text,uuid,bigint,uuid,text)') is null
    or to_regprocedure('public.hems_pending_reservation_labels(daterange)') is null then
    raise exception 'Install the date reservations and dated labels first.';
  end if;
end; $guard$;

-- One combined event sweep: peak Active+Pending, NOT sum of independent peaks.
-- Only affected records are returned; no per-item browser requests.
create or replace function public.hems_planning_stock(
  p_period daterange,p_exclude_pending uuid default null,p_type text default null,p_record uuid default null
) returns table(record_type text,record_id uuid,parent_id uuid,available bigint,physical_available bigint)
language sql volatile security definer set search_path='' as $$
  with allocations as materialized (
    select i.inventory_record_type::text as kind,i.inventory_record_id as rid,l.status::text as state,
      l.id as list_id,
      case when l.status::text='pending' then greatest(0,i.requested_quantity)
        else greatest(0,(case when i.approved_quantity>0 then i.approved_quantity else i.requested_quantity end)
          -coalesce(i.returned_ok_quantity,0)-coalesce(i.returned_maintenance_quantity,0)) end::bigint as qty,
      case when l.status::text='pending' then 0 else greatest(0,coalesce(i.missing_quantity,0)) end::bigint as missing,
      case when l.status::text='pending' then public.hems_reservation_period(to_jsonb(l),false)
        else public.hems_reservation_target_period(to_jsonb(l),false) end as span
    from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
    where (l.status::text='pending' and l.list_type::text in ('local_event','dry_hire','transfer_out','internal_use')
      or l.status::text in ('active','partially_returned') and l.list_type::text not in ('maintenance','transfer_in'))
      and i.inventory_record_type::text in ('unit','matrix_model','matrix_row')
      and coalesce(i.metadata->>'custom_item','false')<>'true'
      and (p_type is null or i.inventory_record_type::text=p_type)
      and (p_record is null or i.inventory_record_id=p_record)
  ), keys as (select distinct kind,rid from allocations), holdings as (
    select kind,rid,sum(qty) as occupied,sum(least(qty,missing)) as lost
      from allocations where state<>'pending' group by kind,rid
  ), stock as (
    select k.kind,k.rid,u.item_id as pid,
      case when coalesce(h.occupied,0)>1 then 0
        when u.expiry_date is not null and u.expiry_date < greatest(
          (now() at time zone 'Asia/Dubai')::date,
          coalesce(upper(p_period)-1,(now() at time zone 'Asia/Dubai')::date)) then 0
        when coalesce(u.status,'available')='available'
        or u.status='in_use' and coalesce(h.occupied,0)=1 then 1 else 0 end::bigint as capacity,
      case when coalesce(u.status,'available')='available'
        and (u.expiry_date is null or u.expiry_date >= (now() at time zone 'Asia/Dubai')::date)
        then 1 else 0 end::bigint as physical,
      coalesce(h.lost,0) as lost
      from keys k join public.units u on k.kind='unit' and u.id=k.rid
      left join holdings h on h.kind=k.kind and h.rid=k.rid
    union all
    select k.kind,k.rid,m.id,
      greatest(0,coalesce(m.total_qty,0)-coalesce(m.maintenance_qty,0)-coalesce(m.in_ksa_qty,0)
        -greatest(0,coalesce(m.in_use_qty,0)-coalesce(h.occupied,0)))::bigint,
      greatest(0,coalesce(m.total_qty,0)-coalesce(m.maintenance_qty,0)-coalesce(m.in_ksa_qty,0)-coalesce(m.in_use_qty,0))::bigint,
      coalesce(h.lost,0)
      from keys k join public.matrix_models m on k.kind='matrix_model' and m.id=k.rid
      left join holdings h on h.kind=k.kind and h.rid=k.rid
    union all
    select k.kind,k.rid,coalesce(r.item_id,r.model_id),
      greatest(0,(case when r.item_id is not null then coalesce(r.total_qty,0) else coalesce(r.qty,0) end)-coalesce(r.maintenance_qty,0)-coalesce(r.in_ksa_qty,0)
        -greatest(0,coalesce(r.in_use_qty,0)-coalesce(h.occupied,0)))::bigint,
      greatest(0,(case when r.item_id is not null then coalesce(r.total_qty,0) else coalesce(r.qty,0) end)-coalesce(r.maintenance_qty,0)-coalesce(r.in_ksa_qty,0)-coalesce(r.in_use_qty,0))::bigint,
      coalesce(h.lost,0)
      from keys k join public.matrix_rows r on k.kind='matrix_row' and r.id=k.rid
      left join holdings h on h.kind=k.kind and h.rid=k.rid
  ), clipped as (
    select kind,rid,span*p_period as span,
      case when state='pending' then qty else qty-least(qty,missing) end as qty
    from allocations where (state<>'pending' or p_exclude_pending is null or list_id<>p_exclude_pending)
      and span&&p_period
  ), events as (
    select kind,rid,coalesce(lower(span),'-infinity'::date) as day,qty as delta from clipped where not isempty(span)
    union all
    select kind,rid,coalesce(upper(span),'infinity'::date),-qty from clipped where not isempty(span)
  ), daily as (
    select kind,rid,day,sum(delta) as delta from events group by kind,rid,day
  ), running as (
    select kind,rid,sum(delta) over(partition by kind,rid order by day rows unbounded preceding) as used from daily
  ), peaks as (select kind,rid,greatest(0,max(used)) as used from running group by kind,rid)
  select s.kind,s.rid,s.pid,greatest(0,s.capacity-s.lost-coalesce(p.used,0))::bigint,s.physical
    from stock s left join peaks p on p.kind=s.kind and p.rid=s.rid;
$$;
revoke all on function public.hems_planning_stock(daterange,uuid,text,uuid) from public,anon,authenticated;

-- Planning-only assertion. Physical Dispatch and active additions keep using
-- their existing checks. The advisory lock serializes concurrent submissions.
create or replace function public.hems_assert_planned_outgoing_window(
  p_type text,p_record_id uuid,p_quantity bigint,p_exclude_list uuid,p_name text,p_period daterange
) returns void language plpgsql volatile security definer set search_path='' as $$
declare target jsonb; free bigint; capacity bigint; label text:=coalesce(p_name,p_record_id::text);
begin
  select to_jsonb(l) into target from public.equipment_lists l where id=p_exclude_list;
  if target is null or target->>'list_type' not in ('local_event','dry_hire')
    or target->>'status' not in ('draft','pending') then
    perform public.hems_assert_outgoing_window(p_type,p_record_id,p_quantity,p_exclude_list,p_name,p_period);
    return;
  end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Reservation changes require Read Committed isolation. Retry through the app.' using errcode='40001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  -- Locks/validates the stock row without changing it. Unknown in-use stock
  -- without an Active allocation remains unavailable, never forecast as free.
  free:=public.hems_outgoing_free_quantity(p_type,p_record_id);
  select s.available into capacity from public.hems_planning_stock(p_period,p_exclude_list,p_type,p_record_id) s;
  if capacity is null then
    select greatest(0,free-coalesce((select quantity from public.hems_pending_window_totals(
      p_period,p_exclude_list,p_type,p_record_id)),0)) into capacity;
  end if;
  if p_type='unit' then
    select label || ' · ID ' || coalesce(u.unit_no::text,u.id::text)
      || case when nullif(btrim(u.serial),'') is null then '' else ' · Serial ' || u.serial end
      into label from public.units u where u.id=p_record_id;
  end if;
  if p_quantity is null or p_quantity<1 or p_quantity>capacity or (p_type='unit' and p_quantity<>1) then
    raise exception 'Only % unit(s) are available for % on these dates. Requested: %.',capacity,label,p_quantity using errcode='23514';
  end if;
end; $$;
revoke all on function public.hems_assert_planned_outgoing_window(text,uuid,bigint,uuid,text,daterange) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION public.hems_assert_outgoing_reservation(p_type text, p_record_id uuid, p_quantity bigint, p_exclude_list uuid, p_name text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare target jsonb; span daterange:=daterange(null,null,'[]');
begin
  if p_exclude_list is not null then
    select to_jsonb(l) into target from public.equipment_lists l where id=p_exclude_list;
    if target is null then raise exception 'Equipment list not found.' using errcode='23514'; end if;
    span:=public.hems_reservation_target_period(target,true);
  end if;
  perform public.hems_assert_planned_outgoing_window(p_type,p_record_id,p_quantity,p_exclude_list,p_name,span);
end; $function$;

CREATE OR REPLACE FUNCTION public.hems_guard_pending_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare line record; span daterange;
begin
  if new.status::text<>'pending' or new.list_type::text not in ('local_event','dry_hire','transfer_out','internal_use') then return new; end if;
  if tg_op='INSERT' then raise exception 'Create a Draft before submitting equipment.' using errcode='23514'; end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  -- A BEFORE trigger must use NEW dates, not the old row still in the table.
  span:=public.hems_reservation_period(to_jsonb(new),true);
  if not exists(select 1 from public.equipment_list_items where list_id=new.id) then
    raise exception 'Add at least one item before submitting.' using errcode='23514'; end if;
  if exists(select 1 from public.equipment_list_items where list_id=new.id and (
    requested_quantity is null or requested_quantity<1 or
    (inventory_record_type::text='item' and coalesce(metadata->>'custom_item','false')<>'true') or
    (inventory_record_type::text<>'item' and coalesce(metadata->>'custom_item','false')='true')
  )) then raise exception 'Review invalid or incorrectly marked custom equipment before submitting.' using errcode='23514'; end if;
  for line in select inventory_record_type::text as kind,inventory_record_id,min(display_name) as name,sum(requested_quantity)::bigint as quantity
    from public.equipment_list_items where list_id=new.id and inventory_record_type::text<>'item'
    group by inventory_record_type,inventory_record_id order by inventory_record_type,inventory_record_id
  loop
    perform public.hems_assert_planned_outgoing_window(line.kind,line.inventory_record_id,line.quantity,new.id,line.name,span);
  end loop;
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public.hems_guard_draft_matrix_quantity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if parent.list_type::text in ('local_event','dry_hire') then
    select coalesce(sum(i.requested_quantity),0)+coalesce(new.requested_quantity,0) into requested_quantity
      from public.equipment_list_items i where i.list_id=new.list_id
        and i.inventory_record_type=new.inventory_record_type and i.inventory_record_id=new.inventory_record_id
        and i.id is distinct from new.id;
    perform public.hems_assert_planned_outgoing_window(new.inventory_record_type::text,new.inventory_record_id,
      requested_quantity::bigint,new.list_id,new.display_name,public.hems_reservation_period(to_jsonb(parent),true));
    return new;
  end if;
  if parent.list_type::text<>'maintenance' then perform pg_catalog.pg_advisory_xact_lock(742193,1); end if;
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
  available_quantity := greatest(0, capacity - occupied - case when parent.list_type::text='maintenance' then 0
    else public.hems_pending_reserved_quantity(new.inventory_record_type::text,new.inventory_record_id,new.list_id) end);
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
$function$;

CREATE OR REPLACE FUNCTION public.hems_dated_pending_reservations(p_list_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare target jsonb; span daterange; result jsonb; planning jsonb:='{"enabled":false,"rows":[]}'::jsonb; today date:=(now() at time zone 'Asia/Dubai')::date;
begin
  if auth.uid() is null then raise exception 'Sign in to read availability.' using errcode='42501'; end if;
  if p_list_id is not null then
    select to_jsonb(l) into target from public.equipment_lists l where id=p_list_id and public.hems_can_view_equipment_list(l.id);
    if target is null then raise exception 'This list is no longer available to you.' using errcode='42501'; end if;
    span:=public.hems_reservation_target_period(target,true);
  else span:=daterange(today,today,'[]'); end if;
  select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into result from (
    select p.record_type,p.record_id,
      case when p.record_type='unit' then u.item_id when p.record_type='matrix_row' then coalesce(m.item_id,m.model_id) else p.record_id end as parent_id,
      p.quantity,case when p.record_type<>'unit' or coalesce(u.status::text,'available')='available' then p.quantity else 0 end as available_quantity
    from public.hems_pending_window_totals(span,null) p
    left join public.units u on p.record_type='unit' and u.id=p.record_id
    left join public.matrix_rows m on p.record_type='matrix_row' and m.id=p.record_id
    where p.quantity>0
  ) t;
  if target->>'list_type' in ('local_event','dry_hire') and target->>'status' in ('draft','pending') then
    select jsonb_build_object('enabled',true,'rows',coalesce(jsonb_agg(jsonb_build_object(
      'record_type',a.record_type,'record_id',a.record_id,'parent_id',a.parent_id,
      'available',a.available,'own_available',b.available,'physical_available',a.physical_available)),'[]'::jsonb))
      into planning
      from public.hems_planning_stock(span,null) a
      join public.hems_planning_stock(span,p_list_id) b using(record_type,record_id);
  end if;
  return jsonb_build_object('planning',planning,'version',1,'rows',result,'period',jsonb_build_object('start',lower(span),'end',upper(span)-1),'labels',public.hems_pending_reservation_labels(span));
end; $function$;


-- Private helpers above remain callable only through authorized guards/RPC.
revoke all on function public.hems_dated_pending_reservations(uuid) from public,anon;
grant execute on function public.hems_dated_pending_reservations(uuid) to authenticated;
-- Include the previously requested Admin-only Dry Hire name/date editor.
-- Guard its shared permission hook before adding the narrowly scoped rule.
do $header_guard$ declare actual text; begin
  select md5(btrim(replace(p.prosrc,chr(13),''),E' \n\t')) into actual from pg_proc p
    where p.oid=to_regprocedure('public.hems_guard_equipment_draft_sharing()');
  if actual is distinct from 'a34bfbec374591225c73b818c6210f1a' then
    raise exception 'Dry Hire header permission guard changed. Stop and export hems_guard_equipment_draft_sharing; do not bypass.';
  end if;
end; $header_guard$;
-- Private, read-only active-period conflict check. Physical stock remains held
-- until Received; changing a planned Return Date never creates availability.
create or replace function public.hems_check_dry_hire_header_dates(p_list jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
declare span daterange; line record; free bigint; reserved bigint; target_list_id uuid:=(p_list->>'id')::uuid;
begin
  if p_list->>'list_type' is distinct from 'dry_hire' then raise exception 'Choose a Dry Hire list.' using errcode='23514'; end if;
  span:=public.hems_reservation_target_period(p_list,true);
  if p_list->>'status' not in ('active','partially_returned') then return; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Retry through the app using Read Committed isolation.' using errcode='40001'; end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  for line in select i.inventory_record_type::text as kind,i.inventory_record_id,min(i.display_name) as name
    from public.equipment_list_items i where i.list_id=target_list_id and i.inventory_record_type::text<>'item'
      and coalesce(i.approved_quantity,0)>coalesce(i.returned_ok_quantity,0)+coalesce(i.returned_maintenance_quantity,0)
    group by i.inventory_record_type,i.inventory_record_id order by i.inventory_record_type,i.inventory_record_id
  loop
    -- Own dispatched equipment is ALREADY deducted from physical free stock.
    -- Other overlapping Pending demand must fit the remaining physical stock.
    free:=public.hems_outgoing_free_quantity(line.kind,line.inventory_record_id);
    select t.quantity into reserved from public.hems_pending_window_totals(span,target_list_id,line.kind,line.inventory_record_id) t;
    if coalesce(reserved,0)>free then
      raise exception 'These dates conflict with another Pending reservation for %. Only % free; % reserved in the new period.',line.name,free,reserved using errcode='23514';
    end if;
  end loop;
end; $$;
revoke all on function public.hems_check_dry_hire_header_dates(jsonb) from public,anon,authenticated;

-- Extend the existing direct-update guard; do not rely only on a hidden button.
-- Preserve every existing creator, sharing, Local Event and Submit check.
do $sharing$ declare definition text; needle text:=$needle$  if tg_op = 'UPDATE' then$needle$;
begin
  definition:=pg_get_functiondef('public.hems_guard_equipment_draft_sharing()'::regprocedure);
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Draft-sharing guard structure changed. Stop and export it.'; end if;
  execute replace(definition,needle,needle || $insert$
    -- Submitted Dry Hire header: only Admin, including direct API updates.
    if old.list_type::text='dry_hire' and old.status::text<>'draft'
      and (new.client_company is distinct from old.client_company
        or new.pickup_date is distinct from old.pickup_date or new.return_date is distinct from old.return_date) then
      if public.hems_current_user_role() is distinct from 'admin' then
        raise exception 'Only Admin can edit submitted Dry Hire name or dates.' using errcode='42501'; end if;
      if new.pickup_date is distinct from old.pickup_date or new.return_date is distinct from old.return_date then
        perform public.hems_check_dry_hire_header_dates(to_jsonb(new));
      end if;
    end if;
$insert$);
end; $sharing$;

-- A name-only save cannot reserve or release equipment. Avoid a false stock
-- conflict while renaming. Date/quantity/status edits still use the FULL guard.
do $pending$ declare definition text;
  needle text:=$needle$  perform pg_catalog.pg_advisory_xact_lock(742193,1);$needle$;
begin
  definition:=pg_get_functiondef('public.hems_guard_pending_reservation()'::regprocedure);
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'Pending guard structure changed. Stop and export it.'; end if;
  execute replace(definition,needle,$insert$  if old.list_type::text='dry_hire' and old.status::text='pending' and new.status::text='pending'
    and (to_jsonb(new)-'client_company'-'updated_at') is not distinct from (to_jsonb(old)-'client_company'-'updated_at') then
    return new;
  end if;
$insert$ || needle);
end; $pending$;

create or replace function public.hems_edit_dry_hire_header(
  p_list_id uuid,p_client_company text,p_pickup_date date,p_return_date date,
  p_expected_name text,p_expected_pickup date,p_expected_return date,p_expected_status text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare parent public.equipment_lists%rowtype; caller uuid:=auth.uid(); actor text;
  company text:=btrim(coalesce(p_client_company,''));
begin
  if caller is null or public.hems_current_user_role() is distinct from 'admin' then
    raise exception 'Only Admin can edit submitted Dry Hire name or dates.' using errcode='42501'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Retry through the app using Read Committed isolation.' using errcode='40001'; end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  select * into parent from public.equipment_lists where id=p_list_id and public.hems_can_view_equipment_list(id) for update;
  if not found or parent.list_type::text<>'dry_hire' then raise exception 'This Dry Hire list is unavailable.' using errcode='42501'; end if;
  if parent.status::text not in ('pending','active','partially_returned','closed') then
    raise exception 'Edit this header only after Submit.' using errcode='23514'; end if;
  if parent.status::text is distinct from p_expected_status or parent.client_company is distinct from p_expected_name
    or parent.pickup_date is distinct from p_expected_pickup or parent.return_date is distinct from p_expected_return then
    raise exception 'Name, dates or status changed. Refresh the list before editing.' using errcode='40001'; end if;
  if length(company)<1 or length(company)>200 then raise exception 'Enter a client/company name from 1 to 200 characters.' using errcode='23514'; end if;
  if p_pickup_date is null or p_return_date is null or not isfinite(p_pickup_date) or not isfinite(p_return_date) or p_return_date<p_pickup_date then
    raise exception 'Enter valid Pickup and Return dates (Return on or after Pickup).' using errcode='22007'; end if;
  if parent.client_company is distinct from company or parent.pickup_date is distinct from p_pickup_date or parent.return_date is distinct from p_return_date then
    -- Pending date edits are checked using NEW dates by the existing guard;
    -- Active date edits are checked by the private helper above.
    update public.equipment_lists set client_company=company,pickup_date=p_pickup_date,return_date=p_return_date,updated_at=now() where id=parent.id;
    select nullif(btrim(full_name),'') into actor from public.profiles where id=caller;
    insert into public.equipment_list_activity(list_id,action,message,actor_id,actor_name,details)
      values(parent.id,'dry_hire_details_updated',parent.reference || ' Dry Hire name/dates updated',caller,coalesce(actor,'Admin'),
        jsonb_build_object('old_client_company',parent.client_company,'new_client_company',company,
          'old_pickup_date',parent.pickup_date,'new_pickup_date',p_pickup_date,'old_return_date',parent.return_date,'new_return_date',p_return_date));
  end if;
  return jsonb_build_object('id',parent.id,'client_company',company,'pickup_date',p_pickup_date,'return_date',p_return_date,'status',parent.status);
end; $$;
revoke all on function public.hems_edit_dry_hire_header(uuid,text,date,date,text,date,date,text) from public,anon;
grant execute on function public.hems_edit_dry_hire_header(uuid,text,date,date,text,date,date,text) to authenticated;

notify pgrst,'reload schema';
commit;

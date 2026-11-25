-- DATE-BASED PENDING RESERVATIONS v1. Run the matching preflight first.
-- No stock, list lines, dates, permissions or dispatched workflow are rewritten.
-- Dubai calendar days. Both endpoints included. Missing/invalid legacy dates
-- are conservatively unbounded; new dated reservations require both dates.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
lock table public.equipment_lists,public.equipment_list_items in share row exclusive mode;

-- Guard against replacing a function that differs from the supplied project.
-- Exact expected bodies are generated in the companion guard block below.
do $guard$ declare fn record; actual text; begin
  for fn in select * from (values
    ('public.hems_pending_reserved_quantity(text,uuid,uuid)','9e2f0097e243345713eb09ea12276e2b'),
    ('public.hems_assert_outgoing_reservation(text,uuid,bigint,uuid,text)','6325a081eceaadb5780e4f96a492d6f9'),
    ('public.hems_guard_pending_reservation()','b46a78e2fcf05f3a4296e982761e9da9'),
    ('public.hems_pending_reservations()','e505e34675e0657696fbec6402259ebe'),
    ('public.hems_outgoing_free_quantity(text,uuid)','1dbc1aee80f853bc8b25a5a664267f0e'),
    ('public.hems_guard_reserved_list_item()','4300d7ec6a6fa7b598a47516bfec2762'),
    ('public.hems_guard_draft_matrix_quantity()','9755de4576726414100eab4e804c3594'),
    ('public.approve_and_dispatch_equipment_list(uuid)','fe49d64fd08bb5891db4ddc93209b697'),
    ('public.hems_dispatch_list_addition()','4877cf82f22199887394fa5f72230cc9')
  ) as expected(signature,hash) loop
    select md5(btrim(replace(p.prosrc,chr(13),''),E' \n\t')) into actual from pg_proc p where p.oid=to_regprocedure(fn.signature);
    if actual is distinct from fn.hash then raise exception 'Live function % differs from the supplied source. Stop and export its definition; do not bypass this guard.',fn.signature; end if;
  end loop;
end; $guard$;

create or replace function public.hems_reservation_period(p_list jsonb,p_require_dates boolean default false)
returns daterange language plpgsql immutable set search_path='' as $$
declare first_day date; last_day date; kind text:=p_list->>'list_type';
begin
  if kind not in ('local_event','dry_hire') or kind is null then return daterange(null,null,'[]'); end if;
  if kind='local_event' then
    first_day:=nullif(p_list->>'setup_date','')::date; last_day:=nullif(p_list->>'dismantling_date','')::date;
  else
    first_day:=nullif(p_list->>'pickup_date','')::date; last_day:=nullif(p_list->>'return_date','')::date;
  end if;
  if first_day is null or last_day is null or last_day<first_day
    or not isfinite(first_day) or not isfinite(last_day) then
    if p_require_dates then raise exception 'Enter valid start and end dates (end on or after start) before reserving equipment.' using errcode='22007'; end if;
    return daterange(null,null,'[]');
  end if;
  return daterange(first_day,last_day,'[]');
end; $$;

-- Real dispatch/additions hold equipment from TODAY even if sent early or
-- returned late. Do not let an outdated event date steal today's reservation.
create or replace function public.hems_reservation_target_period(p_list jsonb,p_require_dates boolean default false)
returns daterange language plpgsql volatile set search_path='' as $$
declare span daterange:=public.hems_reservation_period(p_list,p_require_dates);
  today date:=(now() at time zone 'Asia/Dubai')::date;
begin
  if p_list->>'status' in ('active','partially_returned') and not lower_inf(span) and not upper_inf(span) then
    span:=daterange(least(lower(span),today),greatest(upper(span),today+1),'[)');
  end if;
  return span;
end; $$;

-- Shared event-sweep calculation. Nonoverlapping Pending reservations are NOT
-- summed across a target period. Equal-day endings/starts are grouped first.
create or replace function public.hems_pending_window_totals(p_period daterange,p_exclude_list uuid default null,p_type text default null,p_record uuid default null)
returns table(record_type text,record_id uuid,quantity bigint)
language sql volatile security definer set search_path='' as $$
  with clipped as (
    select i.inventory_record_type::text as kind,i.inventory_record_id as rid,
      i.requested_quantity::bigint as qty,
      public.hems_reservation_period(to_jsonb(l),false)*p_period as span
    from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
    where l.status::text='pending' and l.list_type::text in ('local_event','dry_hire','transfer_out','internal_use')
      and i.inventory_record_type::text in ('unit','matrix_model','matrix_row')
      and (p_exclude_list is null or i.list_id<>p_exclude_list)
      and (p_type is null or i.inventory_record_type::text=p_type)
      and (p_record is null or i.inventory_record_id=p_record)
      and public.hems_reservation_period(to_jsonb(l),false)&&p_period
  ), events as (
    select kind,rid,coalesce(lower(span),'-infinity'::date) as day,qty as delta from clipped where not isempty(span)
    union all
    select kind,rid,coalesce(upper(span),'infinity'::date),-qty from clipped where not isempty(span)
  ), daily as (
    select kind,rid,day,sum(delta) as delta from events group by kind,rid,day
  ), running as (
    select kind,rid,sum(delta) over(partition by kind,rid order by day rows unbounded preceding) as used from daily
  )
  select kind,rid,greatest(0,max(used))::bigint from running group by kind,rid;
$$;

-- Keep this signature: existing draft guards, dispatch and active-additions
-- all call it. Derive dates from the target list rather than the browser.
create or replace function public.hems_pending_reserved_quantity(p_type text,p_record_id uuid,p_exclude_list uuid default null)
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare target jsonb; span daterange:=daterange(null,null,'[]'); result bigint;
begin
  if p_exclude_list is not null then
    select to_jsonb(l) into target from public.equipment_lists l where id=p_exclude_list;
    if target is null then raise exception 'Equipment list not found.' using errcode='23514'; end if;
    span:=public.hems_reservation_target_period(target,true);
  end if;
  select quantity into result from public.hems_pending_window_totals(span,p_exclude_list,p_type,p_record_id)
    where record_type=p_type and record_id=p_record_id;
  return coalesce(result,0);
end; $$;

create or replace function public.hems_assert_outgoing_window(
  p_type text,p_record_id uuid,p_quantity bigint,p_exclude_list uuid,p_name text,p_period daterange
) returns void language plpgsql volatile security definer set search_path='' as $$
declare free bigint; reserved bigint; usable bigint; label text;
begin
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Reservation changes require Read Committed isolation. Retry through the app.' using errcode='40001'; end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  free:=public.hems_outgoing_free_quantity(p_type,p_record_id);
  select quantity into reserved from public.hems_pending_window_totals(p_period,p_exclude_list,p_type,p_record_id)
    where record_type=p_type and record_id=p_record_id;
  reserved:=coalesce(reserved,0); usable:=greatest(0,free-reserved); label:=coalesce(p_name,p_record_id::text);
  if p_type='unit' then
    select label || ' · ID ' || coalesce(u.unit_no::text,u.id::text)
      || case when nullif(btrim(u.serial),'') is null then '' else ' · Serial ' || u.serial end
      into label from public.units u where u.id=p_record_id;
  end if;
  if p_quantity is null or p_quantity<1 or p_quantity>usable or (p_type='unit' and p_quantity<>1) then
    raise exception 'Only % available for %. Requested: %. Reserved in overlapping Pending lists: %.',usable,coalesce(label,p_name,p_record_id::text),p_quantity,reserved
      using errcode='23514',detail=jsonb_build_object('record_type',p_type,'record_id',p_record_id,
        'available',usable,'requested',p_quantity,'reserved',reserved,'period',p_period::text)::text;
  end if;
end; $$;

create or replace function public.hems_assert_outgoing_reservation(p_type text,p_record_id uuid,p_quantity bigint,p_exclude_list uuid,p_name text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare target jsonb; span daterange:=daterange(null,null,'[]');
begin
  if p_exclude_list is not null then
    select to_jsonb(l) into target from public.equipment_lists l where id=p_exclude_list;
    if target is null then raise exception 'Equipment list not found.' using errcode='23514'; end if;
    span:=public.hems_reservation_target_period(target,true);
  end if;
  perform public.hems_assert_outgoing_window(p_type,p_record_id,p_quantity,p_exclude_list,p_name,span);
end; $$;

create or replace function public.hems_assert_dispatch_reservation(p_type text,p_record_id uuid,p_quantity bigint,p_list_id uuid,p_name text)
returns void language plpgsql volatile security definer set search_path='' as $$
declare target jsonb;
begin
  select to_jsonb(l) into target from public.equipment_lists l where id=p_list_id;
  if target is null then raise exception 'Equipment list not found.' using errcode='23514'; end if;
  perform public.hems_assert_outgoing_window(p_type,p_record_id,p_quantity,p_list_id,p_name,
    public.hems_reservation_target_period(jsonb_set(target,'{status}','"active"'::jsonb),true));
end; $$;

create or replace function public.hems_guard_pending_reservation()
returns trigger language plpgsql security definer set search_path='' as $$
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
    perform public.hems_assert_outgoing_window(line.kind,line.inventory_record_id,line.quantity,new.id,line.name,span);
  end loop;
  return new;
end; $$;

-- Read-only dated availability. Caller must be able to view the selected list.
-- No other list IDs, references, event/client names or dates are returned.
create or replace function public.hems_dated_pending_reservations(p_list_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare target jsonb; span daterange; result jsonb; today date:=(now() at time zone 'Asia/Dubai')::date;
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
  return jsonb_build_object('version',1,'rows',result,'period',jsonb_build_object('start',lower(span),'end',upper(span)-1));
end; $$;

-- Stock PDF and older clients have a no-argument read: show TODAY, not all
-- future reservations combined. SQL guards still protect every target period.
create or replace function public.hems_pending_reservations()
returns jsonb language sql volatile security definer set search_path='' as $$
  select public.hems_dated_pending_reservations(null)->'rows';
$$;

revoke all on function public.hems_reservation_period(jsonb,boolean) from public,anon,authenticated;
revoke all on function public.hems_reservation_target_period(jsonb,boolean) from public,anon,authenticated;
revoke all on function public.hems_pending_window_totals(daterange,uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.hems_pending_reserved_quantity(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.hems_assert_outgoing_window(text,uuid,bigint,uuid,text,daterange) from public,anon,authenticated;
revoke all on function public.hems_assert_outgoing_reservation(text,uuid,bigint,uuid,text) from public,anon,authenticated;
revoke all on function public.hems_assert_dispatch_reservation(text,uuid,bigint,uuid,text) from public,anon,authenticated;
revoke all on function public.hems_guard_pending_reservation() from public,anon,authenticated;
revoke all on function public.hems_dated_pending_reservations(uuid) from public,anon;
grant execute on function public.hems_dated_pending_reservations(uuid) to authenticated;
revoke all on function public.hems_pending_reservations() from public,anon;
grant execute on function public.hems_pending_reservations() to authenticated;

-- Change precisely the reservation check; all original dispatch authorization,
-- physical stock, KSA, maintenance, activity and list-status logic stays intact.
do $dispatch$ declare definition text; needle text:='perform public.hems_assert_outgoing_reservation(v_line.kind,v_line.inventory_record_id,v_line.quantity,p_list_id,v_line.name);'; begin
  definition:=pg_get_functiondef('public.approve_and_dispatch_equipment_list(uuid)'::regprocedure);
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'Dispatch reservation check changed; export the current definition before continuing.';
  end if;
  execute replace(definition,needle,'perform public.hems_assert_dispatch_reservation(v_line.kind,v_line.inventory_record_id,v_line.quantity,p_list_id,v_line.name);');
end; $dispatch$;

-- Transaction rolls back fully if an existing dated Pending list is invalid.
-- No stock is modified and no old list is silently assigned new dates.
do $$ declare parent record; begin
  for parent in select to_jsonb(l) as data from public.equipment_lists l
    where status::text='pending' and list_type::text in ('local_event','dry_hire')
  loop perform public.hems_reservation_period(parent.data,true); end loop;
end; $$;
notify pgrst,'reload schema';
commit;

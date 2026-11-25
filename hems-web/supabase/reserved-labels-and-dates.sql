-- DISPLAY ONLY. Requires date-based-pending-reservations.sql already installed.
-- No stock, list status, dates, quantities, reservation math or RLS is changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $guard$ declare actual text; begin
  select md5(btrim(replace(p.prosrc,chr(13),''),E' \n\t')) into actual from pg_proc p
    where p.oid=to_regprocedure('public.hems_dated_pending_reservations(uuid)');
  if actual is distinct from 'f7a10038390663e421db0a690e1fb06c' then
    raise exception 'The dated reservation RPC is missing or changed. Stop and export hems_dated_pending_reservations(uuid); do not bypass this guard.';
  end if;
end; $guard$;

-- Private helper: names/IDs/dates come ONLY from Pending lists the signed-in
-- caller can already view. Other reservations keep anonymous stock identities.
create or replace function public.hems_pending_reservation_labels(p_period daterange)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb; today date:=(now() at time zone 'Asia/Dubai')::date;
begin
  if auth.uid() is null then raise exception 'Sign in to read reservations.' using errcode='42501'; end if;
  with candidates as materialized (
    select l.id,l.list_type::text as list_type,
      public.hems_reservation_period(to_jsonb(l),false) as span,
      public.hems_can_view_equipment_list(l.id) as visible,
      case when l.list_type::text='dry_hire' then coalesce(nullif(btrim(l.client_company),''),'Dry Hire')
        when l.list_type::text='local_event' then coalesce(nullif(concat_ws(' · ',nullif(btrim(l.event_name),''),nullif(btrim(l.venue),'')),''),'Local Event')
        when l.list_type::text='transfer_out' then coalesce(nullif(btrim(l.destination_name),''),'Transfer Out')
        else coalesce(nullif(btrim(l.purpose),''),'Internal Use') end as label
    from public.equipment_lists l where l.status::text='pending'
      and l.list_type::text in ('local_event','dry_hire','transfer_out','internal_use')
  ), facts as materialized (
    select i.inventory_record_type::text as record_type,i.inventory_record_id as record_id,
      case when i.inventory_record_type::text='unit' then u.item_id
        when i.inventory_record_type::text='matrix_row' then coalesce(m.item_id,m.model_id)
        else i.inventory_record_id end as parent_id,
      c.id as list_id,c.list_type,c.label,c.visible,c.span,
      lower(c.span) as start_date,upper(c.span)-1 as end_date,
      greatest(0,coalesce(i.requested_quantity,0))::bigint as quantity
    from candidates c join public.equipment_list_items i on i.list_id=c.id
    left join public.units u on i.inventory_record_type::text='unit' and u.id=i.inventory_record_id
    left join public.matrix_rows m on i.inventory_record_type::text='matrix_row' and m.id=i.inventory_record_id
    where i.inventory_record_type::text in ('unit','matrix_model','matrix_row')
      and (upper_inf(c.span) or upper(c.span)>today or c.span&&p_period)
  ), shown as (
    select record_type,record_id,parent_id,list_id,list_type,label,start_date,end_date,sum(quantity)::bigint as quantity
    from facts where visible is true group by record_type,record_id,parent_id,list_id,list_type,label,start_date,end_date
  ), hidden as (
    select distinct record_type,record_id,parent_id from facts where visible is not true and span&&p_period
  )
  select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(s) order by s.start_date nulls last,s.list_id,s.record_type,s.record_id) from shown s),'[]'::jsonb),
    'hidden',coalesce((select jsonb_agg(to_jsonb(h)) from hidden h),'[]'::jsonb)) into result;
  return result;
end; $$;
revoke all on function public.hems_pending_reservation_labels(daterange) from public,anon,authenticated;

-- Add display metadata to the existing shared request. Keep its version/rows,
-- authorization, context period and peak stock calculation exactly unchanged.
do $display$ declare definition text;
  needle text:=$needle$return jsonb_build_object('version',1,'rows',result,'period',jsonb_build_object('start',lower(span),'end',upper(span)-1));$needle$;
begin
  definition:=pg_get_functiondef('public.hems_dated_pending_reservations(uuid)'::regprocedure);
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'The reservation response has changed. Stop and export hems_dated_pending_reservations(uuid).'; end if;
  execute replace(definition,needle,$replacement$return jsonb_build_object('version',1,'rows',result,'period',jsonb_build_object('start',lower(span),'end',upper(span)-1),'labels',public.hems_pending_reservation_labels(span));$replacement$);
end; $display$;
notify pgrst,'reload schema';
commit;

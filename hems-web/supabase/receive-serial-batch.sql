-- Definitions only; no equipment is received merely by running this migration.
-- Requires the supplied Missing Equipment-aware Receive workflow.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $guard$ begin
  if to_regclass('public.hems_missing_equipment') is null
    or to_regprocedure('public.hems_guard_missing_stock()') is null
    or to_regprocedure('public.return_equipment_list_item(uuid,integer,integer)') is null then
    raise exception 'Install the Missing Equipment workflow before bulk receiving.';
  end if;
  if md5(btrim(replace(pg_get_functiondef('public.return_equipment_list_item(uuid,integer,integer)'::regprocedure),chr(13),''),E' \n\t;'))
    is distinct from '02904aeb2927855ef3da517a71b58820' then
    raise exception 'The live Receive function changed. Stop and export return_equipment_list_item(uuid,integer,integer); do not bypass this check.';
  end if;
end; $guard$;

create or replace function public.hems_receive_serial_batch(p_list_id uuid,p_lines jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ids uuid[]; total integer; distinct_lines integer; locked integer; distinct_units integer; models integer;
  parent public.equipment_lists%rowtype; line public.equipment_list_items%rowtype; result jsonb; final_status text; conflict_name text;
begin
  if auth.uid() is null or public.is_equipment_list_manager() is not true then
    raise exception 'Only Admin or Warehouse Manager can receive serial units.' using errcode='42501'; end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' then
    raise exception 'Choose outstanding serial units.' using errcode='23514'; end if;
  total:=jsonb_array_length(p_lines);
  if total<1 or total>1000 then raise exception 'Select between 1 and 1000 serial units.' using errcode='23514'; end if;
  select array_agg(e.id order by e.id),count(distinct e.id)::integer into ids,distinct_lines
    from jsonb_to_recordset(p_lines) as e(id uuid,approved integer,ok integer,maintenance integer,missing integer);
  if distinct_lines<>total then raise exception 'Choose each serial once; every selected line must have an ID.' using errcode='23514'; end if;

  -- Deterministic line -> parent -> advisory -> stock lock order, matching Receive.
  perform i.id from public.equipment_list_items i where i.list_id=p_list_id and i.id=any(ids) order by i.id for update;
  get diagnostics locked=row_count;
  if locked<>total then raise exception 'Some selected equipment is no longer on this list. Refresh before receiving.' using errcode='40001'; end if;
  select * into parent from public.equipment_lists where id=p_list_id for update;
  if not found or parent.list_type::text<>'local_event' or parent.status::text not in ('active','partially_returned') then
    raise exception 'Bulk Receive is available only for an active Local Event.' using errcode='23514'; end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);

  -- Validate EVERY selected line before the first call to the existing Receive RPC.
  select i.display_name || ' · ID ' || coalesce(i.metadata->>'unit_no',left(i.inventory_record_id::text,8))
    || ' · Serial ' || coalesce(nullif(i.serial_number,''),'—') into conflict_name from public.equipment_list_items i
    join jsonb_to_recordset(p_lines) as e(id uuid,approved integer,ok integer,maintenance integer,missing integer) on e.id=i.id
    where i.list_id=p_list_id and (
      i.inventory_record_type::text<>'unit' or coalesce(i.metadata->>'custom_item','false')='true'
      or i.approved_quantity is distinct from 1 or i.returned_ok_quantity is distinct from 0
      or i.returned_maintenance_quantity is distinct from 0 or i.missing_quantity is distinct from 0
      or e.approved is distinct from i.approved_quantity or e.ok is distinct from i.returned_ok_quantity
      or e.maintenance is distinct from i.returned_maintenance_quantity or e.missing is distinct from i.missing_quantity)
    order by i.id limit 1;
  if found then
    raise exception 'Selected serial changed: %. Refresh the list; no batch receipt was saved.',conflict_name using errcode='40001';
  end if;
  select count(distinct inventory_record_id)::integer into distinct_units from public.equipment_list_items where id=any(ids);
  if distinct_units<>total then raise exception 'Duplicate physical serials were found. Review this list.' using errcode='23514'; end if;
  perform u.id from public.units u join public.equipment_list_items i on i.inventory_record_id=u.id
    where i.id=any(ids) order by u.id for update of u;
  get diagnostics locked=row_count;
  if locked<>total then raise exception 'A selected inventory unit no longer exists.' using errcode='40001'; end if;
  select count(distinct u.item_id)::integer into models from public.units u join public.equipment_list_items i on i.inventory_record_id=u.id where i.id=any(ids);
  if models<>1 or exists(select 1 from public.units u join public.equipment_list_items i on i.inventory_record_id=u.id where i.id=any(ids) and u.item_id is null) then
    raise exception 'Select serials from one equipment model per receipt.' using errcode='23514'; end if;
  select i.display_name || ' · ID ' || coalesce(i.metadata->>'unit_no',left(i.inventory_record_id::text,8))
    || ' · Serial ' || coalesce(nullif(i.serial_number,''),'—') || ' (' || coalesce(u.status::text,'unknown') || ')'
    into conflict_name from public.units u join public.equipment_list_items i on i.inventory_record_id=u.id
    where i.id=any(ids) and u.status::text is distinct from 'in_use' order by i.id limit 1;
  if found then raise exception 'Selected unit is no longer dispatched: %. Review inventory; nothing was received.',conflict_name using errcode='40001'; end if;
  if exists(select 1 from public.equipment_list_items other_line join public.equipment_lists other_list on other_list.id=other_line.list_id
      where other_line.inventory_record_type::text='unit' and other_line.inventory_record_id in
        (select inventory_record_id from public.equipment_list_items where id=any(ids))
        and other_line.list_id<>p_list_id and other_list.status::text in ('active','partially_returned')
        and other_list.list_type::text not in ('maintenance','transfer_in')
        and other_line.approved_quantity>coalesce(other_line.returned_ok_quantity,0)+coalesce(other_line.returned_maintenance_quantity,0)) then
    raise exception 'A selected serial overlaps another dispatched list. Review the movement before receiving.' using errcode='23514'; end if;
  if exists(select 1 from public.hems_missing_equipment m where m.inventory_record_type='unit' and m.remaining_quantity>0
      and m.inventory_record_id in (select inventory_record_id from public.equipment_list_items where id=any(ids))) then
    raise exception 'A selected serial has a Missing hold. Use Recovered for Missing equipment.' using errcode='23514'; end if;

  -- One Postgres transaction: any error on ANY unit rolls back ALL selected units.
  -- Do not catch and continue; do not replace existing stock/maintenance/audit logic.
  for line in select * from public.equipment_list_items where id=any(ids) order by id loop
    result:=public.return_equipment_list_item(line.id,1,0);
  end loop;
  select status::text into final_status from public.equipment_lists where id=p_list_id;
  return jsonb_build_object('list_id',p_list_id,'received',total,'list_status',final_status);
end; $$;
revoke all on function public.hems_receive_serial_batch(uuid,jsonb) from public,anon;
grant execute on function public.hems_receive_serial_batch(uuid,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;

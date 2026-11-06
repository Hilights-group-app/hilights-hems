-- MISSING EQUIPMENT — definitions/schema only; no existing stock is moved on Run.
-- Install this single file before the UI. Any error rolls the whole migration back.
-- Missing retains its existing in_use hold until an authorized Recovered action.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $guard$ begin
  if to_regprocedure('public.hems_correct_received_ok_quantity(uuid,integer,integer,integer,integer,text)') is null or md5(btrim(replace(pg_get_functiondef(to_regprocedure('public.hems_correct_received_ok_quantity(uuid,integer,integer,integer,integer,text)')),chr(13),''),E' \n\t;')) not in ('4382c5c23713f5450c9058f78952ba57','90f3c2364a848c0ffc93565dbad466c2') then
    raise exception 'The hems_correct_received_ok_quantity workflow changed. Stop and export its current definition; do not bypass this check.';
  end if;
  if to_regprocedure('public.hems_dispatch_list_addition()') is null or md5(btrim(replace(pg_get_functiondef(to_regprocedure('public.hems_dispatch_list_addition()')),chr(13),''),E' \n\t;')) not in ('c279b3e4f2ab41a2cf293983ddaea760') then
    raise exception 'The hems_dispatch_list_addition workflow changed. Stop and export its current definition; do not bypass this check.';
  end if;
  if to_regprocedure('public.hems_guard_shared_draft_items()') is null or md5(btrim(replace(pg_get_functiondef(to_regprocedure('public.hems_guard_shared_draft_items()')),chr(13),''),E' \n\t;')) not in ('365375b99fb971ba0bc577a88e262176') then
    raise exception 'The hems_guard_shared_draft_items workflow changed. Stop and export its current definition; do not bypass this check.';
  end if;
  if to_regprocedure('public.hems_outgoing_free_quantity(text,uuid)') is null or md5(btrim(replace(pg_get_functiondef(to_regprocedure('public.hems_outgoing_free_quantity(text,uuid)')),chr(13),''),E' \n\t;')) not in ('c662ddc35bc572833760a7c130e9e891') then
    raise exception 'The hems_outgoing_free_quantity workflow changed. Stop and export its current definition; do not bypass this check.';
  end if;
  if to_regprocedure('public.return_equipment_list_item(uuid,integer,integer)') is null or md5(btrim(replace(pg_get_functiondef(to_regprocedure('public.return_equipment_list_item(uuid,integer,integer)')),chr(13),''),E' \n\t;')) not in ('c9a067d3b03bb51223412744e1ed62a8','02904aeb2927855ef3da517a71b58820') then
    raise exception 'The return_equipment_list_item workflow changed. Stop and export its current definition; do not bypass this check.';
  end if;
end; $guard$;

-- Missing equipment ledger.
create table if not exists public.hems_missing_equipment (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  list_id uuid not null references public.equipment_lists(id) on delete restrict,
  list_item_id uuid not null references public.equipment_list_items(id) on delete restrict,
  inventory_record_type text not null check (inventory_record_type in ('unit','matrix_model','matrix_row')),
  inventory_record_id uuid not null,
  display_name text not null,
  serial_number text,
  metadata jsonb not null default '{}'::jsonb,
  list_reference text not null,
  list_type text not null,
  event_name text not null,
  location text not null default '',
  list_created_at timestamptz not null,
  list_created_by uuid,
  list_created_by_name text not null,
  quantity integer not null check(quantity>0),
  recovered_quantity integer not null default 0 check(recovered_quantity>=0 and recovered_quantity<=quantity),
  remaining_quantity integer generated always as (quantity-recovered_quantity) stored,
  note text not null default '' check(length(note)<=1000),
  reported_by uuid not null,
  reported_by_name text not null,
  reported_at timestamptz not null default now(),
  recovered_at timestamptz,
  recovered_by uuid,
  recovered_by_name text,
  search_text text generated always as (display_name || ' ' || coalesce(serial_number,'') || ' ' || event_name || ' ' || location || ' ' || list_reference || ' ' || list_created_by_name) stored
);
create index if not exists hems_missing_equipment_page on public.hems_missing_equipment(reported_at desc,id desc);
create index if not exists hems_missing_equipment_line on public.hems_missing_equipment(list_item_id);
create index if not exists hems_missing_equipment_stock on public.hems_missing_equipment(inventory_record_type,inventory_record_id) where recovered_quantity<quantity;
alter table public.hems_missing_equipment enable row level security;
revoke all on public.hems_missing_equipment from public,anon,authenticated;
grant select on public.hems_missing_equipment to authenticated;
drop policy if exists hems_missing_read on public.hems_missing_equipment;
create policy hems_missing_read on public.hems_missing_equipment for select to authenticated
using ((select auth.uid()) is not null and exists(select 1 from public.profiles p where p.id=(select auth.uid())));

alter table public.equipment_list_items add column if not exists missing_quantity integer not null default 0;

-- The ledger is authoritative. A forged REST update cannot change Missing,
-- receive it a second time, relink a missing serial or erase its event history.
create or replace function public.hems_guard_missing_list_line()
returns trigger language plpgsql security definer set search_path='' as $$
declare held bigint;
begin
  if tg_op='DELETE' then
    if exists(select 1 from public.hems_missing_equipment where list_item_id=old.id) then
      raise exception 'This event has Missing history. Keep its equipment records.' using errcode='23514';
    end if;
    return old;
  end if;
  if tg_op='INSERT' then
    if new.missing_quantity<>0 then raise exception 'Use Mark Missing.' using errcode='42501'; end if;
    return new;
  end if;
  if old.missing_quantity>0 or new.missing_quantity is distinct from old.missing_quantity then
    select coalesce(sum(quantity-recovered_quantity),0) into held from public.hems_missing_equipment where list_item_id=old.id;
    if new.missing_quantity<0 or new.missing_quantity is distinct from held then
      raise exception 'Missing quantities must match the authorized Missing ledger.' using errcode='23514';
    end if;
    if new.list_id is distinct from old.list_id or new.inventory_record_id is distinct from old.inventory_record_id
      or new.inventory_record_type is distinct from old.inventory_record_type then
      raise exception 'Missing equipment cannot be replaced.' using errcode='23514';
    end if;
    if coalesce(new.returned_ok_quantity,0)+coalesce(new.returned_maintenance_quantity,0)+new.missing_quantity>coalesce(new.approved_quantity,0) then
      raise exception 'Missing equipment cannot also be Received. Use Recovered in Missing Equipment.' using errcode='23514';
    end if;
  end if;
  return new;
end; $$;
drop trigger if exists zzzz_hems_missing_line on public.equipment_list_items;
create trigger zzzz_hems_missing_line before insert or update or delete on public.equipment_list_items
for each row execute function public.hems_guard_missing_list_line();

-- Keep existing in_use holds for missing equipment; do NOT turn loss into Available.
-- No new status enum, no decrease of Total, no reuse of Maintenance counters.
create or replace function public.hems_guard_missing_stock()
returns trigger language plpgsql security definer set search_path='' as $$
declare kind text; record_id uuid; held bigint;
begin
  kind:=case tg_table_name when 'units' then 'unit' when 'matrix_models' then 'matrix_model' else 'matrix_row' end;
  record_id:=old.id;
  select coalesce(sum(quantity-recovered_quantity),0) into held from public.hems_missing_equipment
    where inventory_record_type=kind and inventory_record_id=record_id and recovered_quantity<quantity;
  if held>0 then
    if tg_op='DELETE' then raise exception 'Recover Missing equipment before deleting this stock record.' using errcode='23514'; end if;
    if new.id is distinct from old.id then raise exception 'Missing stock cannot be relinked.' using errcode='23514'; end if;
    if kind='unit' then
      if new.status::text is distinct from 'in_use' then raise exception 'This serial is Missing; use Recovered first.' using errcode='23514'; end if;
    elsif coalesce(new.in_use_qty,0)<held then
      raise exception 'This stock includes % Missing. Use Recovered first.',held using errcode='23514';
    end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end; $$;
drop trigger if exists zzzz_hems_missing_stock on public.units;
create trigger zzzz_hems_missing_stock before update of id,status or delete on public.units for each row execute function public.hems_guard_missing_stock();
drop trigger if exists zzzz_hems_missing_stock on public.matrix_models;
create trigger zzzz_hems_missing_stock before update of id,in_use_qty or delete on public.matrix_models for each row execute function public.hems_guard_missing_stock();
drop trigger if exists zzzz_hems_missing_stock on public.matrix_rows;
create trigger zzzz_hems_missing_stock before update of id,in_use_qty or delete on public.matrix_rows for each row execute function public.hems_guard_missing_stock();

-- In Use covers real outstanding movements PLUS all unresolved Missing holds,
-- including losses from closed events. Refuse to repair inconsistent stock here.
create or replace function public.hems_missing_expected_hold(p_kind text,p_record_id uuid)
returns bigint language sql stable security definer set search_path='' as $$
  select coalesce((select sum(greatest(0,coalesce(i.approved_quantity,0)-coalesce(i.returned_ok_quantity,0)-coalesce(i.returned_maintenance_quantity,0)-i.missing_quantity))
    from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
    where i.inventory_record_type::text=p_kind and i.inventory_record_id=p_record_id
      and l.status::text in ('active','partially_returned') and l.list_type::text not in ('maintenance','transfer_in')),0)
    + coalesce((select sum(quantity-recovered_quantity) from public.hems_missing_equipment where inventory_record_type=p_kind and inventory_record_id=p_record_id and recovered_quantity<quantity),0);
$$;

create or replace function public.hems_mark_missing(
 p_list_item_id uuid,p_quantity integer,p_expected_approved integer,p_expected_ok integer,
 p_expected_maintenance integer,p_expected_missing integer,p_note text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare line public.equipment_list_items%rowtype; parent public.equipment_lists%rowtype;
  entry public.hems_missing_equipment%rowtype; actor text; outside integer; remaining bigint; next_status public.equipment_lists.status%type;
  held bigint; occupied bigint; source_parent uuid;
begin
  if auth.uid() is null or public.is_equipment_list_manager() is not true then raise exception 'Only Admin or Warehouse Manager can mark Missing.' using errcode='42501'; end if;
  if p_request_id is null or p_quantity is null or p_quantity<1 or length(coalesce(p_note,''))>1000 then raise exception 'Choose a positive whole Missing quantity and a note of at most 1000 characters.' using errcode='23514'; end if;
  select * into line from public.equipment_list_items where id=p_list_item_id for update;
  if not found then raise exception 'Equipment line not found.' using errcode='P0002'; end if;
  select * into parent from public.equipment_lists where id=line.list_id for update;
  if not found then raise exception 'Event not found.' using errcode='P0002'; end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  select * into entry from public.hems_missing_equipment where id=p_request_id;
  if found then
    if entry.list_item_id<>line.id or entry.quantity<>p_quantity or entry.reported_by<>auth.uid() or entry.note<>btrim(coalesce(p_note,'')) then
      raise exception 'This request was already used. Refresh Missing Equipment.' using errcode='40001'; end if;
    return jsonb_build_object('id',entry.id,'list_id',parent.id,'list_status',parent.status,'already_saved',true);
  end if;
  if parent.list_type::text not in ('local_event','dry_hire') or parent.status::text not in ('active','partially_returned') then
    raise exception 'Mark Missing is available only for active Local Event or Dry Hire equipment.' using errcode='23514'; end if;
  if line.inventory_record_type::text not in ('unit','matrix_model','matrix_row') or coalesce(line.metadata->>'custom_item','false')='true' then
    raise exception 'Choose registered dispatched equipment, not a custom item.' using errcode='23514'; end if;
  if p_expected_approved is distinct from line.approved_quantity or p_expected_ok is distinct from line.returned_ok_quantity
    or p_expected_maintenance is distinct from line.returned_maintenance_quantity or p_expected_missing is distinct from line.missing_quantity then
    raise exception 'This equipment changed. Refresh the list before marking Missing.' using errcode='40001'; end if;
  if coalesce(line.approved_quantity,0)<1 or coalesce(line.returned_ok_quantity,0)<0 or coalesce(line.returned_maintenance_quantity,0)<0
    or line.missing_quantity<0 or coalesce(line.returned_ok_quantity,0)+coalesce(line.returned_maintenance_quantity,0)+line.missing_quantity>line.approved_quantity then
    raise exception 'Review invalid dispatched/received counters before marking Missing.' using errcode='23514'; end if;
  outside:=coalesce(line.approved_quantity,0)-coalesce(line.returned_ok_quantity,0)-coalesce(line.returned_maintenance_quantity,0)-line.missing_quantity;
  if p_quantity>outside then raise exception 'Only % remain outside. Do not mark returned equipment Missing.',outside using errcode='23514'; end if;
  select coalesce(sum(quantity-recovered_quantity),0) into held from public.hems_missing_equipment
    where inventory_record_type=line.inventory_record_type::text and inventory_record_id=line.inventory_record_id and recovered_quantity<quantity;
  if line.inventory_record_type::text='unit' then
    if p_quantity<>1 or line.approved_quantity<>1 or held<>0 or public.hems_missing_expected_hold('unit',line.inventory_record_id)<>1 then raise exception 'Choose one exact outstanding serial without overlapping events.' using errcode='23514'; end if;
    perform 1 from public.units where id=line.inventory_record_id and status::text='in_use' for update;
    if not found then raise exception 'This serial no longer matches dispatched stock.' using errcode='40001'; end if;
  elsif line.inventory_record_type::text='matrix_model' then
    select in_use_qty into occupied from public.matrix_models where id=line.inventory_record_id for update;
  else
    select in_use_qty,item_id into occupied,source_parent from public.matrix_rows where id=line.inventory_record_id for update;
    if (source_parent is not null) is distinct from (coalesce(line.metadata->>'matrix_source','')='generic') then raise exception 'Inventory source changed.' using errcode='40001'; end if;
  end if;
  if line.inventory_record_type::text<>'unit' and (occupied is null or occupied<held+p_quantity or occupied<public.hems_missing_expected_hold(line.inventory_record_type::text,line.inventory_record_id)) then raise exception 'Stock counters do not cover the active and Missing quantities. Review stock first.' using errcode='23514'; end if;
  select coalesce(nullif(btrim(full_name),''),'Warehouse Manager') into actor from public.profiles where id=auth.uid();
  insert into public.hems_missing_equipment(id,list_id,list_item_id,inventory_record_type,inventory_record_id,display_name,serial_number,metadata,
    list_reference,list_type,event_name,location,list_created_at,list_created_by,list_created_by_name,quantity,note,reported_by,reported_by_name)
  values(p_request_id,parent.id,line.id,line.inventory_record_type::text,line.inventory_record_id,line.display_name,line.serial_number,
    jsonb_strip_nulls(jsonb_build_object('unit_no',line.metadata->'unit_no','row_label',line.metadata->'row_label',
      'matrix_source',line.metadata->'matrix_source','cabinet_area_sqm',line.metadata->'cabinet_area_sqm','cabinet_size',line.metadata->'cabinet_size',
      'photo_url',case when coalesce(line.metadata->>'photo_url','') ~ '^https?://' and length(line.metadata->>'photo_url')<=2048 then line.metadata->>'photo_url' else null end)),
    parent.reference,parent.list_type::text,coalesce(nullif(parent.event_name,''),nullif(parent.client_company,''),parent.reference),coalesce(parent.venue,''),
    parent.created_at,parent.created_by,coalesce(nullif(btrim(parent.created_by_name),''),(select nullif(btrim(full_name),'') from public.profiles where id=parent.created_by),'Unknown'),p_quantity,btrim(coalesce(p_note,'')),auth.uid(),coalesce(actor,'Warehouse Manager'));
  update public.equipment_list_items set missing_quantity=missing_quantity+p_quantity,updated_at=now() where id=line.id;
  select coalesce(sum(greatest(0,coalesce(approved_quantity,0)-coalesce(returned_ok_quantity,0)-coalesce(returned_maintenance_quantity,0)-missing_quantity)),0)
    into remaining from public.equipment_list_items where list_id=parent.id and inventory_record_type::text<>'item' and coalesce(metadata->>'custom_item','false')<>'true';
  next_status:=case when remaining=0 then 'closed' else 'partially_returned' end;
  update public.equipment_lists set status=next_status,closed_at=case when remaining=0 then now() else null end,updated_at=now() where id=parent.id;
  insert into public.equipment_list_activity(list_id,action,message,actor_id,actor_name,details)
    values(parent.id,'equipment_missing',line.display_name || ' · ' || p_quantity || ' Missing',auth.uid(),coalesce(actor,'Warehouse Manager'),
      jsonb_build_object('missing_id',p_request_id,'list_item_id',line.id,'quantity',p_quantity,'note',btrim(coalesce(p_note,'')),'stock_still_unavailable',true));
  return jsonb_build_object('id',p_request_id,'list_id',parent.id,'list_status',next_status,'missing_quantity',line.missing_quantity+p_quantity);
end; $$;

create table if not exists public.hems_missing_recoveries (
  id uuid primary key,
  missing_id uuid not null references public.hems_missing_equipment(id) on delete restrict,
  quantity integer not null check(quantity>0),
  note text not null check(length(note)<=1000),
  recovered_by uuid not null,
  recovered_by_name text not null,
  recovered_at timestamptz not null default now()
);
alter table public.hems_missing_recoveries enable row level security;
revoke all on public.hems_missing_recoveries from public,anon,authenticated;
grant select on public.hems_missing_recoveries to authenticated;
drop policy if exists hems_missing_recovery_read on public.hems_missing_recoveries;
create policy hems_missing_recovery_read on public.hems_missing_recoveries for select to authenticated
using (exists(select 1 from public.hems_missing_equipment m where m.id=missing_id));

create or replace function public.hems_recover_missing(
 p_missing_id uuid,p_quantity integer,p_expected_recovered integer,p_note text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare entry public.hems_missing_equipment%rowtype; line public.equipment_list_items%rowtype;
  parent public.equipment_lists%rowtype; receipt public.hems_missing_recoveries%rowtype; actor text; source_parent uuid; changed integer;
  expected_hold bigint;
begin
  if auth.uid() is null or public.is_equipment_list_manager() is not true then raise exception 'Only Admin or Warehouse Manager can recover Missing equipment.' using errcode='42501'; end if;
  if p_request_id is null or p_quantity is null or p_quantity<1 or length(coalesce(p_note,''))>1000 then raise exception 'Enter a positive whole Recovered quantity and a note of at most 1000 characters.' using errcode='23514'; end if;
  -- Nonlocking lookup only; actual checks are repeated after line -> parent locks.
  select * into entry from public.hems_missing_equipment where id=p_missing_id;
  if not found then raise exception 'Missing record not found.' using errcode='P0002'; end if;
  select * into line from public.equipment_list_items where id=entry.list_item_id for update;
  if not found then raise exception 'The original equipment line is unavailable.' using errcode='23514'; end if;
  select * into parent from public.equipment_lists where id=line.list_id for update;
  if not found or parent.list_type::text not in ('local_event','dry_hire') or parent.status::text not in ('active','partially_returned','closed') then raise exception 'The source event is unavailable.' using errcode='23514'; end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  select * into entry from public.hems_missing_equipment where id=p_missing_id for update;
  select * into receipt from public.hems_missing_recoveries where id=p_request_id;
  if found then
    if receipt.missing_id<>entry.id or receipt.quantity<>p_quantity or receipt.recovered_by<>auth.uid() or receipt.note<>btrim(coalesce(p_note,'')) then raise exception 'This recovery request was already used.' using errcode='40001'; end if;
    return jsonb_build_object('id',entry.id,'list_id',parent.id,'already_saved',true);
  end if;
  if p_expected_recovered is distinct from entry.recovered_quantity or p_quantity>entry.quantity-entry.recovered_quantity or p_quantity>line.missing_quantity then raise exception 'Missing quantity changed. Refresh Missing Equipment.' using errcode='40001'; end if;
  expected_hold:=public.hems_missing_expected_hold(line.inventory_record_type::text,line.inventory_record_id);
  if line.inventory_record_type::text='unit' and expected_hold<>1 then raise exception 'Review overlapping unit movements before recovery.' using errcode='23514'; end if;
  select coalesce(nullif(btrim(full_name),''),'Warehouse Manager') into actor from public.profiles where id=auth.uid();
  -- Release the ledger hold first, in this same transaction. Stock triggers still
  -- protect every other unresolved Missing incident for this inventory record.
  update public.hems_missing_equipment set recovered_quantity=recovered_quantity+p_quantity,recovered_at=now(),
    recovered_by=auth.uid(),recovered_by_name=coalesce(actor,'Warehouse Manager') where id=entry.id;
  if line.inventory_record_type::text='unit' then
    if p_quantity<>1 or line.approved_quantity<>1 then raise exception 'Recover the exact missing serial once.' using errcode='23514'; end if;
    update public.units set status='available' where id=line.inventory_record_id and status::text='in_use';
  elsif line.inventory_record_type::text='matrix_model' then
    update public.matrix_models set in_use_qty=in_use_qty-p_quantity where id=line.inventory_record_id and in_use_qty>=greatest(p_quantity,expected_hold);
  elsif line.inventory_record_type::text='matrix_row' then
    select item_id into source_parent from public.matrix_rows where id=line.inventory_record_id for update;
    if (source_parent is not null) is distinct from (coalesce(line.metadata->>'matrix_source','')='generic') then raise exception 'Inventory source changed.' using errcode='40001'; end if;
    update public.matrix_rows set in_use_qty=in_use_qty-p_quantity where id=line.inventory_record_id and in_use_qty>=greatest(p_quantity,expected_hold);
  else raise exception 'Unsupported missing stock.' using errcode='23514'; end if;
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Stock counters changed. Recovery was not saved.' using errcode='40001'; end if;
  if line.inventory_record_type::text='matrix_row' and source_parent is null then
    update public.matrix_rows set available_qty=greatest(0,coalesce(qty,0)-coalesce(maintenance_qty,0)-coalesce(in_use_qty,0)-coalesce(in_ksa_qty,0)) where id=line.inventory_record_id;
  end if;
  update public.equipment_list_items set missing_quantity=missing_quantity-p_quantity,returned_ok_quantity=coalesce(returned_ok_quantity,0)+p_quantity,updated_at=now() where id=line.id;
  insert into public.hems_missing_recoveries(id,missing_id,quantity,note,recovered_by,recovered_by_name)
    values(p_request_id,entry.id,p_quantity,btrim(coalesce(p_note,'')),auth.uid(),coalesce(actor,'Warehouse Manager'));
  update public.equipment_lists set updated_at=now() where id=parent.id;
  insert into public.equipment_list_activity(list_id,action,message,actor_id,actor_name,details)
    values(parent.id,'missing_equipment_recovered',line.display_name || ' · ' || p_quantity || ' Recovered',auth.uid(),coalesce(actor,'Warehouse Manager'),
      jsonb_build_object('missing_id',entry.id,'recovery_id',p_request_id,'quantity',p_quantity,'note',btrim(coalesce(p_note,''))));
  return jsonb_build_object('id',entry.id,'list_id',parent.id,'recovered_quantity',entry.recovered_quantity+p_quantity);
end; $$;
revoke all on function public.hems_guard_missing_list_line() from public,anon,authenticated;
revoke all on function public.hems_guard_missing_stock() from public,anon,authenticated;
revoke all on function public.hems_missing_expected_hold(text,uuid) from public,anon,authenticated;
revoke all on function public.hems_mark_missing(uuid,integer,integer,integer,integer,integer,text,uuid) from public,anon;
revoke all on function public.hems_recover_missing(uuid,integer,integer,text,uuid) from public,anon;
grant execute on function public.hems_mark_missing(uuid,integer,integer,integer,integer,integer,text,uuid) to authenticated;
grant execute on function public.hems_recover_missing(uuid,integer,integer,text,uuid) to authenticated;


-- Preserve the exported Receive and Correct Received bodies; only subtract Missing
-- from returnable/list-closing totals. Existing allocation guards remain intact.
CREATE OR REPLACE FUNCTION public.return_equipment_list_item(p_list_item_id uuid, p_return_ok_quantity integer DEFAULT 0, p_return_maintenance_quantity integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_line public.equipment_list_items%rowtype;
  v_list public.equipment_lists%rowtype;
  v_ok integer := greatest(coalesce(p_return_ok_quantity, 0), 0);
  v_maintenance integer := greatest(coalesce(p_return_maintenance_quantity, 0), 0);
  v_returned integer;
  v_approved integer;
  v_remaining integer;
  v_remaining_after integer;
  v_list_remaining integer;
  v_actor_name text;
  v_category text;
  v_department text;
  v_source_summary text;
  v_report_href text;
  v_request_id uuid;
  v_next_status text;
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;

  if not public.is_equipment_list_manager() then
    raise exception 'Only a Warehouse Manager or Admin can receive returned equipment.'
      using errcode = '42501';
  end if;

  if v_ok + v_maintenance < 1 then
    raise exception 'Enter at least one returned item.';
  end if;

  select * into v_line
  from public.equipment_list_items
  where id = p_list_item_id
  for update;

  if not found then
    raise exception 'Equipment list item not found.' using errcode = 'P0002';
  end if;

  select * into v_list
  from public.equipment_lists
  where id = v_line.list_id
  for update;

  if not found then
    raise exception 'Equipment list not found.' using errcode = 'P0002';
  end if;

  if v_list.status not in ('active', 'partially_returned') then
    raise exception 'Returns are only allowed for Active or Partially Returned lists.';
  end if;

  if v_line.inventory_record_type not in ('unit', 'item', 'matrix_model', 'matrix_row') then
    raise exception 'This inventory record cannot be returned from this screen.';
  end if;

  v_approved := greatest(coalesce(v_line.approved_quantity, 0), 0);
  v_returned := greatest(coalesce(v_line.returned_ok_quantity, 0), 0)
    + greatest(coalesce(v_line.returned_maintenance_quantity, 0), 0);
  v_remaining := greatest(0, v_approved - v_returned - coalesce(v_line.missing_quantity,0));

  if v_ok + v_maintenance > v_remaining then
    raise exception
      'Only % item(s) remain outside the warehouse. Requested return: %.',
      v_remaining,
      v_ok + v_maintenance;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(742193,1);

  if v_line.inventory_record_type = 'item' then
    if v_maintenance > 0 then
      raise exception 'A custom item can only be returned OK.';
    end if;
    -- Custom items are tracked on the list only. They do not mutate Inventory.
  elsif v_line.inventory_record_type = 'unit' then
    if v_remaining <> 1 or v_ok + v_maintenance <> 1 then
      raise exception 'A serialized unit must be returned once as OK or Maintenance.';
    end if;

    update public.units
    set status = case when v_maintenance = 1 then 'maintenance' else 'available' end
    where id = v_line.inventory_record_id;

    if not found then
      raise exception 'The serialized inventory unit no longer exists.';
    end if;
  elsif v_line.inventory_record_type = 'matrix_model' then
    update public.matrix_models
    set
      in_use_qty = greatest(0, coalesce(in_use_qty, 0) - v_ok - v_maintenance),
      maintenance_qty = coalesce(maintenance_qty, 0) + v_maintenance
    where id = v_line.inventory_record_id;

    if not found then
      raise exception 'The Matrix item no longer exists.';
    end if;
  elsif coalesce(v_line.metadata ->> 'matrix_source', '') = 'generic' then
    update public.matrix_rows
    set
      in_use_qty = greatest(0, coalesce(in_use_qty, 0) - v_ok - v_maintenance),
      maintenance_qty = coalesce(maintenance_qty, 0) + v_maintenance
    where id = v_line.inventory_record_id;

    if not found then
      raise exception 'The Matrix row no longer exists.';
    end if;
  else
    update public.matrix_rows
    set
      in_use_qty = greatest(0, coalesce(in_use_qty, 0) - v_ok - v_maintenance),
      maintenance_qty = coalesce(maintenance_qty, 0) + v_maintenance,
      available_qty = greatest(
        0,
        least(
          greatest(
            0,
            coalesce(qty, 0)
              - coalesce(maintenance_qty, 0)
              - v_maintenance
              - coalesce(in_ksa_qty, 0)
          ),
          coalesce(available_qty, 0) + v_ok
        )
      )
    where id = v_line.inventory_record_id;

    if not found then
      raise exception 'The LED cabinet row no longer exists.';
    end if;
  end if;

  update public.equipment_list_items
  set
    returned_ok_quantity = returned_ok_quantity + v_ok,
    returned_maintenance_quantity = returned_maintenance_quantity + v_maintenance,
    updated_at = v_now
  where id = v_line.id;

  v_remaining_after := v_remaining - v_ok - v_maintenance;

  select nullif(btrim(full_name), '') into v_actor_name
  from public.profiles
  where id = auth.uid();

  v_category := lower(coalesce(v_line.metadata ->> 'category', ''));
  v_department := case
    when v_category ~ '(lighting|light)' then 'lighting'
    when v_category ~ '(truss|rigg|hoist|motor)' then 'rigging'
    when v_category ~ '(led|video|project|lens|matrix)' then 'video'
    else 'general'
  end;

  v_source_summary := case v_list.list_type
    when 'dry_hire' then coalesce(nullif(btrim(v_list.client_company), ''), 'Dry Hire')
    when 'local_event' then coalesce(
      nullif(concat_ws(' · ', nullif(btrim(v_list.event_name), ''), nullif(btrim(v_list.venue), '')), ''),
      'Local Event'
    )
    when 'transfer_out' then coalesce(
      nullif(concat_ws(' → ', nullif(btrim(v_list.from_location_name), ''), nullif(btrim(v_list.destination_name), '')), ''),
      'Transfer Out'
    )
    when 'transfer_in' then coalesce(
      nullif(concat_ws(' → ', nullif(btrim(v_list.from_location_name), ''), nullif(btrim(v_list.destination_name), '')), ''),
      'Transfer In'
    )
    else coalesce(
      nullif(concat_ws(' · ', nullif(btrim(v_list.purpose), ''), nullif(btrim(v_list.assigned_to), '')), ''),
      'Internal Use'
    )
  end;

  if v_line.inventory_record_type = 'matrix_row'
    and coalesce(v_line.metadata ->> 'matrix_source', '') <> 'generic' then
    if coalesce(v_line.metadata ->> 'category', '') <> ''
      and coalesce(v_line.metadata ->> 'subcategory', '') <> '' then
      v_report_href := '/inventory/'
        || (v_line.metadata ->> 'category')
        || '/'
        || (v_line.metadata ->> 'subcategory')
        || '/led-report/'
        || v_line.inventory_record_id::text;
    end if;
  elsif v_line.inventory_record_type = 'unit'
    and coalesce(v_line.metadata ->> 'category', '') <> ''
    and coalesce(v_line.metadata ->> 'subcategory', '') <> ''
    and coalesce(v_line.metadata ->> 'item_id', '') <> '' then
    v_report_href := '/inventory/'
      || (v_line.metadata ->> 'category')
      || '/'
      || (v_line.metadata ->> 'subcategory')
      || '/'
      || (v_line.metadata ->> 'item_id');
  elsif coalesce(v_line.metadata ->> 'category', '') <> ''
    and coalesce(v_line.metadata ->> 'subcategory', '') <> '' then
    v_report_href := '/inventory/'
      || (v_line.metadata ->> 'category')
      || '/'
      || (v_line.metadata ->> 'subcategory');
  end if;

  if v_maintenance > 0 then
    insert into public.maintenance_requests (
      list_id, list_item_id, inventory_record_type, inventory_record_id,
      parent_record_id, display_name, serial_number, quantity, department,
      source_reference, source_type, source_summary, report_href, created_by,
      created_by_name, metadata
    )
    values (
      v_list.id, v_line.id, v_line.inventory_record_type,
      v_line.inventory_record_id, v_line.parent_record_id,
      v_line.display_name, v_line.serial_number, v_maintenance, v_department,
      v_list.reference, v_list.list_type, v_source_summary, v_report_href,
      auth.uid(), coalesce(v_actor_name, 'Warehouse Manager'),
      jsonb_build_object(
        'list_reference', v_list.reference,
        'list_type', v_list.list_type,
        'source_summary', v_source_summary,
        'equipment_metadata', v_line.metadata
      )
    )
    returning id into v_request_id;
  end if;

  select coalesce(
    sum(
      greatest(
        0,
        approved_quantity - returned_ok_quantity - returned_maintenance_quantity - missing_quantity
      )
    ),
    0
  )::integer
  into v_list_remaining
  from public.equipment_list_items
  where list_id = v_list.id and inventory_record_type::text<>'item' and coalesce(metadata->>'custom_item','false')<>'true';

  v_next_status := case
    when v_list_remaining = 0 then 'closed'
    else 'partially_returned'
  end;

  update public.equipment_lists
  set
    status = v_next_status,
    closed_at = case when v_next_status = 'closed' then v_now else null end,
    updated_at = v_now
  where id = v_list.id;

  insert into public.equipment_list_activity (
    list_id, action, message, actor_id, actor_name, details
  )
  values (
    v_list.id,
    case when v_maintenance > 0 then 'returned_to_maintenance' else 'returned_ok' end,
    case
      when v_maintenance > 0 then
        v_line.display_name || ' returned to Maintenance from ' || v_list.reference
      else
        v_line.display_name || ' returned OK from ' || v_list.reference
    end,
    auth.uid(),
    coalesce(v_actor_name, 'Warehouse Manager'),
    jsonb_build_object(
      'list_item_id', v_line.id,
      'inventory_record_id', v_line.inventory_record_id,
      'returned_ok_quantity', v_ok,
      'returned_maintenance_quantity', v_maintenance,
      'remaining_line_quantity', v_remaining_after,
      'maintenance_request_id', v_request_id
    )
  );

  return jsonb_build_object(
    'list_id', v_list.id,
    'list_item_id', v_line.id,
    'list_status', v_next_status,
    'returned_ok_quantity', v_line.returned_ok_quantity + v_ok,
    'returned_maintenance_quantity',
      v_line.returned_maintenance_quantity + v_maintenance,
    'remaining_line_quantity', v_remaining_after,
    'remaining_list_quantity', v_list_remaining,
    'maintenance_request_id', v_request_id
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.hems_correct_received_ok_quantity(p_list_item_id uuid, p_expected_ok integer, p_expected_maintenance integer, p_expected_approved integer, p_corrected_ok integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare line public.equipment_list_items%rowtype; parent public.equipment_lists%rowtype;
  delta integer; active_qty bigint; occupied bigint; new_status public.equipment_lists.status%type;
  list_remaining bigint; list_received bigint; generic_row boolean; stock_parent uuid;
  actor text; reason text:=btrim(coalesce(p_reason,'')); at_time timestamptz:=now();
begin
  if auth.uid() is null or public.is_equipment_list_manager() is not true then
    raise exception 'Only Warehouse Manager or Admin can correct Received quantities.' using errcode='42501';
  end if;
  if length(reason)<5 or length(reason)>1000 then
    raise exception 'Enter a correction reason (5 to 1000 characters).' using errcode='23514';
  end if;
  -- Same line -> parent order as the supplied receive function.
  select * into line from public.equipment_list_items where id=p_list_item_id for update;
  if not found then raise exception 'List item not found.' using errcode='P0002'; end if;
  select * into parent from public.equipment_lists where id=line.list_id for update;
  if not found or parent.list_type::text not in ('local_event','dry_hire')
    or parent.status::text not in ('active','partially_returned') then
    raise exception 'Correct Received is available only for active Local Event or Dry Hire lists.' using errcode='23514';
  end if;
  if line.inventory_record_type::text not in ('unit','matrix_model','matrix_row')
    or coalesce(line.metadata->>'custom_item','false')='true' then
    raise exception 'Only registered dispatched equipment can be corrected here.' using errcode='23514';
  end if;
  if p_expected_ok is distinct from line.returned_ok_quantity
    or p_expected_maintenance is distinct from line.returned_maintenance_quantity
    or p_expected_approved is distinct from line.approved_quantity then
    raise exception 'This receipt changed while the correction was open. Refresh the list and review it again.' using errcode='40001';
  end if;
  if p_corrected_ok is null or p_corrected_ok<0 or p_corrected_ok>=coalesce(line.returned_ok_quantity,0)
    or coalesce(line.returned_ok_quantity,0)+coalesce(line.returned_maintenance_quantity,0)>coalesce(line.approved_quantity,0) then
    raise exception 'Enter a lower Received OK total. Use Received for additional equipment that actually returned.' using errcode='23514';
  end if;
  delta:=line.returned_ok_quantity-p_corrected_ok;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  -- Requires enough still-Available, unreserved stock to undo this false receipt.
  perform public.hems_assert_outgoing_reservation(line.inventory_record_type::text,line.inventory_record_id,delta,parent.id,line.display_name);

  if line.inventory_record_type::text='unit' then
    if line.approved_quantity<>1 or line.returned_ok_quantity<>1 or delta<>1 or coalesce(line.returned_maintenance_quantity,0)<>0 then
      raise exception 'Review this serialized receipt before correcting it.' using errcode='23514';
    end if;
    update public.units set status='in_use' where id=line.inventory_record_id and coalesce(status::text,'available')='available';
    if not found then raise exception 'This serial is no longer Available.' using errcode='23514'; end if;
  else
    select coalesce(sum(greatest(0,(case when i.approved_quantity>0 then i.approved_quantity else i.requested_quantity end)
      -coalesce(i.returned_ok_quantity,0)-coalesce(i.returned_maintenance_quantity,0))),0)
      into active_qty from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
      where i.inventory_record_type=line.inventory_record_type and i.inventory_record_id=line.inventory_record_id
        and l.status::text in ('active','partially_returned') and l.list_type::text not in ('maintenance','transfer_in');
    if line.inventory_record_type::text='matrix_model' then
      select coalesce(in_use_qty,0) into occupied from public.matrix_models where id=line.inventory_record_id for update;
    else
      select coalesce(in_use_qty,0),item_id into occupied,stock_parent
        from public.matrix_rows where id=line.inventory_record_id for update;
      generic_row:=stock_parent is not null;
      if generic_row is distinct from (coalesce(line.metadata->>'matrix_source','')='generic') then
        raise exception 'The inventory source does not match this receipt. Review the item first.' using errcode='23514';
      end if;
    end if;
    if occupied is null or occupied<active_qty then
      raise exception 'Stock counters do not match active movements. Review stock before correcting this receipt.' using errcode='23514';
    end if;
    if line.inventory_record_type::text='matrix_model' then
      update public.matrix_models set in_use_qty=coalesce(in_use_qty,0)+delta where id=line.inventory_record_id;
    else
      update public.matrix_rows set in_use_qty=coalesce(in_use_qty,0)+delta where id=line.inventory_record_id;
      if not generic_row then
        update public.matrix_rows set available_qty=greatest(0,coalesce(qty,0)-coalesce(maintenance_qty,0)
          -coalesce(in_use_qty,0)-coalesce(in_ksa_qty,0)) where id=line.inventory_record_id;
      end if;
    end if;
  end if;
  -- Requested/Approved quantities and every Maintenance receipt stay unchanged.
  update public.equipment_list_items set returned_ok_quantity=p_corrected_ok,updated_at=at_time where id=line.id;
  select coalesce(sum(greatest(0,approved_quantity-coalesce(returned_ok_quantity,0)-coalesce(returned_maintenance_quantity,0)-missing_quantity)),0),
    coalesce(sum(coalesce(returned_ok_quantity,0)+coalesce(returned_maintenance_quantity,0)),0)
    into list_remaining,list_received from public.equipment_list_items where list_id=parent.id;
  if list_remaining<1 then raise exception 'The corrected list must still have equipment outside.' using errcode='23514'; end if;
  new_status:=case when list_received>0 then 'partially_returned' else 'active' end;
  update public.equipment_lists set status=new_status,closed_at=null,updated_at=at_time where id=parent.id;
  select nullif(btrim(full_name),'') into actor from public.profiles where id=auth.uid();
  insert into public.equipment_list_activity(list_id,action,message,actor_id,actor_name,details)
    values(parent.id,'received_quantity_corrected',line.display_name || ' Received OK corrected from ' || line.returned_ok_quantity || ' to ' || p_corrected_ok,
      auth.uid(),coalesce(actor,'Warehouse Manager'),jsonb_build_object('list_item_id',line.id,'inventory_record_id',line.inventory_record_id,
        'old_returned_ok_quantity',line.returned_ok_quantity,'new_returned_ok_quantity',p_corrected_ok,
        'returned_maintenance_quantity_unchanged',line.returned_maintenance_quantity,'reinstated_outside_quantity',delta,
        'sent_quantity',line.approved_quantity,'remaining_line_quantity',line.approved_quantity-p_corrected_ok-coalesce(line.returned_maintenance_quantity,0)-line.missing_quantity,'reason',reason));
  return jsonb_build_object('list_id',parent.id,'list_item_id',line.id,'list_status',new_status,
    'received_ok',p_corrected_ok,'reinstated',delta,'outside',line.approved_quantity-p_corrected_ok-coalesce(line.returned_maintenance_quantity,0)-line.missing_quantity);
end; $function$
;

notify pgrst, 'reload schema';
commit;

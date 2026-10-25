-- Atomic additions to dispatched delivery/event lists. Existing dispatch is preserved.
begin;
set local lock_timeout = '10s';
create or replace function public.hems_dispatch_list_addition()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  parent public.equipment_lists%rowtype;
  stock jsonb;
  delta integer;
  previous integer := 0;
  occupied integer;
  capacity integer;
  active_qty integer;
  ksa boolean;
  generic_row boolean;
  changed integer;
begin
  if tg_op = 'DELETE' then
    select * into parent from public.equipment_lists where id=old.list_id for no key update;
  else
    select * into parent from public.equipment_lists where id=new.list_id for no key update;
  end if;
  if parent.list_type::text not in ('local_event','dry_hire','transfer_out')
    or not (parent.status::text in ('active','partially_returned')
      or (parent.list_type::text='transfer_out' and parent.status::text='closed')) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then raise exception 'Receive dispatched equipment instead of deleting it.'; end if;
  if tg_op='UPDATE' then
    if new.inventory_record_id is distinct from old.inventory_record_id
      or new.inventory_record_type is distinct from old.inventory_record_type
      or new.list_id is distinct from old.list_id then raise exception 'Dispatched inventory cannot be replaced.'; end if;
    if new.requested_quantity is not distinct from old.requested_quantity then return new; end if;
    previous := old.requested_quantity;
  end if;
  if auth.uid() is null or not public.is_equipment_list_manager() then
    raise exception 'Only Admin or Warehouse Manager can add dispatched equipment.' using errcode='42501';
  end if;
  delta := new.requested_quantity-previous;
  if delta is null or delta<=0 then raise exception 'Add a positive quantity. Use Received for returns.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  ksa := parent.list_type::text='transfer_out' and coalesce(parent.destination_name,'') ~* '\m(ksa|saudi|riyadh|jeddah|dammam)\M';
  if new.inventory_record_type::text='unit' then
    if delta<>1 or previous<>0 then raise exception 'Select a different available serial number.'; end if;
    if exists (select 1 from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
      where i.inventory_record_type::text='unit' and i.inventory_record_id=new.inventory_record_id
      and l.status::text in ('active','partially_returned') and l.list_type::text not in ('maintenance','transfer_in')
      and i.approved_quantity>coalesce(i.returned_ok_quantity,0)+coalesce(i.returned_maintenance_quantity,0)) then
      raise exception 'This serial is already dispatched.';
    end if;
    if ksa then
      update public.units set status='in_ksa' where id=new.inventory_record_id and coalesce(status,'available')='available';
    else
      update public.units set status='in_use' where id=new.inventory_record_id and coalesce(status,'available')='available';
    end if;
    get diagnostics changed=row_count;
    if changed<>1 then raise exception 'This serial is no longer available.' using errcode='23514'; end if;
  elsif new.inventory_record_type::text in ('matrix_model','matrix_row') then
    if new.inventory_record_type::text='matrix_model' then
      select to_jsonb(m) into stock from public.matrix_models m where id=new.inventory_record_id for update;
      generic_row := true;
    else
      select to_jsonb(m) into stock from public.matrix_rows m where id=new.inventory_record_id for update;
      generic_row := nullif(stock->>'item_id','') is not null;
      if generic_row is distinct from (coalesce(new.metadata->>'matrix_source','')='generic') then
        raise exception 'Inventory source changed. Reopen the item and try again.';
      end if;
    end if;
    if stock is null then raise exception 'Inventory item no longer exists.'; end if;
    capacity := greatest(0,coalesce((case when generic_row then stock->>'total_qty' else stock->>'qty' end)::integer,0)
      -coalesce((stock->>'maintenance_qty')::integer,0));
    occupied := coalesce((stock->>'in_use_qty')::integer,0)+coalesce((stock->>'in_ksa_qty')::integer,0);
    select coalesce(sum(greatest(0,i.approved_quantity-coalesce(i.returned_ok_quantity,0)-coalesce(i.returned_maintenance_quantity,0))),0)::integer
      into active_qty from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
      where i.inventory_record_type=new.inventory_record_type and i.inventory_record_id=new.inventory_record_id
      and l.status::text in ('active','partially_returned') and l.list_type::text not in ('maintenance','transfer_in');
    if delta>greatest(0,capacity-greatest(occupied,active_qty)) then
      raise exception 'Only % available. Requested addition: %.',greatest(0,capacity-greatest(occupied,active_qty)),delta using errcode='23514';
    end if;
    if new.inventory_record_type::text='matrix_model' then
      update public.matrix_models set in_use_qty=coalesce(in_use_qty,0)+case when ksa then 0 else delta end,
        in_ksa_qty=coalesce(in_ksa_qty,0)+case when ksa then delta else 0 end where id=new.inventory_record_id;
    else
      update public.matrix_rows set in_use_qty=coalesce(in_use_qty,0)+case when ksa then 0 else delta end,
        in_ksa_qty=coalesce(in_ksa_qty,0)+case when ksa then delta else 0 end where id=new.inventory_record_id;
      if not generic_row then
        update public.matrix_rows set available_qty=greatest(0,coalesce(qty,0)-coalesce(maintenance_qty,0)-coalesce(in_use_qty,0)-coalesce(in_ksa_qty,0)) where id=new.inventory_record_id;
      end if;
    end if;
  elsif new.inventory_record_type::text='item' and coalesce(new.metadata->>'custom_item','false')='true' then
    null;
  else raise exception 'Unsupported inventory type.'; end if;
  new.approved_quantity := case when tg_op='UPDATE' then old.approved_quantity else 0 end + delta;
  if parent.list_type::text='transfer_out' then
    new.transfer_received_quantity := case when tg_op='UPDATE' then coalesce(old.transfer_received_quantity,0) else 0 end+delta;
    new.transfer_received_at:=now(); new.transfer_received_by:=auth.uid();
  end if;
  insert into public.equipment_list_activity(list_id,action,message,actor_id,actor_name,details)
    values(parent.id,'approved_and_dispatched',parent.reference || ' additional equipment dispatched',auth.uid(),
      coalesce((select full_name from public.profiles where id=auth.uid()),'Warehouse'),
      jsonb_build_object('supplemental',true,'record_id',new.inventory_record_id,'quantity',delta,'ksa',ksa));
  return new;
end; $$;
revoke all on function public.hems_dispatch_list_addition() from public,anon,authenticated;
drop trigger if exists hems_dispatch_list_addition on public.equipment_list_items;
create trigger hems_dispatch_list_addition before insert or update or delete on public.equipment_list_items
for each row execute function public.hems_dispatch_list_addition();
commit;

-- Definitions only. No existing receipt, list or stock row is changed on Run.
-- Requires the existing Pending Reservations SQL to be installed.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$ begin
  if to_regprocedure('public.hems_assert_outgoing_reservation(text,uuid,bigint,uuid,text)') is null then
    raise exception 'Install the Pending Reservations workflow before this patch.';
  end if;
  if md5(btrim(replace(pg_get_functiondef(to_regprocedure('public.return_equipment_list_item(uuid,integer,integer)')),chr(13),''),E' \n\t;'))
    is distinct from 'c9a067d3b03bb51223412744e1ed62a8' then
    raise exception 'The receive workflow changed since the supplied export. Stop and export it again.';
  end if;
  if md5(btrim(replace(pg_get_functiondef(to_regprocedure('public.hems_guard_shared_draft_items()')),chr(13),''),E' \n\t;'))
    is distinct from '365375b99fb971ba0bc577a88e262176' then
    raise exception 'The shared-draft workflow changed since the supplied export. Stop and export it again.';
  end if;
  if md5(btrim(replace(pg_get_functiondef(to_regprocedure('public.hems_dispatch_list_addition()')),chr(13),''),E' \n\t;'))
    is distinct from 'c279b3e4f2ab41a2cf293983ddaea760' then
    raise exception 'Install the current Pending Reservations active-addition workflow first.';
  end if;
end; $$;

create or replace function public.hems_correct_received_ok_quantity(
  p_list_item_id uuid,p_expected_ok integer,p_expected_maintenance integer,
  p_expected_approved integer,p_corrected_ok integer,p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
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
  select coalesce(sum(greatest(0,approved_quantity-coalesce(returned_ok_quantity,0)-coalesce(returned_maintenance_quantity,0))),0),
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
        'sent_quantity',line.approved_quantity,'remaining_line_quantity',line.approved_quantity-p_corrected_ok-coalesce(line.returned_maintenance_quantity,0),'reason',reason));
  return jsonb_build_object('list_id',parent.id,'list_item_id',line.id,'list_status',new_status,
    'received_ok',p_corrected_ok,'reinstated',delta,'outside',line.approved_quantity-p_corrected_ok-coalesce(line.returned_maintenance_quantity,0));
end; $$;
revoke all on function public.hems_correct_received_ok_quantity(uuid,integer,integer,integer,integer,text) from public,anon;
grant execute on function public.hems_correct_received_ok_quantity(uuid,integer,integer,integer,integer,text) to authenticated;

-- Positive additions for the generic Matrix/Truss/Cable inventory control.
-- This RPC adds a DELTA atomically; it is not a receipt correction.
create or replace function public.hems_add_active_matrix_quantity(
  p_list_id uuid,p_record_type text,p_record_id uuid,p_quantity integer,
  p_parent_id uuid,p_display_name text,p_block_name text,p_metadata jsonb,p_expected_requested bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare parent public.equipment_lists%rowtype; line public.equipment_list_items%rowtype;
  record_type public.equipment_list_items.inventory_record_type%type;
  previous_requested integer; previous_approved integer; target_id uuid; result jsonb;
begin
  if auth.uid() is null or public.is_equipment_list_manager() is not true then
    raise exception 'Only Warehouse Manager or Admin can add dispatched equipment.' using errcode='42501'; end if;
  if p_record_type is null or p_record_type not in ('matrix_model','matrix_row') or p_record_id is null or p_quantity is null or p_quantity<1 then
    raise exception 'Choose registered Matrix equipment and a positive additional quantity.' using errcode='23514'; end if;
  record_type:=p_record_type;
  -- Lock an existing line before its parent, matching Received/Correction.
  select * into line from public.equipment_list_items where list_id=p_list_id
    and inventory_record_type=record_type and inventory_record_id=p_record_id order by created_at,id limit 1 for update;
  select * into parent from public.equipment_lists where id=p_list_id for update;
  if not found or parent.list_type::text not in ('local_event','dry_hire','transfer_out')
    or not (parent.status::text in ('active','partially_returned') or (parent.list_type::text='transfer_out' and parent.status::text='closed')) then
    raise exception 'This list is no longer eligible for additional dispatch. Reopen the list to review its status.' using errcode='23514'; end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  -- A line may have been added while waiting for the parent lock.
  select * into line from public.equipment_list_items where list_id=p_list_id
    and inventory_record_type=record_type and inventory_record_id=p_record_id order by created_at,id limit 1 for update;
  if p_record_type='matrix_row' and not exists(select 1 from public.matrix_rows where id=p_record_id and item_id is not null) then
    raise exception 'Use the LED cabinet picker for this inventory row.' using errcode='23514'; end if;
  -- A stale screen (including a lost success response) must not dispatch twice.
  if p_expected_requested is null or p_expected_requested is distinct from
    (select coalesce(sum(requested_quantity),0)::bigint from public.equipment_list_items
      where list_id=parent.id and inventory_record_type=record_type and inventory_record_id=p_record_id) then
    raise exception 'This list quantity changed. Refresh the list and review the additional dispatch before trying again.' using errcode='40001'; end if;
  perform public.hems_assert_outgoing_reservation(p_record_type,p_record_id,p_quantity,parent.id,p_display_name);
  previous_requested:=coalesce(line.requested_quantity,0); previous_approved:=coalesce(line.approved_quantity,0);
  if line.id is not null then
    update public.equipment_list_items set requested_quantity=previous_requested+p_quantity,updated_at=now()
      where id=line.id returning id into target_id;
  else
    if nullif(btrim(p_display_name),'') is null then raise exception 'Equipment name is required.'; end if;
    insert into public.equipment_list_items(list_id,inventory_record_type,inventory_record_id,parent_record_id,
      display_name,serial_number,block_name,requested_quantity,approved_quantity,metadata)
      values(parent.id,record_type,p_record_id,p_parent_id,btrim(p_display_name),null,p_block_name,p_quantity,0,
        coalesce(p_metadata,'{}'::jsonb) || jsonb_build_object('matrix_source','generic','custom_item',false)) returning id into target_id;
  end if;
  -- The existing addition trigger must perform dispatch and audit atomically.
  select * into line from public.equipment_list_items where id=target_id;
  if line.approved_quantity is distinct from previous_approved+p_quantity
    or line.requested_quantity is distinct from previous_requested+p_quantity then
    raise exception 'The active dispatch trigger is not configured. No addition was saved.' using errcode='23514'; end if;
  select jsonb_build_object('id',target_id,'requested_quantity',sum(requested_quantity),'approved_quantity',sum(approved_quantity),
    'returned_ok_quantity',sum(coalesce(returned_ok_quantity,0)),'returned_maintenance_quantity',sum(coalesce(returned_maintenance_quantity,0)))
    into result from public.equipment_list_items where list_id=parent.id and inventory_record_type=record_type and inventory_record_id=p_record_id;
  update public.equipment_lists set updated_at=now() where id=parent.id;
  return result;
end; $$;
revoke all on function public.hems_add_active_matrix_quantity(uuid,text,uuid,integer,uuid,text,text,jsonb,bigint) from public,anon;
grant execute on function public.hems_add_active_matrix_quantity(uuid,text,uuid,integer,uuid,text,text,jsonb,bigint) to authenticated;
notify pgrst,'reload schema';
commit;

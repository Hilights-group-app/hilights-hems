-- Pending reservations: derived from live Pending lines, not physical stock.
-- Run the read-only preflight first. This migration aborts on existing conflicts.
-- Based on the database function definitions exported 2026-11-02 by the owner.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Block concurrent list edits only during this short schema transaction.
lock table public.equipment_lists,public.equipment_list_items in share row exclusive mode;

-- Refuse to overwrite a workflow changed after the supplied export.
do $$ begin
  if md5(btrim(replace(pg_get_functiondef('public.approve_and_dispatch_equipment_list(uuid)'::regprocedure),chr(13),''),E' \n\t;')) not in ('ef808fa8946aa5c0967d24aac83b8e06','1b92c3647a3252163ba5ba4dd02289f5') then
    raise exception 'approve_and_dispatch_equipment_list changed since export. Stop and export the current workflow again.';
  end if;
  if md5(btrim(replace(pg_get_functiondef('public.hems_dispatch_list_addition()'::regprocedure),chr(13),''),E' \n\t;')) not in ('8e7d335d45802559080c7a8afe727cc2','c279b3e4f2ab41a2cf293983ddaea760') then
    raise exception 'hems_dispatch_list_addition changed since export. Stop and export the current workflow again.';
  end if;
  if md5(btrim(replace(pg_get_functiondef('public.hems_guard_draft_matrix_quantity()'::regprocedure),chr(13),''),E' \n\t;')) not in ('b92feeb57248a36ae3db3f41d817ae31','b08bc2ecd093203234f2d45e5c9960a2') then
    raise exception 'hems_guard_draft_matrix_quantity changed since export. Stop and export the current workflow again.';
  end if;
end; $$;

create index if not exists hems_pending_reservation_record_idx
  on public.equipment_list_items(inventory_record_id,inventory_record_type,list_id);
create index if not exists hems_pending_reservation_lists_idx
  on public.equipment_lists(status,list_type,id);

-- Internal functions: callable only by the definer-owned guards below.
-- VOLATILE is deliberate: after waiting for the dispatch advisory lock each
-- SQL read must see newly committed reservations, not an outer-query snapshot.
create or replace function public.hems_pending_reserved_quantity(
  p_type text, p_record_id uuid, p_exclude_list uuid default null
) returns bigint language sql volatile security definer set search_path = '' as $$
  select coalesce(sum(i.requested_quantity),0)::bigint
  from public.equipment_list_items i
  join public.equipment_lists l on l.id=i.list_id
  where i.inventory_record_type::text=p_type and i.inventory_record_id=p_record_id
    and (p_exclude_list is null or i.list_id<>p_exclude_list)
    and l.status::text='pending'
    and l.list_type::text in ('local_event','dry_hire','transfer_out','internal_use')
    and i.inventory_record_type::text in ('unit','matrix_model','matrix_row');
$$;

create or replace function public.hems_outgoing_free_quantity(p_type text,p_record_id uuid)
returns bigint language plpgsql volatile security definer set search_path = '' as $$
declare stock jsonb; total bigint; occupied bigint; movements bigint;
begin
  if p_type='unit' then
    select jsonb_build_object('status',u.status) into stock from public.units u where id=p_record_id for update;
    if stock is null then raise exception 'Selected unit no longer exists.' using errcode='23514'; end if;
    if coalesce(stock->>'status','available')<>'available' then return 0; end if;
    if exists(select 1 from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
      where i.inventory_record_type::text='unit' and i.inventory_record_id=p_record_id
        and l.status::text in ('active','partially_returned')
        and l.list_type::text not in ('maintenance','transfer_in')
        and (case when i.approved_quantity>0 then i.approved_quantity else i.requested_quantity end)>coalesce(i.returned_ok_quantity,0)+coalesce(i.returned_maintenance_quantity,0)) then return 0; end if;
    return 1;
  elsif p_type='matrix_model' then
    select jsonb_build_object('total_qty',m.total_qty,'maintenance_qty',m.maintenance_qty,
      'in_use_qty',m.in_use_qty,'in_ksa_qty',m.in_ksa_qty) into stock
      from public.matrix_models m where id=p_record_id for update;
  elsif p_type='matrix_row' then
    select jsonb_build_object('item_id',m.item_id,'qty',m.qty,'total_qty',m.total_qty,
      'maintenance_qty',m.maintenance_qty,'in_use_qty',m.in_use_qty,'in_ksa_qty',m.in_ksa_qty) into stock
      from public.matrix_rows m where id=p_record_id for update;
  else raise exception 'Unsupported outgoing inventory type.' using errcode='23514'; end if;
  if stock is null then raise exception 'Selected stock record no longer exists.' using errcode='23514'; end if;
  total:=greatest(0,coalesce((case when p_type='matrix_model' or nullif(stock->>'item_id','') is not null
    then stock->>'total_qty' else stock->>'qty' end)::bigint,0)-coalesce((stock->>'maintenance_qty')::bigint,0));
  occupied:=greatest(0,coalesce((stock->>'in_use_qty')::bigint,0)+coalesce((stock->>'in_ksa_qty')::bigint,0));
  select coalesce(sum(greatest(0,
    (case when i.approved_quantity>0 then i.approved_quantity else i.requested_quantity end)
    -coalesce(i.returned_ok_quantity,0)-coalesce(i.returned_maintenance_quantity,0))),0)::bigint
    into movements from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
    where i.inventory_record_type::text=p_type and i.inventory_record_id=p_record_id
      and l.status::text in ('active','partially_returned') and l.list_type::text not in ('maintenance','transfer_in');
  return greatest(0,total-greatest(occupied,movements));
end; $$;

create or replace function public.hems_assert_outgoing_reservation(
  p_type text,p_record_id uuid,p_quantity bigint,p_exclude_list uuid,p_name text
) returns void language plpgsql volatile security definer set search_path = '' as $$
declare free bigint; reserved bigint; usable bigint; label text;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Reservation changes require Read Committed isolation. Retry through the app.' using errcode='40001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  free:=public.hems_outgoing_free_quantity(p_type,p_record_id);
  reserved:=public.hems_pending_reserved_quantity(p_type,p_record_id,p_exclude_list);
  usable:=greatest(0,free-reserved);
  label:=coalesce(p_name,p_record_id::text);
  if p_type='unit' then
    select coalesce(p_name,p_record_id::text) || ' · ID ' || coalesce(u.unit_no::text,u.id::text)
      || case when nullif(btrim(u.serial),'') is null then '' else ' · Serial ' || u.serial end
      into label from public.units u where u.id=p_record_id;
  end if;
  if p_quantity is null or p_quantity<1 or p_quantity>usable or (p_type='unit' and p_quantity<>1) then
    raise exception 'Only % available for %. Requested: %. Reserved in other Pending lists: %.',
      usable,coalesce(label,p_name,p_record_id::text),p_quantity,reserved
      using errcode='23514', detail=jsonb_build_object('record_type',p_type,'record_id',p_record_id,
        'available',usable,'requested',p_quantity,'reserved',reserved)::text;
  end if;
end; $$;

create or replace function public.hems_guard_pending_reservation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare line record;
begin
  if new.status::text<>'pending' or new.list_type::text not in ('local_event','dry_hire','transfer_out','internal_use') then return new; end if;
  if tg_op='INSERT' then raise exception 'Create a Draft before submitting equipment.' using errcode='23514'; end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  if not exists(select 1 from public.equipment_list_items where list_id=new.id) then
    raise exception 'Add at least one item before submitting.' using errcode='23514'; end if;
  if exists(select 1 from public.equipment_list_items where list_id=new.id and (
    requested_quantity is null or requested_quantity<1 or
    (inventory_record_type::text='item' and coalesce(metadata->>'custom_item','false')<>'true') or
    (inventory_record_type::text<>'item' and coalesce(metadata->>'custom_item','false')='true')
  )) then raise exception 'Review invalid or incorrectly marked custom equipment before submitting.' using errcode='23514'; end if;
  for line in select inventory_record_type::text as kind, inventory_record_id, min(display_name) as name,
      sum(requested_quantity)::bigint as quantity
    from public.equipment_list_items where list_id=new.id and inventory_record_type::text<>'item'
    group by inventory_record_type,inventory_record_id order by inventory_record_type,inventory_record_id
  loop
    perform public.hems_assert_outgoing_reservation(line.kind,line.inventory_record_id,line.quantity,new.id,line.name);
  end loop;
  return new;
end; $$;

create or replace function public.hems_guard_reserved_list_item()
returns trigger language plpgsql security definer set search_path = '' as $$
declare parent public.equipment_lists%rowtype; wanted bigint;
begin
  if tg_op='UPDATE' and new.requested_quantity is not distinct from old.requested_quantity
    and new.inventory_record_id is not distinct from old.inventory_record_id
    and new.inventory_record_type is not distinct from old.inventory_record_type
    and new.list_id is not distinct from old.list_id
    and new.metadata->>'custom_item' is not distinct from old.metadata->>'custom_item' then return new; end if;
  select * into parent from public.equipment_lists where id=new.list_id for no key update;
  if not found then raise exception 'Equipment list not found.' using errcode='23514'; end if;
  if parent.list_type::text not in ('local_event','dry_hire','transfer_out','internal_use')
    or parent.status::text not in ('draft','pending') then return new; end if;
  if new.inventory_record_type::text='item' then return new; end if;
  if coalesce(new.metadata->>'custom_item','false')='true' then
    raise exception 'Inventory equipment cannot be marked as custom.' using errcode='23514'; end if;
  -- Matrix draft edits already use the existing, updated quantity guard.
  if parent.status::text='draft' and new.inventory_record_type::text<>'unit' then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  select coalesce(sum(requested_quantity),0)+coalesce(new.requested_quantity,0) into wanted
    from public.equipment_list_items where list_id=new.list_id
      and inventory_record_type=new.inventory_record_type and inventory_record_id=new.inventory_record_id
      and id is distinct from new.id;
  perform public.hems_assert_outgoing_reservation(new.inventory_record_type::text,new.inventory_record_id,wanted,new.list_id,new.display_name);
  return new;
end; $$;

-- Only aggregate stock identity and quantity are exposed, never Pending list
-- references, people, client names, notes, or list IDs the caller cannot view.
create or replace function public.hems_pending_reservations()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in to read availability.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) into result from (
    select i.inventory_record_type::text as record_type,i.inventory_record_id as record_id,
      case when i.inventory_record_type::text='unit' then u.item_id
        when i.inventory_record_type::text='matrix_row' then coalesce(m.item_id,m.model_id)
        else i.inventory_record_id end as parent_id,
      sum(i.requested_quantity)::bigint as quantity,
      sum(case when i.inventory_record_type::text<>'unit' or coalesce(u.status::text,'available')='available'
        then i.requested_quantity else 0 end)::bigint as available_quantity
    from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
    left join public.units u on i.inventory_record_type::text='unit' and u.id=i.inventory_record_id
    left join public.matrix_rows m on i.inventory_record_type::text='matrix_row' and m.id=i.inventory_record_id
    where l.status::text='pending' and l.list_type::text in ('local_event','dry_hire','transfer_out','internal_use')
      and i.inventory_record_type::text in ('unit','matrix_model','matrix_row')
    group by i.inventory_record_type,i.inventory_record_id,u.item_id,m.item_id,m.model_id
  ) t;
  return result;
end; $$;

-- Private helpers/triggers must not be called as RPCs by clients.
revoke all on function public.hems_pending_reserved_quantity(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.hems_outgoing_free_quantity(text,uuid) from public,anon,authenticated;
revoke all on function public.hems_assert_outgoing_reservation(text,uuid,bigint,uuid,text) from public,anon,authenticated;
revoke all on function public.hems_guard_pending_reservation() from public,anon,authenticated;
revoke all on function public.hems_guard_reserved_list_item() from public,anon,authenticated;
revoke all on function public.hems_pending_reservations() from public,anon;
grant execute on function public.hems_pending_reservations() to authenticated;

CREATE OR REPLACE FUNCTION public.approve_and_dispatch_equipment_list(p_list_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_list public.equipment_lists%rowtype;
  v_item_lines integer;
  v_unit_lines integer;
  v_requested_quantity integer;
  v_updated_units integer;
  v_approved_at timestamptz := now();
  v_actor_name text;
  v_line record;
  v_capacity integer;
  v_legacy_quantity integer;
  v_active_quantity integer;
  v_available_quantity integer;
  v_department text;
  v_report_href text;
  v_source_summary text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;

  if not public.is_equipment_list_manager() then
    raise exception 'Only a Warehouse Manager or Admin can approve this list.'
      using errcode = '42501';
  end if;

  select * into v_list
  from public.equipment_lists
  where id = p_list_id
  for update;

  if not found then
    raise exception 'Equipment list not found.' using errcode = 'P0002';
  end if;

  if v_list.status <> 'pending' then
    raise exception 'Only a Pending list can be approved.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(742193, 1);

  select
    count(*)::integer,
    count(*) filter (where inventory_record_type = 'unit')::integer,
    coalesce(sum(requested_quantity), 0)::integer
  into v_item_lines, v_unit_lines, v_requested_quantity
  from public.equipment_list_items
  where list_id = p_list_id;

  if v_item_lines = 0 then
    raise exception 'Add at least one equipment item before approval.';
  end if;

  if exists (
    select inventory_record_type, inventory_record_id
    from public.equipment_list_items
    where list_id = p_list_id
    group by inventory_record_type, inventory_record_id
    having count(*) > 1
  ) then
    raise exception 'The list contains a duplicated inventory record.';
  end if;

  select nullif(btrim(full_name), '') into v_actor_name
  from public.profiles where id = auth.uid();

  if v_list.list_type::text = 'transfer_in' then
    for v_line in select * from public.equipment_list_items where list_id=p_list_id order by inventory_record_type,inventory_record_id loop
      if v_line.inventory_record_type::text='item' then
        if coalesce(v_line.metadata->>'custom_item','false')='true' and v_line.requested_quantity>=1 then continue; end if;
        raise exception 'Only custom items may be outside registered KSA stock.' using errcode='23514';
      end if;
      if coalesce(v_line.metadata->>'custom_item','false')='true' then raise exception 'Inventory equipment cannot be marked as custom.' using errcode='23514'; end if;
      v_capacity := public.hems_ksa_capacity(v_line.inventory_record_type::text,v_line.inventory_record_id);
      select coalesce(sum(greatest(0,i.requested_quantity-coalesce(i.returned_ok_quantity,0)-coalesce(i.returned_maintenance_quantity,0))),0)::integer
        into v_active_quantity from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
        where l.list_type::text='transfer_in' and l.status::text in ('draft','pending','active','partially_returned')
        and i.inventory_record_type=v_line.inventory_record_type and i.inventory_record_id=v_line.inventory_record_id and i.id<>v_line.id;
      if v_line.requested_quantity<1 or v_line.requested_quantity>greatest(0,v_capacity-v_active_quantity)
        or (v_line.inventory_record_type::text='unit' and v_line.requested_quantity<>1) then
        raise exception 'KSA quantity changed for %. Review and try again.',v_line.display_name using errcode='23514';
      end if;
    end loop;
    update public.equipment_list_items set approved_quantity=requested_quantity,updated_at=v_approved_at where list_id=p_list_id;
    if exists (select 1 from public.equipment_list_items where list_id=p_list_id and inventory_record_type::text<>'item') then
      update public.equipment_lists set status='active',approved_by=auth.uid(),approved_at=v_approved_at,updated_at=v_approved_at where id=p_list_id;
    else
      update public.equipment_lists set status='closed',closed_at=v_approved_at,approved_by=auth.uid(),approved_at=v_approved_at,updated_at=v_approved_at where id=p_list_id;
    end if;
    insert into public.equipment_list_activity(list_id,action,message,actor_id,actor_name,details)
      values(p_list_id,'transfer_in_approved',v_list.reference || ' returning from KSA',auth.uid(),coalesce(v_actor_name,'Warehouse'),jsonb_build_object('approved_quantity',v_requested_quantity));
    return jsonb_build_object('id',p_list_id,'status',(select status from public.equipment_lists where id=p_list_id),'approved_at',v_approved_at,'approved_by',auth.uid());
  end if;

  -- Maintenance dispatch tracks already-broken equipment. It never removes
  -- Available inventory and never increments In Use.
  if v_list.list_type = 'maintenance' then
    if exists (
      select 1 from public.equipment_list_items
      where list_id = p_list_id
        and inventory_record_type not in ('unit', 'matrix_model', 'matrix_row')
    ) then
      raise exception 'A maintenance list can contain only registered inventory.';
    end if;

    for v_line in
      select *
      from public.equipment_list_items
      where list_id = p_list_id
      order by created_at
    loop
      v_department := public.hems_inventory_department(
        v_line.metadata ->> 'category',
        v_line.metadata ->> 'subcategory'
      );

      if v_line.inventory_record_type = 'unit' then
        perform 1
        from public.units
        where id = v_line.inventory_record_id
          and status = 'maintenance'
        for update;

        if not found then
          raise exception '% is not currently in Maintenance.', v_line.display_name;
        end if;

        if exists (
          select 1
          from public.maintenance_requests request
          where request.inventory_record_type = 'unit'
            and request.inventory_record_id = v_line.inventory_record_id
            and request.source_type = 'maintenance'
            and request.status in ('sent', 'received')
        ) then
          raise exception '% is already assigned to an active repair list.', v_line.display_name;
        end if;
      else
        if v_line.inventory_record_type = 'matrix_model' then
          select greatest(0, coalesce(maintenance_qty, 0))
          into v_capacity
          from public.matrix_models
          where id = v_line.inventory_record_id
          for update;
        else
          select greatest(0, coalesce(maintenance_qty, 0))
          into v_capacity
          from public.matrix_rows
          where id = v_line.inventory_record_id
          for update;
        end if;

        if not found then
          raise exception 'One selected maintenance item no longer exists.';
        end if;

        select coalesce(sum(greatest(0, quantity - tested_quantity)), 0)::integer
        into v_active_quantity
        from public.maintenance_requests request
        where request.inventory_record_type = v_line.inventory_record_type
          and request.inventory_record_id = v_line.inventory_record_id
          and request.source_type = 'maintenance'
          and request.status in ('sent', 'received');

        if v_line.requested_quantity > greatest(0, v_capacity - v_active_quantity) then
          raise exception
            'Only % Maintenance unit(s) are available for %. Requested: %.',
            greatest(0, v_capacity - v_active_quantity),
            v_line.display_name,
            v_line.requested_quantity;
        end if;
      end if;
    end loop;

    update public.equipment_list_items
    set approved_quantity = requested_quantity, updated_at = v_approved_at
    where list_id = p_list_id;

    v_source_summary := case
      when nullif(btrim(v_list.repair_company), '') is not null
        then 'At ' || btrim(v_list.repair_company) || ' for Repair'
      else 'External Repair'
    end;

    for v_line in
      select *
      from public.equipment_list_items
      where list_id = p_list_id
      order by created_at
    loop
      v_department := public.hems_inventory_department(
        v_line.metadata ->> 'category',
        v_line.metadata ->> 'subcategory'
      );

      v_report_href := null;
      if v_line.inventory_record_type = 'unit'
        and coalesce(v_line.metadata ->> 'category', '') <> ''
        and coalesce(v_line.metadata ->> 'subcategory', '') <> ''
        and coalesce(v_line.metadata ->> 'item_id', '') <> '' then
        v_report_href := '/inventory/' || (v_line.metadata ->> 'category')
          || '/' || (v_line.metadata ->> 'subcategory')
          || '/' || (v_line.metadata ->> 'item_id');
      elsif v_line.inventory_record_type = 'matrix_row'
        and coalesce(v_line.metadata ->> 'matrix_source', '') <> 'generic'
        and coalesce(v_line.metadata ->> 'category', '') <> ''
        and coalesce(v_line.metadata ->> 'subcategory', '') <> '' then
        v_report_href := '/inventory/' || (v_line.metadata ->> 'category')
          || '/' || (v_line.metadata ->> 'subcategory')
          || '/led-report/' || v_line.inventory_record_id::text;
      elsif coalesce(v_line.metadata ->> 'category', '') <> ''
        and coalesce(v_line.metadata ->> 'subcategory', '') <> '' then
        v_report_href := '/inventory/' || (v_line.metadata ->> 'category')
          || '/' || (v_line.metadata ->> 'subcategory');
      end if;

      insert into public.maintenance_requests (
        list_id, list_item_id, inventory_record_type, inventory_record_id,
        parent_record_id, display_name, serial_number, quantity,
        received_quantity, tested_quantity, department, source_reference,
        source_type, source_summary, report_href, status, created_by,
        created_by_name, metadata
      ) values (
        v_list.id, v_line.id, v_line.inventory_record_type,
        v_line.inventory_record_id, v_line.parent_record_id,
        v_line.display_name, v_line.serial_number, v_line.requested_quantity,
        0, 0, v_department, v_list.reference, 'maintenance',
        v_source_summary, v_report_href, 'sent', auth.uid(),
        coalesce(v_actor_name, 'Warehouse Manager'),
        jsonb_build_object(
          'repair_company', v_list.repair_company,
          'sent_date', v_list.maintenance_sent_date,
          'equipment_metadata', v_line.metadata
        )
      );
    end loop;

    update public.equipment_lists
    set status = 'active', approved_by = auth.uid(),
        approved_at = v_approved_at, updated_at = v_approved_at
    where id = p_list_id;

    insert into public.equipment_list_activity (
      list_id, action, message, actor_id, actor_name, details
    ) values (
      p_list_id, 'sent_for_maintenance',
      v_list.reference || ' sent to ' || coalesce(v_list.repair_company, 'repair'),
      auth.uid(), coalesce(v_actor_name, 'Warehouse Manager'),
      jsonb_build_object(
        'item_lines', v_item_lines,
        'approved_quantity', v_requested_quantity,
        'repair_company', v_list.repair_company
      )
    );

    return jsonb_build_object(
      'id', p_list_id,
      'reference', v_list.reference,
      'status', 'active',
      'approved_by', auth.uid(),
      'approved_at', v_approved_at,
      'approved_quantity', v_requested_quantity,
      'workflow', 'maintenance'
    );
  end if;

  if exists (
    select 1 from public.equipment_list_items
    where list_id = p_list_id
      and inventory_record_type not in ('unit', 'item', 'matrix_model', 'matrix_row')
  ) then
    raise exception 'This approval step does not support one selected record type.';
  end if;

  -- Own Pending reservation is excluded; physical counters are changed only
  -- by the original dispatch below. Other Pending lists remain protected.
  for v_line in select inventory_record_type::text as kind,inventory_record_id,
      sum(requested_quantity)::bigint as quantity,min(display_name) as name
    from public.equipment_list_items where list_id=p_list_id and inventory_record_type::text<>'item'
    group by inventory_record_type,inventory_record_id order by inventory_record_type,inventory_record_id
  loop
    perform public.hems_assert_outgoing_reservation(v_line.kind,v_line.inventory_record_id,v_line.quantity,p_list_id,v_line.name);
  end loop;

  for v_line in
    select inventory_record_type, inventory_record_id, metadata,
      sum(requested_quantity)::integer as requested_quantity
    from public.equipment_list_items
    where list_id = p_list_id
      and inventory_record_type in ('matrix_model', 'matrix_row')
    group by inventory_record_type, inventory_record_id, metadata
  loop
    if v_line.inventory_record_type = 'matrix_model' then
      select
        greatest(0, coalesce(total_qty, 0) - coalesce(maintenance_qty, 0)),
        greatest(0, coalesce(in_use_qty, 0) + coalesce(in_ksa_qty, 0))
      into v_capacity, v_legacy_quantity
      from public.matrix_models
      where id = v_line.inventory_record_id
      for update;
    elsif coalesce(v_line.metadata ->> 'matrix_source', '') = 'generic' then
      select
        greatest(0, coalesce(total_qty, 0) - coalesce(maintenance_qty, 0)),
        greatest(0, coalesce(in_use_qty, 0) + coalesce(in_ksa_qty, 0))
      into v_capacity, v_legacy_quantity
      from public.matrix_rows
      where id = v_line.inventory_record_id
      for update;
    else
      select
        greatest(0, coalesce(qty, 0) - coalesce(maintenance_qty, 0)),
        greatest(0, coalesce(in_use_qty, 0) + coalesce(in_ksa_qty, 0))
      into v_capacity, v_legacy_quantity
      from public.matrix_rows
      where id = v_line.inventory_record_id
      for update;
    end if;

    if not found then
      raise exception 'One selected Matrix item no longer exists.';
    end if;

    select coalesce(sum(greatest(
      0,
      (case when item.approved_quantity > 0
        then item.approved_quantity else item.requested_quantity end)
      - item.returned_ok_quantity - item.returned_maintenance_quantity
    )), 0)::integer
    into v_active_quantity
    from public.equipment_list_items item
    join public.equipment_lists active_list on active_list.id = item.list_id
    where item.inventory_record_type = v_line.inventory_record_type
      and item.inventory_record_id = v_line.inventory_record_id
      and active_list.status in ('active', 'partially_returned')
      and active_list.list_type not in ('maintenance','transfer_in')
      and item.list_id <> p_list_id;

    v_available_quantity := greatest(
      0, v_capacity - greatest(v_legacy_quantity, v_active_quantity)
    );

    if v_line.requested_quantity > v_available_quantity then
      raise exception
        'Only % unit(s) are available for one selected Matrix item. Requested: %.',
        v_available_quantity, v_line.requested_quantity;
    end if;
  end loop;

  update public.units unit_row
  set status = 'in_use'
  where unit_row.id in (
    select inventory_record_id from public.equipment_list_items
    where list_id = p_list_id and inventory_record_type = 'unit'
  )
    and coalesce(unit_row.status, 'available') = 'available';

  get diagnostics v_updated_units = row_count;
  if v_updated_units <> v_unit_lines then
    raise exception 'One or more selected serial numbers are no longer available. Review the list and try again.';
  end if;

  update public.equipment_list_items
  set approved_quantity = requested_quantity, updated_at = v_approved_at
  where list_id = p_list_id;

  with dispatched as (
    select inventory_record_id, sum(requested_quantity)::integer quantity
    from public.equipment_list_items
    where list_id = p_list_id and inventory_record_type = 'matrix_model'
    group by inventory_record_id
  )
  update public.matrix_models model
  set in_use_qty = coalesce(model.in_use_qty, 0) + dispatched.quantity
  from dispatched where model.id = dispatched.inventory_record_id;

  with dispatched as (
    select inventory_record_id, sum(requested_quantity)::integer quantity
    from public.equipment_list_items
    where list_id = p_list_id and inventory_record_type = 'matrix_row'
      and coalesce(metadata ->> 'matrix_source', '') = 'generic'
    group by inventory_record_id
  )
  update public.matrix_rows matrix_row
  set in_use_qty = coalesce(matrix_row.in_use_qty, 0) + dispatched.quantity
  from dispatched where matrix_row.id = dispatched.inventory_record_id;

  with dispatched as (
    select inventory_record_id, sum(requested_quantity)::integer quantity
    from public.equipment_list_items
    where list_id = p_list_id and inventory_record_type = 'matrix_row'
      and coalesce(metadata ->> 'matrix_source', '') <> 'generic'
    group by inventory_record_id
  )
  update public.matrix_rows matrix_row
  set
    in_use_qty = coalesce(matrix_row.in_use_qty, 0) + dispatched.quantity,
    available_qty = greatest(
      0,
      coalesce(matrix_row.qty, 0)
        - coalesce(matrix_row.maintenance_qty, 0)
        - coalesce(matrix_row.in_ksa_qty, 0)
        - coalesce(matrix_row.in_use_qty, 0)
        - dispatched.quantity
    )
  from dispatched where matrix_row.id = dispatched.inventory_record_id;

  update public.equipment_lists
  set status = 'active', approved_by = auth.uid(),
      approved_at = v_approved_at, updated_at = v_approved_at
  where id = p_list_id;

  insert into public.equipment_list_activity (
    list_id, action, message, actor_id, actor_name, details
  ) values (
    p_list_id, 'approved_and_dispatched',
    v_list.reference || ' approved and dispatched', auth.uid(),
    coalesce(v_actor_name, 'Warehouse Manager'),
    jsonb_build_object(
      'item_lines', v_item_lines,
      'approved_quantity', v_requested_quantity
    )
  );

  if v_list.list_type::text = 'transfer_out' then
    perform public.hems_archive_transfer_out(p_list_id);
    return jsonb_build_object('id',p_list_id,'status','closed','approved_at',v_approved_at,'approved_by',auth.uid());
  end if;

  return jsonb_build_object(
    'id', p_list_id, 'reference', v_list.reference, 'status', 'active',
    'approved_by', auth.uid(), 'approved_at', v_approved_at,
    'approved_quantity', v_requested_quantity
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.hems_dispatch_list_addition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if new.inventory_record_type::text in ('unit','matrix_model','matrix_row') then
    perform public.hems_assert_outgoing_reservation(new.inventory_record_type::text,new.inventory_record_id,delta,parent.id,new.display_name);
  end if;
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


drop trigger if exists zz_hems_pending_reservation on public.equipment_lists;
create trigger zz_hems_pending_reservation before insert or update on public.equipment_lists
for each row execute function public.hems_guard_pending_reservation();
drop trigger if exists zz_hems_reserved_list_item on public.equipment_list_items;
create trigger zz_hems_reserved_list_item before insert or update on public.equipment_list_items
for each row execute function public.hems_guard_reserved_list_item();

-- Validate ALL existing Pending allocations together. Do not silently assign
-- priority, change quantities/statuses, or consume stock while installing.
do $$ declare line record; begin
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  if exists(select 1 from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
    where l.status::text='pending' and l.list_type::text in ('local_event','dry_hire','transfer_out','internal_use')
      and (i.requested_quantity is null or i.requested_quantity<1
        or (i.inventory_record_type::text='item' and coalesce(i.metadata->>'custom_item','false')<>'true')
        or (i.inventory_record_type::text<>'item' and coalesce(i.metadata->>'custom_item','false')='true'))) then
    raise exception 'Review invalid/custom Pending lines before enabling reservations.' using errcode='23514';
  end if;
  for line in select l.id,l.reference,i.inventory_record_type::text as kind,i.inventory_record_id,
      sum(i.requested_quantity)::bigint as quantity,min(i.display_name) as name
    from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
    where l.status::text='pending' and l.list_type::text in ('local_event','dry_hire','transfer_out','internal_use')
      and i.inventory_record_type::text in ('unit','matrix_model','matrix_row')
    group by l.id,l.reference,i.inventory_record_type,i.inventory_record_id
    order by i.inventory_record_type,i.inventory_record_id,l.id
  loop
    perform public.hems_assert_outgoing_reservation(line.kind,line.inventory_record_id,line.quantity,line.id,line.reference || ' · ' || line.name);
  end loop;
end; $$;
notify pgrst,'reload schema';
commit;


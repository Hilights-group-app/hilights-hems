-- Run after ksa-transfer-workflow.sql (and the existing draft sharing/order SQL).
begin;
create or replace function public.hems_cancel_pending_list(p_list_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare parent public.equipment_lists%rowtype;
begin
  if auth.uid() is null or public.is_equipment_list_manager() is not true then
    raise exception 'Only Warehouse or Admin can cancel a submitted list.' using errcode='42501';
  end if;
  -- Same parent lock as approval: cancellation cannot race a dispatch.
  select * into parent from public.equipment_lists where id=p_list_id for update;
  if not found then return jsonb_build_object('id',p_list_id,'status','deleted'); end if;
  if parent.list_type::text='internal_use' then raise exception 'Submitted list not found.' using errcode='42501'; end if;
  if parent.status::text<>'pending' or parent.approved_at is not null
    or exists(select 1 from public.equipment_list_items where list_id=p_list_id and coalesce(approved_quantity,0)>0) then
    raise exception 'Only a Pending list can be cancelled. Approved equipment must follow its receipt or return workflow.' using errcode='42501';
  end if;
  -- No stock was dispatched. Cascading foreign keys remove the lines,
  -- maintenance requests and list activity, as with existing Draft deletion.
  delete from public.equipment_list_activity where list_id=p_list_id;
  delete from public.equipment_lists where id=p_list_id;
  return jsonb_build_object('id',p_list_id,'status','deleted');
end; $$;
revoke all on function public.hems_cancel_pending_list(uuid) from public, anon;
grant execute on function public.hems_cancel_pending_list(uuid) to authenticated;

-- Match the existing inventory picker's LED size units and decimal formats.
create or replace function public.hems_ksa_cabinet_area(p_size text)
returns numeric language plpgsql immutable security invoker set search_path = '' as $$
declare dimensions text[]; width numeric; height numeric; width_unit text; height_unit text;
  normalized text:=lower(replace(replace(replace(coalesce(p_size,''),',','.'),'×','x'),'*','x'));
begin
  dimensions:=regexp_match(normalized,'([0-9]+[.]?[0-9]*)\s*(mm|cm|m)?\s*x\s*([0-9]+[.]?[0-9]*)\s*(mm|cm|m)?');
  if dimensions is null then return 0; end if;
  width:=dimensions[1]::numeric;height:=dimensions[3]::numeric;
  width_unit:=coalesce(nullif(dimensions[2],''),nullif(dimensions[4],''),'');
  height_unit:=coalesce(nullif(dimensions[4],''),nullif(dimensions[2],''),'');
  if width_unit='mm' or (width_unit='' and width>100) then width:=width/1000;
  elsif width_unit='cm' or (width_unit='' and width>2) then width:=width/100; end if;
  if height_unit='mm' or (height_unit='' and height>100) then height:=height/1000;
  elsif height_unit='cm' or (height_unit='' and height>2) then height:=height/100; end if;
  return greatest(0,width*height);
end; $$;
revoke all on function public.hems_ksa_cabinet_area(text) from public, anon, authenticated;

-- One card per equipment model, not one repeated card for every serial number.
-- Group before pagination so large serialized models are never split across pages.
create or replace function public.hems_ksa_inventory_groups(p_search text default '',p_offset integer default 0,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; page_size integer:=least(100,greatest(1,coalesce(p_limit,100)));
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode='42501'; end if;
  with stock as materialized (select * from public.hems_ksa_stock_records()),
  totals as (
    select record_type,case when record_type='unit' then parent_record_id else record_id end as group_id,
      sum(in_ksa_quantity) as in_ksa_quantity,sum(reserved_quantity) as reserved_quantity,sum(selectable_quantity) as selectable_quantity,
      bool_or(concat_ws(' ',display_name,serial_number,block_name,metadata->>'category') ilike '%' || coalesce(p_search,'') || '%') as matches
    from stock group by 1,2
  ), sample as (
    select distinct on(record_type,case when record_type='unit' then parent_record_id else record_id end)
      record_type,case when record_type='unit' then parent_record_id else record_id end as group_id,
      parent_record_id,display_name,block_name,metadata
    from stock order by record_type,case when record_type='unit' then parent_record_id else record_id end,record_id
  )
  select coalesce(jsonb_agg(to_jsonb(page)),'[]'::jsonb) into result from (
    select t.record_type,t.group_id as record_id,s.parent_record_id,s.display_name,null::text as serial_number,s.block_name,s.metadata,
      t.in_ksa_quantity,t.reserved_quantity,t.selectable_quantity
    from totals t join sample s on s.record_type=t.record_type and s.group_id=t.group_id where t.matches
      order by lower(coalesce(s.metadata->>'category','')),lower(s.display_name),t.record_type,t.group_id
      offset greatest(0,coalesce(p_offset,0)) limit page_size+1
  ) page;
  return jsonb_build_object('items',case when jsonb_array_length(result)>page_size then result-page_size else result end,'has_more',jsonb_array_length(result)>page_size);
end; $$;
revoke all on function public.hems_ksa_inventory_groups(text,integer,integer) from public, anon;
grant execute on function public.hems_ksa_inventory_groups(text,integer,integer) to authenticated;

create or replace function public.hems_ksa_unit_choices(p_item_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode='42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(choice)),'[]'::jsonb) into result from (
    select u.id,u.unit_no,u.serial,
      not exists (select 1 from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
        where i.inventory_record_type::text='unit' and i.inventory_record_id=u.id and l.list_type::text='transfer_in'
          and l.status::text in ('draft','pending','active','partially_returned')
          and i.requested_quantity>coalesce(i.returned_ok_quantity,0)+coalesce(i.returned_maintenance_quantity,0)) as selectable
    from public.units u where u.item_id=p_item_id and u.status::text='in_ksa'
      order by u.unit_no nulls last,u.serial nulls last,u.id
  ) choice;
  return jsonb_build_object('units',result);
end; $$;
revoke all on function public.hems_ksa_unit_choices(uuid) from public, anon;
grant execute on function public.hems_ksa_unit_choices(uuid) to authenticated;

-- All selected serials are inserted in one transaction. A stale/reserved serial
-- rejects the whole selection instead of silently adding only some of the units.
create or replace function public.hems_add_ksa_units(p_list_id uuid,p_item_id uuid,p_unit_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare parent public.equipment_lists%rowtype; valid_count integer; added_count integer;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode='42501'; end if;
  select * into parent from public.equipment_lists where id=p_list_id for no key update;
  if not found or parent.list_type::text<>'transfer_in' or parent.status::text not in ('draft','pending')
    or not public.hems_can_edit_equipment_list(p_list_id) then raise exception 'Choose an editable Transfer In draft.' using errcode='42501'; end if;
  if p_unit_ids is null or cardinality(p_unit_ids)<1 or cardinality(p_unit_ids)>1000 or array_position(p_unit_ids,null) is not null
    or (select count(distinct id) from unnest(p_unit_ids) as targets(id))<>cardinality(p_unit_ids) then
    raise exception 'Choose between 1 and 1000 distinct serial units.' using errcode='23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(742193,1);
  perform 1 from public.units where id=any(p_unit_ids) order by id for update;
  select count(*) into valid_count from public.units where id=any(p_unit_ids) and item_id=p_item_id and status::text='in_ksa';
  if valid_count<>cardinality(p_unit_ids) then raise exception 'One selected serial is no longer in KSA. Refresh the serial list.' using errcode='40001'; end if;
  if exists (select 1 from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
    where i.inventory_record_type::text='unit' and i.inventory_record_id=any(p_unit_ids) and l.list_type::text='transfer_in'
      and l.status::text in ('draft','pending','active','partially_returned')
      and i.requested_quantity>coalesce(i.returned_ok_quantity,0)+coalesce(i.returned_maintenance_quantity,0)) then
    raise exception 'One selected serial is already reserved for return. Refresh the serial list.' using errcode='23514';
  end if;
  insert into public.equipment_list_items(list_id,inventory_record_type,inventory_record_id,parent_record_id,display_name,serial_number,
    requested_quantity,approved_quantity,returned_ok_quantity,returned_maintenance_quantity,metadata)
    select p_list_id,'unit',u.id,item.id,item.name,nullif(btrim(u.serial),''),1,0,0,0,
      jsonb_strip_nulls(jsonb_build_object('category',category.slug,'subcategory',subcategory.slug,'item_id',item.id,'item_name',item.name,
        'unit_no',u.unit_no,'fixture_type',item.fixture_type,'photo_url',item.photo_url,'transfer_source','ksa'))
    from public.units u join public.items item on item.id=u.item_id
      join public.subcategories subcategory on subcategory.id=item.subcategory_id join public.categories category on category.id=subcategory.category_id
    where u.id=any(p_unit_ids) and u.item_id=p_item_id and u.status::text='in_ksa';
  get diagnostics added_count=row_count;
  if added_count<>cardinality(p_unit_ids) then raise exception 'The equipment model changed. Refresh before adding.' using errcode='40001'; end if;
  return jsonb_build_object('list_id',p_list_id,'added_quantity',added_count);
end; $$;
revoke all on function public.hems_add_ksa_units(uuid,uuid,uuid[]) from public, anon;
grant execute on function public.hems_add_ksa_units(uuid,uuid,uuid[]) to authenticated;
commit;

-- READ ONLY. Run BEFORE pending-stock-reservations.sql.
-- No rows = no conflicting existing Pending outgoing reservations.
-- Rows = review these lists in the app; do not change unit statuses blindly.
with pending as (
  select i.inventory_record_type::text as kind,i.inventory_record_id as record_id,
    min(i.display_name) as equipment,sum(i.requested_quantity)::bigint as requested,
    string_agg(distinct l.reference,', ' order by l.reference) as pending_lists,
    count(*)::bigint as line_count
  from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
  where l.status::text='pending' and l.list_type::text in ('local_event','dry_hire','transfer_out','internal_use')
    and i.inventory_record_type::text in ('unit','matrix_model','matrix_row')
  group by i.inventory_record_type,i.inventory_record_id
), movements as (
  select i.inventory_record_type::text as kind,i.inventory_record_id as record_id,
    sum(greatest(0,(case when i.approved_quantity>0 then i.approved_quantity else i.requested_quantity end)
      -coalesce(i.returned_ok_quantity,0)-coalesce(i.returned_maintenance_quantity,0)))::bigint as quantity
  from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
  where l.status::text in ('active','partially_returned') and l.list_type::text not in ('maintenance','transfer_in')
  group by i.inventory_record_type,i.inventory_record_id
), stock as (
  select 'unit'::text as kind,id as record_id,
    case when coalesce(status::text,'available')='available' then 1 else 0 end::bigint as capacity,
    0::bigint as occupied from public.units
  union all
  select 'matrix_model',id,greatest(0,coalesce(total_qty,0)-coalesce(maintenance_qty,0))::bigint,
    greatest(0,coalesce(in_use_qty,0)+coalesce(in_ksa_qty,0))::bigint from public.matrix_models
  union all
  select 'matrix_row',id,greatest(0,(case when item_id is not null then coalesce(total_qty,0) else coalesce(qty,0) end)-coalesce(maintenance_qty,0))::bigint,
    greatest(0,coalesce(in_use_qty,0)+coalesce(in_ksa_qty,0))::bigint from public.matrix_rows
), checked as (
  select p.*,greatest(0,coalesce(s.capacity,0)-greatest(coalesce(s.occupied,0),coalesce(m.quantity,0))) as physical_available
  from pending p left join stock s on s.kind=p.kind and s.record_id=p.record_id
  left join movements m on m.kind=p.kind and m.record_id=p.record_id
)
select equipment,kind as record_type,record_id,pending_lists,requested as pending_quantity,physical_available,
  case when kind='unit' and line_count>1 then 'Same serial appears more than once'
    else 'Pending demand exceeds available stock (or stock record is missing)' end as problem
from checked where requested>physical_available or requested<1 or (kind='unit' and (line_count>1 or requested<>1))
union all
select i.display_name,i.inventory_record_type::text,i.inventory_record_id,l.reference,
  coalesce(i.requested_quantity,0)::bigint,0::bigint,'Invalid Pending quantity or custom marker'
from public.equipment_list_items i join public.equipment_lists l on l.id=i.list_id
where l.status::text='pending' and l.list_type::text in ('local_event','dry_hire','transfer_out','internal_use')
  and (i.requested_quantity is null or i.requested_quantity<1
    or (i.inventory_record_type::text='item' and coalesce(i.metadata->>'custom_item','false')<>'true')
    or (i.inventory_record_type::text<>'item' and coalesce(i.metadata->>'custom_item','false')='true'))
order by record_type,equipment,record_id;

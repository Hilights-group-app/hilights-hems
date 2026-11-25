-- READ ONLY. Run first. No result = all current dated Pending lists have dates.
-- Return these rows for review; do not invent dates or change stock statuses.
select id,reference,list_type,status,
  case when list_type::text='local_event' then setup_date else pickup_date end as first_day,
  case when list_type::text='local_event' then dismantling_date else return_date end as last_day
from public.equipment_lists
where status::text='pending' and list_type::text in ('local_event','dry_hire') and (
  case when list_type::text='local_event' then setup_date else pickup_date end is null
  or case when list_type::text='local_event' then dismantling_date else return_date end is null
  or case when list_type::text='local_event' then dismantling_date else return_date end
    < case when list_type::text='local_event' then setup_date else pickup_date end
);

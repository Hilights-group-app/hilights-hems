-- Apply after existing equipment-list and maintenance migrations.
-- Does not replace Submit, Received, Tested, approval or stock functions.
begin;
set local lock_timeout = '15s';

alter table public.notifications add column if not exists actor_id uuid references auth.users(id) on delete set null;
alter table public.notifications alter column actor_id set default auth.uid();
-- Historic rows have only a display name. Backfill only unambiguous names.
with actors as (
  select lower(btrim(full_name)) as name,(array_agg(id))[1] as id
  from public.profiles where nullif(btrim(full_name),'') is not null
  group by lower(btrim(full_name)) having count(*)=1
)
update public.notifications n set actor_id=a.id from actors a
where n.actor_id is null and lower(btrim(n.actor_name))=a.name;

create or replace function public.hems_notification_actor_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='INSERT' and auth.uid() is not null then
    new.actor_id:=auth.uid();
    new.actor_name:=coalesce((select nullif(btrim(full_name),'') from public.profiles where id=auth.uid()),nullif(btrim(new.actor_name),''),'A team member');
  elsif tg_op='UPDATE' and auth.uid() is not null and new.actor_id is distinct from old.actor_id then
    raise exception 'Notification authors cannot be changed.' using errcode='42501';
  end if;
  return new;
end; $$;
revoke all on function public.hems_notification_actor_guard() from public,anon,authenticated;
drop trigger if exists hems_notification_actor_guard on public.notifications;
create trigger hems_notification_actor_guard before insert or update on public.notifications
for each row execute function public.hems_notification_actor_guard();
-- Preserve existing recipient/read policies. Only supply the old authenticated
-- feed access when RLS was previously disabled; then restrict self notifications.
do $$
begin
  if not (select relrowsecurity from pg_class where oid='public.notifications'::regclass) then
    execute 'drop policy if exists hems_notifications_existing_feed on public.notifications';
    execute 'create policy hems_notifications_existing_feed on public.notifications for select to authenticated using (auth.uid() is not null)';
    execute 'drop policy if exists hems_notifications_existing_insert on public.notifications';
    execute 'create policy hems_notifications_existing_insert on public.notifications for insert to authenticated with check (auth.uid() is not null and actor_id=auth.uid())';
    execute 'drop policy if exists hems_notifications_existing_read_update on public.notifications';
    execute 'create policy hems_notifications_existing_read_update on public.notifications for update to authenticated using (auth.uid() is not null and (actor_id is null or actor_id<>auth.uid())) with check (auth.uid() is not null and (actor_id is null or actor_id<>auth.uid()))';
  end if;
end; $$;
alter table public.notifications enable row level security;
drop policy if exists hems_notifications_hide_own on public.notifications;
create policy hems_notifications_hide_own on public.notifications as restrictive
for select to authenticated using (auth.uid() is not null and (actor_id is null or actor_id<>auth.uid()));

create index if not exists hems_pending_action_notifications_idx on public.equipment_lists(submitted_at desc)
where status='pending';
create index if not exists hems_received_action_notifications_idx on public.maintenance_requests(department,list_id)
where status='received' and source_type='maintenance';

create or replace function public.hems_action_notifications()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'Please sign in.' using errcode='42501'; end if;
  with tasks as (
    select 'approval:' || l.id::text as id,'approval'::text as kind,
      'LIST SUBMITTED - APPROVAL REQUIRED'::text as title,
      l.reference || ' - ' || coalesce(nullif(btrim(p.full_name),''),'A team member') || ' submitted this list' as message,
      '/inventory/lists/' || l.id::text as href,coalesce(l.submitted_at,l.updated_at,l.created_at) as created_at
    from public.equipment_lists l left join public.profiles p on p.id=l.created_by
    where public.is_equipment_list_manager() is true and l.status='pending'
      and l.list_type::text<>'internal_use' and l.created_by is distinct from auth.uid()
    union all
    select 'testing:' || r.id::text,'testing',
      'RECEIVED - TESTING REQUIRED',
      r.source_reference || ' - ' || r.display_name ||
        case when nullif(btrim(r.serial_number),'') is not null then ' - SN ' || r.serial_number else '' end ||
        ' - ' || (r.received_quantity-r.tested_quantity)::text || ' pcs waiting to be tested',
      '/inventory/lists/' || r.list_id::text,coalesce(r.received_at,r.updated_at,r.created_at)
    from public.maintenance_requests r join public.equipment_lists l on l.id=r.list_id
    where public.can_complete_maintenance_request(r.department) is true
      and r.source_type='maintenance' and r.status='received' and l.status::text='active'
      and r.received_quantity>r.tested_quantity and r.received_by is distinct from auth.uid()
  )
  select coalesce(jsonb_agg(to_jsonb(page)),'[]'::jsonb) into result
  from (select * from tasks order by created_at desc,id limit 100) page;
  return result;
end; $$;
revoke all on function public.hems_action_notifications() from public,anon;
grant execute on function public.hems_action_notifications() to authenticated;
-- Live updates still respect each table's existing RLS permissions.
do $$
declare table_name text;
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach table_name in array array['equipment_lists','maintenance_requests','notifications'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=table_name) then
        execute format('alter publication supabase_realtime add table public.%I',table_name);
      end if;
    end loop;
  end if;
end; $$;
notify pgrst, 'reload schema';
commit;

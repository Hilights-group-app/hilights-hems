-- Run after the existing equipment-list/maintenance migrations, before deploy.
-- Adds sharing for Dry Hire, Local Event and Transfer Out drafts only.
begin;
set local lock_timeout = '15s';

alter table public.equipment_lists
  add column if not exists shared_with uuid[] not null default '{}'::uuid[];

create index if not exists equipment_lists_draft_shared_idx
  on public.equipment_lists using gin (shared_with) where status = 'draft';

create or replace function public.hems_can_view_equipment_list(p_list_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.equipment_lists l where l.id = p_list_id and (
      l.list_type::text = 'internal_use'
      or (l.status::text = 'draft' and (
        l.created_by = auth.uid()
        or (l.list_type::text in ('dry_hire', 'local_event', 'transfer_out')
          and l.shared_with @> array[auth.uid()])
      ))
      or (l.status::text = 'pending' and (
        l.created_by = auth.uid() or public.is_equipment_list_manager()))
      or l.status::text in ('active', 'partially_returned', 'closed')
      or (l.status::text = 'cancelled' and (
        l.created_by = auth.uid() or public.is_equipment_list_manager()))
    )
  );
$$;

create or replace function public.hems_can_edit_equipment_list(p_list_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.equipment_lists l where l.id = p_list_id and (
      (l.status::text = 'draft' and l.list_type::text <> 'internal_use' and (
        (l.created_by = auth.uid() and (
          l.list_type::text <> 'maintenance'
          or public.hems_current_user_role() in ('admin', 'warehouse_manager', 'head')))
        or (l.list_type::text in ('dry_hire', 'local_event', 'transfer_out')
          and l.shared_with @> array[auth.uid()])
      ))
      or (public.is_equipment_list_manager() and (
        (l.status::text = 'draft' and l.list_type::text = 'internal_use')
        or l.status::text in ('pending', 'active', 'partially_returned', 'closed', 'cancelled')
      ))
    )
  );
$$;

revoke all on function public.hems_can_view_equipment_list(uuid) from public, anon;
revoke all on function public.hems_can_edit_equipment_list(uuid) from public, anon;
grant execute on function public.hems_can_view_equipment_list(uuid) to authenticated;
grant execute on function public.hems_can_edit_equipment_list(uuid) to authenticated;

-- Replace both visibility policies: the existing restrictive policy otherwise
-- hides drafts from every recipient even when the item helpers allow editing.
drop policy if exists "hems_lists_select" on public.equipment_lists;
drop policy if exists "hems_lists_select_guard" on public.equipment_lists;
create policy "hems_lists_select" on public.equipment_lists
for select to authenticated using (public.hems_can_view_equipment_list(id));
create policy "hems_lists_select_guard" on public.equipment_lists
as restrictive for select to authenticated using (public.hems_can_view_equipment_list(id));

-- Existing item RLS calls the helpers above. Existing maintenance department
-- checks remain in hems_can_edit_list_item and are intentionally unchanged.
-- Shared users may edit equipment, not the list header or its workflow.
drop policy if exists "hems_shared_draft_header_guard" on public.equipment_lists;
create policy "hems_shared_draft_header_guard" on public.equipment_lists
as restrictive for update to authenticated
using (
  status::text <> 'draft'
  or list_type::text not in ('dry_hire', 'local_event', 'transfer_out')
  or created_by = (select auth.uid())
)
with check (true);

create or replace function public.hems_guard_equipment_draft_sharing()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then return new; end if;

  if tg_op = 'UPDATE' then
    if old.list_type::text in ('dry_hire', 'local_event', 'transfer_out') then
      if new.created_by is distinct from old.created_by
        or new.list_type is distinct from old.list_type then
        raise exception 'The draft creator and list type cannot be changed.' using errcode = '42501';
      end if;
      if old.status::text = 'draft' then
        if caller is distinct from old.created_by then
          raise exception 'Only the draft creator can change or submit this draft.' using errcode = '42501';
        end if;
        if new.status::text not in ('draft', 'pending') then
          raise exception 'Submit the draft for approval before dispatch.' using errcode = '42501';
        end if;
        if new.status::text = 'pending' then
          new.submitted_by := caller;
        end if;
      end if;
    end if;
    if new.shared_with is not distinct from old.shared_with then return new; end if;
    if old.status::text <> 'draft' or caller is distinct from old.created_by then
      raise exception 'Only the creator can share a draft.' using errcode = '42501';
    end if;
  end if;

  new.shared_with := array(
    select distinct recipient from unnest(coalesce(new.shared_with, '{}'::uuid[])) as shares(recipient)
    where recipient is distinct from new.created_by order by recipient
  );
  if cardinality(new.shared_with) > 0 then
    if new.status::text <> 'draft'
      or new.list_type::text not in ('dry_hire', 'local_event', 'transfer_out')
      or caller is distinct from new.created_by then
      raise exception 'This list cannot be shared.' using errcode = '42501';
    end if;
    if exists (
      select 1 from unnest(new.shared_with) as shares(recipient)
      where recipient is null or not exists (
        select 1 from public.profiles p where p.id = recipient
      )
    ) then
      raise exception 'Choose an existing HEMS user.' using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists hems_equipment_draft_sharing_guard on public.equipment_lists;
create trigger hems_equipment_draft_sharing_guard
before insert or update on public.equipment_lists
for each row execute function public.hems_guard_equipment_draft_sharing();

-- Serialize edits on the parent row so a collaborator cannot race a Submit.
-- The trigger also prevents two collaborators adding the same serial/record.
create or replace function public.hems_guard_shared_draft_items()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  target_list uuid;
  target_record uuid;
  target_type text;
  parent public.equipment_lists%rowtype;
begin
  if caller is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'DELETE' then
    target_list := old.list_id;
  else
    target_list := new.list_id;
  end if;
  select * into parent from public.equipment_lists where id = target_list for no key update;
  if not found or parent.list_type::text not in ('dry_hire', 'local_event', 'transfer_out') then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if parent.status::text = 'draft' then
    if caller is distinct from parent.created_by and not (parent.shared_with @> array[caller]) then
      raise exception 'This draft is not shared with you.' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.list_id is distinct from old.list_id then
      raise exception 'Equipment lines cannot be moved to another list.' using errcode = '42501';
    end if;
    if tg_op <> 'DELETE' and caller is distinct from parent.created_by then
      if (tg_op = 'INSERT' and (coalesce(new.approved_quantity, 0) <> 0
        or coalesce(new.returned_ok_quantity, 0) <> 0
        or coalesce(new.returned_maintenance_quantity, 0) <> 0))
        or (tg_op = 'UPDATE' and (
          new.approved_quantity is distinct from old.approved_quantity
          or new.returned_ok_quantity is distinct from old.returned_ok_quantity
          or new.returned_maintenance_quantity is distinct from old.returned_maintenance_quantity)) then
        raise exception 'Shared draft editing cannot approve or return equipment.' using errcode = '42501';
      end if;
    end if;
    if tg_op <> 'DELETE' then
      target_record := new.inventory_record_id;
      target_type := new.inventory_record_type::text;
      if exists (
        select 1 from public.equipment_list_items i
        where i.list_id = target_list and i.inventory_record_type::text = target_type
          and i.inventory_record_id = target_record and i.id is distinct from new.id
      ) then
        raise exception 'This equipment is already in the draft. Refresh the list.' using errcode = '23505';
      end if;
    end if;
  elsif not public.is_equipment_list_manager() then
    raise exception 'The draft has been submitted; equipment editing is closed.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists hems_shared_draft_items_guard on public.equipment_list_items;
create trigger hems_shared_draft_items_guard
before insert or update or delete on public.equipment_list_items
for each row execute function public.hems_guard_shared_draft_items();

-- Owners of these drafts can pick colleagues without requiring Admin access
-- to the global user-management API. No emails or account credentials returned.
create or replace function public.hems_draft_share_users(p_list_id uuid)
returns table(id uuid, full_name text, role text, department text)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.equipment_lists l where l.id = p_list_id
      and l.created_by = auth.uid() and l.status::text = 'draft'
      and l.list_type::text in ('dry_hire', 'local_event', 'transfer_out')
  ) then
    raise exception 'Only the draft creator can manage sharing.' using errcode = '42501';
  end if;
  return query select p.id, coalesce(p.full_name, '')::text,
    coalesce(p.role::text, '')::text, coalesce(p.department::text, '')::text
  from public.profiles p where p.id <> auth.uid()
  order by lower(coalesce(p.full_name, '')), p.id;
end;
$$;

revoke all on function public.hems_draft_share_users(uuid) from public, anon;
grant execute on function public.hems_draft_share_users(uuid) to authenticated;
revoke all on function public.hems_guard_equipment_draft_sharing() from public, anon, authenticated;
revoke all on function public.hems_guard_shared_draft_items() from public, anon, authenticated;

-- Let shared editors record their own equipment changes in the activity log.
drop policy if exists "hems_list_activity_insert" on public.equipment_list_activity;
drop policy if exists "hems_list_activity_insert_guard" on public.equipment_list_activity;
create policy "hems_list_activity_insert" on public.equipment_list_activity
for insert to authenticated with check (
  public.hems_can_view_equipment_list(list_id) and (
    public.is_equipment_list_manager()
    or exists (select 1 from public.equipment_lists l where l.id = list_id and l.created_by = auth.uid())
    or (actor_id = auth.uid() and public.hems_can_edit_equipment_list(list_id))
  )
);
create policy "hems_list_activity_insert_guard" on public.equipment_list_activity
as restrictive for insert to authenticated with check (
  public.hems_can_view_equipment_list(list_id) and (
    public.is_equipment_list_manager()
    or exists (select 1 from public.equipment_lists l where l.id = list_id and l.created_by = auth.uid())
    or (actor_id = auth.uid() and public.hems_can_edit_equipment_list(list_id))
  )
);

-- Publish only the two tables needed for list collaboration, if not already on.
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime' and not puballtables) then
    if not exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'equipment_lists') then
      alter publication supabase_realtime add table public.equipment_lists;
    end if;
    if not exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'equipment_list_items') then
      alter publication supabase_realtime add table public.equipment_list_items;
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;

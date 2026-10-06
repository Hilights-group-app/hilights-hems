-- HEMS equipment-list permissions
-- Run this file once in Supabase SQL Editor while the local dev server is stopped.
-- It is safe to run again: only policies/functions whose names start with "hems_"
-- are replaced. Existing project policies are left intact, while restrictive guards
-- ensure they cannot grant broader access than the rules below.

begin;
set local lock_timeout = '15s';

create or replace function public.hems_current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.role::text from public.profiles p where p.id = auth.uid()),
    ''
  );
$$;

create or replace function public.is_equipment_list_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.hems_current_user_role() in ('admin', 'warehouse_manager');
$$;

create or replace function public.hems_can_view_equipment_list(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.equipment_lists l
    where l.id = p_list_id
      and (
        -- Internal Use is visible to every authenticated user.
        l.list_type::text = 'internal_use'
        -- Drafts remain private to their creator.
        or (l.status::text = 'draft' and l.created_by = auth.uid())
        -- Pending is visible to its creator and list managers.
        or (
          l.status::text = 'pending'
          and (
            l.created_by = auth.uid()
            or public.is_equipment_list_manager()
          )
        )
        -- Dispatched and completed work is visible to the whole team.
        or l.status::text in ('active', 'partially_returned', 'closed')
        -- Cancelled work remains visible only to its creator and managers.
        or (
          l.status::text = 'cancelled'
          and (
            l.created_by = auth.uid()
            or public.is_equipment_list_manager()
          )
        )
      )
  );
$$;

create or replace function public.hems_can_edit_equipment_list(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.equipment_lists l
    where l.id = p_list_id
      and (
        -- Anyone can edit only their own normal Draft.
        (
          l.status::text = 'draft'
          and l.list_type::text <> 'internal_use'
          and l.created_by = auth.uid()
        )
        -- Admin/Warehouse own Internal Use and the operational workflow.
        or (
          public.is_equipment_list_manager()
          and (
            (l.status::text = 'draft' and l.list_type::text = 'internal_use')
            or l.status::text in (
              'pending',
              'active',
              'partially_returned',
              'closed',
              'cancelled'
            )
          )
        )
      )
  );
$$;

revoke all on function public.hems_current_user_role() from public;
revoke all on function public.is_equipment_list_manager() from public;
revoke all on function public.hems_can_view_equipment_list(uuid) from public;
revoke all on function public.hems_can_edit_equipment_list(uuid) from public;

grant execute on function public.hems_current_user_role() to authenticated;
grant execute on function public.is_equipment_list_manager() to authenticated;
grant execute on function public.hems_can_view_equipment_list(uuid) to authenticated;
grant execute on function public.hems_can_edit_equipment_list(uuid) to authenticated;

alter table public.equipment_lists enable row level security;
alter table public.equipment_list_items enable row level security;
alter table public.equipment_list_activity enable row level security;

-- equipment_lists -----------------------------------------------------------

drop policy if exists "hems_lists_select" on public.equipment_lists;
drop policy if exists "hems_lists_select_guard" on public.equipment_lists;
drop policy if exists "hems_lists_insert" on public.equipment_lists;
drop policy if exists "hems_lists_insert_guard" on public.equipment_lists;
drop policy if exists "hems_lists_update" on public.equipment_lists;
drop policy if exists "hems_lists_update_guard" on public.equipment_lists;
drop policy if exists "hems_lists_delete" on public.equipment_lists;
drop policy if exists "hems_lists_delete_guard" on public.equipment_lists;

create policy "hems_lists_select"
on public.equipment_lists
for select
to authenticated
using (public.hems_can_view_equipment_list(id));

create policy "hems_lists_select_guard"
on public.equipment_lists
as restrictive
for select
to authenticated
using (public.hems_can_view_equipment_list(id));

create policy "hems_lists_insert"
on public.equipment_lists
for insert
to authenticated
with check (
  created_by = auth.uid()
  and status::text = 'draft'
  and (
    list_type::text <> 'internal_use'
    or public.is_equipment_list_manager()
  )
);

create policy "hems_lists_insert_guard"
on public.equipment_lists
as restrictive
for insert
to authenticated
with check (
  created_by = auth.uid()
  and status::text = 'draft'
  and (
    list_type::text <> 'internal_use'
    or public.is_equipment_list_manager()
  )
);

create policy "hems_lists_update"
on public.equipment_lists
for update
to authenticated
using (public.hems_can_edit_equipment_list(id))
with check (
  public.is_equipment_list_manager()
  or (
    created_by = auth.uid()
    and list_type::text <> 'internal_use'
    and status::text in ('draft', 'pending')
  )
);

create policy "hems_lists_update_guard"
on public.equipment_lists
as restrictive
for update
to authenticated
using (public.hems_can_edit_equipment_list(id))
with check (
  public.is_equipment_list_manager()
  or (
    created_by = auth.uid()
    and list_type::text <> 'internal_use'
    and status::text in ('draft', 'pending')
  )
);

create policy "hems_lists_delete"
on public.equipment_lists
for delete
to authenticated
using (
  status::text = 'draft'
  and (
    (
      list_type::text <> 'internal_use'
      and created_by = auth.uid()
    )
    or (
      list_type::text = 'internal_use'
      and public.is_equipment_list_manager()
    )
  )
);

create policy "hems_lists_delete_guard"
on public.equipment_lists
as restrictive
for delete
to authenticated
using (
  status::text = 'draft'
  and (
    (
      list_type::text <> 'internal_use'
      and created_by = auth.uid()
    )
    or (
      list_type::text = 'internal_use'
      and public.is_equipment_list_manager()
    )
  )
);

-- equipment_list_items ------------------------------------------------------

drop policy if exists "hems_list_items_select" on public.equipment_list_items;
drop policy if exists "hems_list_items_select_guard" on public.equipment_list_items;
drop policy if exists "hems_list_items_insert" on public.equipment_list_items;
drop policy if exists "hems_list_items_insert_guard" on public.equipment_list_items;
drop policy if exists "hems_list_items_update" on public.equipment_list_items;
drop policy if exists "hems_list_items_update_guard" on public.equipment_list_items;
drop policy if exists "hems_list_items_delete" on public.equipment_list_items;
drop policy if exists "hems_list_items_delete_guard" on public.equipment_list_items;

create policy "hems_list_items_select"
on public.equipment_list_items
for select
to authenticated
using (public.hems_can_view_equipment_list(list_id));

create policy "hems_list_items_select_guard"
on public.equipment_list_items
as restrictive
for select
to authenticated
using (public.hems_can_view_equipment_list(list_id));

create policy "hems_list_items_insert"
on public.equipment_list_items
for insert
to authenticated
with check (public.hems_can_edit_equipment_list(list_id));

create policy "hems_list_items_insert_guard"
on public.equipment_list_items
as restrictive
for insert
to authenticated
with check (public.hems_can_edit_equipment_list(list_id));

create policy "hems_list_items_update"
on public.equipment_list_items
for update
to authenticated
using (public.hems_can_edit_equipment_list(list_id))
with check (public.hems_can_edit_equipment_list(list_id));

create policy "hems_list_items_update_guard"
on public.equipment_list_items
as restrictive
for update
to authenticated
using (public.hems_can_edit_equipment_list(list_id))
with check (public.hems_can_edit_equipment_list(list_id));

create policy "hems_list_items_delete"
on public.equipment_list_items
for delete
to authenticated
using (public.hems_can_edit_equipment_list(list_id));

create policy "hems_list_items_delete_guard"
on public.equipment_list_items
as restrictive
for delete
to authenticated
using (public.hems_can_edit_equipment_list(list_id));

-- equipment_list_activity ---------------------------------------------------

drop policy if exists "hems_list_activity_select" on public.equipment_list_activity;
drop policy if exists "hems_list_activity_select_guard" on public.equipment_list_activity;
drop policy if exists "hems_list_activity_insert" on public.equipment_list_activity;
drop policy if exists "hems_list_activity_insert_guard" on public.equipment_list_activity;

create policy "hems_list_activity_select"
on public.equipment_list_activity
for select
to authenticated
using (public.hems_can_view_equipment_list(list_id));

create policy "hems_list_activity_select_guard"
on public.equipment_list_activity
as restrictive
for select
to authenticated
using (public.hems_can_view_equipment_list(list_id));

create policy "hems_list_activity_insert"
on public.equipment_list_activity
for insert
to authenticated
with check (
  public.hems_can_view_equipment_list(list_id)
  and (
    public.is_equipment_list_manager()
    or exists (
      select 1
      from public.equipment_lists l
      where l.id = list_id and l.created_by = auth.uid()
    )
  )
);

create policy "hems_list_activity_insert_guard"
on public.equipment_list_activity
as restrictive
for insert
to authenticated
with check (
  public.hems_can_view_equipment_list(list_id)
  and (
    public.is_equipment_list_manager()
    or exists (
      select 1
      from public.equipment_lists l
      where l.id = list_id and l.created_by = auth.uid()
    )
  )
);

commit;

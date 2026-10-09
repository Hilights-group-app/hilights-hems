-- HEMS: Send for Maintenance workflow
-- Run this whole file once in Supabase SQL Editor.
-- Safe to run again. It does not delete inventory, reports, or equipment lists.
-- Close local/Vercel app tabs while it runs so schema locks are released quickly.

begin;
set local lock_timeout = '20s';

alter table public.equipment_lists
  add column if not exists repair_company text,
  add column if not exists maintenance_sent_date date;

-- Replace the old list_type check so MR lists are accepted.
do $block$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.equipment_lists'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%list_type%'
  loop
    execute format(
      'alter table public.equipment_lists drop constraint %I',
      constraint_row.conname
    );
  end loop;
end;
$block$;

alter table public.equipment_lists
  add constraint equipment_lists_list_type_check
  check (
    list_type in (
      'dry_hire',
      'local_event',
      'transfer_out',
      'transfer_in',
      'internal_use',
      'maintenance'
    )
  );

create table if not exists public.maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.equipment_lists(id) on delete cascade,
  list_item_id uuid not null references public.equipment_list_items(id) on delete cascade,
  inventory_record_type text not null,
  inventory_record_id uuid not null,
  parent_record_id uuid,
  display_name text not null,
  serial_number text,
  quantity integer not null default 1 check (quantity > 0),
  department text not null default 'general',
  source_reference text not null,
  source_type text not null,
  source_summary text,
  report_href text,
  status text not null default 'pending_report',
  created_by uuid references auth.users(id) on delete set null,
  created_by_name text,
  reported_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  reported_at timestamptz,
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.maintenance_requests
  add column if not exists received_quantity integer not null default 0,
  add column if not exists tested_quantity integer not null default 0,
  add column if not exists received_at timestamptz,
  add column if not exists received_by uuid references auth.users(id) on delete set null,
  add column if not exists tested_at timestamptz,
  add column if not exists tested_by uuid references auth.users(id) on delete set null;

do $block$
declare
  constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.maintenance_requests'::regclass
      and contype = 'c'
      and (
        pg_get_constraintdef(oid) ilike '%status%'
        or pg_get_constraintdef(oid) ilike '%inventory_record_type%'
        or pg_get_constraintdef(oid) ilike '%department%'
      )
  loop
    execute format(
      'alter table public.maintenance_requests drop constraint %I',
      constraint_row.conname
    );
  end loop;
end;
$block$;

alter table public.maintenance_requests
  drop constraint if exists maintenance_requests_received_quantity_check,
  drop constraint if exists maintenance_requests_tested_quantity_check;

alter table public.maintenance_requests
  add constraint maintenance_requests_status_check
    check (status in ('pending_report', 'reported', 'sent', 'received', 'resolved')),
  add constraint maintenance_requests_inventory_record_type_check
    check (inventory_record_type in ('unit', 'matrix_model', 'matrix_row')),
  add constraint maintenance_requests_department_check
    check (department in ('lighting', 'video', 'rigging', 'general')),
  add constraint maintenance_requests_received_quantity_check
    check (received_quantity >= 0 and received_quantity <= quantity),
  add constraint maintenance_requests_tested_quantity_check
    check (tested_quantity >= 0 and tested_quantity <= received_quantity);

create index if not exists maintenance_requests_active_record_idx
  on public.maintenance_requests (
    inventory_record_type,
    inventory_record_id,
    status
  );

create index if not exists maintenance_requests_parent_status_idx
  on public.maintenance_requests (parent_record_id, status);

drop trigger if exists maintenance_requests_touch_updated_at
  on public.maintenance_requests;
create trigger maintenance_requests_touch_updated_at
before update on public.maintenance_requests
for each row execute function public.hems_touch_updated_at();

create or replace function public.hems_current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $function$
  select coalesce(
    (select p.role::text from public.profiles p where p.id = auth.uid()),
    ''
  );
$function$;

create or replace function public.hems_current_user_department()
returns text
language sql
stable
security definer
set search_path = public
as $function$
  select lower(coalesce(
    (select p.department::text from public.profiles p where p.id = auth.uid()),
    ''
  ));
$function$;

create or replace function public.is_equipment_list_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select public.hems_current_user_role() in ('admin', 'warehouse_manager');
$function$;

create or replace function public.hems_inventory_department(
  p_category text,
  p_subcategory text default ''
)
returns text
language plpgsql
immutable
as $function$
declare
  route_text text := lower(
    coalesce(p_category, '') || ' ' || coalesce(p_subcategory, '')
  );
begin
  if route_text ~ '(truss|rigg|hoist|motor|lifting)' then
    return 'rigging';
  elsif route_text ~ '(lighting|light|fixture|dimmer|console)' then
    return 'lighting';
  elsif route_text ~ '(video|led|screen|project|projection|media|server|network|processor|camera|lens)' then
    return 'video';
  end if;
  return 'general';
end;
$function$;

create or replace function public.hems_can_view_equipment_list(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select exists (
    select 1
    from public.equipment_lists l
    where l.id = p_list_id
      and (
        l.list_type::text = 'internal_use'
        or (l.status::text = 'draft' and l.created_by = auth.uid())
        or (
          l.status::text = 'pending'
          and (
            l.created_by = auth.uid()
            or public.is_equipment_list_manager()
          )
        )
        or l.status::text in ('active', 'partially_returned', 'closed')
        or (
          l.status::text = 'cancelled'
          and (
            l.created_by = auth.uid()
            or public.is_equipment_list_manager()
          )
        )
      )
  );
$function$;

create or replace function public.hems_can_edit_equipment_list(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select exists (
    select 1
    from public.equipment_lists l
    where l.id = p_list_id
      and (
        (
          l.status::text = 'draft'
          and l.list_type::text <> 'internal_use'
          and l.created_by = auth.uid()
          and (
            l.list_type::text <> 'maintenance'
            or public.hems_current_user_role() in (
              'admin', 'warehouse_manager', 'head'
            )
          )
        )
        or (
          public.is_equipment_list_manager()
          and (
            (l.status::text = 'draft' and l.list_type::text = 'internal_use')
            or l.status::text in (
              'pending', 'active', 'partially_returned', 'closed', 'cancelled'
            )
          )
        )
      )
  );
$function$;

create or replace function public.hems_can_edit_list_item(
  p_list_id uuid,
  p_metadata jsonb
)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select public.hems_can_edit_equipment_list(p_list_id)
    and exists (
      select 1
      from public.equipment_lists l
      where l.id = p_list_id
        and (
          l.list_type::text <> 'maintenance'
          or public.is_equipment_list_manager()
          or (
            public.hems_current_user_role() = 'head'
            and l.status::text = 'draft'
            and l.created_by = auth.uid()
            and public.hems_inventory_department(
              p_metadata ->> 'category',
              p_metadata ->> 'subcategory'
            ) = public.hems_current_user_department()
          )
        )
    );
$function$;

create or replace function public.can_view_maintenance_request(
  p_department text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select public.hems_current_user_role() in ('admin', 'warehouse_manager')
    or (
      public.hems_current_user_role() = 'head'
      and public.hems_current_user_department() = p_department
    );
$function$;

create or replace function public.can_complete_maintenance_request(
  p_department text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select public.hems_current_user_role() = 'admin'
    or (
      public.hems_current_user_role() = 'head'
      and public.hems_current_user_department() = p_department
    );
$function$;

create or replace function public.next_equipment_list_reference(
  p_list_type text
)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_prefix text;
  v_year integer;
  v_number integer;
begin
  v_prefix := case p_list_type
    when 'dry_hire' then 'DH'
    when 'local_event' then 'EV'
    when 'transfer_out' then 'TO'
    when 'transfer_in' then 'TI'
    when 'internal_use' then 'IU'
    when 'maintenance' then 'MR'
    else null
  end;

  if v_prefix is null then
    raise exception 'Unsupported equipment list type: %', p_list_type;
  end if;

  v_year := extract(year from timezone('Asia/Dubai', now()))::integer;

  insert into public.equipment_list_reference_counters as reference_counter (
    prefix, reference_year, last_number
  )
  values (v_prefix, v_year, 1)
  on conflict (prefix, reference_year)
  do update set last_number = reference_counter.last_number + 1
  returning last_number into v_number;

  return v_prefix || '-' || v_year::text || '-' || lpad(v_number::text, 4, '0');
end;
$function$;

-- RLS ----------------------------------------------------------------------

alter table public.equipment_lists enable row level security;
alter table public.equipment_list_items enable row level security;
alter table public.maintenance_requests enable row level security;

drop policy if exists "hems_lists_select" on public.equipment_lists;
drop policy if exists "hems_lists_select_guard" on public.equipment_lists;
drop policy if exists "hems_lists_insert" on public.equipment_lists;
drop policy if exists "hems_lists_insert_guard" on public.equipment_lists;
drop policy if exists "hems_lists_update" on public.equipment_lists;
drop policy if exists "hems_lists_update_guard" on public.equipment_lists;
drop policy if exists "hems_lists_delete" on public.equipment_lists;
drop policy if exists "hems_lists_delete_guard" on public.equipment_lists;

create policy "hems_lists_select"
on public.equipment_lists for select to authenticated
using (
  list_type::text = 'internal_use'
  or (status::text = 'draft' and created_by = auth.uid())
  or (
    status::text = 'pending'
    and (
      created_by = auth.uid()
      or public.is_equipment_list_manager()
    )
  )
  or status::text in ('active', 'partially_returned', 'closed')
  or (
    status::text = 'cancelled'
    and (
      created_by = auth.uid()
      or public.is_equipment_list_manager()
    )
  )
);

create policy "hems_lists_select_guard"
on public.equipment_lists as restrictive for select to authenticated
using (
  list_type::text = 'internal_use'
  or (status::text = 'draft' and created_by = auth.uid())
  or (
    status::text = 'pending'
    and (
      created_by = auth.uid()
      or public.is_equipment_list_manager()
    )
  )
  or status::text in ('active', 'partially_returned', 'closed')
  or (
    status::text = 'cancelled'
    and (
      created_by = auth.uid()
      or public.is_equipment_list_manager()
    )
  )
);

create policy "hems_lists_insert"
on public.equipment_lists for insert to authenticated
with check (
  created_by = auth.uid()
  and status::text = 'draft'
  and (
    (list_type::text = 'internal_use' and public.is_equipment_list_manager())
    or (
      list_type::text = 'maintenance'
      and public.hems_current_user_role() in ('admin', 'warehouse_manager', 'head')
    )
    or list_type::text not in ('internal_use', 'maintenance')
  )
);

create policy "hems_lists_insert_guard"
on public.equipment_lists as restrictive for insert to authenticated
with check (
  created_by = auth.uid()
  and status::text = 'draft'
  and (
    (list_type::text = 'internal_use' and public.is_equipment_list_manager())
    or (
      list_type::text = 'maintenance'
      and public.hems_current_user_role() in ('admin', 'warehouse_manager', 'head')
    )
    or list_type::text not in ('internal_use', 'maintenance')
  )
);

create policy "hems_lists_update"
on public.equipment_lists for update to authenticated
using (public.hems_can_edit_equipment_list(id))
with check (
  public.is_equipment_list_manager()
  or (
    created_by = auth.uid()
    and list_type::text <> 'internal_use'
    and status::text in ('draft', 'pending')
    and (
      list_type::text <> 'maintenance'
      or public.hems_current_user_role() in ('admin', 'warehouse_manager', 'head')
    )
  )
);

create policy "hems_lists_update_guard"
on public.equipment_lists as restrictive for update to authenticated
using (public.hems_can_edit_equipment_list(id))
with check (
  public.is_equipment_list_manager()
  or (
    created_by = auth.uid()
    and list_type::text <> 'internal_use'
    and status::text in ('draft', 'pending')
    and (
      list_type::text <> 'maintenance'
      or public.hems_current_user_role() in ('admin', 'warehouse_manager', 'head')
    )
  )
);

create policy "hems_lists_delete"
on public.equipment_lists for delete to authenticated
using (
  status::text = 'draft'
  and (
    (list_type::text = 'internal_use' and public.is_equipment_list_manager())
    or (
      list_type::text <> 'internal_use'
      and created_by = auth.uid()
      and (
        list_type::text <> 'maintenance'
        or public.hems_current_user_role() in ('admin', 'warehouse_manager', 'head')
      )
    )
  )
);

create policy "hems_lists_delete_guard"
on public.equipment_lists as restrictive for delete to authenticated
using (
  status::text = 'draft'
  and (
    (list_type::text = 'internal_use' and public.is_equipment_list_manager())
    or (
      list_type::text <> 'internal_use'
      and created_by = auth.uid()
      and (
        list_type::text <> 'maintenance'
        or public.hems_current_user_role() in ('admin', 'warehouse_manager', 'head')
      )
    )
  )
);

drop policy if exists "hems_list_items_select" on public.equipment_list_items;
drop policy if exists "hems_list_items_select_guard" on public.equipment_list_items;
drop policy if exists "hems_list_items_insert" on public.equipment_list_items;
drop policy if exists "hems_list_items_insert_guard" on public.equipment_list_items;
drop policy if exists "hems_list_items_update" on public.equipment_list_items;
drop policy if exists "hems_list_items_update_guard" on public.equipment_list_items;
drop policy if exists "hems_list_items_delete" on public.equipment_list_items;
drop policy if exists "hems_list_items_delete_guard" on public.equipment_list_items;

create policy "hems_list_items_select"
on public.equipment_list_items for select to authenticated
using (public.hems_can_view_equipment_list(list_id));

create policy "hems_list_items_select_guard"
on public.equipment_list_items as restrictive for select to authenticated
using (public.hems_can_view_equipment_list(list_id));

create policy "hems_list_items_insert"
on public.equipment_list_items for insert to authenticated
with check (public.hems_can_edit_list_item(list_id, metadata));

create policy "hems_list_items_insert_guard"
on public.equipment_list_items as restrictive for insert to authenticated
with check (public.hems_can_edit_list_item(list_id, metadata));

create policy "hems_list_items_update"
on public.equipment_list_items for update to authenticated
using (public.hems_can_edit_equipment_list(list_id))
with check (public.hems_can_edit_list_item(list_id, metadata));

create policy "hems_list_items_update_guard"
on public.equipment_list_items as restrictive for update to authenticated
using (public.hems_can_edit_equipment_list(list_id))
with check (public.hems_can_edit_list_item(list_id, metadata));

create policy "hems_list_items_delete"
on public.equipment_list_items for delete to authenticated
using (public.hems_can_edit_equipment_list(list_id));

create policy "hems_list_items_delete_guard"
on public.equipment_list_items as restrictive for delete to authenticated
using (public.hems_can_edit_equipment_list(list_id));

drop policy if exists "maintenance requests visible by department"
  on public.maintenance_requests;
drop policy if exists "maintenance requests updated by department head"
  on public.maintenance_requests;
drop policy if exists "hems_maintenance_requests_select"
  on public.maintenance_requests;
drop policy if exists "hems_maintenance_requests_update"
  on public.maintenance_requests;

create policy "hems_maintenance_requests_select"
on public.maintenance_requests for select to authenticated
using (
  source_type = 'maintenance'
  or public.can_view_maintenance_request(department)
);

create policy "hems_maintenance_requests_update"
on public.maintenance_requests for update to authenticated
using (public.can_complete_maintenance_request(department))
with check (public.can_complete_maintenance_request(department));

grant select, update on public.maintenance_requests to authenticated;
revoke insert, delete on public.maintenance_requests from authenticated;

-- Dispatch ---------------------------------------------------------------

create or replace function public.approve_and_dispatch_equipment_list(
  p_list_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
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
      and active_list.list_type <> 'maintenance'
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

  return jsonb_build_object(
    'id', p_list_id, 'reference', v_list.reference, 'status', 'active',
    'approved_by', auth.uid(), 'approved_at', v_approved_at,
    'approved_quantity', v_requested_quantity
  );
end;
$function$;

-- Receive repaired equipment. It remains Maintenance until it is tested.
create or replace function public.receive_maintenance_list_item(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_request public.maintenance_requests%rowtype;
  v_list public.equipment_lists%rowtype;
  v_now timestamptz := now();
  v_actor_name text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;
  if not public.is_equipment_list_manager() then
    raise exception 'Only Warehouse or Admin can receive repaired equipment.'
      using errcode = '42501';
  end if;

  select * into v_request from public.maintenance_requests
  where id = p_request_id for update;
  if not found or v_request.source_type <> 'maintenance' then
    raise exception 'Maintenance request not found.' using errcode = 'P0002';
  end if;

  select * into v_list from public.equipment_lists
  where id = v_request.list_id for update;
  if not found or v_list.status <> 'active' then
    raise exception 'This maintenance list is not Active.';
  end if;

  if v_request.status = 'resolved' then
    raise exception 'This item has already been tested.';
  end if;

  update public.maintenance_requests
  set received_quantity = quantity, received_at = coalesce(received_at, v_now),
      received_by = auth.uid(), status = 'received', updated_at = v_now
  where id = v_request.id;

  select nullif(btrim(full_name), '') into v_actor_name
  from public.profiles where id = auth.uid();

  insert into public.equipment_list_activity (
    list_id, action, message, actor_id, actor_name, details
  ) values (
    v_list.id, 'maintenance_received',
    v_request.display_name || ' received from repair; awaiting test',
    auth.uid(), coalesce(v_actor_name, 'Warehouse Manager'),
    jsonb_build_object(
      'maintenance_request_id', v_request.id,
      'quantity', v_request.quantity
    )
  );

  return jsonb_build_object(
    'request_id', v_request.id,
    'status', 'received',
    'received_quantity', v_request.quantity
  );
end;
$function$;

-- Admin or the matching department Head tests received equipment.
create or replace function public.test_maintenance_list_item(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_request public.maintenance_requests%rowtype;
  v_list public.equipment_lists%rowtype;
  v_test_quantity integer;
  v_open_requests integer;
  v_now timestamptz := now();
  v_actor_name text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.' using errcode = '42501';
  end if;

  select * into v_request from public.maintenance_requests
  where id = p_request_id for update;
  if not found or v_request.source_type <> 'maintenance' then
    raise exception 'Maintenance request not found.' using errcode = 'P0002';
  end if;

  if not public.can_complete_maintenance_request(v_request.department) then
    raise exception 'Only Admin or the relevant department Head can confirm testing.'
      using errcode = '42501';
  end if;

  if v_request.status <> 'received' then
    raise exception 'Warehouse must mark this item Received before testing.';
  end if;

  v_test_quantity := greatest(
    0, v_request.received_quantity - v_request.tested_quantity
  );
  if v_test_quantity = 0 then
    raise exception 'There is no received quantity waiting for test.';
  end if;

  select * into v_list from public.equipment_lists
  where id = v_request.list_id for update;
  if not found or v_list.status <> 'active' then
    raise exception 'This maintenance list is not Active.';
  end if;

  if v_request.inventory_record_type = 'unit' then
    update public.units set status = 'available'
    where id = v_request.inventory_record_id and status = 'maintenance';
    if not found then
      raise exception 'The unit is no longer in Maintenance.';
    end if;
  elsif v_request.inventory_record_type = 'matrix_model' then
    update public.matrix_models
    set maintenance_qty = greatest(
      0, coalesce(maintenance_qty, 0) - v_test_quantity
    )
    where id = v_request.inventory_record_id;
    if not found then
      raise exception 'The Matrix item no longer exists.';
    end if;
  else
    update public.matrix_rows
    set
      maintenance_qty = greatest(
        0, coalesce(maintenance_qty, 0) - v_test_quantity
      ),
      available_qty = case
        when coalesce(v_request.metadata #>> '{equipment_metadata,matrix_source}', '') = 'generic'
          then available_qty
        else greatest(
          0,
          least(
            greatest(
              0,
              coalesce(qty, 0)
                - greatest(0, coalesce(maintenance_qty, 0) - v_test_quantity)
                - coalesce(in_use_qty, 0)
                - coalesce(in_ksa_qty, 0)
            ),
            coalesce(available_qty, 0) + v_test_quantity
          )
        )
      end
    where id = v_request.inventory_record_id;
    if not found then
      raise exception 'The Matrix row no longer exists.';
    end if;
  end if;

  update public.maintenance_requests
  set tested_quantity = received_quantity, tested_at = v_now,
      tested_by = auth.uid(), status = 'resolved', resolved_at = v_now,
      updated_at = v_now
  where id = v_request.id;

  select count(*)::integer into v_open_requests
  from public.maintenance_requests
  where list_id = v_list.id
    and source_type = 'maintenance'
    and status <> 'resolved';

  if v_open_requests = 0 then
    update public.equipment_lists
    set status = 'closed', closed_at = v_now, updated_at = v_now
    where id = v_list.id;
  end if;

  select nullif(btrim(full_name), '') into v_actor_name
  from public.profiles where id = auth.uid();

  insert into public.equipment_list_activity (
    list_id, action, message, actor_id, actor_name, details
  ) values (
    v_list.id, 'maintenance_tested',
    v_request.display_name || ' tested and returned to Available',
    auth.uid(), coalesce(v_actor_name, 'Department Head'),
    jsonb_build_object(
      'maintenance_request_id', v_request.id,
      'quantity', v_test_quantity,
      'list_closed', v_open_requests = 0
    )
  );

  return jsonb_build_object(
    'request_id', v_request.id,
    'status', 'resolved',
    'tested_quantity', v_request.received_quantity,
    'list_status', case when v_open_requests = 0 then 'closed' else 'active' end
  );
end;
$function$;

revoke all on function public.hems_current_user_role() from public, anon;
revoke all on function public.hems_current_user_department() from public, anon;
revoke all on function public.is_equipment_list_manager() from public, anon;
revoke all on function public.hems_inventory_department(text, text) from public, anon;
revoke all on function public.hems_can_view_equipment_list(uuid) from public, anon;
revoke all on function public.hems_can_edit_equipment_list(uuid) from public, anon;
revoke all on function public.hems_can_edit_list_item(uuid, jsonb) from public, anon;
revoke all on function public.can_view_maintenance_request(text) from public, anon;
revoke all on function public.can_complete_maintenance_request(text) from public, anon;
revoke all on function public.approve_and_dispatch_equipment_list(uuid) from public, anon;
revoke all on function public.receive_maintenance_list_item(uuid) from public, anon;
revoke all on function public.test_maintenance_list_item(uuid) from public, anon;

grant execute on function public.hems_current_user_role() to authenticated;
grant execute on function public.hems_current_user_department() to authenticated;
grant execute on function public.is_equipment_list_manager() to authenticated;
grant execute on function public.hems_inventory_department(text, text) to authenticated;
grant execute on function public.hems_can_view_equipment_list(uuid) to authenticated;
grant execute on function public.hems_can_edit_equipment_list(uuid) to authenticated;
grant execute on function public.hems_can_edit_list_item(uuid, jsonb) to authenticated;
grant execute on function public.can_view_maintenance_request(text) to authenticated;
grant execute on function public.can_complete_maintenance_request(text) to authenticated;
grant execute on function public.approve_and_dispatch_equipment_list(uuid) to authenticated;
grant execute on function public.receive_maintenance_list_item(uuid) to authenticated;
grant execute on function public.test_maintenance_list_item(uuid) to authenticated;

commit;

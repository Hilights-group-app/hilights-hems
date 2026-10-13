-- Apply after the existing KSA and maintenance migrations. No approval RPC is replaced.
begin;
set local lock_timeout = '15s';
create or replace function public.hems_current_user_role()
returns text language sql stable security definer set search_path = '' as $$
  select lower(btrim(coalesce((select role::text from public.profiles where id=auth.uid()),'')));
$$;
create or replace function public.hems_current_user_department()
returns text language sql stable security definer set search_path = '' as $$
  select lower(btrim(coalesce((select department::text from public.profiles where id=auth.uid()),'')));
$$;
create or replace function public.hems_maintenance_user_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('role',public.hems_current_user_role(),'department',public.hems_current_user_department());
$$;
revoke all on function public.hems_maintenance_user_access() from public, anon;
grant execute on function public.hems_maintenance_user_access() to authenticated;
create or replace function public.can_complete_maintenance_request(p_department text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    public.hems_current_user_role()='admin' or (
      public.hems_current_user_role()='head'
      and lower(btrim(coalesce(p_department,''))) in ('lighting','video','rigging')
      and public.hems_current_user_department()=lower(btrim(p_department))
    ));
$$;
create or replace function public.can_view_maintenance_request(p_department text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (public.is_equipment_list_manager() is true
    or public.can_complete_maintenance_request(p_department) is true);
$$;
-- Classify the category before generic subcategory names such as "consoles".
-- Word boundaries prevent "serialized" being mistaken for LED equipment.
create or replace function public.hems_inventory_department(p_category text,p_subcategory text default '')
returns text language plpgsql immutable set search_path = '' as $$
declare route text;
begin
  foreach route in array array[lower(coalesce(p_category,'')),lower(coalesce(p_subcategory,''))] loop
    if route ~ '\m(video|led|screens?|projectors?|projection|media|servers?|network|processors?|cameras?|lenses?|lens)\M' then return 'video';
    elsif route ~ '\m(rigging|truss|trusses|hoists?|motors?|lifting)\M' then return 'rigging';
    elsif route ~ '\m(lighting|lights?|fixtures?|dimmers?|consoles?)\M' then return 'lighting'; end if;
  end loop;
  return 'general';
end; $$;
-- Repair existing open requests from their saved inventory category only.
-- Never infer a department from a free-text equipment name or user permission.
with classified as (
  select r.id,public.hems_inventory_department(
    coalesce(nullif(i.metadata->>'category',''),r.metadata#>>'{equipment_metadata,category}'),
    coalesce(nullif(i.metadata->>'subcategory',''),r.metadata#>>'{equipment_metadata,subcategory}')
  ) as department
  from public.maintenance_requests r
  join public.equipment_lists l on l.id=r.list_id
  left join public.equipment_list_items i on i.id=r.list_item_id
  where r.source_type='maintenance' and l.status::text='active' and r.status<>'resolved'
)
update public.maintenance_requests r set department=c.department,updated_at=now()
from classified c where r.id=c.id and c.department<>'general' and r.department is distinct from c.department;

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


commit;

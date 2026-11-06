-- Local Event header only. No existing event or stock is edited on Run.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $guard$ declare body text; begin
  select p.prosrc into body from pg_proc p where p.oid=to_regprocedure('public.hems_guard_equipment_draft_sharing()');
  if body is null or md5(btrim(replace(body,chr(13),''),E' \n\t')) not in ('fdd383a273e559f3446481cd484aab20','a34bfbec374591225c73b818c6210f1a') then
    raise exception 'The live draft-sharing guard differs from this project. Stop and export hems_guard_equipment_draft_sharing(); do not bypass this check.';
  end if;
end; $guard$;

create or replace function public.hems_guard_equipment_draft_sharing()
returns trigger language plpgsql security definer set search_path='' as $function$
declare
  caller uuid := auth.uid();
begin
  if caller is null then return new; end if;

  if tg_op = 'UPDATE' then
    -- Scoped metadata-only exception; Submit and Share remain creator-only.
    if old.list_type::text='local_event' and old.status::text='draft' and new.status::text='draft'
      and (to_jsonb(new)-'event_name'-'venue'-'updated_at') is not distinct from (to_jsonb(old)-'event_name'-'venue'-'updated_at') then
      if public.hems_can_view_equipment_list(old.id) is not true
        or (caller=old.created_by or coalesce(old.shared_with @> array[caller],false) or public.hems_current_user_role()='admin') is not true then
        raise exception 'This draft is not shared with you.' using errcode='42501'; end if;
      return new;
    end if;
    if old.list_type::text='local_event' and old.status::text<>'draft'
      and (new.event_name is distinct from old.event_name or new.venue is distinct from old.venue) then
      if public.hems_current_user_role() is distinct from 'admin' or new.venue is distinct from old.venue then
        raise exception 'Only Admin can rename a submitted event; location stays unchanged.' using errcode='42501'; end if;
    end if;
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
$function$;
revoke all on function public.hems_guard_equipment_draft_sharing() from public,anon,authenticated;

-- A narrow RPC: no changes to quantities, stock, dates, sharing or workflow.
create or replace function public.hems_edit_local_event_header(
  p_list_id uuid,p_event_name text,p_venue text,
  p_expected_name text,p_expected_venue text,p_expected_status text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare parent public.equipment_lists%rowtype; caller uuid:=auth.uid(); role_name text;
  event_title text:=btrim(coalesce(p_event_name,'')); location_name text; actor text;
begin
  if caller is null then raise exception 'Sign in before editing the event.' using errcode='42501'; end if;
  select * into parent from public.equipment_lists where id=p_list_id and public.hems_can_view_equipment_list(id) for update;
  if not found or parent.list_type::text<>'local_event' then raise exception 'This local event is unavailable.' using errcode='42501'; end if;
  role_name:=public.hems_current_user_role();
  if parent.status::text='draft' then
    if (parent.created_by=caller or coalesce(parent.shared_with @> array[caller],false) or role_name='admin') is not true then
      raise exception 'This draft is not shared with you.' using errcode='42501'; end if;
    location_name:=btrim(coalesce(p_venue,''));
    if length(location_name)<1 or length(location_name)>300 then raise exception 'Enter a location from 1 to 300 characters.' using errcode='23514'; end if;
  elsif parent.status::text in ('pending','active','partially_returned','closed') then
    if role_name is distinct from 'admin' then raise exception 'Only Admin can rename a submitted event.' using errcode='42501'; end if;
    if p_venue is distinct from parent.venue then raise exception 'Location cannot be changed after Submit.' using errcode='42501'; end if;
    location_name:=parent.venue;
  else raise exception 'This event cannot be edited.' using errcode='23514'; end if;
  if parent.status::text is distinct from p_expected_status
    or parent.event_name is distinct from p_expected_name or parent.venue is distinct from p_expected_venue then
    raise exception 'The event details or status changed. Refresh the list before editing.' using errcode='40001'; end if;
  if length(event_title)<1 or length(event_title)>200 then raise exception 'Enter an event name from 1 to 200 characters.' using errcode='23514'; end if;
  if parent.event_name is not distinct from event_title and parent.venue is not distinct from location_name then
    return jsonb_build_object('id',parent.id,'already_saved',true);
  end if;
  update public.equipment_lists set event_name=event_title,venue=location_name,updated_at=now() where id=parent.id;
  select nullif(btrim(full_name),'') into actor from public.profiles where id=caller;
  insert into public.equipment_list_activity(list_id,action,message,actor_id,actor_name,details)
    values(parent.id,'event_details_updated',parent.reference || ' event details updated',caller,coalesce(actor,'Team member'),
      jsonb_build_object('old_event_name',parent.event_name,'new_event_name',event_title,'old_location',parent.venue,'new_location',location_name));
  return jsonb_build_object('id',parent.id,'event_name',event_title,'venue',location_name,'status',parent.status);
end; $$;
revoke all on function public.hems_edit_local_event_header(uuid,text,text,text,text,text) from public,anon;
grant execute on function public.hems_edit_local_event_header(uuid,text,text,text,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;

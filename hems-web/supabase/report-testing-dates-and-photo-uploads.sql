-- Report-wide testing dates and compressed report photos. Safe to run again.
-- No old testing dates or photos are deleted or automatically overwritten.
begin;
set local lock_timeout = '5s';

alter table public.units add column if not exists testing_date date;
alter table public.matrix_rows add column if not exists testing_date date;

create or replace function public.hems_set_led_report_testing_date(p_row_id uuid, p_testing_date date)
returns date
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_role text; v_department text; v_date date;
begin
  if auth.uid() is null then raise exception 'Sign in to update this report.'; end if;
  select p.role::text, lower(coalesce(p.department::text, ''))
    into v_role, v_department from public.profiles p where p.id = auth.uid();
  if not (coalesce(v_role, '') in ('admin','warehouse_manager')
      or (coalesce(v_role, '') = 'head' and coalesce(v_department, '') = 'video')) then
    raise exception 'You do not have permission to edit this LED report.';
  end if;
  if p_testing_date is null then raise exception 'Choose a testing date.'; end if;
  update public.matrix_rows set testing_date = p_testing_date
    where id = p_row_id returning testing_date into v_date;
  if not found then raise exception 'LED report not found.'; end if;
  return v_date;
end;
$$;
revoke all on function public.hems_set_led_report_testing_date(uuid,date) from public, anon;
grant execute on function public.hems_set_led_report_testing_date(uuid,date) to authenticated;

-- Existing inventory photo policies are preserved. Allow compressed report
-- objects in a dedicated folder for the same roles that can edit reports.
drop policy if exists hems_report_photo_insert on storage.objects;
create policy hems_report_photo_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'equipment-photos'
  and (storage.foldername(name))[1] = 'unit-reports'
  and public.hems_current_user_role() in ('admin','warehouse_manager','head')
  and lower(storage.extension(name)) in ('webp','jpg')
);

commit;

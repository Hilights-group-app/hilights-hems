-- Requires maintenance-repair-lifecycle.sql already applied. Run this focused update once.
begin;
do $$ begin
 if not exists(select 1 from information_schema.columns where table_schema='public'
   and table_name='led_maintenance_logs' and column_name='stock_quantity') then
  raise exception 'Apply maintenance-repair-lifecycle.sql before led-issue-repaired.sql.';
 end if;
end; $$;
alter table public.led_maintenance_logs
 add column if not exists repaired_quantity integer not null default 0,
 add column if not exists repaired_at timestamptz,
 add column if not exists repaired_by uuid references auth.users(id) on delete set null;

create table if not exists public.led_issue_repairs(
 id uuid primary key default gen_random_uuid(),
 issue_id uuid not null references public.led_maintenance_logs(id) on delete cascade,
 matrix_row_id uuid not null references public.matrix_rows(id) on delete cascade,
 quantity integer not null check(quantity>0),
 released_quantity integer not null check(released_quantity>=0 and released_quantity<=quantity),
 action text not null check(action in ('repaired','tested')),
 note text not null default '',
 actor_id uuid references auth.users(id) on delete set null,
 actor_name text not null,
 created_at timestamptz not null default now()
);
create index if not exists led_issue_repairs_issue_created_idx on public.led_issue_repairs(issue_id,created_at desc);
alter table public.led_issue_repairs enable row level security;
revoke all on public.led_issue_repairs from public,anon,authenticated;
grant select on public.led_issue_repairs to authenticated;
drop policy if exists "led repair history readable with issue" on public.led_issue_repairs;
create policy "led repair history readable with issue" on public.led_issue_repairs for select to authenticated
using(exists(select 1 from public.led_maintenance_logs issue where issue.id=issue_id));

create or replace function public.hems_led_issue_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_row uuid; v_old integer:=0;v_new integer:=0;v_delta integer;v_floor integer;
 v_stock public.matrix_rows%rowtype;v_old_qty integer:=0;v_new_qty integer:=0;
begin
 if tg_op<>'INSERT' then v_row:=old.matrix_row_id;v_old:=old.stock_quantity;
  if old.problem_type not in ('damaged_housing','hub_card_problem') then v_old_qty:=greatest(0,old.qty); end if;
 end if;
 if tg_op<>'DELETE' then
  if tg_op='UPDATE' and new.matrix_row_id is distinct from old.matrix_row_id then
   raise exception 'An LED issue cannot be moved to a different stock row.';
  end if;
  if tg_op='UPDATE' and current_setting('hems.testing_led_stock',true)='on'
    and current_setting('hems.led_repair_action',true)='repaired'
    and old.problem_type in ('damaged_housing','hub_card_problem') then return new; end if;
  v_row:=new.matrix_row_id;
  if new.problem_type not in ('damaged_housing','hub_card_problem') then v_new_qty:=greatest(0,new.qty); end if;
  -- Internal Tested updates only stock_quantity, never historical problem qty.
  if tg_op='UPDATE' and new.stock_quantity is distinct from old.stock_quantity then
   if current_setting('hems.testing_led_stock',true)='on' then
    if new.stock_quantity<old.stock_quantity then
     v_delta:=old.stock_quantity-new.stock_quantity;
     new.repaired_quantity:=old.repaired_quantity+v_delta;
     new.repaired_at:=now();new.repaired_by:=auth.uid();
     insert into public.led_issue_repairs(issue_id,matrix_row_id,quantity,released_quantity,action,actor_id,actor_name,note)
     values(old.id,old.matrix_row_id,v_delta,v_delta,
       case when current_setting('hems.led_repair_action',true)='repaired' then 'repaired' else 'tested' end,
       auth.uid(),coalesce((select nullif(btrim(full_name),'') from public.profiles where id=auth.uid()),'Unknown User'),
       case when current_setting('hems.led_repair_action',true)='repaired' then coalesce(current_setting('hems.led_repair_note',true),'') else '' end);
    end if;
    return new;
   end if;
  end if;
  if tg_op='UPDATE' then
   if new.qty<old.repaired_quantity then raise exception 'Original quantity cannot be lower than the already repaired quantity.'; end if;
   new.repaired_quantity:=old.repaired_quantity;
   new.repaired_at:=old.repaired_at;new.repaired_by:=old.repaired_by;
  else
   new.repaired_quantity:=0;new.repaired_at:=null;new.repaired_by:=null;
  end if;
  v_new:=greatest(0,v_old+v_new_qty-v_old_qty);
  new.stock_quantity:=v_new;
 end if;
 v_delta:=v_new-v_old;
 if v_delta<>0 then
  select * into v_stock from public.matrix_rows where id=v_row for update;
  if not found then
   if tg_op='DELETE' then return old; end if;
   raise exception 'The LED stock row no longer exists.';
  end if;
  select coalesce(sum(r.quantity-r.tested_quantity),0)::integer into v_floor
   from public.maintenance_requests r join public.equipment_lists l on l.id=r.list_id
   where r.inventory_record_type='matrix_row' and r.inventory_record_id=v_row
    and r.source_type='maintenance' and r.status in ('sent','received') and l.status='active';
  if coalesce(v_stock.maintenance_qty,0)+v_delta<v_floor then
   raise exception 'This LED quantity is in an active repair. Use Received, then Tested.';
  end if;
  if v_delta>0 and v_delta>greatest(0,coalesce(v_stock.qty,0)-coalesce(v_stock.in_use_qty,0)-coalesce(v_stock.in_ksa_qty,0)-coalesce(v_stock.maintenance_qty,0)) then
   raise exception 'The report quantity exceeds the available LED stock.';
  end if;
  update public.matrix_rows set maintenance_qty=greatest(0,coalesce(maintenance_qty,0)+v_delta),
    available_qty=greatest(0,coalesce(qty,0)-coalesce(in_use_qty,0)-coalesce(in_ksa_qty,0)-greatest(0,coalesce(maintenance_qty,0)+v_delta))
  where id=v_row;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;
revoke all on function public.hems_led_issue_stock() from public,anon,authenticated;
drop trigger if exists hems_led_issue_stock on public.led_maintenance_logs;
create trigger hems_led_issue_stock before insert or update or delete on public.led_maintenance_logs
for each row execute function public.hems_led_issue_stock();


-- Atomic local repair. Original issue quantity, notes, photos and dates are never changed.
create or replace function public.hems_repair_led_issue(
 p_issue_id uuid,p_quantity integer,p_expected_remaining integer,p_note text default ''
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_issue public.led_maintenance_logs%rowtype;v_row public.matrix_rows%rowtype;
 v_row_id uuid;v_remaining integer;v_stock_tracked boolean;v_released integer:=0;v_name text;v_note text:=btrim(coalesce(p_note,''));
begin
 if auth.uid() is null or public.can_complete_maintenance_request('video') is not true then
  raise exception 'Only Admin or Head of Video can confirm an LED repair.' using errcode='42501';
 end if;
 if p_quantity is null or p_quantity<=0 or p_expected_remaining is null then
  raise exception 'Enter a positive whole number of cabinets.';
 end if;
 if length(v_note)>2000 then raise exception 'Repair note must be 2000 characters or fewer.'; end if;
 -- Same advisory lock as dispatch. Lock issue logs before the stock row, as Tested does.
 perform pg_catalog.pg_advisory_xact_lock(742193,1);
 select matrix_row_id into v_row_id from public.led_maintenance_logs where id=p_issue_id;
 if not found then raise exception 'The issue no longer exists.'; end if;
 perform 1 from public.led_maintenance_logs where matrix_row_id=v_row_id order by created_at,id for update;
 select * into v_issue from public.led_maintenance_logs where id=p_issue_id and matrix_row_id=v_row_id;
 if not found then raise exception 'The issue changed. Reopen the report and try again.'; end if;
 select * into v_row from public.matrix_rows where id=v_row_id for update;
 if not found then raise exception 'The LED stock row no longer exists.'; end if;
 v_stock_tracked:=v_issue.problem_type not in ('damaged_housing','hub_card_problem');
 v_remaining:=case when v_stock_tracked then v_issue.stock_quantity else greatest(0,v_issue.qty-v_issue.repaired_quantity) end;
 if v_remaining=0 then
  return jsonb_build_object('issue',to_jsonb(v_issue),'row',to_jsonb(v_row),'released_quantity',0,'already_repaired',true);
 end if;
 if v_remaining<>p_expected_remaining then
  raise exception 'This issue was updated by another user. Refresh it before confirming another repair.';
 end if;
 if p_quantity>v_remaining then raise exception 'Repaired quantity exceeds the remaining issue quantity.'; end if;
 -- Cabinet repair requests identify a stock row, not the individual issue/panel.
 -- Avoid guessing which panels are external: finish Received/Tested for this row first.
 if public.hems_open_repair_quantity('matrix_row',v_row_id)>0 then
  raise exception 'This cabinet type has an active external repair. Complete Received and Tested in the maintenance list first.';
 end if;
 if v_stock_tracked then
  if coalesce(v_row.maintenance_qty,0)<p_quantity then
   raise exception 'Repair / stock mismatch. Review Maintenance stock before confirming repair.';
  end if;
  v_released:=p_quantity;
 end if;
 select coalesce(nullif(btrim(full_name),''),'Unknown User') into v_name from public.profiles where id=auth.uid();
 perform pg_catalog.set_config('hems.testing_led_stock','on',true);
 perform pg_catalog.set_config('hems.led_repair_action','repaired',true);
 perform pg_catalog.set_config('hems.led_repair_note',v_note,true);
 if v_stock_tracked then
  -- Trigger records repaired counters/history. This RPC applies the physical stock delta once.
  update public.led_maintenance_logs set stock_quantity=stock_quantity-p_quantity
   where id=p_issue_id returning * into v_issue;
  update public.matrix_rows set maintenance_qty=maintenance_qty-p_quantity,
   available_qty=greatest(0,coalesce(qty,0)-coalesce(in_use_qty,0)-coalesce(in_ksa_qty,0)-(maintenance_qty-p_quantity))
   where id=v_row_id returning * into v_row;
 else
  update public.led_maintenance_logs set repaired_quantity=repaired_quantity+p_quantity,
   repaired_at=now(),repaired_by=auth.uid() where id=p_issue_id returning * into v_issue;
  insert into public.led_issue_repairs(issue_id,matrix_row_id,quantity,released_quantity,action,actor_id,actor_name,note)
   values(p_issue_id,v_row_id,p_quantity,0,'repaired',auth.uid(),coalesce(v_name,'Unknown User'),v_note);
 end if;
 perform pg_catalog.set_config('hems.testing_led_stock','off',true);
 perform pg_catalog.set_config('hems.led_repair_action','',true);
 perform pg_catalog.set_config('hems.led_repair_note','',true);
 return jsonb_build_object('issue',to_jsonb(v_issue),'row',to_jsonb(v_row),'released_quantity',v_released,'already_repaired',false);
end; $$;
revoke all on function public.hems_repair_led_issue(uuid,integer,integer,text) from public,anon;
grant execute on function public.hems_repair_led_issue(uuid,integer,integer,text) to authenticated;
notify pgrst,'reload schema';
commit;

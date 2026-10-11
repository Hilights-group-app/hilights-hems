-- Run once in Supabase SQL Editor before deploying the shared-order update.
begin;

create table if not exists public.matrix_manual_orders (
  subcategory_id uuid primary key references public.subcategories(id) on delete cascade,
  block_order jsonb not null default '[]'::jsonb
    check (jsonb_typeof(block_order) = 'array'),
  item_order_by_block jsonb not null default '{}'::jsonb
    check (jsonb_typeof(item_order_by_block) = 'object')
);

alter table public.matrix_manual_orders enable row level security;
revoke all on public.matrix_manual_orders from public, anon, authenticated;
grant select, insert, update on public.matrix_manual_orders to authenticated;

-- Keep the existing inventory editor permissions. Drag handles remain admin-only.
create or replace function public.hems_can_save_matrix_order()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role::text in ('admin', 'warehouse_manager')
  );
$$;

revoke all on function public.hems_can_save_matrix_order() from public, anon;
grant execute on function public.hems_can_save_matrix_order() to authenticated;

drop policy if exists "matrix_order_read" on public.matrix_manual_orders;
create policy "matrix_order_read" on public.matrix_manual_orders
for select to authenticated using (true);

drop policy if exists "matrix_order_insert" on public.matrix_manual_orders;
create policy "matrix_order_insert" on public.matrix_manual_orders
for insert to authenticated
with check ((select public.hems_can_save_matrix_order()));

drop policy if exists "matrix_order_update" on public.matrix_manual_orders;
create policy "matrix_order_update" on public.matrix_manual_orders
for update to authenticated
using ((select public.hems_can_save_matrix_order()))
with check ((select public.hems_can_save_matrix_order()));

notify pgrst, 'reload schema';
commit;

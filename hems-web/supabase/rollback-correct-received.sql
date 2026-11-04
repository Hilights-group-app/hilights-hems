-- Deploy the included previous UI files BEFORE removing these two new RPCs.
-- This removes the feature, not any recorded receipt correction or audit.
begin;
set local lock_timeout='5s';
drop function if exists public.hems_correct_received_ok_quantity(uuid,integer,integer,integer,integer,text);
drop function if exists public.hems_add_active_matrix_quantity(uuid,text,uuid,integer,uuid,text,text,jsonb,bigint);
notify pgrst,'reload schema';
commit;

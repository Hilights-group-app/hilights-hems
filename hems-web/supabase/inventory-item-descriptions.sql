-- Multiline descriptions shown below equipment brand/model in inventory pages.
-- Safe to run more than once.

alter table public.items
  add column if not exists description text;

alter table public.matrix_models
  add column if not exists description text;

comment on column public.items.description is
  'Optional multiline equipment description displayed below the item name.';

comment on column public.matrix_models.description is
  'Optional multiline equipment description displayed below the matrix or LED model name.';

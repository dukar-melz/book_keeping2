-- Bookkeeping agent — Supabase schema
-- Run all of this in the Supabase SQL editor.

create table if not exists public.expenses (
  id uuid primary key,
  date date,
  vendor text,
  description text,
  category text,
  currency text,
  amount numeric,
  amount_usd numeric,
  exchange_rate numeric,
  payment_method text,
  receipt jsonb,
  line_items jsonb,
  tags text[],
  notes text,
  created_at timestamptz,
  updated_at timestamptz
);

create index if not exists expenses_date_idx on public.expenses (date desc);
create index if not exists expenses_vendor_idx on public.expenses (vendor);
create index if not exists expenses_category_idx on public.expenses (category);
create index if not exists expenses_tags_idx on public.expenses using gin (tags);

create table if not exists public.facts (
  id uuid primary key,
  key text unique not null,
  value jsonb,
  source text,
  notes text,
  created_at timestamptz
);

alter table public.expenses enable row level security;
alter table public.facts enable row level security;

-- Private bucket for uploaded receipts.
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;
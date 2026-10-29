-- PostCrew database. Paste this whole file into Supabase > SQL Editor > New query > Run.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  plan text not null default 'free',
  subscription_status text,
  stripe_customer_id text unique,
  stripe_subscription_id text,
  usage_month text,
  usage_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.brands (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  description text not null,
  audience text,
  tone text,
  updated_at timestamptz not null default now()
);

create table if not exists public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  input jsonb not null,
  posts jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists generations_user_created on public.generations (user_id, created_at desc);

-- Lock the tables: only the server (service role key) can read or write them.
-- The browser never talks to these tables directly.
alter table public.profiles enable row level security;
alter table public.brands enable row level security;
alter table public.generations enable row level security;

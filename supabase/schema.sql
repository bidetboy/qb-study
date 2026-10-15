-- Run once in Supabase: SQL Editor → New query → paste → Run.
create table if not exists public.user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

drop policy if exists "read own data" on public.user_data;
drop policy if exists "insert own data" on public.user_data;
drop policy if exists "update own data" on public.user_data;

create policy "read own data" on public.user_data
  for select using (auth.uid() = user_id);
create policy "insert own data" on public.user_data
  for insert with check (auth.uid() = user_id);
create policy "update own data" on public.user_data
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Password recovery codes (no email needed).
-- Codes are stored only as bcrypt hashes; the table has no policies, so it is
-- reachable solely through the functions below.
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.recovery_codes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now()
);

alter table public.recovery_codes enable row level security;

-- Signed-in user sets (or replaces) their own recovery code.
create or replace function public.set_recovery_code(p_code text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if length(p_code) < 16 then
    raise exception 'Recovery code too short';
  end if;
  insert into public.recovery_codes (user_id, code_hash)
  values (auth.uid(), crypt(p_code, gen_salt('bf')))
  on conflict (user_id) do update set code_hash = excluded.code_hash, created_at = now();
end;
$$;

create or replace function public.has_recovery_code()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.recovery_codes where user_id = auth.uid());
$$;

-- Anyone may call this; it only succeeds with the right username + recovery code.
-- On success the password is changed, other sessions are signed out, and the
-- code is replaced by p_new_code (each code works once).
create or replace function public.reset_password_with_code(
  p_username text, p_code text, p_new_password text, p_new_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid;
  v_hash text;
begin
  if length(p_new_password) < 6 then
    raise exception 'Password must be at least 6 characters.';
  end if;
  if length(p_new_code) < 16 then
    raise exception 'Recovery code too short';
  end if;

  select u.id, r.code_hash into v_user, v_hash
  from auth.users u
  join public.recovery_codes r on r.user_id = u.id
  where u.email = lower(trim(p_username)) || '@users.qbstudy.app';

  if v_user is null or crypt(p_code, v_hash) <> v_hash then
    perform pg_sleep(1); -- slow down guessing
    return false;
  end if;

  update auth.users
  set encrypted_password = crypt(p_new_password, gen_salt('bf')), updated_at = now()
  where id = v_user;

  update public.recovery_codes
  set code_hash = crypt(p_new_code, gen_salt('bf')), created_at = now()
  where user_id = v_user;

  begin
    delete from auth.sessions where user_id = v_user;
  exception when undefined_table then null;
  end;

  return true;
end;
$$;

revoke all on function public.set_recovery_code(text) from public, anon;
revoke all on function public.has_recovery_code() from public, anon;
revoke all on function public.reset_password_with_code(text, text, text, text) from public;
grant execute on function public.set_recovery_code(text) to authenticated;
grant execute on function public.has_recovery_code() to authenticated;
grant execute on function public.reset_password_with_code(text, text, text, text) to anon, authenticated;

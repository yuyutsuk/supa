create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

create unique index if not exists app_users_email_lower_key
  on public.app_users (lower(email))
  where email is not null;

with canonical_users as (
  select id, max(email) as email
  from (
    select id, email from auth.users
    union all
    select distinct user_id as id, null::text as email from public.items
  ) as owners
  group by id
)
insert into public.app_users (id, email)
select id, email from canonical_users
on conflict (id) do update
  set email = coalesce(public.app_users.email, excluded.email);

create table if not exists public.user_identities (
  provider text not null,
  provider_sub uuid not null,
  user_id uuid not null references public.app_users(id),
  verified_email text,
  linked_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (provider, provider_sub),
  unique (provider, user_id)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'items_user_id_app_users_fkey'
      and conrelid = 'public.items'::regclass
  ) then
    alter table public.items
      add constraint items_user_id_app_users_fkey
      foreign key (user_id) references public.app_users(id)
      not valid;
    alter table public.items validate constraint items_user_id_app_users_fkey;
  end if;
end;
$$;

alter table public.app_users enable row level security;
alter table public.user_identities enable row level security;

drop policy if exists "app users can read own row" on public.app_users;
create policy "app users can read own row"
  on public.app_users
  for select
  to authenticated
  using ((select auth.uid()) = id);

grant select on public.app_users to authenticated;
revoke all on public.user_identities from anon, authenticated;

create or replace function public.resolve_or_provision_current_identity()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  access_sub uuid := (select auth.uid());
  access_email text := nullif(lower((select auth.jwt() ->> 'email')), '');
  bridge_stage text := nullif((select auth.jwt() ->> 'bridge_stage'), '');
  canonical_user_id uuid;
  identity_revoked_at timestamptz;
begin
  if access_sub is null
    or bridge_stage is distinct from 'identity_resolution'
    or access_email is null then
    raise exception 'invalid identity-resolution token' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(access_sub::text, 0));

  select user_id, revoked_at
  into canonical_user_id, identity_revoked_at
  from public.user_identities
  where provider = 'cloudflare_access'
    and provider_sub = access_sub;

  if found then
    if identity_revoked_at is not null then
      raise exception 'identity link is revoked' using errcode = '28000';
    end if;
    return canonical_user_id;
  end if;

  select id
  into canonical_user_id
  from public.app_users
  where lower(email) = access_email;

  if not found then
    begin
      insert into public.app_users (email)
      values (access_email)
      returning id into canonical_user_id;
    exception when unique_violation then
      select id
      into canonical_user_id
      from public.app_users
      where lower(email) = access_email;
    end;
  end if;

  insert into public.user_identities (
    provider,
    provider_sub,
    user_id,
    verified_email
  )
  values (
    'cloudflare_access',
    access_sub,
    canonical_user_id,
    access_email
  );

  return canonical_user_id;
end;
$$;

revoke all on function public.resolve_or_provision_current_identity() from public, anon;
grant execute on function public.resolve_or_provision_current_identity() to authenticated;

# Identity migration design proposal

## Status

**Phase 1 implemented locally; Worker deployment and end-to-end Access test pending.**

Supabase schema migration `20260915000100_identity_migration.sql` is applied.
Cloudflare D1 database `items-api-identities` has the `access_identities`
directory schema applied. The Worker now checks D1 first and only uses the
Supabase resolver on a D1 miss.

## Problem

Today, existing ownership is based on a GoTrue UUID:

```text
auth.users.id = x
items.user_id = x
RLS: items.user_id = auth.uid()
```

Cloudflare Access issues a provider-specific subject:

```text
Cloudflare Access sub = y
```

`x` and `y` are different UUIDs. If the Option C bridge directly mints
`sub = y`, old items owned by `x` are not visible under existing RLS. Replacing
all business-table IDs with `y` would also couple ownership to one provider and
may break foreign keys to `auth.users`.

## Decision

Introduce an application-owned canonical identity (`x`) and provider-identity
mapping (`y -> x`). Preserve existing business ownership IDs during migration.
Use D1 as the low-latency runtime directory after an identity has been
provisioned; retain Supabase as the controlled provisioning and audit path.

```text
Cloudflare Access identity
  provider = cloudflare_access
  provider_sub = y
              |
              v
public.user_identities
  provider + provider_sub -> user_id x
              |
              v
public.app_users
  id = x
              |
              v
public.items.user_id = x
```

```text
Cloudflare D1 access_identities
  access_sub y -> user_id x
```

The final bridge JWT will contain:

```json
{
  "sub": "x",
  "cf_access_sub": "y",
  "email": "verified-access-email@example.com",
  "role": "authenticated"
}
```

Therefore current ownership policies continue to evaluate
`items.user_id = auth.uid()` without rewriting business rows.

## Target schema

Names are illustrative; write an audited migration before applying them.

```sql
create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

create table public.user_identities (
  provider text not null,
  provider_sub uuid not null,
  user_id uuid not null references public.app_users(id),
  verified_email text,
  linked_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (provider, provider_sub),
  unique (provider, user_id)
);
```

`public` is only a PostgreSQL schema name; it does **not** make either table
publicly readable or writable.

## RLS and bootstrap design

Enable RLS on both identity tables.

```text
app_users          RLS on; final JWT sub=x may read its own row
user_identities    RLS on; no direct client read/write policy
items              keep existing ownership RLS
```

There is one bootstrap issue: the Worker knows Access `y` before it knows the
canonical `x`. The normal path uses D1; the Supabase RPC is a one-time fallback
without a broad `service_role` secret in the Worker:

```text
1. Worker validates the Access assertion and obtains y + verified email.
2. Worker asks D1 for y -> x.
3. On a D1 hit, Worker mints the final five-minute JWT with sub=x and performs CRUD.
4. On a D1 miss only, Worker mints a temporary JWT with sub=y and calls
   resolve_or_provision_current_identity().
5. RPC returns x; Worker persists y -> x to D1 and then mints final JWT C.
```

The fallback RPC is a narrowly scoped `SECURITY DEFINER` function. It must:

- accept no caller-supplied user-ID argument;
- derive `y` only from `auth.uid()` and email only from signed JWT claims;
- use a fixed safe `search_path`;
- be executable only by `authenticated`;
- return only the caller's own canonical UUID;
- avoid exposing identity-map rows; and
- handle concurrent first logins with unique constraints/upsert logic.

This is not a GoTrue function. It is a custom Postgres RPC. The temporary JWT
is safe only because the Worker first verifies the Cloudflare Access JWT and
the Supabase signing key is private to Supabase and Worker Secrets.

## Existing-user migration

1. Inventory every foreign key, RLS policy, trigger, storage ownership column,
   and application query that currently references `auth.users.id`.
2. Create `app_users`, then backfill one row per existing `auth.users` row with
   the same UUID: `app_users.id = auth.users.id = x`.
3. Change business-table foreign keys from `auth.users(id)` to
   `app_users(id)`. Existing `items.user_id` values remain `x`; do not rewrite
   those ownership values.
4. Establish `cloudflare_access:y -> app_users:x` links.
5. During the controlled migration, a verified, normalized, one-to-one email
   match can propose a link. Do not automatically link duplicates, aliases,
   changed emails, disabled accounts, or ambiguous matches.
6. Production-safe linking asks an existing user to prove their old Supabase
   account once, after Access authentication. Persist the resulting mapping;
   future requests resolve by `provider_sub`, not email.
7. Keep an audit record for creation, relinking, and revocation. Do not permit
   silent mapping overwrites.

Email is a correlation/recovery signal, never the authorization key. Cloudflare
Access `sub` is stable for an email within the same Zero Trust organization,
but can change if the user is removed/re-added or logs into another organization.

## New Access users

For a first-time Access user with no D1 mapping:

1. The Worker takes the D1-miss path and calls `resolve_or_provision_current_identity()`.
2. RPC creates `app_users.id = x` and `cloudflare_access:y -> x` in `user_identities`.
3. Worker writes `y -> x` to D1, mints final JWT C with `sub=x`, and proceeds.

No new GoTrue user, password, or Supabase login session is created. This lets
new users be fully Access-native while old users retain their historical `x`
ownership ID.

## GoTrue retirement phases

1. **Compatibility:** GoTrue remains enabled; Option C mints `sub=x` for linked users.
2. **D1 directory:** D1 receives every new `y -> x` link. Worker reads D1 first;
   JWT B/RPC remain only for a missing directory row.
3. **Backfill/link:** seed D1 for all verified existing links, compare D1 and
   Supabase mappings, and repair any mismatch before removing fallback use.
4. **Access-first:** all new users provision only through Access; disable new
   password signups while retaining old login only for one-time account linking.
5. **Retire resolver:** when D1 has all active mappings and reconciliation is
   clean, remove JWT B and `resolve_or_provision_current_identity()` from the
   Worker request path. Retain Supabase mapping read-only for audit/rollback.
6. **Retire GoTrue:** after every active user is linked and no dependency remains
   on `auth.users`, remove GoTrue sign-in paths and the remaining dependency.

Rollback before retirement is straightforward: keep issuing/accepting the old
GoTrue JWTs, because their `sub` remains the same canonical `x`.

## Why not rewrite `items.user_id` to Access sub?

It is simpler at runtime but worse for migration:

- every ownership row and related foreign key must be rewritten;
- provider-specific `y` becomes the business identity;
- another future auth-provider migration requires another full rewrite; and
- Access `y` has no natural `auth.users` row, so existing foreign keys fail.

The mapping model adds one controlled identity-resolution step but keeps
business ownership stable and makes providers replaceable.

## Lean acceptance checks

1. A linked old user reads an existing `items.user_id=x` row through Access.
2. The same user cannot read or mutate another user's row.
3. A new Access email provisions `x` and creates/reads its own row without a
   GoTrue signup.
4. An ambiguous email cannot auto-link and receives a safe linking-required
   response.
5. A revoked mapping stops resolution after the short bridge-JWT lifetime.
6. A D1 directory hit creates only final JWT C and makes no Supabase resolver RPC.
7. A D1 miss provisions once, writes D1 `y -> x`, and the next request is a hit.

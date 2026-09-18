# Replacing GoTrue with Better Auth on Cloudflare while preserving Supabase RLS

## Problem

The migration objective is to replace authentication from Supabase GoTrue with Better Auth, without breaking existing Supabase row ownership and RLS behavior.

The key constraint was existing ownership semantics:

`items.user_id = auth.uid()`

If migration changed effective subject identity for existing users, historical data access would break even when sign-in succeeded.

## Scope

This migration focuses on:

- replacing GoTrue on the Worker API path
- preserving Supabase Data API + Postgres RLS authorization
- keeping existing user UUID ownership intact

## Before and after

Previous API path:

```text
Client -> Supabase GoTrue -> GoTrue JWT -> Supabase API path -> RLS
```

Current API path:

```text
Client -> Worker + Better Auth -> Supabase Data API -> RLS
```

Inside the Worker runtime:

- Better Auth handles `/api/auth/*` (sign-up, sign-in, session)
- Worker reads Better Auth session for app routes
- Worker mints short-lived Supabase-compatible JWT for Data API/RLS

## Target architecture

```text
Client
  |
  | Better Auth bearer/session token
  v
Cloudflare Worker
  |
  | /api/auth/* -> Better Auth (user/session/account tables in Postgres via Hyperdrive)
  |
  | /items -> resolve Better Auth session -> mint short-lived ES256 Supabase JWT
  v
Supabase Data API (PostgREST)
  |
  v
Postgres RLS (auth.uid() ownership checks)
```

## Why this keeps RLS stable

The core migration decision was to preserve GoTrue user UUID as Better Auth `user.id`.

That means:

- old `items.user_id` values still point to the same user identity
- Worker bridge JWT uses `sub = BetterAuthUserId`
- Supabase RLS still evaluates ownership through `auth.uid()` without policy rewrite

No business-table ownership rewrite was required.

## Data migration approach

### 1) Better Auth schema in Postgres

Created Better Auth tables in `public` schema:

- `user`
- `account`
- `session`
- `verification`
- `rate_limit`

Also switched `items.user_id` foreign key to `public.user(id)`.

### 2) One-time user/account migration

Ran a script migration from:

- source: `auth.users` + `auth.identities` (GoTrue)
- target: `public.user` + `public.account` (Better Auth)

Important details:

- `public.user.id = auth.users.id` (UUID preserved)
- existing bcrypt password hashes copied to Better Auth account rows
- migrated users can sign in with existing password

### 3) Session model cutover

GoTrue sessions were not reused.

Users sign in through Better Auth, which creates new Better Auth sessions. Data ownership still works because user ID stayed stable.

## Runtime auth flow now

For auth endpoints:

- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-in/email`
- `GET /api/auth/get-session`

Better Auth manages session issuance + validation.

For app data routes:

1. Worker reads Better Auth session.
2. Worker mints short-lived ES256 JWT for Supabase Data API.
3. Data API verifies JWT and evaluates RLS.
4. CRUD executes only for rows owned by `auth.uid()`.

## Token model

There are three tokens in motion:

1. Better Auth bearer/session token for Worker auth context.
2. Worker-minted internal Supabase bridge JWT for Data API/RLS.

Only the second token is used to satisfy Supabase Data API/RLS requirements, and it is short-lived and internal to the Worker->Supabase hop.

## What changed in implementation

- Added Better Auth + Drizzle auth module and Postgres adapter via Hyperdrive.
- Added schema + SQL migrations for Better Auth tables and `items` FK switch.
- Added one-time GoTrue -> Better Auth data migration script.
- Kept existing Supabase RLS model by preserving user UUID and minting bridge JWT per request.

## Validation

Validated end-to-end behavior:

- sign-in via Better Auth succeeds
- session fetch returns expected user UUID
- CRUD requests work through Supabase Data API
- RLS continues enforcing per-user ownership

## Outcome

GoTrue replaced on the API auth path with Better Auth, while preserving Supabase RLS and existing ownership semantics.

This produces a cleaner Worker-native auth flow with minimal blast radius to data authorization.

## References

- Better Auth Supabase migration guide: https://better-auth.com/docs/guides/supabase-migration-guide
- Better Auth Drizzle adapter docs: https://www.better-auth.com/docs/adapters/drizzle
- Supabase signing keys: https://supabase.com/docs/guides/auth/signing-keys
- Supabase third-party auth overview: https://supabase.com/docs/guides/auth/third-party/overview

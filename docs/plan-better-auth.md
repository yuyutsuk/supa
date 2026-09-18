# Plan: Replace Cloudflare Access with Better Auth (proper CIAM)

## Status

Draft. Branch: `feat/to-cf-ckpt5.1-better-auth`.

## Objective

Cloudflare Access is a workforce/Zero Trust IAM product, not a CIAM. It has no
self-service signup, no consumer-scale pricing model, and no CIAM-native
features (social login for public users, magic links, passkeys, progressive
profiling). This plan replaces the Access-JWT bridge (Option C) with
[Better Auth](https://www.better-auth.com/) — an open-source, TypeScript-native
auth library that runs natively on Cloudflare Workers — while keeping Supabase
Postgres as the system of record and, where possible, keeping Postgres Row
Level Security as the authorization boundary.

## Why Better Auth

- Open source, self-hosted, no per-seat licensing — fits a consumer user base
  of any size.
- Native Cloudflare integration via
  [`better-auth-cloudflare`](https://github.com/zpg6/better-auth-cloudflare):
  D1, Hyperdrive (Postgres/MySQL), KV, R2, geolocation, all first-class.
- CIAM-relevant features out of the box: email/password, social providers,
  magic links, passkeys, 2FA, organization/multi-tenancy plugin, session
  management with rotation.
- Runs inside the Worker itself — no new always-on service, no seat-based
  vendor, and no separate IdP hop for every login.

## What changes vs the Access bridge (Option C)

| Aspect | Option C (Cloudflare Access) | This plan (Better Auth) |
| --- | --- | --- |
| Authentication authority | Cloudflare Access (Zero Trust) | Better Auth (self-hosted CIAM) |
| Signup | Not possible — Access assumes pre-provisioned identities | Native self-service signup (email/password, social, magic link) |
| Identity storage | None — Access is an external gate | Better Auth's own `user`/`session`/`account` tables in Postgres |
| Session | Cloudflare Access session (cookie, IdP-managed) | Better Auth session (cookie, Worker-managed, rotation supported) |
| Provider→canonical mapping | Required (`access_sub y → canonical x`) via D1 + resolver RPC | Not required at all — official migration preserves the original GoTrue UUID as Better Auth's `user.id` |
| Existing-user migration | N/A (was already solving Access sub → old GoTrue UUID) | One-time batch script, `auth.users` → `public.user`, same UUID carried over |
| Cost model | Per-seat (Zero Trust pricing) | Free / self-hosted |

The core simplification: because we now own the identity provider, there is no
third-party `sub` to translate at all — not even once. Better Auth publishes
an [official Supabase migration guide](https://better-auth.com/docs/guides/supabase-migration-guide)
that copies `auth.users` rows directly into `public.user` **using the same
`id`**. Since `items.user_id` already equals that same GoTrue UUID, no
mapping table, resolver RPC, or `y → x` indirection is needed at all — the
approach Option C required is not just simplified, it is eliminated for
identity purposes. It only remains relevant for keeping `auth.uid()` working
through the Supabase Data API (see Target Architecture).

## Target architecture

```text
Client (Web/Mobile)
  |
  v
Cloudflare Worker
  |
  ├── /api/auth/*  → Better Auth handler
  │     issues + verifies its own session (cookie-based)
  │     stores user/session/account/verification in Postgres
  │
  └── /items, /api/*  → application routes
        reads Better Auth session from the request
        mints short-lived Supabase-compatible JWT (sub = user.id, role = authenticated)
        calls Supabase Data API with that JWT
        Postgres RLS enforces auth.uid() = user.id
```

Better Auth becomes the single authentication authority. The
Supabase-JWT-minting step is retained (not the Access-validation step) so that
Postgres RLS keeps working unmodified — the bridge shrinks from
"validate Access JWT → resolve identity → mint JWT" to "read Better Auth
session → mint JWT."

## Database connectivity decision

Better Auth needs to write its own tables (`user`, `session`, `account`,
`verification`, plus `rate_limit` if database-backed rate limiting is used).
Two options:

1. **Hyperdrive → same Supabase Postgres** (recommended). Better Auth and the
   application share one Postgres instance. No second database to keep in
   sync. Requires a Hyperdrive binding pointed at the Supabase connection
   string.
2. **Cloudflare D1** for Better Auth's own tables, Supabase Postgres only for
   application data. Simpler locally (no Hyperdrive setup) but splits the
   identity store from the data store, which reintroduces a mapping step
   between "D1 user id" and "Supabase canonical id" — the exact indirection
   this plan is trying to remove.

**Decision: use Hyperdrive into the existing Supabase Postgres.** Single
source of truth for identity and data; RLS can eventually reference Better
Auth's own tables directly if needed.

## Identity migration for existing users

Better Auth publishes an official, tested migration path for exactly this
case: [Migrating from Supabase Auth to Better Auth](https://better-auth.com/docs/guides/supabase-migration-guide).
Use it as-is rather than reintroducing the Option C mapping-table pattern.

Key facts from that guide, applied to this project:

1. **Same database, two schemas.** Because we are staying on the same
   Supabase Postgres instance, `FROM_DATABASE_URL` and `TO_DATABASE_URL` in
   the migration script are the **same connection string** — the script reads
   `auth.users`/`auth.identities` and writes `public.user`/`public.account`.
2. **UUID is preserved, not remapped.** The script inserts
   `id: user.id` directly from `auth.users.id` into `public.user.id`. Since
   `items.user_id` already holds that exact UUID, RLS keeps matching with
   **zero changes to any business table** and **no linking table at all**.
   This fully replaces the `app_users` / `user_identities` / resolver-RPC
   design built for Option C — that pattern is not needed for this migration
   path.
3. **Password hashing differs.** Supabase hashes with `bcrypt`; Better Auth
   defaults to `scrypt`. Configure `emailAndPassword.password.hash/verify` to
   use `bcrypt` (via the `bcrypt` npm package) so migrated users can log in
   with their existing password without a forced reset.
4. **Plugins must match used Supabase features**, or that data is silently
   skipped:
   - `anonymous` plugin — required. Bottomo's meeting-guest flow issues
     Supabase anonymous sessions (`is_anonymous: true`); without this plugin
     those rows/semantics are dropped by the migration script.
   - `admin` plugin — needed only if `is_super_admin` / `banned_until` are in
     use (confirm before running).
   - `phoneNumber` plugin — not needed; no phone-based auth in the current
     Bottomo/Supabase model per the architecture PDF.
5. **All active sessions are invalidated** by this migration (explicit
   warning in the guide). Plan a cutover window; users must sign in again
   after migration completes.
6. **RLS and 2FA are explicitly out of scope of the guide.** It moves
   identity rows only. `auth.uid()` inside RLS policies depends on PostgREST
   injecting JWT claims per request — Better Auth does not do this
   automatically. This is exactly why the Target Architecture above keeps the
   short-lived Supabase-JWT-minting step: it is what keeps `auth.uid()`
   resolving correctly after the identity migration.

Net effect: the `y → x` canonical-identity problem that Option C had to solve
does not reappear here. The only remaining bridge work is issuing a
Supabase-compatible JWT per request from a Better Auth session — an even
narrower version of what Option C's Worker already did.

## Implementation steps

1. **Dependencies**
   - `better-auth`, `better-auth-cloudflare`, `drizzle-orm`,
     `@better-auth/drizzle-adapter`, a Postgres driver (`postgres` /
     `postgres-js`).
2. **Cloudflare resources**
   - Add a Hyperdrive binding pointed at the Supabase Postgres connection
     string (session pooler, not the Data API URL).
   - Keep `IDENTITY_DB` (D1) only if the one-time legacy-link cache from
     Option C is still wanted as a fast path; otherwise it can be retired once
     migration is complete.
3. **Schema**
   - Generate Better Auth's Drizzle schema (`user`, `session`, `account`,
     `verification`, `ssoProvider` if SSO is needed) via
     `npx @better-auth/cli generate`.
   - Run `npx auth migrate` against the same Supabase Postgres database
     (via Hyperdrive) so tables land in `public`, not `auth`.
   - Add `admin`, `anonymous` plugins as needed (see Identity Migration) —
     the migration script auto-detects and migrates their data only if the
     plugin is present when the script runs.
4. **Auth config** (`src/auth/index.ts` or equivalent)
   - `betterAuth({ ...withCloudflare({ postgres: { db }, kv: env.KV }, {
     emailAndPassword: { enabled: true, password: { hash, verify } },
     plugins: [admin(), anonymous()], verification: { storeInDatabase: true },
     rateLimit: { storage: "database" } }) })`.
   - Configure `password.hash`/`password.verify` with `bcrypt` to match
     Supabase's existing hashes (see Identity Migration).
   - Start with email/password; add social providers once the core flow is
     verified, matching every provider already configured in Supabase so the
     migration script links existing social accounts correctly.
5. **Run the official migration script**
   - Follow [the guide](https://better-auth.com/docs/guides/supabase-migration-guide)
     verbatim: same `FROM_DATABASE_URL`/`TO_DATABASE_URL`, batched
     cursor-based copy of `auth.users` + `auth.identities` into
     `public.user` + `public.account`, preserving `id`.
   - Back up the database first (guide's explicit warning).
   - Communicate the session-invalidation cutover window to users.
6. **Worker routes**
   - Mount Better Auth's handler at `/api/auth/*`.
   - In the existing `items` handler, replace `validateAccessAssertion` +
     `resolveInternalUserId` with: read the Better Auth session from the
     request, take `session.user.id` directly as the canonical id (no lookup
     needed — it already equals the historical `items.user_id`), then mint
     the same short-lived ES256 Supabase JWT used today with `sub =
     session.user.id`.
7. **Cutover**
   - Ship Better Auth behind a flag or separate route first.
   - Verify RLS still enforces `auth.uid() = user.id` correctly for
     Better-Auth-issued bridge JWTs.
   - Retire the Cloudflare Access application and the Access-specific code
     path (`validateAccessAssertion`, `CF_ACCESS_*` secrets) once verified.
   - Retire `d1/migrations/0001_access_identity_directory.sql` and
     `supabase/migrations/20260915000100_identity_migration.sql`'s
     `app_users`/`user_identities`/resolver-RPC pattern — not needed by this
     migration path.

## Open decisions

1. **Rate limiting storage** — Better Auth 1.7 requires atomic storage for
   rate limiting; KV cannot provide this. Use `rateLimit.storage: "database"`
   (adds one read + one write per request) or a Durable Object–backed atomic
   store if that overhead is unacceptable at scale.
2. **Session caching** — KV as secondary session storage is eventually
   consistent (~60s propagation). If instant revocation is required (ban,
   logout-everywhere), do not cache sessions in KV; read from Postgres per
   request or accept the propagation delay.
3. **Keep Supabase Data API + RLS, or query Postgres directly via Hyperdrive?**
   Keeping the Data API preserves the existing RLS policies and the JWT-bridge
   pattern already proven in Option C. Querying Postgres directly via
   Hyperdrive removes the JWT-minting step entirely but requires moving
   authorization logic out of RLS and into application code (or emulating RLS
   via session variables set per Hyperdrive connection). **Default: keep the
   Data API + RLS** to minimize blast radius; revisit only if Hyperdrive
   direct-write throughput becomes a bottleneck.
4. **Retire D1 identity directory.** With the official migration path,
   `access_identities` (D1) and `app_users`/`user_identities` (Supabase) have
   no remaining purpose — Better Auth's `public.user.id` **is** the canonical
   id directly, preserved from `auth.users.id`. Drop both once the migration
   script has run and been verified, rather than repurposing them.

## Risks

- Better Auth's own tables (`user`, `session`, etc.) must not collide with
  existing Supabase Auth (`auth.users`) — they should live in `public` or a
  dedicated schema, not `auth`.
- **Migration invalidates every active session** — this is a hard cutover for
  users, not a rolling migration. Needs a maintenance-window communication
  plan.
- **Password hash mismatch if `bcrypt` config is skipped** — migrated users
  cannot log in with their existing password until
  `emailAndPassword.password.hash/verify` is wired to `bcrypt`.
- **Missing plugins silently drop data** — if `anonymous` (or `admin`, if
  used) is not enabled before running the migration script, that data is
  skipped rather than erroring loudly. Confirm plugin list against actual
  Supabase feature usage before running the script, not after.
- **RLS is not migrated by the official script.** `auth.uid()` still depends
  on the Supabase-JWT-minting bridge described in Target Architecture; do not
  assume RLS "just works" post-migration without that bridge in place.
- Database-backed rate limiting adds latency/cost per request; must be sized
  before rollout.
- Social provider client secrets need the same secret-handling discipline as
  the existing `SUPABASE_JWT_SIGNING_KEY`.

## References

- [Better Auth](https://www.better-auth.com/)
- [Better Auth — Migrating from Supabase Auth](https://better-auth.com/docs/guides/supabase-migration-guide)
- [better-auth-cloudflare](https://github.com/zpg6/better-auth-cloudflare)
- [Cloudflare Hyperdrive — connect to Postgres](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)
- [Better Auth — Drizzle adapter / schema generation](https://www.better-auth.com/docs/adapters/drizzle)
- [Better Auth — secondary storage / KV caveats](https://www.better-auth.com/docs/concepts/database#secondary-storage)

# Cloudflare Access Auth with Supabase Database

This repository shows how to replace Supabase GoTrue authentication on an API path with Cloudflare Access, while keeping Supabase Postgres, Supabase Data API, and existing Row Level Security (RLS) in place.

In short:

- Authentication (who the caller is): Cloudflare Access
- Authorization (which rows the caller can read/write): Supabase/Postgres RLS

## Architecture

![Cloudflare Access to Supabase authentication architecture](docs/diagrams/option-c-auth-flow.png)

Request path:

```text
Client -> Cloudflare Access -> Cloudflare Worker -> Supabase Data API -> Postgres RLS
```

## What changed from the original model

Previous model:

```text
Client -> Supabase GoTrue -> GoTrue JWT -> Supabase API path -> RLS
```

Current model for this Worker API:

```text
Client -> Cloudflare Access -> Worker token bridge -> Supabase Data API -> RLS
```

GoTrue can still exist for legacy compatibility, but this Worker path does not rely on GoTrue-issued tokens.

## Cloudflare Access JWT compatibility gap with Supabase Auth and RLS

Supabase accepts a JWT only after it can establish trust in its issuer, signing
keys, and expected claims. A Cloudflare Access JWT contains a useful identity,
but it is not directly compatible with this Supabase Data API/RLS path.

- Supabase supports JWTs from Supabase Auth and explicitly configured
  third-party integrations. Its current first-class integrations are Clerk,
  Firebase Auth, Auth0, AWS Cognito, and WorkOS; Cloudflare Access is not on
  that list. Therefore this project has no direct Cloudflare issuer/JWKS trust
  configuration at the Data API. [Supabase third-party auth docs](https://supabase.com/docs/guides/auth/third-party/overview)
- A third-party JWT needs the literal `role: "authenticated"` claim for
  Supabase to select the `authenticated` Postgres role. Without it, Supabase
  treats the request as `anon`, so policies written `to authenticated` deny it.
  [Supabase's Auth0 integration documents this requirement](https://supabase.com/docs/guides/auth/third-party/auth0).
- Even after trust and role compatibility are solved, the Access subject `y`
  need not equal canonical UUID `x` already stored in `items.user_id`.

Direct forwarding therefore stops before Postgres can evaluate `auth.uid()`.
The issue is not missing identity data; it is issuer/signature trust, claim
compatibility, and stable application identity.

The Worker is the bridge: it validates the Access JWT, resolves `y` to `x`, and
signs a short-lived ES256 Supabase-compatible JWT. Supabase holds the matching
public signing key and can then verify the Worker-issued token for its Data API
and RLS path.

## How the Worker bridges the JWT

Cloudflare Access and Supabase Data API do not share native JWT trust by default.

- Access issues an application token with Access issuer/audience semantics.
- Supabase verifies JWTs using its configured signing keys.
- Existing RLS relies on a valid `sub` identity and `role = authenticated`.
- Existing business ownership also depends on canonical UUID `x`, while Access identity uses `y`.

Because of this, the Worker acts as a narrow trust bridge:

1. Validate Cloudflare Access JWT cryptographically.
2. Resolve identity mapping from Access `y` to canonical app user `x`.
3. Mint a short-lived Supabase-compatible JWT signed with the configured ES256 key.
4. Send only that bridged JWT to Supabase Data API.

This preserves Cloudflare Access for authentication and Supabase/Postgres for authorization.

## How the auth bridge works

The Worker in `src/index.ts` enforces this sequence:

1. Read `Cf-Access-Jwt-Assertion` from the incoming request.
2. Verify Access JWT signature using Access JWKS (`/cdn-cgi/access/certs`), expected issuer (`CF_ACCESS_TEAM_DOMAIN`), and expected audience (`CF_ACCESS_AUD`).
3. Extract trusted identity from Access claims:
   - `y` = Access subject (`sub`, UUID)
   - `email` = verified identity email from Access
4. Resolve canonical app user:
   - Look up `y -> x` in D1 table `access_identities`.
   - If D1 miss: mint a short resolver JWT and call Supabase RPC `resolve_or_provision_current_identity()`.
   - Persist mapping back to D1.
5. Mint final short-lived Supabase-compatible JWT with:
   - `sub = x`
   - `role = authenticated`
   - `email`, `cf_access_sub = y`
   - TTL 5 minutes
6. Call Supabase Data API using the minted token.
7. Let Postgres RLS evaluate ownership rules using `auth.uid() = x`.

The Access JWT is never forwarded directly to Supabase. The bridge JWTs are never returned to the client.

## Identity model (why `x` and `y` both exist)

- `y` is Cloudflare Access identity (`sub`) and is provider-specific.
- `x` is canonical application user UUID used by business data ownership.
- Existing ownership remains stable:

```sql
items.user_id = auth.uid()
```

Mapping components:

- D1 `access_identities` for low-latency runtime lookup (`y -> x`).
- Supabase `app_users` as canonical user table.
- Supabase `user_identities` as provider identity links.
- Supabase RPC `resolve_or_provision_current_identity()` for controlled resolution/provisioning.

This avoids rewriting existing business rows to provider-specific IDs.

## Migration approach for old users

To keep existing users working during auth cutover, the migration keeps their historical ownership UUID (`x`) intact.

1. Backfill canonical users into `app_users` from existing Supabase users/owners.
2. Keep business row ownership unchanged (`items.user_id = x`).
3. Link Cloudflare Access identity `y` to canonical `x` in `user_identities`.
4. On first Access login, resolve `y -> x` via the constrained resolver RPC (only when D1 has no mapping), then cache it in D1.
5. Use bridged CRUD JWTs with `sub = x`, so existing RLS policies continue to work without rewriting old rows.

Result: old users keep their existing data ownership, while authentication shifts to Cloudflare Access.

## Token samples (redacted)

These are structure examples only. Do not commit real tokens.

```jsonc
// A: Cloudflare Access assertion (RS256)
{
  "sub": "<access-sub-y>",
  "email": "user@example.com",
  "iss": "https://<team>.cloudflareaccess.com",
  "aud": ["<access-app-audience>"],
  "exp": 0
}

// B: Worker resolver token (ES256, D1 miss path only)
{
  "sub": "<access-sub-y>",
  "cf_access_sub": "<access-sub-y>",
  "email": "user@example.com",
  "role": "authenticated",
  "bridge_stage": "identity_resolution",
  "iat": 0,
  "exp": 0
}

// C: Worker CRUD token (ES256, every successful request)
{
  "sub": "<canonical-user-x>",
  "cf_access_sub": "<access-sub-y>",
  "email": "user@example.com",
  "role": "authenticated",
  "iat": 0,
  "exp": 0
}
```

## API behavior (Worker)

- `GET /` -> returns items for the resolved caller.
- `POST /` with `{ "name": "Apple" }` -> inserts caller-owned item.
- `PATCH /?id=<item-id>` with `{ "name": "Pear" }` -> updates caller-owned item.
- `DELETE /?id=<item-id>` -> deletes caller-owned item.

Identity is derived from validated Access claims. The API does not trust caller-supplied `user_id`.

## Repository map

- `src/index.ts` - Worker implementation (Access validation, identity resolution, JWT bridge, CRUD).
- `d1/migrations/0001_access_identity_directory.sql` - D1 directory schema.
- `supabase/migrations/20260915000100_identity_migration.sql` - Supabase identity schema + resolver RPC.
- `docs/diagrams/option-c-auth-flow.d2` - architecture diagram source.
- `docs/diagrams/option-c-auth-sequence.puml` - end-to-end request sequence.
- `docs/diagrams/option-c-jwt-identity-sequence.puml` - detailed JWT/identity sequence.
- `supabase/functions/items-api/` - legacy Supabase Edge Function baseline.

## Configuration

Worker secrets:

| Variable | Purpose |
| --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | Access issuer base URL (`https://<team>.cloudflareaccess.com`) |
| `CF_ACCESS_AUD` | Cloudflare Access application audience |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase publishable key (`sb_publishable_...`) |
| `SUPABASE_JWT_KEY_ID` | `kid` of imported ES256 signing key in Supabase |
| `SUPABASE_JWT_SIGNING_KEY` | Same ES256 private JWK in Worker secret storage |
| `DEBUG_LOG_BRIDGE_JWTS` | Optional; set `false` to disable bridge JWT logging |

Worker binding:

- `IDENTITY_DB` (D1 database) in `wrangler.jsonc`

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Apply D1 migrations:

```bash
npx wrangler d1 migrations apply items-api-identities --local
npx wrangler d1 migrations apply items-api-identities --remote
```

3. Apply Supabase migration:

```bash
npx supabase db push
```

4. In Supabase, import and activate an ES256 private JWK as a JWT signing key, then copy its `kid`.

5. Set Worker secrets:

```bash
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_KEY
npx wrangler secret put SUPABASE_JWT_KEY_ID
npx wrangler secret put SUPABASE_JWT_SIGNING_KEY
npx wrangler secret put DEBUG_LOG_BRIDGE_JWTS
```

6. Protect the Worker hostname with a Cloudflare Access application and an allow policy.

7. Run locally or deploy:

```bash
npx wrangler dev
npx wrangler deploy
```

## Request example (redacted)

For browser clients, Access injects the assertion header after successful login.

```bash
curl -s "https://<worker-domain>/" \
  -H "Cf-Access-Jwt-Assertion: <access-jwt>" | jq
```

## Security notes

- Do not commit real API keys, JWTs, or private JWKs.
- Keep signing keys only in secure secret stores (Cloudflare Worker secrets + Supabase signing key store).
- Disable bridge JWT logging outside local debugging (`DEBUG_LOG_BRIDGE_JWTS=false`).
- Rotate keys immediately if any sample token or key leaks.

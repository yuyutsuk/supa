# Better Auth on Cloudflare Worker with Supabase RLS

This repo runs CIAM auth with Better Auth inside a Cloudflare Worker, while keeping Supabase Postgres + Supabase Data API + existing `auth.uid()` RLS enforcement for app data.

In short:

- User auth/session authority: Better Auth (`/api/auth/*`)
- Data authorization: Supabase/Postgres RLS
- Internal bridge: Worker mints short-lived Supabase-compatible JWT per request

## Architecture

![Better Auth + Supabase bridge architecture](docs/diagrams/better-auth-flow.png)

![Better Auth + Supabase bridge sequence](docs/diagrams/better-auth-sequence.png)

Request path:

```text
Client -> Worker (/ui assets, /api/auth, or / CRUD) -> Supabase Data API -> Postgres RLS
```

## Runtime model

1. Worker routes:
   - `/api/auth/*` -> Better Auth handler (sign-up, sign-in, get-session, etc.)
   - `/` CRUD routes -> app logic
2. Better Auth persists to Supabase Postgres through Hyperdrive (`user`, `session`, `account`, `verification`, `rate_limit`).
3. For CRUD requests, Worker reads Better Auth session, then mints an internal ES256 JWT for Supabase Data API with:
   - `sub = session.user.id`
   - `role = authenticated`
   - optional `email`
4. Supabase Data API verifies that JWT and RLS evaluates `auth.uid()` as before.

## Token boundaries

- Better Auth bearer token: signed session token (`set-auth-token` header), not a JWT.
- Supabase bridge JWT: internal Worker -> Supabase token; not returned to client.

## API behavior

- `POST /api/auth/sign-up/email` -> creates Better Auth user/account/session.
- `POST /api/auth/sign-in/email` -> returns auth response + `set-auth-token` header.
- `GET /api/auth/get-session` -> returns session/user for the current bearer token.
- `GET /` -> list caller-owned items.
- `POST /` with `{ "name": "Apple" }` -> create caller-owned item.
- `PATCH /?id=<item-id>` -> update caller-owned item.
- `DELETE /?id=<item-id>` -> delete caller-owned item.

## Repo map

- `src/index.ts` - Worker router, Better Auth session resolution, Supabase JWT bridge, CRUD handlers.
- `src/auth/index.ts` - Better Auth config (`admin`, `anonymous`, `bearer` plugins).
- `src/db/` - Drizzle schema + Hyperdrive/Postgres adapter.
- `drizzle/` - SQL migrations for Better Auth tables + `items` FK switch.
- `migration.ts` - one-time GoTrue (`auth.users`/`auth.identities`) -> Better Auth table migrator.
- `scripts/run-betterauth-migrations.sh` - migration SQL runner for linked Supabase project.
- `supabase/` - Supabase project config and legacy artifacts.

## Configuration

### Wrangler bindings

- `SUPABASE_HYPERDRIVE` (required)

### Worker secrets

| Variable | Purpose |
| --- | --- |
| `BETTER_AUTH_SECRET` | signs/verifies Better Auth session tokens |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase API key used by Worker |
| `SUPABASE_JWT_KEY_ID` | `kid` for imported ES256 verification key in Supabase |
| `SUPABASE_JWT_SIGNING_KEY` | ES256 private JWK used by Worker to mint bridge JWT |

## Setup and migrate

1. Install dependencies:

```bash
npm install
```

2. Ensure Supabase has the Better Auth tables and FK migration:

```bash
supabase db query --linked --file drizzle/0000_better_auth_init.sql --output json
supabase db query --linked --file drizzle/0001_items_fk_switch.sql --output json
```

3. Run one-time user migration from GoTrue:

```bash
FROM_DATABASE_URL="<postgres-url>" \
TO_DATABASE_URL="<postgres-url>" \
npx tsx migration.ts
```

If direct DB host DNS fails locally, use the Supabase pooler URL.

4. Set Worker secrets:

```bash
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_KEY
npx wrangler secret put SUPABASE_JWT_KEY_ID
npx wrangler secret put SUPABASE_JWT_SIGNING_KEY
```

5. Deploy:

```bash
npm run deploy
```

## Manual test (Bearer flow)

```bash
BASE_URL="https://items-api-worker.gaurkuber.workers.dev"

AUTH_TOKEN="$({
  curl -sS -o /tmp/bottomo.signin.json \
    -w "%header{set-auth-token}" \
    -X POST "$BASE_URL/api/auth/sign-in/email" \
    -H "origin: $BASE_URL" \
    -H "content-type: application/json" \
    --data '{"email":"user@example.com","password":"StrongPass123"}'
} | tr -d '\r\n')"

curl -sS "$BASE_URL/api/auth/get-session" \
  -H "origin: $BASE_URL" \
  -H "authorization: Bearer $AUTH_TOKEN"

curl -sS "$BASE_URL/" \
  -H "origin: $BASE_URL" \
  -H "authorization: Bearer $AUTH_TOKEN"
```

## Troubleshooting

- `401 {"error":"Authentication is required"}` -> Better Auth session missing or expired.
- `MISSING_OR_NULL_ORIGIN` on auth routes -> send `origin: $BASE_URL` header.
- `Missing required env var: FROM_DATABASE_URL` -> pass migration env vars when running `migration.ts`.

## Security notes

- Never commit real secrets, tokens, or private JWKs.
- Keep `BETTER_AUTH_SECRET` and `SUPABASE_JWT_SIGNING_KEY` only in secret stores.
- Supabase bridge JWT is internal-only and short-lived; do not expose it to clients.

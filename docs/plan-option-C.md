# Option C — Cloudflare Access to Supabase-compatible JWT bridge

## Objective

Replace the Worker API authentication path with Cloudflare Access while preserving the existing Supabase Data API and RLS authorization boundary. GoTrue remains enabled and unchanged for now.

```text
Client -> Cloudflare Access -> Cf-Access-Jwt-Assertion
       -> Worker validates Access JWT
       -> Worker mints a 5-minute ES256 JWT
       -> Supabase Data API -> Postgres RLS
```

## Implemented Worker flow

1. A Cloudflare Access application will protect `items-api-worker` and authenticate the caller.
2. The Worker reads `Cf-Access-Jwt-Assertion` and validates its signature using the Access team JWKS, expected issuer, and application audience.
3. The validated Access `sub` (must be a UUID) and `email` are the identity source.
4. The Worker signs a new ES256 JWT containing `sub`, `role: "authenticated"`, `iat`, `exp` (five minutes), `email`, and `cf_access_sub`.
5. `@supabase/supabase-js` receives that JWT through its `accessToken` option and sends it to the Data API.
6. Supabase verifies the JWT with the matching imported signing key and Postgres applies existing RLS policies.

## Required remote setup

Generate an ES256 private JWK and keep it in a secure temporary file. Use the **same JWK** in both places; do not commit it.

1. In Supabase Dashboard: **Project Settings > JWT Keys > JWT Signing Keys**, import the private JWK as a standby key, rotate it to active, and record its `kid`. Supabase retains the private key and uses its public part to verify Data API JWTs.
2. In Cloudflare Worker secrets, set `SUPABASE_JWT_SIGNING_KEY` to the same private JWK and `SUPABASE_JWT_KEY_ID` to that `kid`.
3. Create a Cloudflare Access application for the Worker's `workers.dev` URL with a narrow pilot Allow policy. Record its audience tag and team domain.
4. Set `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` as Worker secrets. The existing `SUPABASE_URL` and publishable `SUPABASE_KEY` secrets remain required.

## Security assumptions

- Access is the authentication authority. The Worker rejects missing, invalid, wrong-issuer, and wrong-audience Access assertions.
- The Worker mints only after Access validation and never trusts a `user_id` from request input as identity.
- The bridge JWT has a five-minute lifetime, only the `authenticated` role, is never returned to callers, and is not logged.
- `SUPABASE_JWT_SIGNING_KEY` can mint Data API-trusted JWTs. It must only exist in Cloudflare Worker Secrets and Supabase's signing-key store, and must be rotated in both places.
- The Supabase publishable key identifies the application; it does not bypass RLS.

## Existing-user mapping — deliberately deferred

Cloudflare Access `sub` is a UUID but is not the existing Supabase Auth user UUID. The current `items.user_id = auth.uid()` RLS model works only once a row's owner UUID equals the Access `sub` used in the bridged JWT.

Do not mass-update `items.user_id` yet. First inspect foreign keys to `auth.users`, create an explicit mapping from Access subject/email to the old ownership UUID, backfill safely, and then choose either an ownership rewrite or a mapping-aware RLS policy. GoTrue stays live until that migration is complete.

## Test status

- Worker bundle validation: passed (`wrangler deploy --dry-run`).
- Supabase signing key: passed. A fresh ES256 private JWK was imported through the Supabase Management API and activated. The matching JWK and `kid`, plus the Supabase URL and publishable key, were stored as secrets on `items-api-worker`. No key material was committed or logged.
- Access application: passed. The application and One-time PIN policy were created in the Cloudflare dashboard. Its audience and team domain were set as `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` Worker secrets.
- Deployment: passed. Option C was deployed to `https://items-api-worker.gaurkuber.workers.dev`.
- Unauthenticated edge test: passed. A request without an Access session receives Cloudflare Access HTTP 302 login interception rather than reaching the Worker.
- Authenticated Access assertion and end-to-end Data API/RLS: pending a browser/session request to the newly deployed Worker. Existing-user ownership mapping remains separately deferred.

The proof will be a pilot user creating, reading, updating, and deleting only rows mapped to that Access identity; the existing GoTrue JWT flow remains available throughout.

## References

- [Cloudflare Access Worker protection](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Supabase JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys)
- [Supabase custom JWT client setup](https://supabase.com/docs/guides/auth/jwts)

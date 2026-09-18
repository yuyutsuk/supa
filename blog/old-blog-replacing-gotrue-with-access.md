# Replacing GoTrue with Cloudflare Access while preserving Supabase RLS

Source URL: https://wiki.cfdata.org/spaces/~kgaur/blog/2026/09/16/1467636289/Replacing+GoTrue+with+Cloudflare+Access+while+preserving+Supabase+RLS

_MCP: Agents Gateway Client | wiki-mcp-server-production (v1.0.0)_

# Problem

We needed to replace Supabase GoTrue authentication on an API path with Cloudflare Access, while preserving existing Supabase row ownership and Postgres RLS behavior.

The critical constraint is existing ownership semantics: `items.user_id = auth.uid()`. If auth migration changes the effective subject identity, old user data access can break even when authentication succeeds.

# Architecture diagram

![Cloudflare Access to Supabase auth bridge architecture](https://raw.githubusercontent.com/yuyutsuk/supa/feat/tp-cf-ckpt5-migrate-old-users-better/docs/diagrams/option-c-auth-flow.png)

High-level request path:

```text
Client | v Cloudflare Access (AuthN) | | Cf-Access-Jwt-Assertion (JWT A) v Cloudflare Worker (validate A, resolve y -> x, mint bridge JWT) | | Authorization: Bearer JWT C (sub = x, role = authenticated) v Supabase Data API | v Postgres RLS (AuthZ via auth.uid() = x)
```

Identity mapping model:

```text
Cloudflare Access subject y (provider identity) | v identity mapping (y -> x) | v canonical app user x (business ownership identity) | v items.user_id = x
```

# What changed

Previous path:

```text
Client -> Supabase GoTrue -> GoTrue JWT -> Supabase API path -> RLS
```

Current path:

```text
Client -> Cloudflare Access -> Worker token bridge -> Supabase Data API -> RLS
```

GoTrue may still coexist for legacy compatibility, but this Worker path does not depend on GoTrue-issued tokens.

# Cloudflare Access JWT compatibility gap with Supabase Auth and RLS

Cloudflare Access JWTs contain valid user identity, but they are not directly compatible with this Supabase Data API/RLS path.

- Supabase accepts JWTs from Supabase Auth and explicitly configured third-party integrations. Current first-class integrations are Clerk, Firebase Auth, Auth0, AWS Cognito, and WorkOS; Cloudflare Access is not in that list.<sup>[[3]](https://supabase.com/docs/guides/auth/third-party/overview)</sup>
- Supabase role selection depends on the literal claim `role = authenticated`. Without that claim, requests are treated as `anon`, and `to authenticated` RLS policies deny access.<sup>[[4]](https://supabase.com/docs/guides/auth/third-party/auth0)</sup>
- Even with trust and role solved, Access subject `y` may not equal canonical ownership UUID `x` already stored in business rows.

Direct forwarding therefore fails before useful RLS evaluation. The issue is not just identity presence; it is issuer/signature trust, claim compatibility, and stable application identity.

# Why the Worker bridges the JWT

The Worker acts as a narrow trust bridge between Access authentication and Supabase authorization:

1. Validate Cloudflare Access JWT cryptographically (signature, issuer, audience).<sup>[[2]](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)</sup>
2. Resolve Access subject `y` to canonical application user `x`.
3. Mint a short-lived Supabase-compatible JWT signed with the configured ES256 key.<sup>[[5]](https://supabase.com/docs/guides/auth/signing-keys)</sup>
4. Send only that bridged JWT to Supabase Data API.

This preserves Cloudflare Access as authentication authority and Supabase/Postgres RLS as authorization authority.

# How the migration works

## Request-time identity flow

1. Cloudflare Access protects the endpoint and forwards `Cf-Access-Jwt-Assertion`.<sup>[[1]](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)</sup>
2. The Worker validates the Access assertion using Access JWKS and expected issuer/audience.<sup>[[2]](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)</sup>
3. The Worker extracts trusted Access identity claims (`sub = y`, `email`).
4. The Worker resolves canonical user identity:
   - Fast path: D1 lookup for `y -> x`.
   - Fallback path: on D1 miss, mint temporary resolver token and call constrained Supabase RPC to resolve/provision `x`, then persist mapping.
5. The Worker mints final CRUD token with `sub = x`, `role = authenticated`, `cf_access_sub = y`, and short TTL; Supabase verifies the signing key before evaluating RLS.<sup>[[5]](https://supabase.com/docs/guides/auth/signing-keys)</sup>
6. Postgres RLS evaluates `auth.uid() = x`.

## Migration approach for old users

To avoid breaking existing ownership, migration keeps historical canonical UUID `x` intact.

1. Backfill canonical users into `app_users` from existing Supabase users/owners.
2. Keep business ownership rows unchanged (`items.user_id = x`).
3. Create/provider-link identity mapping from Access subject `y` to canonical user `x` in `user_identities`.
4. On first Access login, resolve `y -> x` via constrained RPC only when D1 does not already have mapping, then cache mapping in D1.
5. Use bridged CRUD JWTs with `sub = x`, so existing RLS policies continue to work without rewriting old business rows.

Result: old users keep their current data ownership, while authentication shifts to Cloudflare Access.

# Token shapes (redacted)

Structure examples only:

```text
JWT A (Access assertion, RS256) sub = y email = user@example.com iss = https://<team>.cloudflareaccess.com aud = [<access-app-audience>] JWT B (Worker resolver token, ES256, only on D1 miss) sub = y role = authenticated bridge_stage = identity_resolution cf_access_sub = y JWT C (Worker CRUD token, ES256, normal data path) sub = x role = authenticated cf_access_sub = y
```

Bridge tokens are short-lived and never returned to callers.

# Security boundary after migration

- Cloudflare Access: authentication authority.
- Worker: Access validation, identity resolution, minimal JWT minting.
- Supabase/Postgres RLS: authorization authority.
- GoTrue: optional legacy coexistence path, not required for this Access-protected API path.

# Outcome

The migration replaces GoTrue on the API authentication path while preserving Supabase ownership semantics and RLS policy logic. This avoids business-table ownership rewrites and keeps authorization centralized in Postgres.<sup>[[6]](https://gitlab.cfdata.org/kgaur/migrate-supa-auth-gotrue-access#)</sup>

# References

1. [Cloudflare Access protection for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
2. [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
3. [Supabase third-party auth overview](https://supabase.com/docs/guides/auth/third-party/overview)
4. [Supabase role claim requirement (Auth0 integration)](https://supabase.com/docs/guides/auth/third-party/auth0)
5. [Supabase JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys)
6. [Internal implementation notes (GitLab)](https://gitlab.cfdata.org/kgaur/migrate-supa-auth-gotrue-access#)

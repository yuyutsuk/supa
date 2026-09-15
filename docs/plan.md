# Migration plan

1. Freeze the current Supabase Edge Function behavior and RLS model.
2. Move CRUD handling to a Cloudflare Worker while forwarding the existing Supabase Auth JWT.
3. Keep GoTrue active and verify `Supabase Auth -> Worker -> Supabase Data API -> RLS`.
4. Evaluate a replacement authentication authority without changing ownership semantics prematurely.

## Option C — Cloudflare Access JWT bridge

Option D cannot send a standard Cloudflare Access JWT directly to Supabase because Supabase does not trust that issuer by default and Access tokens do not include `role: "authenticated"`.

Option C validates the Access assertion in the Worker and then mints a five-minute ES256 JWT with the validated Access `sub` and `role: "authenticated"`. Supabase Data API verifies the bridge JWT using the matching imported signing key; existing RLS remains the authorization layer. GoTrue is not removed.

See [Option C implementation plan](./plan-option-C.md) for secret setup, Access policy setup, identity migration constraints, security assumptions, and test results.

Current checkpoint: Cloudflare Access is configured with One-time PIN login, and Option C is deployed on `items-api-worker`. The unauthenticated edge path is protected by Access. The remaining proof is an authenticated browser/session request through the bridge and the deferred Access-sub to existing ownership mapping.

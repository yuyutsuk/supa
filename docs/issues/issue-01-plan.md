# Issue 01 — Freeze the current API contract and RLS baseline

## Goal

Record and test the existing `items-api` Edge Function before changing its runtime.  The Cloudflare Worker in the next phase must be indistinguishable to callers and must continue to let Supabase/Postgres enforce row ownership through the caller's JWT.

## Current behaviour to preserve

- Endpoint implementation: `supabase/functions/items-api/index.ts` delegates CRUD work to `main.ts`.
- Authentication modes: `withSupabase({ auth: ["user", "secret"] })`; a user request uses `ctx.supabase` and a secret request uses `ctx.supabaseAdmin`.
- `GET ?user_id=<uuid>` returns the matching items.
- `POST` accepts `{ "name", "user_id" }`, creates an item, and returns it with `201`.
- `PATCH ?id=<id>&user_id=<uuid>` accepts `{ "name" }`, updates one matching item, and returns it.
- `DELETE ?id=<id>&user_id=<uuid>` deletes a matching item and returns `204`.
- Missing required inputs return `400`; unsupported methods return `405`; Supabase errors are returned as `{ "error": "..." }` with `500`.

`user_id` remains a request input in this phase because that is the current API contract.  The tests must prove that a normal user JWT cannot use that field to read or mutate another user's rows; the expected protection boundary is the existing RLS policy, not the handler's filters alone.

## Implementation plan

1. **Capture the database/auth assumptions.** Export or write down the `items` table schema, relevant RLS policies, and the local Supabase version/configuration. Confirm the exact policy behavior for authenticated users and for the `secret` mode; do not edit policies in this issue.
2. **Create isolated fixtures.** In local Supabase, create two ordinary test users (A and B), obtain one JWT for each, and create clearly attributable items for both. Keep service-role/secret credentials separate from user JWTs and out of committed test files.
3. **Add a repeatable integration test runner.** Start the local Supabase stack and serve `items-api`, then invoke the HTTP endpoint with user A, user B, no bearer token, and secret credentials. Prefer a Deno-compatible test or a small documented shell runner; its inputs must come from environment variables.
4. **Test the happy-path contract.** As user A, verify create → get → patch → delete, including status codes, JSON response shape, and that each operation affects only the intended row. Verify equivalent GET results for user B's own fixture.
5. **Test authorization/RLS boundaries.** With user A's JWT and user B's `user_id` or item id, assert that A cannot read B's rows, cannot update B's row, and cannot delete B's row. Record the actual safe response shape/status produced by the current stack as the baseline rather than changing it here.
6. **Test input and method failures.** Cover each required parameter/body field missing, malformed request JSON if currently exposed, and an unsupported method. Assert the existing `400`/`405` behavior and error payloads where stable.
7. **Exercise secret mode explicitly.** If secret mode is intentionally supported, test and document its permitted cross-user behavior separately. If it is not a public API path, mark it as an operational-only scenario and exclude its credential from ordinary client tests.
8. **Publish the baseline artifact.** Store the test command, redacted request examples, expected-result matrix, and test output in this issue or adjacent test documentation. This becomes the acceptance suite for the Worker bridge in Issue 02.

## Acceptance criteria

- A fresh developer can run one documented command against local Supabase and reproduce the suite.
- The suite covers every currently supported HTTP method plus missing-input and unsupported-method cases.
- It demonstrates user-to-user isolation for reads, updates, and deletes under real user JWTs.
- The schema/RLS/auth assumptions and any secret-mode behavior are documented without committing secrets.
- No Cloudflare Worker, auth-provider, Hyperdrive, database-schema, or RLS-policy migration is made in this issue.

## Output handed to the next issue

The next issue receives a passing contract suite and its documented API/RLS baseline. It can then implement `Supabase Auth JWT -> Cloudflare Worker -> Supabase Data API -> Postgres RLS` and run the same suite against both endpoints.

# Better Auth Steps (Concise)

1. Cleanup/reset done
   - Supabase cleanup executed: dropped `public."user"`, `public.account`, `public.session`, `public.verification`, `public.rate_limit`.
   - Restored `items` FK back to `app_users(id)`.
   - Removed old local migration chain from `drizzle/`.

2. Auth config updated
   - Set app name to `Bottomo` in `src/auth/index.ts`.
   - Added Step 5 fields in `src/auth/index.ts`:
     - `userMetadata` (json)
     - `appMetadata` (json)
     - `invitedAt` (date)
     - `lastSignInAt` (date)

3. Drizzle auth schema regenerated
   - Restored missing `src/db/auth.schema.ts` (file was required by `src/db/schema.ts`).
   - Ran:
     - `npx @better-auth/cli generate --config src/auth/index.ts --output src/db/auth.schema.ts -y`

4. SQL migration generated from schema
   - Recreated `drizzle/meta/_journal.json` (it was missing after cleanup).
   - Ran:
     - `npx drizzle-kit generate --dialect postgresql --schema ./src/db/auth.schema.ts --out ./drizzle --name better_auth_init --breakpoints`
   - Output:
     - `drizzle/0000_better_auth_init.sql`
     - `drizzle/meta/0000_snapshot.json`

5. Supabase provider check
   - Checked project auth config via API.
   - No social providers enabled; only email auth is enabled.
   - So `socialProviders` config was not added.

6. Items FK switch migration added (setup-specific)
   - Added `drizzle/0001_items_fk_switch.sql`.
   - It drops `items_user_id_app_users_fkey` and adds `items_user_id_user_fkey` -> `public."user"(id)` with `ON DELETE CASCADE NOT VALID`.

7. GoTrue data migration switched to script approach
   - Removed `drizzle/0002_backfill_gotrue_users.sql` (replaced with script).
   - Added `migration.ts` (guide-style flow) for one-time user/account import from `auth.users` + `auth.identities` into Better Auth tables.
   - Required env vars: `FROM_DATABASE_URL`, `TO_DATABASE_URL`.

8. How to run `migration.ts`
   - Load local env: `set -a; source .local/.vars.env; set +a`
   - Preferred run (this environment): `FROM_DATABASE_URL="$SUPABASE_DB_POOLER_URL" TO_DATABASE_URL="$SUPABASE_DB_POOLER_URL" npx tsx migration.ts`
   - If direct DB DNS works on your host, you can use `SUPABASE_DIRECT_DB_URL` instead.

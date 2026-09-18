import { randomUUID } from "node:crypto";
import postgres from "postgres";

type IdentityRow = {
  created_at: string | null;
  identity_data: Record<string, unknown> | null;
  provider: string;
  provider_id: string;
  updated_at: string | null;
};

type UserRow = {
  banned_until: string | null;
  created_at: string | null;
  deleted_at: string | null;
  email: string | null;
  email_confirmed_at: string | null;
  encrypted_password: string | null;
  id: string;
  identities: IdentityRow[];
  invited_at: string | null;
  is_anonymous: boolean | null;
  is_super_admin: boolean | null;
  last_sign_in_at: string | null;
  raw_app_meta_data: Record<string, unknown> | null;
  raw_user_meta_data: Record<string, unknown> | null;
  role: string | null;
  updated_at: string | null;
};

const CONFIG = {
  batchSize: Number(process.env.BATCH_SIZE ?? "5000"),
  resumeFromId: process.env.RESUME_FROM_ID ?? null,
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function pickString(source: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!source) {
    return null;
  }
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function deriveName(user: UserRow): string {
  return (
    pickString(user.raw_user_meta_data, "name") ??
    pickString(user.raw_user_meta_data, "full_name") ??
    (user.email ? user.email.split("@")[0] : null) ??
    "user"
  );
}

function deriveImage(user: UserRow): string | null {
  return (
    pickString(user.raw_user_meta_data, "avatar_url") ??
    pickString(user.raw_user_meta_data, "picture") ??
    null
  );
}

async function migrate() {
  const fromDb = postgres(requiredEnv("FROM_DATABASE_URL"), { max: 1, prepare: false });
  const toDb = postgres(requiredEnv("TO_DATABASE_URL"), { max: 1, prepare: false });

  let processed = 0;
  let migrated = 0;
  let failed = 0;
  let skipped = 0;
  let cursor = CONFIG.resumeFromId;

  try {
    const [{ count }] = await fromDb.unsafe<{ count: string }[]>(
      "select count(*)::text as count from auth.users where deleted_at is null",
      [],
    );
    const total = Number(count);

    console.log(`Starting Supabase Auth -> Better Auth migration (total users: ${total})`);
    console.log(`Batch size: ${CONFIG.batchSize}`);
    if (cursor) {
      console.log(`Resume from ID: ${cursor}`);
    }

    while (true) {
      const batch = await fromDb.unsafe<UserRow[]>(
        `
          select
            u.*,
            coalesce(
              json_agg(i.* order by i.id) filter (where i.id is not null),
              '[]'::json
            ) as identities
          from auth.users u
          left join auth.identities i on i.user_id = u.id
          where u.deleted_at is null
            and ($1::uuid is null or u.id > $1::uuid)
          group by u.id
          order by u.id asc
          limit $2
        `,
        [cursor, CONFIG.batchSize],
      );

      if (batch.length === 0) {
        break;
      }

      for (const user of batch) {
        processed += 1;
        cursor = user.id;

        if (!user.email) {
          skipped += 1;
          continue;
        }

        try {
          await toDb.begin(async (tx) => {
            const isBanned = Boolean(user.banned_until && new Date(user.banned_until) > new Date());

            await tx.unsafe(
              `
                insert into public."user" (
                  id,
                  name,
                  email,
                  email_verified,
                  image,
                  created_at,
                  updated_at,
                  role,
                  banned,
                  ban_reason,
                  ban_expires,
                  is_anonymous,
                  user_metadata,
                  app_metadata,
                  invited_at,
                  last_sign_in_at
                )
                values (
                  $1, $2, $3, $4, $5,
                  coalesce($6::timestamp, now()),
                  coalesce($7::timestamp, now()),
                  $8, $9, $10, $11::timestamp,
                  $12, $13::jsonb, $14::jsonb, $15::timestamp, $16::timestamp
                )
                on conflict (id) do nothing
              `,
              [
                user.id,
                deriveName(user),
                user.email,
                user.email_confirmed_at !== null,
                deriveImage(user),
                user.created_at,
                user.updated_at,
                user.is_super_admin ? "admin" : user.role ?? "user",
                isBanned,
                isBanned ? "Migrated from Supabase ban" : null,
                isBanned ? user.banned_until : null,
                user.is_anonymous ?? false,
                user.raw_user_meta_data ? JSON.stringify(user.raw_user_meta_data) : null,
                user.raw_app_meta_data ? JSON.stringify(user.raw_app_meta_data) : null,
                user.invited_at,
                user.last_sign_in_at,
              ],
            );

            if (user.encrypted_password) {
              await tx.unsafe(
                `
                  insert into public.account (
                    id,
                    account_id,
                    provider_id,
                    user_id,
                    password,
                    created_at,
                    updated_at
                  )
                  select
                    $1,
                    $2,
                    'credential',
                    $3,
                    $4,
                    coalesce($5::timestamp, now()),
                    coalesce($6::timestamp, now())
                  where not exists (
                    select 1
                    from public.account a
                    where a.provider_id = 'credential'
                      and a.account_id = $2
                  )
                `,
                [
                  randomUUID(),
                  user.id,
                  user.id,
                  user.encrypted_password,
                  user.created_at,
                  user.updated_at,
                ],
              );
            }

            for (const identity of user.identities) {
              if (identity.provider === "email") {
                continue;
              }

              const socialAccountId =
                (typeof identity.identity_data?.sub === "string" && identity.identity_data.sub.length > 0
                  ? identity.identity_data.sub
                  : null) ?? identity.provider_id;

              await tx.unsafe(
                `
                  insert into public.account (
                    id,
                    account_id,
                    provider_id,
                    user_id,
                    created_at,
                    updated_at
                  )
                  select
                    $1,
                    $2,
                    $3,
                    $4,
                    coalesce($5::timestamp, now()),
                    coalesce($6::timestamp, now())
                  where not exists (
                    select 1
                    from public.account a
                    where a.provider_id = $3
                      and a.account_id = $2
                  )
                `,
                [
                  randomUUID(),
                  socialAccountId,
                  identity.provider,
                  user.id,
                  identity.created_at ?? user.created_at,
                  identity.updated_at ?? user.updated_at,
                ],
              );
            }
          });

          migrated += 1;
        } catch (error) {
          failed += 1;
          console.error(`Failed user ${user.id}:`, error);
        }
      }

      console.log(
        `Progress: ${processed}/${total} | migrated=${migrated} skipped=${skipped} failed=${failed}`,
      );
    }

    console.log("Migration complete");
    console.log(`Final: migrated=${migrated} skipped=${skipped} failed=${failed}`);
    if (cursor) {
      console.log(`Last processed ID: ${cursor}`);
    }
  } finally {
    await fromDb.end({ timeout: 5 });
    await toDb.end({ timeout: 5 });
  }
}

migrate().catch((error) => {
  console.error("Migration failed", error);
  process.exitCode = 1;
});

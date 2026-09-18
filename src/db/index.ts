import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema";

type HyperdriveEnv = Env & {
  SUPABASE_HYPERDRIVE: Hyperdrive;
};

type Database = ReturnType<typeof drizzle>;

export function getDb(env: HyperdriveEnv): Database {
  const sql = postgres(env.SUPABASE_HYPERDRIVE.connectionString, {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    prepare: false,
  });
  return drizzle(sql, { schema });
}

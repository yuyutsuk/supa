import { compare, hash } from "bcryptjs";
import type { IncomingRequestCfProperties } from "@cloudflare/workers-types";
import { betterAuth } from "better-auth";
import { admin, anonymous, bearer } from "better-auth/plugins";
import {
  type CloudflareGeolocation,
  withCloudflare,
} from "better-auth-cloudflare";
import { drizzle } from "drizzle-orm/postgres-js";
import { getDb } from "../db";
import { schema } from "../db/schema";

const BCRYPT_ROUNDS = 10;

export type AuthEnv = Env & {
  BETTER_AUTH_SECRET: string;
  PUBLIC_APP_ORIGINS?: string;
  SUPABASE_HYPERDRIVE: Hyperdrive;
};

function readPublicAppOrigins(env?: AuthEnv): string[] {
  return env?.PUBLIC_APP_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];
}

function toGeolocation(
  cf?: IncomingRequestCfProperties | null,
): CloudflareGeolocation {
  if (!cf) {
    return {};
  }

  return {
    city: cf.city ?? null,
    colo: cf.colo ?? null,
    country: cf.country ?? null,
    latitude: cf.latitude ?? null,
    longitude: cf.longitude ?? null,
    region: cf.region ?? null,
    regionCode: cf.regionCode ?? null,
    timezone: cf.timezone ?? null,
  };
}

export function createAuth(
  env?: AuthEnv,
  cf?: IncomingRequestCfProperties,
  baseURL?: string,
) {
  const db = env ? getDb(env) : drizzle.mock({ schema });

  return betterAuth({
    appName: "Bottomo",
    baseURL: baseURL ?? "http://localhost",
    secret: env?.BETTER_AUTH_SECRET,
    trustedOrigins: readPublicAppOrigins(env),
    ...withCloudflare(
      {
        autoDetectIpAddress: env ? true : false,
        cf: toGeolocation(cf),
        geolocationTracking: true,
        postgres: {
          db,
        },
      },
      {
        advanced: {
          database: {
            generateId: "uuid",
          },
        },
        emailAndPassword: {
          enabled: true,
          password: {
            hash: async (password) => hash(password, BCRYPT_ROUNDS),
            verify: async ({ hash: storedHash, password }) =>
              compare(password, storedHash),
          },
        },
        plugins: [admin(), anonymous(), bearer()],
        user: {
          additionalFields: {
            userMetadata: {
              input: false,
              required: false,
              type: "json",
            },
            appMetadata: {
              input: false,
              required: false,
              type: "json",
            },
            invitedAt: {
              input: false,
              required: false,
              type: "date",
            },
            lastSignInAt: {
              input: false,
              required: false,
              type: "date",
            },
          },
        },
        rateLimit: {
          storage: "database",
        },
        verification: {
          storeInDatabase: true,
        },
      },
    ),
  });
}

export const auth = createAuth();

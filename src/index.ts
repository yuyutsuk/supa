import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, importJWK, jwtVerify, SignJWT } from "jose";

type ItemBody = {
  name?: string;
  user_id?: string;
};

// Wrangler cannot infer secret names because secrets are not stored in config.
type WorkerEnv = {
  CF_ACCESS_AUD: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  SUPABASE_JWT_KEY_ID: string;
  SUPABASE_JWT_SIGNING_KEY: string;
};

type PrivateSigningJwk = {
  crv: "P-256";
  d: string;
  kty: "EC";
  x: string;
  y: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPABASE_JWT_TTL_SECONDS = 300;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

async function readBody(request: Request): Promise<ItemBody | null> {
  try {
    const value: unknown = await request.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const field = (key: string): string | undefined => {
      const property = Object.getOwnPropertyDescriptor(value, key)?.value;
      return typeof property === "string" ? property : undefined;
    };

    return { name: field("name"), user_id: field("user_id") };
  } catch {
    return null;
  }
}

function readPrivateSigningJwk(serialized: string): PrivateSigningJwk {
  let value: unknown;

  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("SUPABASE_JWT_SIGNING_KEY is not valid JSON");
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SUPABASE_JWT_SIGNING_KEY must be a JWK object");
  }

  const field = (key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
  if (
    field("kty") !== "EC" ||
    field("crv") !== "P-256" ||
    typeof field("d") !== "string" ||
    typeof field("x") !== "string" ||
    typeof field("y") !== "string"
  ) {
    throw new Error("SUPABASE_JWT_SIGNING_KEY must be an ES256 private JWK");
  }

  return {
    crv: "P-256",
    d: field("d"),
    kty: "EC",
    x: field("x"),
    y: field("y"),
  };
}

async function mintSupabaseJwt(
  accessAssertion: string,
  env: WorkerEnv,
): Promise<string> {
  const accessJwks = createRemoteJWKSet(
    new URL(`${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
  );
  const { payload } = await jwtVerify(accessAssertion, accessJwks, {
    audience: env.CF_ACCESS_AUD,
    issuer: env.CF_ACCESS_TEAM_DOMAIN,
  });

  if (typeof payload.sub !== "string" || !UUID_PATTERN.test(payload.sub)) {
    throw new Error("Cloudflare Access subject is not a UUID");
  }

  const signingKey = await importJWK(readPrivateSigningJwk(env.SUPABASE_JWT_SIGNING_KEY), "ES256");
  const claims: Record<string, string> = {
    cf_access_sub: payload.sub,
    role: "authenticated",
  };
  if (typeof payload.email === "string") {
    claims.email = payload.email;
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: env.SUPABASE_JWT_KEY_ID, typ: "JWT" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${SUPABASE_JWT_TTL_SECONDS}s`)
    .sign(signingKey);
}

export default {
  async fetch(request, env): Promise<Response> {
    const accessAssertion = request.headers.get("Cf-Access-Jwt-Assertion");

    if (!accessAssertion) {
      return Response.json({ error: "Cloudflare Access authentication is required" }, { status: 403 });
    }

    let supabaseJwt: string;
    try {
      supabaseJwt = await mintSupabaseJwt(accessAssertion, env);
    } catch {
      return Response.json({ error: "Invalid Cloudflare Access token" }, { status: 403 });
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY, {
      accessToken: () => supabaseJwt,
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });

    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const userId = url.searchParams.get("user_id");

    if (request.method === "GET") {
      if (!userId) {
        return Response.json({ error: "user_id is required" }, { status: 400 });
      }

      const { data, error } = await supabase.from("items").select("*").eq("user_id", userId);
      return error
        ? Response.json({ error: error.message }, { status: 500 })
        : Response.json(data);
    }

    if (request.method === "POST") {
      const body = await readBody(request);
      if (!body || !hasText(body.name) || !hasText(body.user_id)) {
        return Response.json({ error: "name and user_id are required" }, { status: 400 });
      }

      const { data, error } = await supabase
        .from("items")
        .insert({ name: body.name, user_id: body.user_id })
        .select()
        .single();
      return error
        ? Response.json({ error: error.message }, { status: 500 })
        : Response.json(data, { status: 201 });
    }

    if (request.method === "PATCH") {
      if (!id || !userId) {
        return Response.json({ error: "id and user_id are required" }, { status: 400 });
      }

      const body = await readBody(request);
      const { data, error } = await supabase
        .from("items")
        .update({ name: body?.name })
        .eq("id", id)
        .eq("user_id", userId)
        .select()
        .single();
      return error
        ? Response.json({ error: error.message }, { status: 500 })
        : Response.json(data);
    }

    if (request.method === "DELETE") {
      if (!id || !userId) {
        return Response.json({ error: "id and user_id are required" }, { status: 400 });
      }

      const { error } = await supabase
        .from("items")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);
      return error
        ? Response.json({ error: error.message }, { status: 500 })
        : new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  },
} satisfies ExportedHandler<WorkerEnv>;

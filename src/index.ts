import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, importJWK, jwtVerify, SignJWT } from "jose";

type ItemBody = {
  name?: string;
};

type AccessIdentity = {
  email: string;
  sub: string;
};

// Wrangler cannot infer secret names because secrets are not stored in config.
type WorkerEnv = {
  CF_ACCESS_AUD: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  DEBUG_LOG_BRIDGE_JWTS?: string;
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

    return { name: field("name") };
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

async function validateAccessAssertion(
  accessAssertion: string,
  env: WorkerEnv,
): Promise<AccessIdentity> {
  const accessJwks = createRemoteJWKSet(
    new URL(`${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`),
  );
  const { payload } = await jwtVerify(accessAssertion, accessJwks, {
    audience: env.CF_ACCESS_AUD,
    issuer: env.CF_ACCESS_TEAM_DOMAIN,
  });

  if (
    typeof payload.sub !== "string" ||
    !UUID_PATTERN.test(payload.sub) ||
    typeof payload.email !== "string" ||
    payload.email.length === 0
  ) {
    throw new Error("Cloudflare Access subject is not a UUID");
  }

  return { email: payload.email, sub: payload.sub };
}

async function mintSupabaseJwt(
  identity: AccessIdentity,
  subject: string,
  env: WorkerEnv,
  bridgeStage?: "identity_resolution",
): Promise<string> {
  const signingKey = await importJWK(readPrivateSigningJwk(env.SUPABASE_JWT_SIGNING_KEY), "ES256");
  const claims: Record<string, string> = {
    cf_access_sub: identity.sub,
    email: identity.email,
    role: "authenticated",
  };
  if (bridgeStage) {
    claims.bridge_stage = bridgeStage;
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: env.SUPABASE_JWT_KEY_ID, typ: "JWT" })
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(`${SUPABASE_JWT_TTL_SECONDS}s`)
    .sign(signingKey);
}

function createSupabaseClient(env: WorkerEnv, accessToken: string) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_KEY, {
    accessToken: () => accessToken,
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

async function resolveInternalUserId(identity: AccessIdentity, env: WorkerEnv): Promise<string> {
  const resolutionJwt = await mintSupabaseJwt(identity, identity.sub, env, "identity_resolution");
  if (env.DEBUG_LOG_BRIDGE_JWTS !== "false") {
    console.log("Option C identity-resolution JWT", resolutionJwt);
  }
  const { data, error } = await createSupabaseClient(env, resolutionJwt)
    .rpc("resolve_or_provision_current_identity");

  if (error || typeof data !== "string" || !UUID_PATTERN.test(data)) {
    throw new Error("Unable to resolve application identity");
  }

  return data;
}

export default {
  async fetch(request, env): Promise<Response> {
    const accessAssertion = request.headers.get("Cf-Access-Jwt-Assertion");

    if (!accessAssertion) {
      return Response.json({ error: "Cloudflare Access authentication is required" }, { status: 403 });
    }

    let identity: AccessIdentity;
    try {
      identity = await validateAccessAssertion(accessAssertion, env);
    } catch {
      return Response.json({ error: "Invalid Cloudflare Access token" }, { status: 403 });
    }

    let internalUserId: string;
    let supabaseJwt: string;
    try {
      internalUserId = await resolveInternalUserId(identity, env);
      supabaseJwt = await mintSupabaseJwt(identity, internalUserId, env);
      if (env.DEBUG_LOG_BRIDGE_JWTS !== "false") {
        console.log("Option C final CRUD JWT", supabaseJwt);
      }
    } catch {
      return Response.json({ error: "Unable to resolve application identity" }, { status: 403 });
    }

    const supabase = createSupabaseClient(env, supabaseJwt);

    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (request.method === "GET") {
      const { data, error } = await supabase.from("items").select("*").eq("user_id", internalUserId);
      return error
        ? Response.json({ error: error.message }, { status: 500 })
        : Response.json(data);
    }

    if (request.method === "POST") {
      const body = await readBody(request);
      if (!body || !hasText(body.name)) {
        return Response.json({ error: "name is required" }, { status: 400 });
      }

      const { data, error } = await supabase
        .from("items")
        .insert({ name: body.name, user_id: internalUserId })
        .select()
        .single();
      return error
        ? Response.json({ error: error.message }, { status: 500 })
        : Response.json(data, { status: 201 });
    }

    if (request.method === "PATCH") {
      if (!id) {
        return Response.json({ error: "id is required" }, { status: 400 });
      }

      const body = await readBody(request);
      const { data, error } = await supabase
        .from("items")
        .update({ name: body?.name })
        .eq("id", id)
        .eq("user_id", internalUserId)
        .select()
        .single();
      return error
        ? Response.json({ error: error.message }, { status: 500 })
        : Response.json(data);
    }

    if (request.method === "DELETE") {
      if (!id) {
        return Response.json({ error: "id is required" }, { status: 400 });
      }

      const { error } = await supabase
        .from("items")
        .delete()
        .eq("id", id)
        .eq("user_id", internalUserId);
      return error
        ? Response.json({ error: error.message }, { status: 500 })
        : new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  },
} satisfies ExportedHandler<WorkerEnv>;

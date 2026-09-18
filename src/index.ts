import { createClient } from "@supabase/supabase-js";
import { importJWK, SignJWT } from "jose";
import { createAuth, type AuthEnv } from "./auth";

type ItemBody = {
  name?: string;
};

// Wrangler cannot infer secret names because secrets are not stored in config.
type WorkerEnv = AuthEnv & {
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  SUPABASE_JWT_KEY_ID: string;
  SUPABASE_JWT_SIGNING_KEY: string;
};

type SessionIdentity = {
  email: string | null;
  userId: string;
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
  const d = field("d");
  const x = field("x");
  const y = field("y");

  if (field("kty") !== "EC" || field("crv") !== "P-256" || typeof d !== "string" || typeof x !== "string" || typeof y !== "string") {
    throw new Error("SUPABASE_JWT_SIGNING_KEY must be an ES256 private JWK");
  }

  return {
    crv: "P-256",
    d,
    kty: "EC",
    x,
    y,
  };
}

function appendCsvHeaderValue(headers: Headers, name: string, value: string): void {
  const nextValues = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (nextValues.length === 0) {
    return;
  }

  const current = headers.get(name);
  if (!current) {
    headers.set(name, nextValues.join(", "));
    return;
  }

  const values = new Set(
    current
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  for (const item of nextValues) {
    values.add(item);
  }
  headers.set(name, Array.from(values).join(", "));
}

function withAuthHeaders(response: Response, authHeaders: Headers): Response {
  for (const value of authHeaders.getSetCookie()) {
    response.headers.append("set-cookie", value);
  }

  const authToken = authHeaders.get("set-auth-token");
  if (hasText(authToken)) {
    response.headers.set("set-auth-token", authToken);
  }

  const exposeHeaders = authHeaders.get("access-control-expose-headers");
  if (hasText(exposeHeaders)) {
    appendCsvHeaderValue(
      response.headers,
      "access-control-expose-headers",
      exposeHeaders,
    );
  }

  return response;
}

async function mintSupabaseJwt(
  identity: SessionIdentity,
  env: WorkerEnv,
): Promise<string> {
  const signingKey = await importJWK(readPrivateSigningJwk(env.SUPABASE_JWT_SIGNING_KEY), "ES256");
  const claims: Record<string, string> = {
    better_auth_user_id: identity.userId,
    role: "authenticated",
  };
  if (identity.email) {
    claims.email = identity.email;
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: env.SUPABASE_JWT_KEY_ID, typ: "JWT" })
    .setSubject(identity.userId)
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

async function resolveSession(
  request: Request,
  auth: ReturnType<typeof createAuth>,
): Promise<{ authHeaders: Headers; identity: SessionIdentity | null }> {
  const result = await auth.api.getSession({
    headers: request.headers,
    returnHeaders: true,
  });
  const session = result.response;

  if (!session) {
    return { authHeaders: result.headers, identity: null };
  }

  if (!UUID_PATTERN.test(session.user.id)) {
    throw new Error("Better Auth user id is not a UUID");
  }

  return {
    authHeaders: result.headers,
    identity: {
      email: hasText(session.user.email) ? session.user.email : null,
      userId: session.user.id,
    },
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const auth = createAuth(env, request.cf, url.origin);

    if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
      try {
        const authResponse = await auth.handler(request);
        if (authResponse) {
          return authResponse;
        }

        console.error("Better Auth handler returned no response", {
          method: request.method,
          path: url.pathname,
        });
        return Response.json({ error: "Unknown Better Auth route" }, { status: 404 });
      } catch (error) {
        console.error("Better Auth handler failed", error);
        return Response.json({ error: "Better Auth request failed" }, { status: 500 });
      }
    }

    let session;
    try {
      session = await resolveSession(request, auth);
    } catch {
      return Response.json({ error: "Invalid Better Auth session" }, { status: 403 });
    }

    if (!session.identity) {
      const response = Response.json(
        { error: "Authentication is required" },
        { status: 401 },
      );
      return withAuthHeaders(response, session.authHeaders);
    }

    let supabaseJwt: string;
    try {
      supabaseJwt = await mintSupabaseJwt(session.identity, env);
    } catch {
      const response = Response.json(
        { error: "Unable to mint Supabase authorization token" },
        { status: 500 },
      );
      return withAuthHeaders(response, session.authHeaders);
    }

    const internalUserId = session.identity.userId;
    const supabase = createSupabaseClient(env, supabaseJwt);
    const id = url.searchParams.get("id");

    if (request.method === "GET") {
      const { data, error } = await supabase.from("items").select("*").eq("user_id", internalUserId);
      const response = error
        ? Response.json({ error: error.message }, { status: 500 })
        : Response.json(data);
      return withAuthHeaders(response, session.authHeaders);
    }

    if (request.method === "POST") {
      const body = await readBody(request);
      if (!body || !hasText(body.name)) {
        const response = Response.json({ error: "name is required" }, { status: 400 });
        return withAuthHeaders(response, session.authHeaders);
      }

      const { data, error } = await supabase
        .from("items")
        .insert({ name: body.name, user_id: internalUserId })
        .select()
        .single();
      const response = error
        ? Response.json({ error: error.message }, { status: 500 })
        : Response.json(data, { status: 201 });
      return withAuthHeaders(response, session.authHeaders);
    }

    if (request.method === "PATCH") {
      if (!id) {
        const response = Response.json({ error: "id is required" }, { status: 400 });
        return withAuthHeaders(response, session.authHeaders);
      }

      const body = await readBody(request);
      const { data, error } = await supabase
        .from("items")
        .update({ name: body?.name })
        .eq("id", id)
        .eq("user_id", internalUserId)
        .select()
        .single();
      const response = error
        ? Response.json({ error: error.message }, { status: 500 })
        : Response.json(data);
      return withAuthHeaders(response, session.authHeaders);
    }

    if (request.method === "DELETE") {
      if (!id) {
        const response = Response.json({ error: "id is required" }, { status: 400 });
        return withAuthHeaders(response, session.authHeaders);
      }

      const { error } = await supabase
        .from("items")
        .delete()
        .eq("id", id)
        .eq("user_id", internalUserId);
      const response = error
        ? Response.json({ error: error.message }, { status: 500 })
        : new Response(null, { status: 204 });
      return withAuthHeaders(response, session.authHeaders);
    }

    return withAuthHeaders(
      new Response("Method not allowed", { status: 405 }),
      session.authHeaders,
    );
  },
} satisfies ExportedHandler<WorkerEnv>;

import { createClient } from "@supabase/supabase-js";

type ItemBody = {
  name?: string;
  user_id?: string;
};

// Wrangler cannot infer secret names because secrets are not stored in config.
type WorkerEnv = {
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
};

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

export default {
  async fetch(request, env): Promise<Response> {
    const authorization = request.headers.get("Authorization");

    if (!authorization?.startsWith("Bearer ")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      global: { headers: { Authorization: authorization } },
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

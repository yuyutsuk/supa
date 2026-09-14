import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function handleItems(
  req: Request,
  supabase: SupabaseClient,
): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const userId = url.searchParams.get("user_id");

  // GET /items-api?user_id=...
  if (req.method === "GET") {
    if (!userId) {
      return Response.json(
        { error: "user_id is required" },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from("items")
      .select("*")
      .eq("user_id", userId);

    if (error) {
      return Response.json(
        { error: error.message },
        { status: 500 },
      );
    }

    return Response.json(data);
  }

  // POST /items-api
  if (req.method === "POST") {
    const { name, user_id } = await req.json();

    if (!name || !user_id) {
      return Response.json(
        { error: "name and user_id are required" },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from("items")
      .insert({
        name,
        user_id,
      })
      .select()
      .single();

    if (error) {
      return Response.json(
        { error: error.message },
        { status: 500 },
      );
    }

    return Response.json(data, { status: 201 });
  }

  // PATCH /items-api?id=1&user_id=...
  if (req.method === "PATCH") {
    if (!id || !userId) {
      return Response.json(
        { error: "id and user_id are required" },
        { status: 400 },
      );
    }

    const { name } = await req.json();

    const { data, error } = await supabase
      .from("items")
      .update({ name })
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) {
      return Response.json(
        { error: error.message },
        { status: 500 },
      );
    }

    return Response.json(data);
  }

  // DELETE /items-api?id=1&user_id=...
  if (req.method === "DELETE") {
    if (!id || !userId) {
      return Response.json(
        { error: "id and user_id are required" },
        { status: 400 },
      );
    }

    const { error } = await supabase
      .from("items")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);

    if (error) {
      return Response.json(
        { error: error.message },
        { status: 500 },
      );
    }

    return new Response(null, { status: 204 });
  }

  return new Response("Method not allowed", { status: 405 });
}

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function handleItems(
  req: Request,
  supabase: SupabaseClient,
): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  // GET
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("items")
      .select("*");

    if (error) {
      return Response.json(
        { error: error.message },
        { status: 500 },
      );
    }

    return Response.json(data);
  }

  // POST
  if (req.method === "POST") {
    const { name } = await req.json();

    const { data, error } = await supabase
      .from("items")
      .insert({ name })
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

  // PATCH /items-api?id=1
  if (req.method === "PATCH" && id) {
    const { name } = await req.json();

    const { data, error } = await supabase
      .from("items")
      .update({ name })
      .eq("id", id)
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

  // DELETE /items-api?id=1
  if (req.method === "DELETE" && id) {
    const { error } = await supabase
      .from("items")
      .delete()
      .eq("id", id);

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

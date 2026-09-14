import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import { handleItems } from "./main.ts";

export default {
  fetch: withSupabase(
    {
      auth: ["publishable", "secret"],
    },
    async (req, ctx) => {
      const supabase =
        ctx.authMode === "secret"
          ? ctx.supabaseAdmin
          : ctx.supabase;

      return handleItems(req, supabase);
    },
  ),
};

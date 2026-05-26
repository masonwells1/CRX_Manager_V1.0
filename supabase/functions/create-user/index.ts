import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { captureEdgeException } from "../_shared/sentry.ts";
import { requireActiveProfile } from "../_shared/auth.ts";

// IMPORTANT: Set ALLOWED_ORIGIN in Supabase Function secrets for production.
// e.g. supabase secrets set ALLOWED_ORIGIN=https://your-domain.com
// PR-16: removed the silent fallback to https://croprxsolutions.app —
// missing env var now throws at function startup.
function getAllowedOrigin(): string {
  const origin = Deno.env.get("ALLOWED_ORIGIN");
  if (origin) return origin;
  const url = Deno.env.get("SUPABASE_URL") || "";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "http://localhost:5173";
  throw new Error(
    "ALLOWED_ORIGIN env var is required for production deployments. " +
      "Set via: supabase secrets set ALLOWED_ORIGIN=https://your-domain.com",
  );
}

const corsHeaders = {
  "Access-Control-Allow-Origin": getAllowedOrigin(),
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user: caller },
    } = await callerClient.auth.getUser();
    if (!caller) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    // Codex audit F1 (P1, 2026-05-16): is_active gate enforced server-side.
    const gate = await requireActiveProfile(adminClient, caller.id, ["admin"]);
    if ("error" in gate) {
      return new Response(JSON.stringify({ error: gate.error }), {
        status: gate.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action } = body;

    // --- Reset Password action ---
    if (action === "reset_password") {
      const { user_id, password: newPw } = body;
      if (!user_id || !newPw) {
        return new Response(
          JSON.stringify({ error: "user_id and password are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (newPw.length < 8) {
        return new Response(
          JSON.stringify({ error: "Password must be at least 8 characters" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // B8 (2026-05-26 post-Codex audit): mirror the entity_recipient guard
      // from reset-user-password. SettingsPage.tsx:393 routes the Set-Password
      // UI through THIS endpoint (action=reset_password), so the EDGE-2 fix
      // applied to reset-user-password v12 was effectively dead code without
      // this server-side check. The UI filter at SettingsPage.tsx:185-193 is
      // defense-in-depth; this gate is the real one. Without it, a crafted
      // POST with a known entity_recipient UUID would defeat the
      // "can never log in" guarantee from migration 20260516090000.
      const { data: targetProfile } = await adminClient
        .from("profiles")
        .select("role")
        .eq("id", user_id)
        .maybeSingle();
      if (targetProfile?.role === "entity_recipient") {
        return new Response(
          JSON.stringify({ error: "Cannot reset password for service profiles" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const { error: updateError } = await adminClient.auth.admin.updateUserById(user_id, { password: newPw });
      if (updateError) {
        return new Response(JSON.stringify({ error: updateError.message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // --- Create User action (default) ---
    const { email, password, full_name, role, phone } = body;

    if (!email || !password || !full_name) {
      return new Response(
        JSON.stringify({ error: "Email, password, and full name are required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const validRoles = ["admin", "sales_rep", "driver", "applicator"];
    if (role && !validRoles.includes(role)) {
      return new Response(
        JSON.stringify({ error: `Invalid role: ${role}. Must be one of: ${validRoles.join(", ")}` }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: newUser, error: createError } =
      await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name, role: role || "sales_rep" },
      });

    if (createError) {
      return new Response(JSON.stringify({ error: createError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (phone) {
      const { error: phoneError } = await adminClient
        .from("profiles")
        .update({ phone })
        .eq("id", newUser.user.id);
      if (phoneError) {
        await captureEdgeException(phoneError, {
          function: "create-user",
          level: "warning",
          extra: { context: "profile_phone_update", user_id: newUser.user.id },
        });
      }
    }

    return new Response(
      JSON.stringify({ user: { id: newUser.user.id, email } }),
      {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    // Audit #28: surface unhandled errors to Sentry — admin user creation
    // failures are security-relevant (e.g. service-role permission issues,
    // mass-create attempts) and need oncall visibility.
    await captureEdgeException(err, {
      function: "create-user",
      level: "error",
    });
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

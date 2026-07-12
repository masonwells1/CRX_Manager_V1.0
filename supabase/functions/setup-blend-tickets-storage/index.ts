import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { captureEdgeException } from "../_shared/sentry.ts";
import { requireActiveProfile } from "../_shared/auth.ts";

// IMPORTANT: Set ALLOWED_ORIGIN in Supabase Function secrets for production.
// e.g. supabase secrets set ALLOWED_ORIGIN=https://your-domain.com
// 2026-05-16 (ultra-review P3 #7): removed silent prod-URL fallback. Missing
// secret now fails loud, matching the PR-16 pattern used by every other
// hardened Edge Function. Hides deployment misconfiguration is worse than
// boot failure — at least boot failure is loud.
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
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info, x-supabase-api-version, x-request-id",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  // Authenticate caller
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing authorization" }, 401);
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller } } = await callerClient.auth.getUser();
  if (!caller) {
    return jsonResponse({ error: "Invalid token" }, 401);
  }

  // Codex audit F1 (P1, 2026-05-16): is_active gate enforced server-side.
  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const gate = await requireActiveProfile(adminClient, caller.id, ["admin"]);
  if ("error" in gate) {
    return jsonResponse({ error: gate.error }, gate.status);
  }

  try {
    const data = {
      message: "Storage bucket setup instructions",
      instructions: [
        "1. Go to Supabase Dashboard > Storage",
        "2. Create a new bucket named: blend-ticket-images",
        "3. Set it as PRIVATE bucket (not public)",
        "4. Configure max file size: 10MB",
        "5. Allowed MIME types: image/jpeg, image/png",
        "6. Enable RLS policies for authenticated uploads",
        "7. Use signed URLs to access images (handled by the app)"
      ],
      bucketName: "blend-ticket-images",
      bucketConfig: {
        public: false,
        fileSizeLimit: 10485760,
        allowedMimeTypes: ["image/jpeg", "image/png", "image/jpg"]
      }
    };

    return new Response(JSON.stringify(data), {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    // Audit #28: surface unhandled errors. Storage setup failures usually
    // indicate Supabase Storage misconfiguration or service-role key drift.
    await captureEdgeException(error, {
      function: "setup-blend-tickets-storage",
      level: "error",
    });
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});

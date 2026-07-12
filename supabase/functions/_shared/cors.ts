// Shared CORS for all edge functions. Origin is locked to ALLOWED_ORIGIN;
// preflight reflects the browser's requested headers so a new client/SDK
// header can never silently block every function again (2026-07-12 outage).
function getAllowedOrigin(): string {
  const origin = Deno.env.get("ALLOWED_ORIGIN");
  if (origin) return origin;
  const url = Deno.env.get("SUPABASE_URL") || "";
  if (url.includes("localhost") || url.includes("127.0.0.1")) {
    return "http://localhost:5173";
  }
  throw new Error(
    "ALLOWED_ORIGIN env var is required for production deployments. " +
      "Set via: supabase secrets set ALLOWED_ORIGIN=https://your-domain.com",
  );
}

// Explicit fallback list — the exact set the app currently sends.
export const FALLBACK_ALLOW_HEADERS =
  "Content-Type, Authorization, apikey, x-client-info, x-supabase-api-version, x-request-id";

// Static headers attached to ACTUAL (non-preflight) responses. Origin + methods
// are what matter here; Allow-Headers is only consulted by the browser on the
// preflight, so the fallback list is fine for real responses.
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": getAllowedOrigin(),
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": FALLBACK_ALLOW_HEADERS,
  "Vary": "Origin",
};

// Preflight response: echo whatever headers the browser asks to send (falling
// back to the explicit list), so an unknown-but-legit header is never blocked.
export function preflightResponse(req: Request): Response {
  const requested = req.headers.get("Access-Control-Request-Headers");
  return new Response(null, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Access-Control-Allow-Headers": requested ?? FALLBACK_ALLOW_HEADERS,
      "Vary": "Origin, Access-Control-Request-Headers",
    },
  });
}

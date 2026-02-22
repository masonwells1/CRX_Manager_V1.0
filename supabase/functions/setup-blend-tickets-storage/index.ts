import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// IMPORTANT: Set ALLOWED_ORIGIN in Supabase Function secrets for production.
// e.g. supabase secrets set ALLOWED_ORIGIN=https://your-domain.com
function getAllowedOrigin(): string {
  const origin = Deno.env.get("ALLOWED_ORIGIN");
  if (origin) return origin;
  const url = Deno.env.get("SUPABASE_URL") || "";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "http://localhost:5173";
  console.error("ALLOWED_ORIGIN not set — CORS will block all requests");
  return "";
}

const corsHeaders = {
  "Access-Control-Allow-Origin": getAllowedOrigin(),
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
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
    return new Response(
      JSON.stringify({ error: error.message }),
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

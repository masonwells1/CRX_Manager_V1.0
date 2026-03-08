import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

// CORS — mirrors create-user pattern
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

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    // 1. Validate JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) {
      return jsonResponse({ error: "Invalid token" }, 401);
    }

    // 2. Admin role check
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: callerProfile } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .maybeSingle();

    if (!callerProfile || callerProfile.role !== "admin") {
      return jsonResponse({ error: "Admin access required" }, 403);
    }

    // 3. Parse request body
    const {
      to,
      subject,
      html,
      email_type,
      customer_id,
      idempotency_key,
      attachments,
    } = await req.json();

    if (!to || !subject || !html || !email_type) {
      return jsonResponse({ error: "to, subject, html, and email_type are required" }, 400);
    }

    // 4. Idempotency check — if key already exists, return existing result
    if (idempotency_key) {
      const { data: existing } = await adminClient
        .from("email_log")
        .select("id, resend_message_id, status")
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();

      if (existing) {
        return jsonResponse({
          success: existing.status === "sent",
          email_log_id: existing.id,
          resend_message_id: existing.resend_message_id,
          deduplicated: true,
        });
      }
    }

    // 5. Call Resend API
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("FROM_EMAIL") || "noreply@croprxsolutions.app";

    if (!resendApiKey) {
      return jsonResponse({ error: "RESEND_API_KEY not configured" }, 500);
    }

    const resendBody: Record<string, unknown> = {
      from: fromEmail,
      to: [to],
      subject,
      html,
    };

    // Attach files if provided
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      resendBody.attachments = attachments.map(
        (att: { filename: string; content: string }) => ({
          filename: att.filename,
          content: att.content,
        }),
      );
    }

    const resendResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify(resendBody),
    });

    const resendResult = await resendResp.json();
    const success = resendResp.ok;
    const resendMessageId = resendResult.id || null;
    const errorMessage = success ? null : (resendResult.message || JSON.stringify(resendResult));

    // 6. Insert into email_log
    const { data: logRow, error: logError } = await adminClient
      .from("email_log")
      .insert({
        customer_id: customer_id || null,
        recipient_email: to,
        email_type,
        subject,
        html_body: html,
        attachment_name: attachments?.[0]?.filename || null,
        resend_message_id: resendMessageId,
        status: success ? "sent" : "failed",
        error_message: errorMessage,
        idempotency_key: idempotency_key || null,
        created_by: caller.id,
      })
      .select("id")
      .single();

    if (logError) {
      console.error("Failed to insert email_log:", logError);
    }

    if (!success) {
      return jsonResponse({
        success: false,
        error: errorMessage,
        email_log_id: logRow?.id,
      }, 502);
    }

    return jsonResponse({
      success: true,
      email_log_id: logRow?.id,
      resend_message_id: resendMessageId,
    });
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});

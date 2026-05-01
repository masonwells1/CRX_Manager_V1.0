import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

// =============================================================================
// CRX send-email — Sprint F #1 lockdown
//
// Hardens the email Edge Function against arbitrary-recipient + arbitrary-type
// abuse vectors flagged in the security audit:
//   1. Recipient `to` MUST match customer.email for the supplied customer_id
//      (server-side lookup; caller-provided `to` is validated, never trusted).
//   2. email_type is allowlisted per role:
//        admin, sales_rep -> all 8 types
//        driver           -> only delivery_completed (with proof of assignment)
//   3. Drivers must supply resource_type='delivery' + resource_id and be the
//      assigned driver of that delivery; the delivery's customer_id must
//      match the request's customer_id.
//   4. Attachments capped at 5 files / 10MB total decoded.
//   5. Per-user rate limit of 50 emails per rolling hour (counts email_log).
//   6. (Future) Server-side HTML templates keyed by email_type — current
//      version still accepts caller HTML but is gated by validation above.
// =============================================================================

// CORS — mirrors create-user pattern
function getAllowedOrigin(): string {
  const origin = Deno.env.get("ALLOWED_ORIGIN");
  if (origin) return origin;
  const url = Deno.env.get("SUPABASE_URL") || "";
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "http://localhost:5173";
  return "https://croprxsolutions.app";
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

// --- Allowlists ---------------------------------------------------------------

const ALL_EMAIL_TYPES = new Set([
  "invoice",
  "statement",
  "order_confirmed",
  "delivery_completed",
  "quote",
  "ar_reminder",
  "low_stock_alert",
  "month_end_close",
]);

// What email types each role may send.
const EMAIL_TYPES_BY_ROLE: Record<string, Set<string>> = {
  admin: ALL_EMAIL_TYPES,
  sales_rep: ALL_EMAIL_TYPES,
  driver: new Set(["delivery_completed"]),
};

// Attachment limits
const MAX_ATTACHMENTS = 5;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB after base64 decode

// Rate limit
const RATE_LIMIT_PER_HOUR = 50;

function decodedBase64Length(b64: string): number {
  // base64 expands 3 bytes -> 4 chars (with == padding). Use the standard formula:
  // bytes = (len(b64) * 3 / 4) - padding_count
  const padding = (b64.match(/=+$/) || [""])[0].length;
  return Math.floor((b64.length * 3) / 4) - padding;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    // 1. JWT validation
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

    // 2. Role lookup
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: callerProfile } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .maybeSingle();

    const role = callerProfile?.role;
    if (!role || !EMAIL_TYPES_BY_ROLE[role]) {
      return jsonResponse({ error: "Insufficient role" }, 403);
    }

    // 3. Parse body
    const body = await req.json();
    const {
      to,
      subject,
      html,
      email_type,
      customer_id,
      resource_type,
      resource_id,
      idempotency_key,
      attachments,
    } = body;

    if (!to || !subject || !html || !email_type) {
      return jsonResponse({ error: "to, subject, html, and email_type are required" }, 400);
    }
    if (!customer_id) {
      return jsonResponse({ error: "customer_id is required" }, 400);
    }
    if (typeof to !== "string" || typeof subject !== "string" || typeof html !== "string") {
      return jsonResponse({ error: "to, subject, html must be strings" }, 400);
    }

    // 4. email_type allowlist (catch unknown values + per-role gate)
    if (!ALL_EMAIL_TYPES.has(email_type)) {
      return jsonResponse({ error: `Unknown email_type: ${email_type}` }, 400);
    }
    const allowedForRole = EMAIL_TYPES_BY_ROLE[role];
    if (!allowedForRole.has(email_type)) {
      return jsonResponse(
        { error: `Role '${role}' is not permitted to send '${email_type}' emails` },
        403,
      );
    }

    // 5. Customer email match — recipient is validated server-side from customer_id
    const { data: customerRow } = await adminClient
      .from("customers")
      .select("id, email, name")
      .eq("id", customer_id)
      .maybeSingle();

    if (!customerRow) {
      return jsonResponse({ error: "customer_id not found" }, 404);
    }

    const customerEmail = (customerRow.email || "").trim().toLowerCase();
    const requestedTo = to.trim().toLowerCase();
    if (!customerEmail) {
      return jsonResponse({ error: "Customer has no email on file" }, 400);
    }
    if (customerEmail !== requestedTo) {
      return jsonResponse(
        { error: "Recipient does not match customer email on file" },
        403,
      );
    }

    // 6. Driver per-resource auth (only relevant when role='driver')
    if (role === "driver") {
      if (resource_type !== "delivery" || !resource_id) {
        return jsonResponse(
          { error: "Drivers must supply resource_type='delivery' and resource_id" },
          400,
        );
      }
      const { data: deliveryRow } = await adminClient
        .from("deliveries")
        .select("id, assigned_driver, customer_id, status")
        .eq("id", resource_id)
        .maybeSingle();

      if (!deliveryRow) {
        return jsonResponse({ error: "Delivery not found" }, 404);
      }
      if (deliveryRow.assigned_driver !== caller.id) {
        return jsonResponse(
          { error: "Driver is not assigned to this delivery" },
          403,
        );
      }
      if (deliveryRow.customer_id !== customer_id) {
        return jsonResponse(
          { error: "Delivery customer does not match customer_id" },
          400,
        );
      }
    }

    // 7. Attachment limits
    if (attachments && Array.isArray(attachments)) {
      if (attachments.length > MAX_ATTACHMENTS) {
        return jsonResponse(
          { error: `Too many attachments (max ${MAX_ATTACHMENTS})` },
          400,
        );
      }
      let totalBytes = 0;
      for (const att of attachments) {
        if (!att?.filename || typeof att.content !== "string") {
          return jsonResponse(
            { error: "Each attachment must have filename + base64 content" },
            400,
          );
        }
        totalBytes += decodedBase64Length(att.content);
      }
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        return jsonResponse(
          { error: `Attachments exceed ${MAX_TOTAL_ATTACHMENT_BYTES} byte cap` },
          400,
        );
      }
    }

    // 8. Rate limit — count this caller's email_log rows in the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentCount } = await adminClient
      .from("email_log")
      .select("id", { count: "exact", head: true })
      .eq("created_by", caller.id)
      .gte("created_at", oneHourAgo);

    if ((recentCount ?? 0) >= RATE_LIMIT_PER_HOUR) {
      return jsonResponse(
        {
          error: `Rate limit: ${RATE_LIMIT_PER_HOUR} emails/hour exceeded for this user. Try again later.`,
        },
        429,
      );
    }

    // 9. Idempotency replay
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

    // 10. Resend send
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

    // 11. email_log audit
    const { data: logRow, error: logError } = await adminClient
      .from("email_log")
      .insert({
        customer_id: customer_id,
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
      console.warn("Failed to insert email_log:", logError);
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

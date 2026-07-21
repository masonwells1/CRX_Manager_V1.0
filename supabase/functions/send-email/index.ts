import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { captureEdgeException } from "../_shared/sentry.ts";
import { requireActiveProfile } from "../_shared/auth.ts";
import { corsHeaders, preflightResponse } from "../_shared/cors.ts";

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
  // Field-app parity #40: before-application customer notice. Sendable by
  // admin + sales_rep (it is in ALL_EMAIL_TYPES, which both roles map to below);
  // NOT a driver type. This line is PREPARED but its effect only goes live when
  // this edge function is DEPLOYED — that deploy is GATED for Mason. The local
  // `pre_application_notice` enum value migration is applied to LOCAL only.
  "pre_application_notice",
  // Field-app parity #41: after-application customer notice. Same as the pre
  // notice above — admin + sales_rep only (via ALL_EMAIL_TYPES), NOT a driver
  // type. PREPARED here but its effect only goes live when this edge function is
  // DEPLOYED — that deploy is GATED for Mason. The local `post_application_notice`
  // enum value migration is applied to LOCAL only.
  "post_application_notice",
]);

// What email types each role may send.
//   admin, sales_rep -> all types in ALL_EMAIL_TYPES (incl. pre_application_notice)
//   driver           -> only delivery_completed
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
    return preflightResponse(req);
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

    // 2. Role lookup (Codex audit F1, P1, 2026-05-16): is_active gate enforced.
    // Pass `undefined` for allowedRoles because send-email branches on role via
    // EMAIL_TYPES_BY_ROLE below — we still need a check, but the role membership
    // is enforced by that lookup, not by requireActiveProfile.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const gate = await requireActiveProfile(adminClient, caller.id);
    if ("error" in gate) {
      return jsonResponse({ error: gate.error }, gate.status);
    }
    const role = gate.profile.role;
    if (!EMAIL_TYPES_BY_ROLE[role]) {
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
    // PR-03 fix: column is `farm_name`, not `name`. Surface the error explicitly so
    // future schema drifts don't get silently swallowed by the `!customerRow` 404 path.
    const { data: customerRow, error: customerErr } = await adminClient
      .from("customers")
      .select("id, email, farm_name")
      .eq("id", customer_id)
      .maybeSingle();

    if (customerErr) {
      console.warn("send-email: customers lookup failed", {
        customer_id,
        code: customerErr.code,
        message: customerErr.message,
      });
      return jsonResponse(
        { error: `Customer lookup failed: ${customerErr.message}` },
        500,
      );
    }

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

    // Invoice sends are gated again inside the server boundary. The browser also
    // checks immediately before calling us for fast feedback, but that check can
    // be bypassed or race with a status change. Never trust it as the authority.
    if (email_type === "invoice" && (resource_type !== "invoice" || !resource_id)) {
      return jsonResponse(
        { error: "Invoice emails require resource_type='invoice' and resource_id" },
        400,
      );
    }
    let invoiceGateId = resource_type === "invoice" ? resource_id : null;

    // Proof notices can originate on JobDetail before billing or from an invoice
    // after billing. Do not trust the caller to say which. The notification RPC's
    // server-created idempotency key binds the send to its job/customer; if that
    // job has invoices, derive the correct child (or sole legacy un-split invoice)
    // and enforce its disposition. If billing has not happened, no invoice gate
    // exists yet and the ordinary post-application notice remains sendable.
    if (email_type === "post_application_notice") {
      if (!idempotency_key) {
        return jsonResponse({ error: "Post-application notices require an idempotency key" }, 400);
      }
      const { data: notificationRow, error: notificationErr } = await adminClient
        .from("job_notifications")
        .select("job_id, customer_id")
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();
      if (notificationErr) {
        return jsonResponse({ error: `Notification lookup failed: ${notificationErr.message}` }, 500);
      }
      if (!notificationRow || notificationRow.customer_id !== customer_id) {
        return jsonResponse({ error: "Notification key does not match this customer" }, 403);
      }
      const { data: jobInvoices, error: jobInvoicesErr } = await adminClient
        .from("invoices")
        .select("id, customer_id")
        .eq("job_id", notificationRow.job_id);
      if (jobInvoicesErr) {
        return jsonResponse({ error: `Invoice gate lookup failed: ${jobInvoicesErr.message}` }, 500);
      }
      const matchingInvoices = (jobInvoices ?? []).filter((invoice) => invoice.customer_id === customer_id);
      if (matchingInvoices.length > 1) {
        return jsonResponse({ error: "Multiple invoices match this proof-notice recipient" }, 409);
      }
      const derivedInvoice = matchingInvoices[0] ?? (jobInvoices?.length === 1 ? jobInvoices[0] : null);
      if ((jobInvoices?.length ?? 0) > 0 && !derivedInvoice) {
        return jsonResponse({ error: "Could not resolve the recipient invoice send gate" }, 409);
      }
      if (
        derivedInvoice &&
        resource_type === "invoice" &&
        resource_id !== derivedInvoice.id
      ) {
        return jsonResponse({ error: "Invoice resource does not match the server-derived notification invoice" }, 400);
      }
      invoiceGateId = derivedInvoice?.id ?? null;
    }

    if (invoiceGateId) {
      const primaryInvoiceLookup = await adminClient
        .from("invoices")
        .select("id, customer_id, send_disposition, status, deleted_at")
        .eq("id", invoiceGateId)
        .maybeSingle();
      let invoiceRow = primaryInvoiceLookup.data as {
        id: string;
        customer_id: string;
        send_disposition?: string;
        status: string;
        deleted_at: string | null;
      } | null;
      let invoiceErr = primaryInvoiceLookup.error;
      const preMigrationMissingDisposition =
        !!invoiceErr && (invoiceErr.code === "42703" || invoiceErr.code === "PGRST204");
      if (preMigrationMissingDisposition) {
        // Compatibility for an edge-first rollout: lifecycle/customer checks still
        // run, while the later invoice-only gate permits only this exact missing-
        // column condition. No suppressed split children can exist before schema.
        const fallbackLookup = await adminClient
          .from("invoices")
          .select("id, customer_id, status, deleted_at")
          .eq("id", invoiceGateId)
          .maybeSingle();
        invoiceRow = fallbackLookup.data as typeof invoiceRow;
        invoiceErr = fallbackLookup.error;
      }
      if (invoiceErr) {
        return jsonResponse({ error: `Invoice send-status lookup failed: ${invoiceErr.message}` }, 500);
      }
      if (!invoiceRow) {
        return jsonResponse({ error: "Invoice not found" }, 404);
      }
      if (invoiceRow.deleted_at != null || invoiceRow.status === "voided" || invoiceRow.status === "cancelled") {
        return jsonResponse({ error: "A voided, cancelled, or deleted invoice must not be emailed" }, 409);
      }
      if (email_type === "invoice" && invoiceRow.customer_id !== customer_id) {
        return jsonResponse({ error: "Invoice customer does not match customer_id" }, 400);
      }
      if (invoiceRow.send_disposition != null && invoiceRow.send_disposition !== "normal" && invoiceRow.send_disposition !== "sendable") {
        return jsonResponse(
          { error: invoiceRow.send_disposition === "suppressed_zero_total"
              ? "This $0 split invoice is suppressed and must not be emailed"
              : "Invoice send status is unavailable" },
          409,
        );
      }
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

    // 6b. Zero-invoice suppression (Codex r4 P1 / r5 P1+P1). A $0 per-line split child invoice is
    // marked send_disposition='suppressed_zero_total' by the split writer and must NEVER be emailed.
    // The client helper isInvoiceEmailSuppressed() gates the UI, but a direct call could bypass it —
    // enforce server-side. (r5) An invoice email MUST carry a real invoice resource so the check
    // can't be skipped by omitting/falsifying resource_*; and the lookup FAILS CLOSED on any error
    // except the pre-migration missing-column case (no suppressed invoices exist then).
    if (email_type === "invoice") {
      if (resource_type !== "invoice" || !resource_id) {
        return jsonResponse(
          { error: "Invoice emails require resource_type='invoice' and a resource_id" },
          400,
        );
      }
      const { data: invRow, error: invErr } = await adminClient
        .from("invoices")
        .select("id, send_disposition, customer_id")
        .eq("id", resource_id)
        .maybeSingle();
      // Pre-migration only: the send_disposition column doesn't exist yet — Postgres 42703
      // (undefined_column) or PostgREST PGRST204 (schema-cache miss). No suppressed invoices
      // exist then, so it's safe to fall through. EVERY other error fails closed.
      const preMigrationMissingColumn =
        !!invErr && (invErr.code === "42703" || invErr.code === "PGRST204");
      if (invErr && !preMigrationMissingColumn) {
        console.error("send-email: invoice suppression lookup failed — refusing send", {
          resource_id,
          code: invErr.code,
          message: invErr.message,
        });
        return jsonResponse(
          { error: "Could not verify invoice email eligibility; send refused" },
          503,
        );
      }
      if (invErr) {
        console.warn(
          "send-email: send_disposition column absent (pre-migration) — suppression check skipped",
          { resource_id, code: invErr.code },
        );
      } else if (!invRow) {
        return jsonResponse({ error: "Invoice resource_id not found" }, 404);
      } else {
        if (invRow.customer_id && invRow.customer_id !== customer_id) {
          return jsonResponse({ error: "Invoice does not belong to customer_id" }, 400);
        }
        if (invRow.send_disposition === "suppressed_zero_total") {
          return jsonResponse(
            {
              error:
                "This $0 split invoice is recorded but not emailable (send_disposition=suppressed_zero_total)",
            },
            409,
          );
        }
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

    // 9. Idempotency replay — return cached success if we've already sent
    //    successfully under this key.
    let emailLogId: string | null = null;

    if (idempotency_key) {
      const { data: existing } = await adminClient
        .from("email_log")
        .select("id, resend_message_id, status")
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();

      if (existing && existing.status === "sent") {
        // Already successfully sent — return cached success.
        return jsonResponse({
          success: true,
          email_log_id: existing.id,
          resend_message_id: existing.resend_message_id,
          deduplicated: true,
        });
      }

      // Codex P2 fix (PR #59, 2026-05-16 review of e5de0f2): refuse to re-send
      // when an existing row for this idempotency_key is still 'pending'. The
      // prior attempt may have already reached Resend and succeeded — only the
      // post-send DB update failed. A re-send here would duplicate the
      // customer email. Operator reconciles by inspecting Resend dashboard
      // and updating the email_log row to 'sent' (replay deduplicates) or
      // 'failed' (replay retries) before the same key can be reused.
      if (existing && existing.status === "pending") {
        return jsonResponse({
          success: false,
          error:
            "Previous attempt with this idempotency_key is still pending. " +
            "The email may already have been sent. Check Resend dashboard, " +
            "then update email_log row to 'sent' (treat as deduplicated) or " +
            "'failed' (allow retry) before reusing this key.",
          email_log_id: existing.id,
          needs_reconciliation: true,
        }, 409);
      }

      // If existing failed row: reuse its id, update to pending below, and
      // overwrite the result after the next send attempt.
      if (existing) emailLogId = existing.id;
    }

    // 10. Write-ahead log (2026-05-16 ultra-review P2 #5): insert/update the
    //     email_log row to status='pending' BEFORE calling Resend. If this
    //     write fails, we DON'T send — otherwise the customer could receive
    //     an email with no audit record and no idempotency replay marker.
    if (emailLogId) {
      // Existing pending/failed row from a prior interrupted attempt — reset
      // it to pending. Don't update content fields (preserve original intent).
      const { error: updateErr } = await adminClient
        .from("email_log")
        .update({
          status: "pending",
          resend_message_id: null,
          error_message: null,
        })
        .eq("id", emailLogId);
      if (updateErr) {
        await captureEdgeException(
          new Error(`email_log pre-send reset failed: ${updateErr.message}`),
          {
            function: "send-email",
            level: "error",
            tags: { email_type, phase: "pre-send-log-reset" },
            extra: { customer_id, idempotency_key, email_log_id: emailLogId },
            user: { id: caller.id },
          },
        );
        return jsonResponse(
          { error: `Email pre-flight log reset failed: ${updateErr.message}` },
          500,
        );
      }
    } else {
      // Fresh send — insert new pending row.
      const { data: newRow, error: insertErr } = await adminClient
        .from("email_log")
        .insert({
          customer_id: customer_id,
          recipient_email: to,
          email_type,
          subject,
          html_body: html,
          attachment_name: attachments?.[0]?.filename || null,
          resend_message_id: null,
          status: "pending",
          error_message: null,
          idempotency_key: idempotency_key || null,
          created_by: caller.id,
        })
        .select("id")
        .single();
      if (insertErr || !newRow) {
        await captureEdgeException(
          new Error(`email_log pre-send insert failed: ${insertErr?.message || 'no row returned'}`),
          {
            function: "send-email",
            level: "error",
            tags: { email_type, phase: "pre-send-log-insert" },
            extra: { customer_id, idempotency_key },
            user: { id: caller.id },
          },
        );
        return jsonResponse(
          { error: `Email pre-flight log insert failed: ${insertErr?.message || 'unknown'}` },
          500,
        );
      }
      emailLogId = newRow.id;
    }

    // 11. Resend send
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const fromEmail = Deno.env.get("FROM_EMAIL") || "noreply@croprxsolutions.app";

    if (!resendApiKey) {
      // RESEND_API_KEY missing — mark the pending row as failed so the audit
      // trail reflects reality.
      await adminClient
        .from("email_log")
        .update({ status: "failed", error_message: "RESEND_API_KEY not configured" })
        .eq("id", emailLogId);
      return jsonResponse({ error: "RESEND_API_KEY not configured", email_log_id: emailLogId }, 500);
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

    // Re-read the authoritative invoice state at the last possible boundary.
    // The earlier gate protects all pre-send work, but another session can
    // void/cancel/delete/suppress an invoice while attachments, rate limits,
    // idempotency, and the write-ahead log are being processed. Fail closed
    // here before making the irreversible outbound request.
    if (invoiceGateId) {
      const finalGateLookup = await adminClient
        .from("invoices")
        .select("id, customer_id, send_disposition, status, deleted_at")
        .eq("id", invoiceGateId)
        .maybeSingle();
      let finalInvoiceRow = finalGateLookup.data as {
        id: string;
        customer_id: string;
        send_disposition?: string;
        status: string;
        deleted_at: string | null;
      } | null;
      let finalGateError = finalGateLookup.error;
      const finalGatePreMigrationFallback =
        !!finalGateError && (finalGateError.code === "42703" || finalGateError.code === "PGRST204");
      if (finalGatePreMigrationFallback) {
        const fallbackLookup = await adminClient
          .from("invoices")
          .select("id, customer_id, status, deleted_at")
          .eq("id", invoiceGateId)
          .maybeSingle();
        finalInvoiceRow = fallbackLookup.data as typeof finalInvoiceRow;
        finalGateError = fallbackLookup.error;
      }

      let finalGateRefusal: string | null = null;
      if (finalGateError) {
        finalGateRefusal = `Final invoice eligibility lookup failed: ${finalGateError.message}`;
      } else if (!finalInvoiceRow) {
        finalGateRefusal = "Invoice no longer exists";
      } else if (
        finalInvoiceRow.deleted_at != null ||
        finalInvoiceRow.status === "voided" ||
        finalInvoiceRow.status === "cancelled"
      ) {
        finalGateRefusal = "Invoice became voided, cancelled, or deleted before send";
      } else if (email_type === "invoice" && finalInvoiceRow.customer_id !== customer_id) {
        finalGateRefusal = "Invoice customer changed before send";
      } else if (
        finalInvoiceRow.send_disposition != null &&
        finalInvoiceRow.send_disposition !== "normal" &&
        finalInvoiceRow.send_disposition !== "sendable"
      ) {
        finalGateRefusal = "Invoice became suppressed or unavailable before send";
      }

      if (finalGateRefusal) {
        await adminClient
          .from("email_log")
          .update({ status: "failed", error_message: finalGateRefusal })
          .eq("id", emailLogId);
        return jsonResponse(
          { error: `${finalGateRefusal}; email send refused`, email_log_id: emailLogId },
          finalGateError ? 503 : 409,
        );
      }
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

    // 12. Update the pending row to sent/failed. Even if this update fails,
    //     the pending row exists for idempotency replay — durability is
    //     already achieved.
    const { error: postUpdateErr } = await adminClient
      .from("email_log")
      .update({
        resend_message_id: resendMessageId,
        status: success ? "sent" : "failed",
        error_message: errorMessage,
      })
      .eq("id", emailLogId);

    if (postUpdateErr) {
      console.warn("[email_log] post-send update failed:", postUpdateErr);
      await captureEdgeException(postUpdateErr, {
        function: "send-email",
        level: "warning",
        tags: { email_type, phase: "post-send-log-update" },
        extra: { customer_id, email_log_id: emailLogId, resend_message_id: resendMessageId, send_succeeded: success },
        user: { id: caller.id },
      });
    }

    if (!success) {
      // Sprint F #7 — alert on Resend send failures (high-impact: customer
      // didn't get the email they expected).
      await captureEdgeException(new Error(errorMessage || "Resend send failed"), {
        function: "send-email",
        level: "error",
        tags: { email_type, status_code: String(resendResp.status) },
        extra: { customer_id, email_log_id: emailLogId, resend_message_id: resendMessageId },
        user: { id: caller.id },
      });
      return jsonResponse({
        success: false,
        error: errorMessage,
        email_log_id: emailLogId,
      }, 502);
    }

    return jsonResponse({
      success: true,
      email_log_id: emailLogId,
      resend_message_id: resendMessageId,
    });
  } catch (err) {
    await captureEdgeException(err, {
      function: "send-email",
      level: "fatal",
    });
    return jsonResponse(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});

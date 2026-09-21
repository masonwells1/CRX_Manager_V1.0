import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { requireActiveProfile } from "../_shared/auth.ts";
import { captureEdgeException } from "../_shared/sentry.ts";
import { corsHeaders, preflightResponse } from "../_shared/cors.ts";
import {
  buildStoragePath,
  canAccessCustomerDocuments,
  DOCUMENT_BUCKET,
  isServerIssuedPath,
  parseDocumentFileRequest,
} from "./logic.ts";

// The server-controlled byte boundary for customer documents (PR #635 P1).
// Browser users hold no Storage policy on the bucket, so they cannot mint a
// signed download URL that would outlive a soft delete. Every download
// re-reads the metadata row here; uploads use a single-path upload token that
// grants no read access.

const MAX_REQUEST_BODY_BYTES = 4_096;

class RequestBodyTooLargeError extends Error {}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function readRequestText(req: Request): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  return text;
}

// storage-js 2.57 reports a missing object as a StorageUnknownError whose
// message is "{}"; Storage's own answer ({"statusCode":"404","error":"not_found"})
// is only in the original HTTP response. Only error "not_found" counts: a
// missing or renamed BUCKET also answers statusCode 404 ("Bucket not found")
// and must surface as a real failure, not a missing file.
async function isObjectNotFound(error: unknown): Promise<boolean> {
  const candidate = error as { originalError?: unknown } | null;
  if (!(candidate?.originalError instanceof Response)) return false;
  try {
    const body = await candidate.originalError.clone().json() as { error?: unknown };
    return body?.error === "not_found";
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return preflightResponse(req);
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  let phase = "authentication";
  let callerId: string | undefined;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization." }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    if (!caller) {
      return jsonResponse({ error: "Invalid token." }, 401);
    }
    callerId = caller.id;

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const profileGateClient = adminClient as unknown as Parameters<
      typeof requireActiveProfile
    >[0];
    const gate = await requireActiveProfile(profileGateClient, caller.id, [
      "admin",
      "sales_rep",
    ]);
    if ("error" in gate) {
      return jsonResponse({ error: gate.error }, gate.status);
    }
    const role = gate.profile.role;

    // False when the customer does not exist or the caller may not reach it,
    // so both cases answer the same way and leak nothing about other customers.
    const authorizeCustomer = async (customerId: string): Promise<boolean> => {
      const { data, error } = await adminClient
        .from("customers")
        .select("id, assigned_sales_rep")
        .eq("id", customerId)
        .maybeSingle();
      if (error) throw new Error(`Customer lookup failed: ${error.message}`);
      if (!data) return false;
      const customer = data as { id: string; assigned_sales_rep: string | null };
      return canAccessCustomerDocuments(role, caller.id, customer.assigned_sales_rep);
    };

    phase = "request-body";
    let body: unknown;
    try {
      body = JSON.parse(await readRequestText(req));
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) throw error;
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }
    const parsed = parseDocumentFileRequest(body);
    if (!parsed.ok) {
      return jsonResponse({ error: parsed.error }, 400);
    }
    const request = parsed.request;
    const bucket = adminClient.storage.from(DOCUMENT_BUCKET);

    if (request.action === "prepare_upload") {
      phase = "prepare-upload";
      if (!await authorizeCustomer(request.customerId)) {
        return jsonResponse({ error: "You cannot add documents for this customer." }, 403);
      }
      const storagePath = buildStoragePath(
        request.customerId,
        crypto.randomUUID(),
        request.filename,
      );
      const { data, error } = await bucket.createSignedUploadUrl(storagePath);
      if (error || !data?.token) {
        throw new Error(`Could not prepare upload: ${error?.message ?? "no token"}`);
      }
      return jsonResponse({ storage_path: storagePath, token: data.token });
    }

    phase = "download";
    const { data: documentRow, error: documentError } = await adminClient
      .from("customer_documents")
      .select("id, customer_id, storage_path, deleted_at")
      .eq("id", request.documentId)
      .maybeSingle();
    if (documentError) throw new Error(`Document lookup failed: ${documentError.message}`);

    const document = documentRow as
      | { id: string; customer_id: string; storage_path: string; deleted_at: string | null }
      | null;
    // A removed document answers exactly like a missing one.
    if (!document || document.deleted_at !== null) {
      return jsonResponse({ error: "This document is no longer available." }, 404);
    }
    if (!await authorizeCustomer(document.customer_id)) {
      return jsonResponse({ error: "This document is no longer available." }, 404);
    }
    if (!isServerIssuedPath(document.storage_path, document.customer_id)) {
      throw new Error("Document storage path is not a server-issued path.");
    }

    const { data: file, error: downloadError } = await bucket.download(document.storage_path);
    if (downloadError || !file) {
      // Only a genuinely missing object is a 404; an outage or misconfiguration
      // must reach Sentry as a 500 rather than masquerade as a missing file.
      if (!downloadError || !await isObjectNotFound(downloadError)) {
        throw new Error(`Document download failed: ${downloadError?.message ?? "no data"}`);
      }
      await captureEdgeException(new Error("Live document row has no stored file."), {
        function: "customer-document-files",
        level: "warning",
        tags: { phase },
        extra: { documentId: document.id },
        user: { id: caller.id },
      });
      return jsonResponse({ error: "The document file could not be found." }, 404);
    }
    return new Response(file, {
      status: 200,
      headers: {
        ...corsHeaders,
        // octet-stream makes the browser client hand back a Blob; the page
        // already knows the real type and name from the metadata row.
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonResponse({ error: "Request body is too large." }, 413);
    }
    await captureEdgeException(error, {
      function: "customer-document-files",
      level: "error",
      tags: { phase },
      user: callerId ? { id: callerId } : undefined,
    });
    return jsonResponse({ error: "Unable to complete the document request." }, 500);
  }
});

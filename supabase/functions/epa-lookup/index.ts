import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { requireActiveProfile } from "../_shared/auth.ts";
import { captureEdgeException } from "../_shared/sentry.ts";
import {
  classifyRegistrationNumber,
  type EpaLookupResult,
  normalizeEpaPayload,
  type RegistrationClassification,
} from "./logic.ts";

const MAX_REQUEST_BODY_BYTES = 4_096;
const MAX_UPSTREAM_RESPONSE_BYTES = 2_000_000;
const EPA_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 15 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;
const MAX_RATE_LIMIT_ENTRIES = 1_000;

const EPA_ORIGIN = "https://ordspub.epa.gov";
const EPA_HOST = "ordspub.epa.gov";
const EPA_LOOKUP_PATH = "/ords/pesticides/cswu/ppls/";

type SupportedRegistration = Extract<
  RegistrationClassification,
  { supported: true }
>;

interface CacheEntry {
  expiresAt: number;
  value: EpaLookupResult;
}

interface RateLimitEntry {
  count: number;
  windowStartedAt: number;
}

const lookupCache = new Map<string, CacheEntry>();
const rateLimits = new Map<string, RateLimitEntry>();

class RequestBodyTooLargeError extends Error {}
class UpstreamResponseError extends Error {}

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

const corsHeaders = {
  "Access-Control-Allow-Origin": getAllowedOrigin(),
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-client-info, x-supabase-api-version, x-request-id",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function contentLengthExceeds(headers: Headers, limit: number): boolean {
  const value = headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return false;
  return Number(value) > limit;
}

async function readBytesWithCap(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  makeError: () => Error,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel();
        throw makeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readRequestBody(req: Request): Promise<string> {
  if (contentLengthExceeds(req.headers, MAX_REQUEST_BODY_BYTES)) {
    throw new RequestBodyTooLargeError();
  }
  const bytes = await readBytesWithCap(
    req.body,
    MAX_REQUEST_BODY_BYTES,
    () => new RequestBodyTooLargeError(),
  );
  return new TextDecoder().decode(bytes);
}

function getCached(regNumber: string, now: number): EpaLookupResult | null {
  const cached = lookupCache.get(regNumber);
  if (!cached) return null;
  if (cached.expiresAt <= now) {
    lookupCache.delete(regNumber);
    return null;
  }
  return cached.value;
}

function setCached(
  regNumber: string,
  value: EpaLookupResult,
  now: number,
): void {
  for (const [key, entry] of lookupCache) {
    if (entry.expiresAt <= now) lookupCache.delete(key);
  }
  if (!lookupCache.has(regNumber) && lookupCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = lookupCache.keys().next().value;
    if (typeof oldestKey === "string") lookupCache.delete(oldestKey);
  }
  lookupCache.set(regNumber, { expiresAt: now + CACHE_TTL_MS, value });
}

function consumeRateLimit(callerId: string, now: number): boolean {
  if (!rateLimits.has(callerId) && rateLimits.size >= MAX_RATE_LIMIT_ENTRIES) {
    for (const [key, entry] of rateLimits) {
      if (now - entry.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
        rateLimits.delete(key);
      }
    }
    if (rateLimits.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = rateLimits.keys().next().value;
      if (typeof oldestKey === "string") rateLimits.delete(oldestKey);
    }
  }

  const current = rateLimits.get(callerId);
  if (!current || now - current.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(callerId, { count: 1, windowStartedAt: now });
    return true;
  }
  if (current.count >= MAX_REQUESTS_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

function clientErrorForClassification(
  classification: RegistrationClassification,
): string {
  if (classification.kind === "sln_24c") {
    return "SLN/24(c) registration numbers are not supported by this lookup.";
  }
  if (classification.kind === "section18") {
    return "Section 18 emergency exemptions are not supported by this lookup.";
  }
  return "Enter an EPA registration number in C-P or C-P-D numeric format.";
}

async function fetchEpaLookup(
  registration: SupportedRegistration,
): Promise<EpaLookupResult> {
  const url = new URL(
    `${EPA_LOOKUP_PATH}${encodeURIComponent(registration.normalized)}`,
    EPA_ORIGIN,
  );
  if (url.protocol !== "https:" || url.hostname !== EPA_HOST) {
    throw new UpstreamResponseError("EPA URL invariant failed");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), EPA_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    throw new UpstreamResponseError(
      error instanceof Error && error.name === "AbortError"
        ? "EPA request timed out"
        : "EPA request failed",
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamResponseError(
      `EPA returned redirect status ${response.status}`,
    );
  }
  if (!response.ok) {
    throw new UpstreamResponseError(`EPA returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]
    .trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new UpstreamResponseError(
      `EPA returned unexpected Content-Type ${contentType ?? "missing"}`,
    );
  }
  if (contentLengthExceeds(response.headers, MAX_UPSTREAM_RESPONSE_BYTES)) {
    throw new UpstreamResponseError("EPA response exceeded the byte limit");
  }

  const bytes = await readBytesWithCap(
    response.body,
    MAX_UPSTREAM_RESPONSE_BYTES,
    () => new UpstreamResponseError("EPA response exceeded the byte limit"),
  );

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch (_error) {
    throw new UpstreamResponseError("EPA returned invalid JSON");
  }

  try {
    return normalizeEpaPayload(
      payload,
      registration.kind,
      registration.normalized,
    );
  } catch (error) {
    throw new UpstreamResponseError(
      error instanceof Error
        ? `EPA response shape was invalid: ${error.message}`
        : "EPA response shape was invalid",
    );
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
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
    // Supabase's query builder is PromiseLike at runtime, while the shared helper's
    // deliberately loose interface declares Promise. Narrow through unknown so this
    // house-style helper remains usable without weakening either module with `any`.
    const profileGateClient = adminClient as unknown as Parameters<
      typeof requireActiveProfile
    >[0];
    const gate = await requireActiveProfile(profileGateClient, caller.id, [
      "admin",
    ]);
    if ("error" in gate) {
      return jsonResponse({ error: gate.error }, gate.status);
    }

    if (!consumeRateLimit(caller.id, Date.now())) {
      return jsonResponse({
        error: "Too many EPA lookup requests. Please try again shortly.",
      }, 429);
    }

    phase = "request-body";
    const requestText = await readRequestBody(req);
    let body: unknown;
    try {
      body = JSON.parse(requestText);
    } catch (_error) {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonResponse(
        { error: "Request body must be a JSON object." },
        400,
      );
    }
    const requestBody = body as Record<string, unknown>;
    if (Object.keys(requestBody).some((key) => key !== "regNumber")) {
      return jsonResponse(
        { error: "Request contains unsupported fields." },
        400,
      );
    }

    phase = "registration-classification";
    const classification = classifyRegistrationNumber(requestBody.regNumber);
    if (!classification.supported) {
      return jsonResponse({
        error: clientErrorForClassification(classification),
      }, 400);
    }

    const now = Date.now();
    const cached = getCached(classification.normalized, now);
    if (cached) return jsonResponse(cached);

    phase = "epa-fetch";
    const result = await fetchEpaLookup(classification);
    setCached(classification.normalized, result, now);
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonResponse({ error: "Request body is too large." }, 413);
    }

    await captureEdgeException(error, {
      function: "epa-lookup",
      level: "error",
      tags: { phase },
      user: callerId ? { id: callerId } : undefined,
    });

    if (error instanceof UpstreamResponseError) {
      return jsonResponse(
        { error: "EPA lookup is temporarily unavailable." },
        502,
      );
    }
    return jsonResponse({ error: "Unable to complete EPA lookup." }, 500);
  }
});

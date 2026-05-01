// =============================================================================
// Edge Function Sentry helper — Sprint F #7
//
// Small helper that posts events to Sentry's HTTP store endpoint without
// pulling in a Node-only SDK. Safe to import from any Deno-hosted Edge
// Function. If SENTRY_DSN is not set, every call is a no-op so dev/test
// environments never accidentally hit production Sentry.
//
// Usage:
//   import { captureEdgeException } from "../_shared/sentry.ts";
//   try { ... } catch (err) {
//     await captureEdgeException(err, {
//       function: "send-email",
//       extra: { email_type, customer_id },
//     });
//     throw err; // or return error response
//   }
//
// Set SENTRY_DSN as a Supabase Function secret to enable.
// =============================================================================

interface CaptureContext {
  function: string;
  level?: "fatal" | "error" | "warning" | "info";
  extra?: Record<string, unknown>;
  tags?: Record<string, string>;
  user?: { id?: string; email?: string };
}

interface ParsedDsn {
  host: string;
  projectId: string;
  publicKey: string;
}

function parseSentryDsn(dsn: string): ParsedDsn | null {
  // DSN format: https://<publicKey>@<host>/<projectId>
  const match = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)$/);
  if (!match) return null;
  return { publicKey: match[1], host: match[2], projectId: match[3] };
}

/**
 * Send an exception to Sentry. Resolves to true if sent, false on failure
 * or when no DSN is configured. Never throws — Sentry is observability,
 * not a user-facing dependency.
 */
export async function captureEdgeException(
  err: unknown,
  context: CaptureContext,
): Promise<boolean> {
  const dsn = Deno.env.get("SENTRY_DSN");
  if (!dsn) return false;

  const parsed = parseSentryDsn(dsn);
  if (!parsed) {
    console.warn("Invalid SENTRY_DSN — Sentry alerting disabled");
    return false;
  }

  const error = err instanceof Error ? err : new Error(String(err));
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const timestamp = new Date().toISOString();

  const payload = {
    event_id: eventId,
    timestamp,
    platform: "javascript",
    level: context.level ?? "error",
    server_name: `edge-function:${context.function}`,
    environment: Deno.env.get("SENTRY_ENVIRONMENT") || "production",
    release: Deno.env.get("SENTRY_RELEASE") || undefined,
    tags: {
      edge_function: context.function,
      ...(context.tags ?? {}),
    },
    user: context.user ?? undefined,
    extra: context.extra ?? undefined,
    exception: {
      values: [
        {
          type: error.name,
          value: error.message,
          stacktrace: error.stack
            ? {
              frames: error.stack
                .split("\n")
                .slice(1)
                .map((line) => ({ filename: line.trim() }))
                .reverse(),
            }
            : undefined,
        },
      ],
    },
  };

  try {
    const url =
      `https://${parsed.host}/api/${parsed.projectId}/store/?sentry_version=7&sentry_key=${parsed.publicKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (sentryErr) {
    console.warn("Sentry capture failed:", sentryErr);
    return false;
  }
}

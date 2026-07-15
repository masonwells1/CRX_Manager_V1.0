// =============================================================================
// Edge Function auth helper — Codex audit Finding 1 (P1, 2026-05-16)
//
// Every JWT-gated Edge Function previously looked up the caller's profile and
// checked only `role`. The frontend (`ProtectedRoute.tsx:33-36`) ALSO blocks
// `!profile.is_active`, but Edge Functions did not — meaning a deactivated
// employee with a still-valid JWT (refresh tokens persist for days by default)
// could continue to call `create-user`, `send-email`, `reset-user-password`,
// `setup-blend-tickets-storage`, `process-blend-ticket`, `process-document`.
//
// This helper centralizes the lookup so every Edge Function gets the same
// (role + is_active) gate from a single source of truth.
//
// Usage:
//   import { requireActiveProfile } from "../_shared/auth.ts";
//
//   const gate = await requireActiveProfile(adminClient, caller.id, ["admin"]);
//   if ("error" in gate) {
//     return jsonResponse({ error: gate.error }, gate.status);
//   }
//   const callerProfile = gate.profile; // { role, is_active: true }
//
// Pass `allowedRoles = undefined` to permit any active profile regardless of
// role (rare — only for functions that branch on role internally, like
// send-email which inspects EMAIL_TYPES_BY_ROLE after the gate).
// =============================================================================

export interface ActiveProfile {
  role: string;
  is_active: boolean;
}

interface ProfileGateOk {
  profile: ActiveProfile;
}

interface ProfileGateErr {
  error: string;
  status: number;
}

export type ProfileGateResult = ProfileGateOk | ProfileGateErr;

// Loose type so we don't have to import SupabaseClient generics in every Edge Function.
// The shape is: `client.from('profiles').select('role, is_active').eq('id', id).maybeSingle()`.
interface SupabaseLike {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        // PostgrestBuilder is awaitable (PromiseLike), but intentionally does
        // not implement the full Promise surface such as catch/finally.
        maybeSingle: () => PromiseLike<{
          data: ActiveProfile | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
}

export async function requireActiveProfile(
  // Accept unknown at the boundary so Deno does not recursively instantiate
  // SupabaseClient's full generated schema just to prove this tiny query shape.
  adminClient: unknown,
  callerId: string,
  allowedRoles?: readonly string[],
): Promise<ProfileGateResult> {
  const client = adminClient as SupabaseLike;
  const { data, error } = await client
    .from("profiles")
    .select("role, is_active")
    .eq("id", callerId)
    .maybeSingle();

  if (error) {
    // Lookup itself failed — fail closed.
    return { error: "Profile lookup failed", status: 500 };
  }
  if (!data) {
    return { error: "Profile not found", status: 403 };
  }
  if (!data.is_active) {
    // Match frontend ProtectedRoute behavior: deactivated == forbidden, not 401.
    // Caller's JWT is still cryptographically valid; the account is just disabled.
    return { error: "Account is deactivated", status: 403 };
  }
  if (allowedRoles && !allowedRoles.includes(data.role)) {
    return { error: "Forbidden", status: 403 };
  }
  return { profile: data };
}

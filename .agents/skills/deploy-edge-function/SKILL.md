---
name: deploy-edge-function
description: Deploy a Supabase Edge Function to live via the Supabase MCP with pre-flight checks, version verification, and a post-deploy smoke test. Use when the user wants to deploy or update one of the Edge Functions in supabase/functions/ (currently create-user, epa-lookup, process-blend-ticket, process-document, reset-user-password, send-email, setup-blend-tickets-storage — the directory listing is authoritative). Catches the B8 class of bug — guard added to the wrong function, frontend caller routes elsewhere.
---

# Deploy Edge Function

Wraps the Supabase MCP `deploy_edge_function` workflow with the safety checks Mason wants before every live deploy.

## Step 0: Identify the Target

Ask the user which function to deploy, or infer from recent Edits. Confirm:

- Function name (must match a directory under `supabase/functions/`)
- The change being deployed (one-line description)
- The expected new version number (current + 1)

If unsure of the current version, check via Supabase MCP:

```
mcp__50e15046-cf2c-49da-b8df-ceef27768f63__get_edge_function
  project_id: rhyzpcqhnizqbxphqdkr
  function_slug: <name>
```

## Step 1: Pre-Flight Checks (BLOCKING)

Before deploying, verify ALL of the following. If any fails, STOP and report to user.

### 1a. CORS hardening present
Read `supabase/functions/<name>/index.ts`. The file MUST:
- Import or define CORS headers that read from `ALLOWED_ORIGIN` env var (not `*`)
- Handle OPTIONS preflight

If missing: refuse to deploy and tell the user what to add.

### 1b. Frontend caller verification (B8 protection)
Search `src/` for callers of this function. Specifically:

```bash
grep -rn "supabase.functions.invoke.*<name>" src/ || true
grep -rn "/functions/v1/<name>" src/ || true
```

If there are NO callers, ask: "This function has no frontend callers. Is it a webhook/cron target? If not, are you sure you want to deploy?"

If there ARE callers, list them. For each caller, verify the action/query-param the caller uses matches what the new function bundle handles. The B8 incident was: UI routed to `create-user?action=reset_password` but the new guard was added to `reset-user-password` instead — the new code was dead.

### 1c. Sentry import shape (audit #28 hardening)
The function should import Sentry from `_shared/sentry.ts`, not directly from `@sentry/deno` or `@sentry/node`. Confirm or report.

### 1d. Env vars present
List the required env vars by grepping for `Deno.env.get(`. Tell the user which ones must be set in Supabase dashboard (you can't read them from here).

## Step 2: Bundle Read

Read the full function body so the deploy payload is exactly what's on disk:

```
Read supabase/functions/<name>/index.ts
Read supabase/functions/<name>/<any-helper>.ts (if present)
Read supabase/functions/_shared/<any-imported-file>.ts (if imported)
```

For functions over ~40KB, you may need to use Bash + node to JSON-encode the file content (the technique used for `process-blend-ticket` v17 — see CLAUDE.md 2026-05-16 PM note).

## Step 3: Get User Confirmation

Print a summary and WAIT for user approval before deploying:

```
═══ DEPLOY EDGE FUNCTION ═══
Function:    <name>
Project:     rhyzpcqhnizqbxphqdkr
Current:     v<N>
New:         v<N+1>
Change:      <one-line description>

Pre-flight:
  CORS:           PASS (ALLOWED_ORIGIN read at line <X>)
  Callers found:  <count> in src/
  Caller match:   PASS / CONCERN: <details>
  Sentry shape:   PASS (imports _shared/sentry.ts)
  Env vars used:  <list>

Files included:
  - supabase/functions/<name>/index.ts (<lines>)
  - supabase/functions/_shared/<helper>.ts (if any)

Type 'deploy' to proceed, anything else to abort.
```

ONLY proceed if the user types `deploy` (or yes/y).

## Step 4: Deploy

Call:

```
mcp__50e15046-cf2c-49da-b8df-ceef27768f63__deploy_edge_function
  project_id: rhyzpcqhnizqbxphqdkr
  name: <function name>
  files: [{ name: "index.ts", content: "<full content>" }, ...]
  entrypoint_path: "index.ts"
```

Capture the returned version number.

## Step 5: Post-Deploy Verification

### 5a. Confirm new version is ACTIVE

```
mcp__50e15046-cf2c-49da-b8df-ceef27768f63__get_edge_function
  project_id: rhyzpcqhnizqbxphqdkr
  function_slug: <name>
```

Verify `version` field matches what was deployed and status is `ACTIVE`.

### 5b. Smoke test (caller-dependent)

If the function is HTTP-callable from frontend, suggest the user manually trigger one call in the live app and watch the network tab. You cannot do this — only the user can sign in to the live UI.

If the function is a webhook target (e.g., `process-blend-ticket` from Storage trigger), tell the user how to verify (e.g., "drop a test PDF into the blend-tickets bucket and watch `mcp__...__get_logs` for the new invocation").

### 5c. Recent logs check

```
mcp__50e15046-cf2c-49da-b8df-ceef27768f63__get_logs
  project_id: rhyzpcqhnizqbxphqdkr
  service: edge-function
```

Scan for any error events from the new version in the last 5 minutes.

## Step 6: Update CLAUDE.md "Current State"

Add or update the line in CLAUDE.md's "Current State" section that names the version, e.g.:

```
- **2026-MM-DD:** `<name>` Edge Function deployed to v<N+1> (<one-line change>); verified ACTIVE via MCP.
```

Do NOT commit — let Mason commit when he's ready.

## Step 7: Print Summary

```
═══ DEPLOY COMPLETE ═══
Function:    <name>
Version:     v<N> → v<N+1>  (ACTIVE)
Logs:        <clean / N errors in last 5min>

CLAUDE.md updated.
Manual smoke test recommended in live UI.
```

## Hard Rules

- NEVER deploy without the pre-flight checks passing.
- NEVER deploy without explicit user confirmation in Step 3.
- NEVER skip the post-deploy verification — the B7/B8 incidents happened because nobody re-read the live state.
- NEVER auto-commit. Mason commits.
- If `get_edge_function` shows the version did NOT bump, alert the user loudly — the deploy silently failed.

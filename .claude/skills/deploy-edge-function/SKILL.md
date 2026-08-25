---
name: deploy-edge-function
description: Deploy a Supabase Edge Function to live via the Supabase MCP with pre-flight checks, version verification, and a post-deploy smoke test. Use when the user wants to deploy or update one of the Edge Functions in supabase/functions/ (currently create-user, epa-lookup, process-blend-ticket, process-document, reset-user-password, send-email, setup-blend-tickets-storage — the directory listing is authoritative). Catches the B8 class of bug — guard added to the wrong function, frontend caller routes elsewhere.
---

# Deploy Edge Function

Wraps the Supabase MCP `deploy_edge_function` workflow with the safety checks Mason wants before every live deploy.

**Tool names:** the Supabase connector's tools are prefixed with a per-install UUID
(`mcp__<uuid>__deploy_edge_function`). That UUID is not stable across machines or reinstalls, so
this skill writes tool names as `mcp__<supabase>__<tool>`. Resolve the real prefix by matching the
**name suffix** (`deploy_edge_function`, `get_edge_function`, `query_logs`) in the available tool
list at run time. If no Supabase tool is present, the connector is not connected — STOP and say
so. Never deploy by another route.

## Step 0: Identify the Target

Ask the user which function to deploy, or infer from recent Edits. Confirm:

- Function name (must match a directory under `supabase/functions/`)
- The change being deployed (one-line description)
- The expected new version number (current + 1)

If unsure of the current version, check via Supabase MCP:

```
mcp__<supabase>__get_edge_function
  function_slug: <name>
```

## Step 1: Pre-Flight Checks (BLOCKING)

Before deploying, verify ALL of the following. If any fails, STOP and report to user.

### 1a. CORS hardening present
Read `supabase/functions/<name>/index.ts`. Every current function gets CORS from the shared
helper, and that is the shape to require:

```ts
import { corsHeaders, preflightResponse } from "../_shared/cors.ts";
```

`_shared/cors.ts` is the only place that reads `ALLOWED_ORIGIN` — do **not** expect
`Deno.env.get('ALLOWED_ORIGIN')` inside the function's own `index.ts`; none of the seven have it,
so a literal grep for it there fails on correct code. Verify instead that:

- the function imports `corsHeaders` / `preflightResponse` from `../_shared/cors.ts` (not a
  hand-rolled header object, and never a wildcard `Access-Control-Allow-Origin`), and
- it handles the OPTIONS preflight via `preflightResponse`.

If the function hand-rolls CORS or wildcards the origin: refuse to deploy and say what to change.
A function with genuinely no browser caller (pure webhook/cron target) may not need CORS at all —
say that explicitly rather than reporting a false FAIL.

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

Every `_shared/*` file the function imports must be included in the deploy payload — the deployed
bundle has no access to files you did not send. All seven current functions import
`../_shared/cors.ts`, and most also import `../_shared/sentry.ts`. Missing one produces a function
that deploys cleanly and then fails at runtime on its first request.

For functions over ~40KB, you may need to use Bash + node to JSON-encode the file content (the
technique used for `process-blend-ticket` v17).

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
  CORS:           PASS (imports _shared/cors.ts; preflight handled)
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
mcp__<supabase>__deploy_edge_function
  name: <function name>
  files: [
    { name: "index.ts", content: "<full content>" },
    { name: "../_shared/cors.ts", content: "<full content>" },
    ...every other imported _shared file
  ]
  entrypoint_path: "index.ts"
```

Include every imported `_shared` file, using the same relative path the import uses. Capture the
returned version number.

## Step 5: Post-Deploy Verification

### 5a. Confirm new version is ACTIVE

```
mcp__<supabase>__get_edge_function
  function_slug: <name>
```

Verify `version` field matches what was deployed and status is `ACTIVE`.

### 5b. Smoke test (caller-dependent) — REQUIRED before calling the deploy proven

A version bump proves the upload landed. It does **not** prove the new code runs, and it does not
prove the caller reaches it — that was exactly the B8 failure. Someone has to exercise the real
caller path:

- HTTP-callable from the frontend: Mason triggers one call in the live app and watches the
  network tab. You cannot do this — only he can sign in to the live UI. Ask him, and wait.
- Webhook/storage target (e.g. `process-blend-ticket` from a Storage trigger): tell him how to
  trigger it — "drop a test PDF into the blend-tickets bucket" — then confirm the invocation
  yourself in `mcp__<supabase>__query_logs`.

If the caller path has not been exercised, the deploy is **UNVERIFIED**, not complete. Say which
proof is missing rather than printing a clean summary.

### 5c. Recent logs check

```
mcp__<supabase>__query_logs
  sql: select timestamp, event_message from logs where source = 'edge_logs' and event_message like '%/functions/v1/%' order by timestamp desc limit 50
  iso_timestamp_start: <5 minutes ago, ISO 8601 with Z>
```

(The tool was previously named `get_logs` and took `service:`; `query_logs` instead takes a read-only ClickHouse `sql` query against the unified `logs` table, filtered by `source`. Resolve by suffix if the connector still exposes the old name.) **Empty is not clean:** run `select distinct source from logs` once first — sources vary by project, and a query against a source that doesn't exist (this project has NO `function_edge_logs`) returns zero rows with no error. If the invocation you just triggered doesn't appear, the check is UNVERIFIED, not passing.

Scan for any error events from the new version in the last 5 minutes.

## Step 6: Update the Current State doc

Version numbers are volatile counts, so they do **not** go in `CLAUDE.md` or `AGENTS.md` —
`npm run check:agent-guidance` fails on that. Update `docs/manual/CURRENT_STATE.md` instead
(the "Recent production deployments" section), e.g.:

```
- **2026-MM-DD:** `<name>` Edge Function deployed to v<N+1> (<one-line change>); verified ACTIVE
  via the Supabase connector, caller path exercised.
```

Do NOT commit — the user decides when to commit.

## Step 7: Print Summary

Print `DEPLOY COMPLETE` only when the caller path was actually exercised. Otherwise print
`DEPLOY UNVERIFIED` and name what is missing.

```
═══ DEPLOY COMPLETE / DEPLOY UNVERIFIED ═══
Function:    <name>
Version:     v<N> → v<N+1>  (ACTIVE)
Logs:        <clean / N errors in last 5min>
Caller path: EXERCISED (<what was triggered, what was observed>) / NOT EXERCISED

docs/manual/CURRENT_STATE.md updated.
```

## Hard Rules

- NEVER deploy without the pre-flight checks passing.
- NEVER deploy without explicit user confirmation in Step 3.
- NEVER skip the post-deploy verification — the B7/B8 incidents happened because nobody re-read the live state.
- NEVER auto-commit — the user decides when to commit.
- NEVER print `DEPLOY COMPLETE` on a version bump alone; a bump is not proof the new code runs.
- NEVER hard-code the Supabase connector's UUID prefix — resolve it by tool-name suffix at run time.
- If `get_edge_function` shows the version did NOT bump, alert the user loudly — the deploy silently failed.

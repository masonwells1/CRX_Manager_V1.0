---
name: spot-check-prod
description: Quick production health dashboard for CRX Manager. Pulls recent Sentry errors, Supabase performance/security advisor counts, Vercel last build status, and Edge Function deploy state into a single one-page report. Use when the user asks "is prod okay?", "any errors lately?", "what's prod doing?", or before approving any new deploy. Faster than /status (local repo) and /audit (validation suite) — this is "what's the live system doing right now?".
---

# Spot-Check Prod

A 30-second production health check. Pulls live status from each external system CRX Manager depends on and surfaces anything actionable.

## Step 1: Sentry — recent errors

Sentry is a **connector**, so its tools are UUID-prefixed — they are named
`mcp__<uuid>__search_issues`, `mcp__<uuid>__search_events`, etc., **not** `mcp__sentry__*`.
Matching on `mcp__sentry__*` never matches anything and silently skips this whole section; that
was a real defect. Discover the tools by name suffix (`search_issues`, `find_projects`,
`analyze_issue_with_seer`) rather than by a hard-coded prefix, and never hard-code a UUID —
reinstalling the connector rebinds it.

If the Sentry tools are available:
- Query the project for issues created or seen in the last 24 hours
- Capture: count, top 3 by frequency, any new (first-seen-in-24h) issues

If they are NOT available, say so explicitly, mark this section UNAVAILABLE in the report, and
tell the user to check the sentry.io dashboard for the CRX Manager project. An unavailable
section is never a pass.

Notes:
- Filter out known-noise issues if Mason has flagged any (check `docs/` for any "sentry-ignore" notes).
- A spike in a single issue is more concerning than 1-2 occurrences of many issues.

## Step 2: Supabase — security & performance advisors

Run both in parallel via Supabase MCP. Like the other connectors, resolve the tool by **name
suffix** (`get_advisors`) — never hard-code the UUID prefix; a reinstall rebinds it:

```
mcp__<supabase>__get_advisors
  type: security

mcp__<supabase>__get_advisors
  type: performance
```

Capture:
- Total count of ERROR + WARN findings
- Any NEW findings since the last run. The baseline lives in `docs/manual/CURRENT_STATE.md`
  (`CLAUDE.md` no longer has a "Current State" section and must not regain one).
- Specifically flag any advisor in the "RLS not enabled" / "SECURITY DEFINER missing search_path" family — these are the B7/B8/B9 class

### Known `profile_public_view` exception

`public.profile_public_view` intentionally uses SECURITY DEFINER view semantics
to expose only the non-sensitive employee-directory columns `id`, `full_name`,
`role`, and `is_active` to signed-in users. Supabase reports this as a
`security_definer_view` ERROR even when the boundary is correct.

Do not count this one finding as actionable or make the overall result YELLOW
when all of these live read-only checks pass:

- the view definition selects exactly `id`, `full_name`, `role`, and `is_active`
  from `public.profiles`;
- `anon` and `PUBLIC` do not have `SELECT`;
- `authenticated` has `SELECT`; and
- the view owner still has `BYPASSRLS` (normally owner `postgres`); and
- every applicable `SELECT` policy on `public.profiles` has been inspected, and
  the complete set is exactly one permissive `profiles_select` policy with the
  admin-or-self predicate.

Use Supabase MCP read-only SQL when available. If custom SQL cannot run
unattended through MCP, use `supabase db query --linked` with SELECT-only SQL.
Report both the raw advisor count and the actionable count, for example:
`raw 1 ERROR / actionable 0 ERROR (verified profile_public_view exception)`.
If any condition cannot be verified or has drifted, treat the finding as
actionable and report the exact failed or blocked check.

## Step 3: Vercel — last build status

The Vercel plugin (`vercel@claude-plugins-official`) is **enabled** in `.claude/settings.json`.
Its tools are connector-scoped and UUID-prefixed, so locate them by name suffix
(`list_deployments`, `get_deployment`, `get_deployment_build_logs`) rather than by a hard-coded
prefix — a reinstall rebinds the UUID.

- `list_deployments` for the croprxsolutions.app project
- Capture: last deploy status (READY / ERROR / BUILDING), commit SHA, time
- If status = ERROR, capture the build log excerpt, then check the **production alias** — a
  failed build usually leaves the previous good deployment still serving production, so a red
  build is not by itself a production outage.

If the tools are not reachable, mark this section UNAVAILABLE and say so; do not assume the
plugin is disabled.

## Step 4: Edge Functions — deploy state

For each Edge Function in `supabase/functions/`, check live version:

```
mcp__<supabase>__list_edge_functions
```

Capture each function name, current live version, last update timestamp. Compare against the
version references in `docs/manual/CURRENT_STATE.md` (e.g. "process-document v21") — flag drift only
for functions whose version CURRENT_STATE.md actually records; report a function with no
recorded version as `NO BASELINE` (neither drift nor clean) so the gap is visible — it does not
downgrade the overall result on its own. Do not look for these in `CLAUDE.md`; that section moved.

## Step 5: Recent Supabase logs (5min scan)

```
mcp__<supabase>__query_logs
  sql: select timestamp, event_message from logs where source = 'edge_logs' order by timestamp desc limit 50
  iso_timestamp_start: <5 minutes ago, ISO 8601 with Z>
```

(The tool was previously named `get_logs` and took `service:`; `query_logs` instead takes a read-only ClickHouse `sql` query against the unified `logs` table, filtered by `source`. Resolve by suffix if the connector still exposes the old name.)

Scan for any error-level events in the last 5 minutes. Don't dump the whole log — count, and surface the top 3 distinct error messages.

Repeat with `source = 'postgres_logs'` if time permits. **Empty is not clean:** run
`select distinct source from logs` once first — sources vary by project (this project exposes
`edge_logs`, `postgres_logs`, `auth_logs`, etc., and has NO `function_edge_logs`); a query
against a source that doesn't exist returns zero rows with no error, which would read as a
false pass. Edge-function requests surface as `/functions/v1/...` rows in `edge_logs`.

## Step 6: Print the Dashboard

```
═══════════════════════════════════════════════════
  PROD SPOT-CHECK — <YYYY-MM-DD HH:MM UTC>
═══════════════════════════════════════════════════

SENTRY (24h)
  Total issues:   <N>
  New since Y'day: <N>
  Top issues:
    1. <error message> — <count> events
    2. <error message> — <count> events
    3. <error message> — <count> events

SUPABASE ADVISORS
  Security raw:        <N error / N warn>  [baseline: docs/manual/CURRENT_STATE.md]
  Security actionable: <N error / N warn>  [verified exceptions: <none / list>]
  Performance: <N error / N warn>
  New findings:
    - <advisor name> on <object>: <one-line description>

VERCEL
  Last deploy: <READY / ERROR / BUILDING>
  Commit: <sha> — <time ago>
  <If ERROR: include first 3 lines of build log>

EDGE FUNCTIONS
  create-user:                v<N>   (last updated <date>)
  process-blend-ticket:       v<N>   ...
  ...
  Drift from CURRENT_STATE.md: <none / list>

LIVE LOGS (5min)
  api errors:        <count> — top: <message>
  edge-fn errors:    <count>
  postgres errors:   <count>

─── OVERALL ─────────────────────────────────────────

<One-line verdict. GREEN requires that EVERY section actually ran:
  "GREEN — prod is healthy (all N sections checked)"
  "INCOMPLETE — <N> section(s) unavailable: <list>; nothing actionable in what did run"
  "YELLOW — <N> non-urgent issues, see above"
  "RED — <urgent issue>, recommend immediate action">

Never report GREEN when a section was skipped or its tools were unavailable — a partial check
that reads as "prod is healthy" is exactly the false green this skill must not produce. List the
unchecked sections by name in the verdict line.

─── RECOMMENDED NEXT STEPS ──────────────────────────

<2-4 concrete actions if anything is YELLOW/RED>
```

## Step 7: Optional Follow-Ups

If any RED issue surfaced, offer:
- "Want me to investigate the <X> error?" (would invoke `/quick-fix` or just deep-read the Sentry issue)
- "Want me to dispatch the rls-security-reviewer subagent on the latest migration?" (if Supabase flagged RLS issues)
- "Want me to roll back the Vercel deploy?" — **only after confirming production is actually
  serving the bad build.** A failed build normally leaves the previous production deployment
  live, so check the production alias first; rolling back a healthy production because a
  candidate build went red makes things worse.

Do NOT take any of these actions automatically. Mason decides.

## Hard Rules

- This is READ-ONLY. Never modify state on Sentry, Supabase, or Vercel from this skill.
- If an MCP tool fails, say so explicitly — don't silently skip a section.
- Don't include the dashboard if every section is empty (means MCPs aren't available) — instead report which MCPs need to be set up.
- Mark every section that could not run as UNAVAILABLE, and downgrade the overall verdict to INCOMPLETE. Partial evidence never yields GREEN.
- Never hard-code a connector UUID; resolve tools by name suffix so a reinstall doesn't silently disable a section.
- Keep the output under one screen. If there's too much to display, link/cite and let Mason ask follow-up.

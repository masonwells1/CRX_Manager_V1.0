---
name: spot-check-prod
description: Quick production health dashboard for CRX Manager. Pulls recent Sentry errors, Supabase performance/security advisor counts, Vercel last build status, and Edge Function deploy state into a single one-page report. Use when the user asks "is prod okay?", "any errors lately?", "what's prod doing?", or before approving any new deploy. Faster than /status (local repo) and /audit (validation suite) — this is "what's the live system doing right now?".
---

# Spot-Check Prod

A 30-second production health check. Pulls live status from each external system CRX Manager depends on and surfaces anything actionable.

## Step 1: Sentry — recent errors

If Sentry MCP is available (`mcp__sentry__*`):
- Query the project for issues created or seen in the last 24 hours
- Capture: count, top 3 by frequency, any new (first-seen-in-24h) issues

If Sentry MCP is NOT available, tell the user how to check manually (sentry.io dashboard for the CRX Manager project) and skip this section in the report.

Notes:
- Filter out known-noise issues if Mason has flagged any (check `docs/` for any "sentry-ignore" notes).
- A spike in a single issue is more concerning than 1-2 occurrences of many issues.

## Step 2: Supabase — security & performance advisors

Run both in parallel via Supabase MCP:

```
mcp__50e15046-cf2c-49da-b8df-ceef27768f63__get_advisors
  project_id: rhyzpcqhnizqbxphqdkr
  type: security

mcp__50e15046-cf2c-49da-b8df-ceef27768f63__get_advisors
  project_id: rhyzpcqhnizqbxphqdkr
  type: performance
```

Capture:
- Total count of ERROR + WARN findings
- Any NEW findings since the last run (compare to `CLAUDE.md` Current State if there's a recent reference like "Supabase performance advisor: 0 WARN findings")
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

If the Vercel plugin is enabled (`mcp__0fb370f6-ff90-41a7-8c20-6f1490a21d59__*`):
- `list_deployments` for the croprxsolutions.app project
- Capture: last deploy status (READY / ERROR / BUILDING), commit SHA, time
- If status = ERROR, capture build log excerpt

If Vercel plugin is NOT enabled, suggest user enable it via `.claude/settings.json` (it's already in the config, just set to false).

## Step 4: Edge Functions — deploy state

For each Edge Function in `supabase/functions/`, check live version:

```
mcp__50e15046-cf2c-49da-b8df-ceef27768f63__list_edge_functions
  project_id: rhyzpcqhnizqbxphqdkr
```

Capture each function name, current live version, last update timestamp. Compare against CLAUDE.md's "Current State" version references (e.g., "send-email v11") — flag any that drifted.

## Step 5: Recent Supabase logs (5min scan)

```
mcp__50e15046-cf2c-49da-b8df-ceef27768f63__get_logs
  project_id: rhyzpcqhnizqbxphqdkr
  service: api
```

Scan for any error-level events in the last 5 minutes. Don't dump the whole log — count, and surface the top 3 distinct error messages.

Repeat for `service: edge-function` and `service: postgres` if time permits.

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
  Security raw:        <N error / N warn>  [previous baseline: <from CLAUDE.md>]
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
  Drift from CLAUDE.md:       <none / list>

LIVE LOGS (5min)
  api errors:        <count> — top: <message>
  edge-fn errors:    <count>
  postgres errors:   <count>

─── OVERALL ─────────────────────────────────────────

<One-line verdict:
  "GREEN — prod is healthy"
  "YELLOW — <N> non-urgent issues, see above"
  "RED — <urgent issue>, recommend immediate action">

─── RECOMMENDED NEXT STEPS ──────────────────────────

<2-4 concrete actions if anything is YELLOW/RED>
```

## Step 7: Optional Follow-Ups

If any RED issue surfaced, offer:
- "Want me to investigate the <X> error?" (would invoke `/quick-fix` or just deep-read the Sentry issue)
- "Want me to dispatch the rls-security-reviewer subagent on the latest migration?" (if Supabase flagged RLS issues)
- "Want me to roll back the Vercel deploy?" (if build failed mid-deploy)

Do NOT take any of these actions automatically. Mason decides.

## Hard Rules

- This is READ-ONLY. Never modify state on Sentry, Supabase, or Vercel from this skill.
- If an MCP tool fails, say so explicitly — don't silently skip a section.
- Don't include the dashboard if every section is empty (means MCPs aren't available) — instead report which MCPs need to be set up.
- Keep the output under one screen. If there's too much to display, link/cite and let Mason ask follow-up.

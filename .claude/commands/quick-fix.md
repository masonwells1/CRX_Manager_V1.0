Check for recent errors in the CRX Manager production app and suggest fixes.

Steps:
1. If Sentry MCP tools are available, search for unresolved issues in the last 7 days for the CRX Manager project
2. If Vercel MCP tools are available, check runtime logs for errors in the last 24 hours
3. If Supabase MCP tools are available, check postgres and edge-function logs for errors

For each error found:
- Explain what it means in plain English (Mason has no coding experience)
- Identify the likely source file and line
- Suggest a specific fix
- Rate severity: LOW (cosmetic), MEDIUM (feature broken), HIGH (data at risk), CRITICAL (app down)

If no MCP tools are available, fall back to checking:
- `git log --oneline -10` for recent changes that might have introduced bugs
- `npm run build` for any build errors
- `npm run test` for any test failures

Present findings sorted by severity (CRITICAL first).

If the right fix is undoing a recent deploy/migration/edge-function change rather than patching forward, switch to `/rollback` and follow `docs/runbooks/incident-rollback.md`.

# CRX Manager — Production Runbook

**Last updated:** 2026-07-16 (backup/recovery section rewritten to FREE-plan reality; revert path updated to the PR-only landing flow)
**Audience:** Mason (owner) and any future on-call admin.
**Scope:** day-to-day operations, deploys, rollbacks, incident response, and recurring maintenance for the production system.

---

## 1. System landscape

| Component | Where it runs | Dashboard / CLI |
|---|---|---|
| Frontend | Vercel (production) | https://vercel.com/dashboard |
| Live URL | https://croprxsolutions.app | — |
| Database | Supabase project `rhyzpcqhnizqbxphqdkr` | https://supabase.com/dashboard/project/rhyzpcqhnizqbxphqdkr |
| Edge Functions | Supabase (7 functions) | Supabase → Edge Functions tab |
| Email | Resend (via `send-email` Edge Function) | https://resend.com/dashboard |
| OCR | Google Vision API (via `process-blend-ticket`) | https://console.cloud.google.com |
| Repo | GitHub `masonwells1/CRX_Manager_V1.0` | https://github.com/masonwells1/CRX_Manager_V1.0 |
| CI | GitHub Actions (`.github/workflows/ci.yml`) | Repo → Actions tab |
| Error tracking | Sentry | https://sentry.io |

**Stack:** React 18 + TypeScript + Vite + Tailwind + Supabase + Vercel.

---

## 2. Deploy

### 2.1 Normal deploy (frontend)

Vercel auto-deploys every push to `main` and every PR (preview).

1. Run `npm run build` locally to confirm a clean build.
2. Open a PR → Vercel posts a preview URL on the PR.
3. Smoke-test the preview against your test customer / test orders.
4. Squash-merge to `main` → Vercel promotes to production.
5. Watch [Vercel deployments](https://vercel.com/dashboard) until the new build is "Ready."
6. Hit https://croprxsolutions.app → hard refresh → confirm the new build (look for the new feature or check Vercel build hash).

### 2.2 Database migration deploy

Migrations are SQL files in `supabase/migrations/`. They are applied to production via the Supabase MCP (`mcp__supabase__apply_migration`) — **NOT** by `npx supabase db push`.

Order of operations:

1. Write the migration file under `supabase/migrations/<timestamp>_<name>.sql`.
2. Run `npm run typecheck && npm run build && npm run test` to confirm the codebase still compiles against the planned schema.
3. Update `src/types/index.ts` if columns/tables changed.
4. Apply via Supabase MCP (or the Supabase CLI dashboard SQL editor as a fallback).
5. Verify via `mcp__supabase__get_advisors --type security` — expect zero new advisor errors.
6. Update `docs/reference/migration-history.md`, `docs/CHANGELOG.md`, `CLAUDE.md` migration count.
7. Commit the migration file + the doc updates together.

### 2.3 Edge Function deploy

Edge Functions live in `supabase/functions/<function-name>/`. Each has its own `index.ts` and runs on Deno.

Deploy a single function:
```bash
npx supabase functions deploy <function-name> --project-ref rhyzpcqhnizqbxphqdkr
```

Deploy all:
```bash
for fn in supabase/functions/*/; do
  name=$(basename "$fn")
  npx supabase functions deploy "$name" --project-ref rhyzpcqhnizqbxphqdkr
done
```

After deploy, smoke-test by triggering the function from the live app (or via `curl` with a valid JWT).

### 2.4 Required environment variables

**Vercel project:**
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_MAPBOX_TOKEN`
- `VITE_SENTRY_DSN`

**Supabase Edge Functions (per-function secrets):**
- `ALLOWED_ORIGIN` — must be set on every function for CORS
- `RESEND_API_KEY` — `send-email` only
- `GOOGLE_VISION_API_KEY` — `process-blend-ticket` only
- `SUPABASE_SERVICE_ROLE_KEY` — present automatically; never expose to frontend
- `SENTRY_DSN` — required to enable Edge Function error alerting (Sprint F #7).
  When unset, captureEdgeException is a no-op. Set via:
  `npx supabase secrets set SENTRY_DSN=https://... --project-ref rhyzpcqhnizqbxphqdkr`

---

## 3. Rollback

### 3.1 Rolling back the frontend

**Fastest path — Vercel "Promote to Production":**
1. Vercel Dashboard → Deployments tab.
2. Find the last known-good deployment (look at commit hash).
3. Click "..." → "Promote to Production."
4. Confirm. Live URL points at the old build within ~30 seconds.

**Alternative — git revert via a PR** (direct pushes to `main` are impossible — the
`protect-main` ruleset rejects them for everyone):
```bash
git checkout -b revert/<short-name> origin/main
git revert <bad-commit-sha>
git push -u origin revert/<short-name>
gh pr create --fill
# Wait for required checks, then merge the exact reviewed head (auto-merge is intentionally disabled).
gh pr view --json headRefOid --jq .headRefOid
# Substitute the returned literal 40-character SHA below; do not use a shell variable because the guard must inspect it.
gh pr merge --squash --match-head-commit <head-sha>
```
The merge to `main` auto-deploys the revert via Vercel. (The Vercel dashboard
rollback above is faster — prefer it mid-incident.)

### 3.2 Rolling back a database migration

**Migrations are append-only — there is no "down" script.** If a migration introduced a bug:

1. **DO NOT** delete or modify the bad migration file in git history.
2. Write a NEW migration that reverses the bad changes (drop columns added, restore prior function definitions, etc.).
3. Apply via `mcp__supabase__apply_migration`.
4. Confirm app works against the reversed state.

**Worst-case (data corruption):** restore from a Supabase point-in-time backup (see §4).

### 3.3 Rolling back an Edge Function

Edge Functions are versioned by deploy. To roll back, redeploy the prior version's source code:

```bash
git checkout <good-sha> -- supabase/functions/<fn-name>/
npx supabase functions deploy <fn-name> --project-ref rhyzpcqhnizqbxphqdkr
git checkout HEAD -- supabase/functions/<fn-name>/
```

---

## 4. Backups and disaster recovery

> **Rewritten 2026-07-16.** The old text here described Supabase Pro-plan daily backups
> and point-in-time recovery. **The org is on the FREE plan — there are NO Supabase
> daily backups and NO PITR, and no "Restore" button in the dashboard.** The two paths
> below are the ONLY recovery paths (settled 2026-07-12/13, see `docs/manual/DECISION_LOG.md`).

### 4.1 What's actually backed up

- **Database (primary, off-site):** a weekly encrypted `pg_dump` pushed to the private
  GitHub repo `masonwells1/CRX_Backups` by a GitHub Action. This is the real
  disaster-recovery copy. Trigger a fresh one anytime with the `/backup-db` skill
  (deterministic half: `node scripts/backup-db.mjs --plan`).
- **Database (secondary, in-DB):** a weekly `pg_cron` job snapshots every table into the
  `backup_snapshots` table (migration `20260713050000`), keeping 8 weeks, pruned only on
  full success. Protects against bad-data mistakes, NOT against losing the database itself.
- **Edge Function source:** stored in this repo only — git is the backup.
- **Vercel deployments:** retained ~30 days; you can promote any past deployment.
- **Storage buckets** (blend ticket images, signature uploads): NOT covered by either
  backup path above — treat uploads as re-obtainable from the customer if lost.

### 4.2 Restoring

**Bad data written (table intact):** query `backup_snapshots` for the affected table's
last-known-good rows and write a compensating fix through the normal migration gate.

**Database lost/corrupted:** clone `masonwells1/CRX_Backups`, decrypt the newest dump
(key location: Mason's password manager), and restore with `pg_restore`/`psql` against a
fresh project using the Session-pooler connection string (IPv4). Restore to a NEW
project first — never overwrite production directly.

**Restore drill (recommended quarterly):** run the database-lost path against a throwaway
project, verify representative rows (`customers`, `invoices`, recent
`inventory_transactions`), document the time it took here.

**Last drill:** _none yet — schedule for 2026-08-01_

### 4.3 What's NOT in the backup

- `.env` secrets (live in Vercel + Supabase, NOT in any database backup)
- Resend email logs (Resend's own retention — 30 days)
- Sentry error history (Sentry's own retention)
- GitHub Actions logs (90 days)

Keep an offline copy of:
- Supabase service role key (in a password manager)
- Resend API key
- Mapbox token
- Sentry DSN
- Vercel deploy hooks (if any)

---

## 5. Month-end close

**Cadence:** First weekday of every month, for the previous calendar month.

1. **Confirm all deliveries are completed or cancelled** for the closing month. Open `Deliveries` page → filter status = `in_progress` or `scheduled` with delivery date in the closing month → resolve each.
2. **Confirm all invoices are posted or voided** for the closing month. `Invoices` page → filter status = `unposted` or `draft` with invoice date in the closing month → post or void.
3. **Generate finance charges** for overdue customers (Customers → Statements → Generate Finance Charges).
4. **Run the period close:** Settings → Accounting Periods → close the month. The `close_accounting_period()` RPC checks for any blocking open transactions and refuses if anything is incomplete.
5. **Generate statements** (Customers → Statements → Generate Batch Statements) and review/email.
6. **Apply remaining prepayments:** Customers → Prepay → Apply Remaining → confirm balances.
7. **Reconcile commissions:** Commissions page → review the prior month → mark paid where applicable.
8. **Export reports** (Reports page → P&L, Balance Sheet, AR Aging) for record keeping.

If the close RPC rejects: read the error message — it names the open transaction. Resolve the transaction first, then retry.

---

## 6. Common incidents

### 6.1 "The site is down"

1. **Check Vercel status:** dashboard shows current deployment health.
2. **Check Supabase status:** https://status.supabase.com
3. **Hit the health endpoint:** `curl -I https://croprxsolutions.app/` should return `200`.
4. **Check Sentry:** look for spikes in unhandled errors in the past hour.

If Vercel is fine but the app errors:
- 401/403 errors → Supabase anon key likely changed; verify env var.
- 500 errors from RPC calls → check Supabase logs for the function name.
- Blank screen → check browser console. Likely a missing build asset or CSP violation.

### 6.2 "Emails aren't going out"

1. Open Sentry → filter `edge_function:send-email` (alerts auto-fire on Resend send failures since Sprint F #7).
2. Check Resend dashboard → look for failed sends.
3. Verify `RESEND_API_KEY` in Supabase Edge Function secrets (rotated keys are the most common cause).
4. Manually call `send-email` from the live app with a test recipient; the response includes any error body.

### 6.3 "The pre-commit hook is taking too long"

It runs lint + build + 1,841 tests = 90–120 seconds on a healthy machine. If it's longer:
- `npm ci` to ensure clean dependencies
- Restart your terminal (long-running test workers can lock up)
- As a last resort: `git commit --no-verify` is BANNED by hard rule, but if absolutely needed, the CI sql-validation + lint-typecheck-test jobs (added in Sprint F #5) will still catch most issues at PR time.

### 6.4 "I broke a migration that's already applied"

See §3.2 — write a forward-fix migration, never edit history.

### 6.5 "Customer reports their data is wrong"

1. Check `activity_feed` for the customer + date range — every meaningful mutation is logged with `performed_by`.
2. Check `financial_audit_log` for any payment/invoice mutations — append-only, never deleted.
3. If the bug is a system bug, write the fix migration; if it's user error, walk them through the correct flow.

---

## 7. Routine maintenance

| Task | Cadence | How |
|---|---|---|
| Restore drill | Quarterly | §4.2 |
| Month-end close | Monthly (first weekday) | §5 |
| Vercel + Supabase + Resend usage check | Monthly | Each dashboard's billing tab |
| Sentry triage | Weekly | Sentry → Issues → unresolved |
| Dependency audit (`npm audit`) | Weekly | Run `npm audit --audit-level=critical` |
| `pg_cron` job health (after Sprint F #3) | Monthly | Supabase → Database → cron schedules |
| Reconciliation report (after Sprint F #4) | Monthly, before close | Admin dashboard → Integrity Report |

---

## 8. Hard rules (from CLAUDE.md, repeated here for ops)

- **NEVER** modify or delete an existing migration file. Only add new ones.
- **NEVER** drop RLS from a table. Every table must have RLS.
- **NEVER** expose `service_role` key in the frontend.
- **NEVER** modify `financial_audit_log` records — append-only.
- **NEVER** use binary floating point for money. New storage uses `bigint` cents.
  Legacy PostgreSQL numeric-dollar storage is not an approved exception until exact
  `numeric` arithmetic, clean finite whole-cent values, and an active finite whole-cent
  CHECK are verified. Dirty or unconstrained columns remain tracked findings.
- **NEVER** commit with `--no-verify` (bypasses lint+build+test gate).
- **NEVER** push to `main` directly with destructive force flags.

---

## 9. Quick reference — files & docs

| Doc | Purpose |
|---|---|
| `CLAUDE.md` | Project rules, current state, conventions |
| `SAFE_DEVELOPMENT_RULES.md` | Mandatory pre-commit safety checklist |
| `DATABASE_CHANGE_CHECKLIST.md` | Step-by-step for schema changes |
| `docs/CHANGELOG.md` | Sprint-by-sprint development history |
| `docs/reference/migration-history.md` | Every migration with description |
| `docs/reference/rpc-functions.md` | All RPCs + signatures |
| `docs/reference/database-schema.md` | All tables + RLS matrix |
| `docs/audits/` | Codex audit findings (current and past) |

---

## 10. When to update this runbook

After any of:
- New Edge Function deployed
- New external service integrated (replace Resend, add Stripe, etc.)
- Disaster recovery drill performed (record outcome in §4.2)
- Incident that revealed a missing playbook step
- New month-end procedure or accounting period rule

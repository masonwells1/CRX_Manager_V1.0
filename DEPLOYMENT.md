# Deployment Guide

How CRX Manager reaches production, what CI checks, which secrets the Edge Functions need, and how
to roll back. The step-by-step landing procedure agents follow is `.claude/commands/ship.md`; this
page summarises it and does not replace it.

## How a change reaches production

- **Production** is the Vercel deployment at [croprxsolutions.app](https://croprxsolutions.app),
  backed by the one live Supabase project (`rhyzpcqhnizqbxphqdkr`). There is **no staging
  environment** — no staging Supabase project and no staging branch (creating one is an open owner
  action in `TODO.md`).
- **`main` is protected.** Nobody pushes to it directly; GitHub refuses the push.
- **Landing = branch → pull request → required CI checks → review → merge.** Agents follow
  `.claude/commands/ship.md` for the exact order, the review gates, and the merge command.
- **The merge deploys.** When a pull request merges into `main`, Vercel builds and deploys the site
  automatically. Vercel keeps every earlier deployment, so a bad deploy can be rolled back with one
  click (see [Rollback](#rollback)).
- **Database changes and Edge Functions do not deploy with the merge.** A migration is applied to
  the live database, and an Edge Function is deployed, as separate steps — each needs Mason's
  explicit approval in the current conversation (see `AGENTS.md` › Safety and Protected Delivery). The
  only exception is a non-destructive migration in a hands-free run Mason pre-authorized with an
  armed autopilot flag and a fresh proof and Codex verdict; it never covers an Edge Function deploy.

## Before you open the pull request

Run the same core checks CI runs, locally:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run check:docs
```

The git hooks also help: pre-commit runs fast checks on staged files, and pre-push runs private-artifact
containment, `npm run typecheck`, and `npm run build`. Neither hook runs lint or the unit tests —
CI does.

There is no browser (E2E) test gate today: the Playwright suite only runs against a staging project,
which does not exist yet. See [TESTING.md](./TESTING.md#running-e2e-tests).

---

## Vercel configuration

- Framework preset: **Vite**. Build command `npm run build`, output directory `dist`.
- `vercel.json` sets only the single-page-app rewrite (every path serves `index.html`) and the
  security headers (Content-Security-Policy, HSTS, `X-Frame-Options`, and others). It does not
  override the install or build commands.
- The custom domain `croprxsolutions.app` is attached in the Vercel project settings. Changing
  domains is an owner decision (`AGENTS.md`).

### Frontend environment variables

Set in the Vercel project settings, and in your local `.env` (see `.env.example`):

| Variable | Required? | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | Required | The Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Required | The public (anon) key — safe in the browser; data is protected by Row Level Security |
| `VITE_MAPBOX_TOKEN` | Optional | Enables the map and field-boundary features |
| `VITE_SENTRY_DSN` | Optional | Enables browser error reporting to Sentry |

**Security notes:**
- Only `VITE_`-prefixed variables reach the app, and everything they hold is visible to anyone
  using the site — never put a secret in one.
- The `service_role` key must never appear in `.env`, in `src/`, or in Vercel. It exists only
  inside Edge Functions, where Supabase provides it.
- Never commit `.env` (it is git-ignored).

---

## Supabase Edge Functions

Each folder under `supabase/functions/` (except `_shared/`, which is a helper library) is one
function; that folder list is the authoritative inventory. Today there are eight: `create-user`,
`customer-document-files`, `epa-lookup`, `process-blend-ticket`, `process-document`,
`reset-user-password`, `send-email`, and `setup-blend-tickets-storage`. `customer-document-files`
was first deployed as v1 on 2026-09-22 UTC, and migration
`20260914100700_customer_document_bytes_server_only` (which makes customer-document bytes reachable
only through that function) was applied live on 2026-09-26; keep the function deployed.

Deploying or redeploying a function is a live change that needs Mason's explicit OK; use the
`deploy-edge-function` workflow, which runs the pre-flight checks and a post-deploy smoke test.

### Edge Function secrets

Names only — never write a secret value into this repository. Setting or changing a secret needs
Mason's explicit OK.

| Secret | Used by | Notes |
|---|---|---|
| `ALLOWED_ORIGIN` | All eight (through `_shared/cors.ts`) | CORS origin. Must be exactly `https://croprxsolutions.app` (no trailing slash). If it is missing, every function fails at start-up. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | All eight | Provided automatically by hosted Supabase; nothing to set. |
| `GOOGLE_VISION_API_KEY` | `process-blend-ticket`, `process-document` | OCR for blend tickets and uploaded documents. |
| `RESEND_API_KEY` | `send-email` | Without it, each send is recorded as failed in `email_log` and returns an error. |
| `FROM_EMAIL` | `send-email` | Optional sender address; the function falls back to a built-in `croprxsolutions.app` address. |
| `SENTRY_DSN` | All eight (through `_shared/sentry.ts`) | Optional. Without it, errors are logged as `SENTRY_MISCONFIG` instead of being reported to Sentry. |
| `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | All eight (through `_shared/sentry.ts`) | Optional labels on Sentry events (environment defaults to `production`). |

To set one (after approval): `npx supabase secrets set <NAME>=<value> --project-ref rhyzpcqhnizqbxphqdkr`.

**Verification steps:**
1. Run `npx supabase secrets list --project-ref rhyzpcqhnizqbxphqdkr` to confirm the names are set
   (it shows names and digests, not values).
2. After a deploy, exercise each changed function from the app and confirm it responds.
3. If the browser console shows `403` or `CORS` errors, check that `ALLOWED_ORIGIN` matches the
   exact origin (protocol included, no trailing slash).

---

## After the merge deploys

1. **Watch the deployment** in the Vercel dashboard until it is **READY**; a failed build leaves
   the previous deployment live.
2. **Check the live site:** open croprxsolutions.app, sign in, and exercise the flow the change
   touched. Check the browser console for errors.
3. **Watch for errors** for the first hour: Sentry, Supabase logs, and user reports. The
   `spot-check-prod` workflow gathers these into one view.

---

## Rollback

The full decision tree is `docs/runbooks/incident-rollback.md`; say "roll back" to an agent and the
`/rollback` workflow (`.claude/commands/rollback.md`) walks through it. Every rollback step that
changes production waits for Mason's explicit OK.

### Bad frontend deploy — Vercel rollback

1. Open the Vercel dashboard → the CRX Manager project → **Deployments**.
2. Find the last **READY** deployment from before the problem started.
3. Click **"..."** → **Promote to Production**.
4. Reload croprxsolutions.app and confirm the problem is gone.

Nothing is deleted; the bad deployment stays in the list.

### Undoing the code itself

A promoted older deployment is a stopgap — the next merge would ship the bad code again. Undo the
code through the normal path: create a branch, `git revert <commit-hash>` on it, open a pull
request, and merge once CI passes. Never push the revert straight to `main`.

### Bad live migration or Edge Function

- **Migration:** never edit or delete an applied migration. Write a new, compensating migration and
  apply it through the normal review gates. Restoring from a backup is the last resort.
- **Edge Function:** redeploy the last good version from git with the `deploy-edge-function`
  workflow.

---

## Continuous Integration (CI)

GitHub Actions runs three workflows from `.github/workflows/`:

| Workflow | When it runs | What it does |
|---|---|---|
| `ci.yml` | Every pull request into `main` and every push to `main` | The main gate: lint, type check, unit tests with coverage, the production build, SQL migration validation, the documentation check, guard-hook regression tests, and the Phase 3C private-artifact containment check (plus a Windows leg of that check). **No browser test runs** — see the note below. |
| `phase3-private-artifact-containment.yml` | Pull requests into `main` | Standalone containment check for private supplier-pricing artifacts, run from the trusted base branch. |
| `coderabbit-final-review.yml` | Pull-request events (labels, new commits, and so on) | The CodeRabbit final-review gate: when a frozen candidate is labelled `ready-for-coderabbit`, it rechecks the head and required checks and then asks CodeRabbit for one formal review. See `docs/reference/coderabbit-native-review.md`. |

Two older workflows, `production-migration.yml` and `production-approval-canary.yml`, were
**removed** on 2026-08-31 when the production migration approval gate was retired — see
`docs/changelog.d/2026-08-31-retire-production-migration-approval-gate.md`. Do not expect them to
exist.

The jobs inside `ci.yml` are `phase3-private-artifact-containment`, `ci-scope`,
`sql-validation`, `lint-typecheck-test`, `phase3c-containment-windows`, and
`e2e-smoke`. `ci-scope` classifies each change fail-closed, so a docs-only pull
request can skip the expensive proof steps while anything touching code, SQL, or
the agent surface gets the full run.

> **`e2e-smoke` is disabled and never runs.** The job is pinned `if: false` in
> `ci.yml`, so it is skipped on every pull request and every push. **CI currently
> provides no browser coverage** — do not read a green CI as evidence that a UI
> flow was exercised. The job's own comment carries the checklist for re-enabling
> it, ending in "change `if: false` back to `if: github.event_name == 'push'`";
> the blockers are that no staging project exists yet and the E2E suite still
> contains production endpoints, which the safety guard in
> `tests/e2e/utils/safety-guards.ts` refuses to run against.

`check:docs` is the documentation gate CI runs in `ci.yml`; it verifies that reference-doc claims
still match the repository.

Edit the workflow files directly if CI needs to change; do not add a parallel
`test.yml`.

---

## Troubleshooting Deployment

### Build fails

**Error: "Module not found"**
- Check `package.json` lists the dependency, then run `npm ci` locally to reproduce.

**Error: "Out of memory"**
- Increase Node memory for the build:
  ```
  NODE_OPTIONS="--max-old-space-size=4096" npm run build
  ```

### Environment variables not working

**Symptoms:** the app shows a "Configuration Error" screen, or features fail only in production.

1. Verify the variable names start with `VITE_`.
2. Check they are set in the Vercel project settings.
3. Redeploy after adding variables — Vite bakes them in at build time.
4. Check for typos in the names.

### Database connection issues

**Symptoms:** "Failed to fetch" errors, login fails, data does not load.

1. Verify the Supabase project is not paused.
2. Check the RLS policies allow the access.
3. Confirm the environment variables are correct.
4. Check the Supabase API limits and quotas.

---

## Additional Resources

- [Vercel Documentation](https://vercel.com/docs)
- [Supabase Documentation](https://supabase.com/docs)
- [Vite Deployment Guide](https://vitejs.dev/guide/static-deploy.html)

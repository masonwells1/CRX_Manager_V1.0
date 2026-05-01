# Pending Manual Operational Steps

Steps that require credentials or interactive auth Claude couldn't perform autonomously. Run when you have a moment — they unlock features that are otherwise dormant.

---

## 1. Set `SENTRY_DSN` Edge Function secret

**Why:** Sprint F #7 added `captureEdgeException` calls to `send-email`, `process-blend-ticket`, and `process-document`. Without `SENTRY_DSN` set, every call is a silent no-op — Edge Function failures will continue to be invisible.

**How (one command):**

```bash
npx supabase secrets set SENTRY_DSN=<your-dsn> --project-ref rhyzpcqhnizqbxphqdkr
```

You can find the DSN in:
- Vercel project env vars: `VITE_SENTRY_DSN` (the same DSN works server-side; the `VITE_` prefix is just a Vite-build convention)
- Sentry dashboard: Project → Settings → Client Keys (DSN)

**Verify it took:**
```bash
npx supabase secrets list --project-ref rhyzpcqhnizqbxphqdkr
```
You should see `SENTRY_DSN` in the list.

**Test it works:**
1. Trigger a deliberate failure (e.g., call `send-email` with a non-existent customer_id).
2. Check Sentry → Issues. A new event tagged `edge_function:send-email` should appear within ~30 seconds.

**If something goes wrong:** the Edge Functions don't break — `captureEdgeException` swallows its own errors. Worst case you just don't get alerts. Set the secret correctly and they'll start flowing.

---

## 2. Push the local commit chain to GitHub

**Why:** 33+ commits accumulated locally since the last push. Until pushed, the new CI sql-validation job hasn't been exercised, and the GitHub repo is stale.

**How:**
```bash
git push origin main
```

Watch the GitHub Actions run on push. The new `sql-validation` job runs first and must pass with `--max-violations=20` before the `lint-typecheck-test` job kicks off.

**If sql-validation fails on first run:** the actual violation count on Linux CI may differ slightly from local (Git Bash on Windows had subshell timing oddities). Bump the baseline in `.github/workflows/ci.yml` if it's just at the edge, or investigate if the count is wildly off.

---

## 3. Schedule the recurring agents

These are queued via `/schedule` (separate from this doc — see the schedule list with `/schedule list`):

- **Monthly integrity-report check** — runs `runReconciliationChecks()` and posts results before month-end close.
- **Quarterly SQL violation baseline review** — drops the `--max-violations` baseline if violations have decreased.

If `/schedule list` doesn't show them, re-run `/schedule create` with the prompts saved alongside this doc.

---

## When to delete this file

Once all items are done, delete this file. If you need to add new pending steps in the future, replace the contents — don't accumulate stale items.

# Incident rollback — what to do when a change broke production

**Who to call first: Claude.** Open a Claude session and say: **"something's broken in prod"**
(that triggers the `/quick-fix` check) or **"roll back"** (that triggers `/rollback`, which
walks you through this runbook step by step). You never have to do any of this alone —
this page exists so you understand what Claude is doing and can do it yourself if Claude
is unavailable.

> **Preconditions — what must be true for each path to work**
>
> - **Frontend rollback (a):** a previous READY deployment exists in the Vercel
>   dashboard. It almost always does — Vercel keeps every past deployment.
> - **Migration recovery (b):** worst case needs a reasonably fresh backup — check the
>   date on the newest folder under `backups/` (the local JSON dumps, refreshed weekly
>   via `scripts/backup-via-rest.py`) and the Supabase dashboard's own daily backups
>   (see `docs/operations/production-runbook.md` §4). Anything applied since the backup
>   would be lost in a full restore, which is why restore is the LAST resort.
> - **Edge function rollback (c):** a prior version of the function exists — the
>   Supabase dashboard (Edge Functions → the function → version history) shows every
>   past deploy, and the source of every version lives in git.

---

## (a) Bad frontend deploy — the website looks or behaves wrong

**Symptoms:** pages blank or broken, buttons erroring, layout scrambled, a feature that
worked yesterday failing — but the *data* (customers, invoices, inventory) looks intact.
Usually starts right after a push to `main` (every push to `main` deploys the site).

**Fix — one click in Vercel (fully reversible):**

1. Open the Vercel dashboard → the CRX Manager project → **Deployments**.
2. Find the most recent deployment marked **READY** from *before* the problem started.
3. Click its **"..."** menu → **Promote to Production**.
4. Reload https://croprxsolutions.app — the site is now running the older, good version.

That's it. Nothing is deleted; the bad deployment stays in the list and can be re-promoted
later once it's fixed. You can also just tell Claude **"roll back the site"** and it walks
you through these exact clicks.

---

## (b) Bad live migration — a database change broke something

**Symptoms:** errors mentioning a table, column, or function; saves failing app-wide;
numbers suddenly wrong everywhere. Usually starts right after a migration was applied.

**The one hard rule: NEVER edit or delete an applied migration file.** The live database
already ran it — changing the file can't un-run it, and it corrupts the migration history
that every future change depends on. The fix is always a **NEW compensating migration**
(a fresh migration that undoes or corrects the bad one) written and applied through the
normal gates: Codex review, the migration-apply-guard proof, and your explicit OK.

**What Claude needs from you (say as much as you know):**

- **Which migration** — or just roughly *when* things broke ("right after this morning's
  change"); Claude can find the migration from the timestamp.
- **What broke** — which page or action fails, in your own words.
- **The exact error text** — a screenshot or copy-paste of the red error message.

Claude then diagnoses, writes the compensating migration, runs it through review, and
asks for your OK before applying it — same as any other migration.

**Last resort only:** restoring the database from a backup. This throws away everything
entered since the backup was taken, so it's reserved for real data corruption that a
compensating migration can't fix. Backups live in the `backups/` folder (weekly JSON
dumps) and in the Supabase dashboard (daily); the restore procedure is in
`docs/operations/production-runbook.md` §4 — and it restores to a NEW project first,
never straight over production.

---

## (c) Bad edge function — emails, OCR, or user-admin actions failing

**Symptoms:** one specific background job fails while the rest of the app works —
invoice/notification emails not sending (send-email), blend-ticket scans not reading
(process-blend-ticket / process-document), or creating/resetting users failing
(create-user / reset-user-password). Usually starts right after an edge function deploy.

**Fix — redeploy the previous version:**

1. Tell Claude **"roll back the <name> function"** — it uses `/deploy-edge-function`
   to redeploy the prior version's source (every version's code is in git, and the
   deploy flow includes pre-flight checks and a post-deploy smoke test).
2. To see what versions exist: Supabase dashboard → Edge Functions → the function —
   the version history lists every past deploy with dates.
3. Like every edge-function deploy, this waits for your explicit OK before it goes live.

---

## After any rollback

1. **Verify:** load the site / retry the failing action and confirm the error is gone.
2. **Log it:** the incident and the rollback get an entry in `docs/CHANGELOG.md`
   (Claude does this as part of `/rollback`).
3. **Fix forward:** rolling back buys time — the underlying bug still needs a proper
   fix through the normal `/ship` pipeline before the change goes out again.

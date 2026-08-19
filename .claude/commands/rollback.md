Walk Mason through undoing a bad production change — a frontend deploy, a live migration, or an edge function. Triggered when he says "roll back", "undo the deploy", "revert the site", or anything similar. This command drives the decision tree in `docs/runbooks/incident-rollback.md`; read that file first and follow it. Mason has no coding experience — explain every step in plain English, and EVERY irreversible step waits for his explicit OK in this conversation.

## Step 1: Read the runbook

Read `docs/runbooks/incident-rollback.md` in full. It defines the three scenarios, their preconditions, and the fix for each. Do not improvise a different recovery path.

## Step 2: Identify which scenario applies — from evidence, not guesswork

Ask Mason what he's seeing (in his words), then confirm against real evidence. Run whichever of these apply, in parallel where possible:

- **Frontend deploy?** List the project's recent Vercel deployments via the Vercel MCP (`list_deployments`) — a deploy in the last hours that lines up with when the problem started points to scenario (a). Note the last-known-good READY deployment.
- **Live migration?** `list_migrations` via the Supabase MCP — a migration applied around when things broke points to scenario (b). Cross-check `git log --oneline -10` for what shipped.
- **Edge function?** `list_edge_functions` via the Supabase MCP — check each function's version and updated timestamp; a fresh version on any deployable function in `supabase/functions/` (the directories containing an `index.ts` are authoritative; `_shared/` is a helper library, not a function) points to scenario (c). The Supabase dashboard shows the full version history.

State the diagnosis in one plain-English sentence ("the 2:10pm site deploy broke the quotes page — we'll promote the 11am deployment back to production") and confirm it with Mason before acting.

## Step 3: Execute the matching runbook path — gated

- **(a) Bad frontend deploy:** walk Mason click-by-click through Vercel → Deployments → the previous READY deployment → "..." → **Promote to Production** (or drive it for him if he asks). Promoting changes the live site — get his explicit OK first.
- **(b) Bad live migration:** NEVER edit or delete the applied migration file. Gather the three facts the runbook lists (which migration, what broke, exact error text), then write a NEW compensating migration and run it through the normal gates (`/migration-review`, Codex review, apply-guard proof). Applying it to the live DB waits for Mason's explicit OK. Restore-from-backup is the last resort only — and is its own explicitly-approved decision.
- **(c) Bad edge function:** identify the last-good version's source in git, then redeploy it via `/deploy-edge-function` (it runs the pre-flight checks and post-deploy smoke test). The deploy waits for Mason's explicit OK.

## Step 4: Verify and log

1. **Verify the rollback worked:** load https://croprxsolutions.app (or retry the failing action / hit the endpoint) and confirm the error is gone. Show Mason what you ran and what you saw — "done = ran and proven".
2. **Log the incident:** add an entry to `docs/CHANGELOG.md` — what broke, when, what was rolled back, and the follow-up fix still owed. Rolling back is a stopgap; the real fix still goes through `/ship`.

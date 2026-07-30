Show Mason every PARKED migration across all worktrees — database changes that are written and waiting, but have NOT been applied to the live database — and, if he wants one applied, walk it through the existing safety gates.

Use this when Mason asks anything like: "what's parked", "anything waiting on me", "what migrations are pending", "apply the parked ones".

## Steps

1. Run the fleet report and focus on the parked section:
   ```
   node scripts/fleet-status.mjs
   ```
   The "Parked migrations awaiting apply" section lists each draft with the worktree it lives in, when it was last touched, and its first comment line (what it says it does). Parked drafts live in `scripts/.staging-migrations/`, as `*draft*.sql` files in `docs/audits/`, and as branch-owned `supabase/migrations/*.sql` only when a standalone leading SQL status line explicitly marks them `PARKED`, `NOT APPLIED`, or `DO NOT APPLY`; ordinary forward migrations are deliberately excluded. Files marked SUPERSEDED are already replaced and are correctly ignored.

2. Present the parked list in plain English: for each one, what it changes, why it was parked (check the loop ledger / `docs/loops/` mission doc it came from if unclear), and how risky it looks. Lead with a recommendation for which one (if any) to handle first.

3. **If Mason asks to APPLY one — never apply it directly from here.** Route into the existing gated flow, in order:
   1. `/explain-migration <file>` — plain-English explanation of exactly what the SQL will do to the live database, what could go wrong, and what rollback looks like.
   2. `/migration-review <file>` — the deep parallel review (RLS + drift + types with adversarial verification); only a clean verdict stamps the proof file the `migration-apply-guard` hook requires.
   3. **Mason's explicit OK** — a live migration is a hard-gated action. Approval for a push, deploy, or another migration does not cover it. Only after his clear yes in the current conversation does `apply_migration` run, followed by the standard post-apply verification (smoke the change against live, `list_migrations`, update docs).

   The human gate stays. If any step fails or the review comes back blocked, stop and tell Mason what was found and what you recommend instead.

4. If a parked draft lives in ANOTHER worktree, don't edit or move that worktree's files — coordinate: tell Mason which window/session owns it, or copy the SQL content read-only for review here. (See the staging-migrations DRAFT/APPLY protocol — check for parallel-session writes first.)

Without an apply request, this command reads and reports only.

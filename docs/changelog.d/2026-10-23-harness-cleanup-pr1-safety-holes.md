## 2026-10-23 — Harness cleanup PR 1: three safety holes closed, four sources of guard noise removed

A read-only audit of the agent harness (hooks, skills, settings), reviewed item by item by Codex
(`gpt-6-luna`, xhigh; 56 findings, each checked against the code), found guards that let dangerous
actions through and guards that blocked harmless ones. This change does the first, Codex-agreed part.

**Safety holes closed.**
- Live-data guard (`live-testdata-guard.mjs`, `live-testdata-lib.mjs`). Any `REAL-DATA-OK` marker
  switched every rule off, TRUNCATE and DDL included. New worktrees receive a copy of the main
  checkout's `.claude/session-state/` with a fresh mtime, so one 2026-10-19 marker ("read-only
  cost/margin role check") had disabled the guard in the main checkout and 13 worktrees. Replayed with
  that real marker: before, `TRUNCATE customers`, `DROP TABLE invoices` and `DELETE FROM payments` were
  allowed; after, all three are refused and plain reads still pass. The marker now counts only when its
  first line is the UTC time it was written and that time is under 2 hours old, and it relaxes only real
  inserts/updates and money-column updates. The marker never unlocks audit-log writes, TRUNCATE,
  DDL/GRANT, sequence changes, RPC calls, deletes or cancels/voids, including later in the same batch.
  (It used to unlock RPC calls; a function body can delete or void, and a list of "destructive" names
  never converges, so a real RPC call now goes through the app.) Deletes and cancels/voids now honour `[E2E]` per statement and only in the SQL, not
  a comment, so `DELETE FROM invoices WHERE id = 7; -- [E2E]` is refused; before, one marker anywhere
  exempted the whole batch. Unchanged and deferred: a batch-wide `[E2E]`, a comment included, still
  exempts ordinary inserts and updates. The guard now denies an event it cannot read or a classifier
  error instead of allowing it (Luna rounds 1–3).
- Vercel: 35 current connector tools that change live settings had no deny entry (DNS records,
  redirects, domain verification, sandboxes that run commands, team access/SSO, toolbar comments,
  `get_project_deletion_link`, which only reads but hands out a link that deletes the project). Added to
  `permissions.deny`. Other read-only tools are unchanged.
- Secrets: `Read` of real `.env` files (not the `.example` files) and the plain `cat`, `type` and
  `Get-Content` forms of `.env`, `.env.local`, `.env.production`, `.env.development`, `.env.staging`
  and `.env.test`, plus a few `./` spellings, are now
  denied. Bash rules match command text only, so other spellings still get through: a speed bump, not a
  boundary.
- The migration-apply and live-data gates now carry `onFailure: "block"` (Claude Code 2.1.295+), so a
  crashed or timed-out check refuses the call instead of allowing it. `migration-apply-guard.mjs` also
  refuses an unreadable tool call.

**Noise removed.**
- Hold latch (`prompt-source-lib.mjs`). Claude Code 2.1.304 hands a background subagent's report to
  UserPromptSubmit hooks as the bare body, opening with the harness's `[Subagent hand-back]` frame line
  and without the preamble and tags the stripping keyed on. Four audit reports latched a hold (and fired
  the ship reminder) in a session where Mason never said stop. Replaying those four real reports: all
  four latched before, none after; a typed "stop" still latches.
- `review-proof-guard.mjs` no longer denies Read, Grep or Glob on `.claude/session-state`; writes there
  are still denied.
- Matchers: the migration gate runs only on `apply_migration` (it loaded a ~330 KB rule book on every
  MCP call, ~250 ms), the live-data guard only on `execute_sql`, `mcp-tool-guard.mjs` only on the tool
  names it checks, and `review-proof-guard.mjs`/`hold-latch-guard.mjs` skip Read, Grep and Glob.
- `worktree-cleanup.mjs` stays automatic (Mason, 2026-07-13) but runs in the background (`async: true`):
  it took 30–35 s against a 30 s timeout, delaying every session start. Its in-session report gives a
  count of kept branches instead of ~180 names.

**Deferred to later PRs, per the Codex review:** removing `codex-push-guard.mjs` (keep a narrow gate
until disguised and non-main pushes are mapped), `active-area-guard.mjs` and `mcp-tool-guard.mjs` (both
kept; they are opt-in or cover any server), the autopilot hook (woven through the push, migration and
hold gates), a per-session hold latch (rejected: a stop must reach every session on the checkout),
merging the SQL authoring checks, and the skill/command and stale-instruction cleanup. `.codex/hooks.json`
keeps its existing matchers; Codex runs the same hook files, so the code fixes reach it.

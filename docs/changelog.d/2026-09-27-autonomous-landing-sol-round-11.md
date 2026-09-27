## 2026-09-27 - autonomous landing: overwriting data waits for Mason too

**Sol HIGH ×2, round 11 on PR #804.** (1) The destructive check only named deleting, so a migration
such as `UPDATE public.invoices SET total_amount_cents = 0` applied by itself. (2) Replacing an
authenticated-callable SECURITY DEFINER function with one that reads `auth.users` changed no grant,
so the access classifier passed it. Shown the measured cost of each option, Mason chose **"Data
rewrites wait"** (DECISION_LOG 2026-09-26, item 6).

- New `dataRewriteCheck()` in `.claude/hooks/migration-access-lib.mjs`, run by the apply guard
  between the destructive and access checks and by the daily summary: an apply-time UPDATE,
  INSERT ... ON CONFLICT DO UPDATE, MERGE or column type conversion on a table the migration did not
  create is Mason's, and so is a function the migration runs while applying (defined in it or in an
  earlier migration, followed through the functions it calls) whose body changes rows or runs dynamic
  SQL. A name that is only named (`ALTER FUNCTION f(...)`, a string, a DO block's own `$tag$` text) is
  not a call. Adding rows or columns stays routine. Without the migration history (the daily
  summary), a call to an earlier `public.` function is unknown and listed for Mason.
- `accessChangeCheck()` now reads SECURITY DEFINER bodies: one that reaches `auth`, `storage` or
  `vault` (other than `auth.uid()`/`role()`/`jwt()`/`email()`) is Mason's, as is a SECURITY DEFINER
  body the check cannot locate.
- The daily summary's footer now says overwriting data stays Mason's. AGENTS.md is unchanged: on a
  Windows checkout (CRLF) it sits 2 bytes under its 12,000-byte budget and its autonomous-landing
  wording is pinned by `check-agent-guidance.mjs`; its "the merge and apply gates enforce it" defers
  to the gate, and DECISION_LOG items 3 and 6 carry the rule.

**Measured** on the last 60 real migrations with the real history: 35 apply by themselves, 25 wait
(10 destructive, 4 data rewrites — the line-profit backfill, commission snapshot reconcile, quote cost
snapshot and order-line cents repair — and 11 access). Three false alarms found in that run were
fixed before counting (a function named in `ALTER FUNCTION ... RENAME` inside a DO block, a name inside
a string literal, a name inside a DO block's `$checks$` JSON). Slowest check 0.5 s against the hook's
15-second budget. Tests: `migration-access-lib` 108 (was 79), `migration-apply-lib` 270 (was 267,
including the gate refusing an UPDATE and a history-read widening end to end).

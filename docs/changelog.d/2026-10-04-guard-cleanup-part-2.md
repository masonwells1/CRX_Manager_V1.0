## 2026-10-04 — guard cleanup, part 2: dead reminders deleted, three false-alarm sources fixed

Follow-up to part 1 (`2026-10-02-guard-cleanup-noisy-blocks.md`), under Mason's 2026-10-02 decision that guards block only what cannot be undone.

**Removed**

- The five prompt reminders part 1 unwired — `dangerous-phrase-warning`, `codex-gauntlet-reminder`, `agent-pair-review-reminder`, `codex-to-claude-handoff-reminder`, `autopilot-intent-reminder` — with their own tests, their `package.json` test entries, the agent-health required-file entry and the `SETUP-NEW-MACHINE.md` demo.
- The overnight handshake in `unattended-autopilot.mjs` / `autopilot-lib.mjs` (`intentFresh`, `overnightGateDecision`, the arm-command allowance) and `overnight-intent-clear.test.mjs`. Nothing writes `OVERNIGHT-INTENT.flag` any more. Armed autopilot is unchanged.

**Changed**

- `live-testdata-lib.mjs`: read-only catalog functions that were refused as application RPCs in real sessions are allowed (`pg_get_userbyid`, `pg_get_triggerdef`, `pg_get_function_identity_arguments`, `pg_get_function_arguments`, `pg_get_function_result`, `to_regprocedure`, `aclexplode`, `oidvectortypes`, `auth.uid()` and close siblings), and a column-alias list (`AS t(x)`) or typmod cast (`::numeric(12,2)`) is no longer read as a call.
- `codex-push-lib.mjs` (shared by the merge guard, the push guard and Codex's production guard): the "program built at run time" check blanks single-quoted text first and reads each `$( … )` as one word, checking its inside separately. awk scripts such as `'$2=="pending"'` and assignments such as `x=$(echo "$f")` had made ordinary read-only loops look like hidden merges.

**Kept on purpose**

- `loop-guard.mjs` is not dead: it is the lock the `codex-driven-bug-hunt` workflow registers in its own worktree, and inert everywhere else.

**Proof observed**

- Real hook processes, current main vs this branch. Merge and push guards: the three most common refused read-only commands from recent sessions (a `gh pr checks | awk` count, a `while read` + `git show` loop, a `git diff | awk` sum) were DENIED on main and allowed here; every one of the 20 attack shapes main denies (of 23 tried) is still denied, and two main allowed (`x=$($P pr merge 1 --admin)` and its nested twin) are now denied. The third, `x=$(echo me); gh pr "${x}rge" 1 --admin`, is allowed on both. That gap is not new, and GitHub's protect-main ruleset, which has no bypass actors, still refuses the merge. Live-data guard: `pg_get_userbyid`/`pg_get_function_identity_arguments`, `pg_get_triggerdef` and a `::numeric(12,2)` read went BLOCK → allow; `SELECT save_invoice(...)` and `SELECT approve_return(1)` stay blocked. Autopilot: with a fresh `OVERNIGHT-INTENT.flag` and autopilot unarmed, main denied an Edit with "OVERNIGHT HANDSHAKE" and this branch does nothing; armed, both allow the Edit and deny `git push --force origin main`.
- `npm run test:correction-guards` and `npm run test:agent-workflows` exited 0, with regression cases for each fix.

**Not verified**

- The new allowances were not exercised through a live session's hooks, because a session runs the main checkout's copies until this merges.
- Still open from the audit, deliberately not changed: `codex-push-guard` refuses `cd <dir> && git push` and names `git -C <dir> push` instead. It fires only on real pushes, and its message says exactly what to run.

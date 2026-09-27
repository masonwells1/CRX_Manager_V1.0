## 2026-09-26 - autonomous landing: close the two findings from the exact-SHA Sol review of PR #804

**HIGH — a live migration could pass without its PR's final reviews.** The apply gate checked the
migration's own reviewer and Sol proofs but not the pull request carrying it. New
`.claude/hooks/migration-landing-gate-lib.mjs`, run as the LAST step of
`migration-apply-lib.mjs`, requires a clean checkout of the PR's branch with the migration committed
at HEAD, HEAD equal to the open PR's head into `main`, CodeRabbit APPROVED on that head, no
CHANGES_REQUESTED, the newest run of every check green with `mergeStateStatus` CLEAN, and a fresh
exact-SHA `gpt-6-sol` merge proof bound to that head and GitHub's base — the merge gates' own
predicates. Anything unreadable fails closed. Tested with 20 refusal cases plus the rule-book wiring;
the hook and script suites now treat "stopped at the landing gate" as "every local check passed",
because a fixture cannot have a real PR. Real run: refused an apply from #804's branch (CodeRabbit
had not approved) and from `main` (not a PR branch).

**MEDIUM — a queued rerun could hide behind an older success.** `newestCheckRollup` now ranks any
CheckRun that has not COMPLETED as newest, whatever its (possibly missing) `startedAt`.

Also brought the injected landing-policy reminders (`prompt-source-lib.mjs` `PUSH_POLICY`,
`session-context-reminder.mjs`, `autopilot-intent-reminder.mjs`) in line with the rule — they still
said armed runs park every push and merge and that migrations need an in-chat OK.

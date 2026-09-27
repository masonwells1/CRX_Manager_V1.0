## 2026-09-26 - autonomous landing: pin every agent merge to the checked head; bound the landing gate in time

**Sol round 3 on PR #804** raised two HIGH and one MED, all fixed:

- **HIGH — a slow landing check could leave a live apply ungated.** The migration hook has a 15-second
  budget and a killed hook allows. `migration-landing-gate-lib.mjs` now runs every git/gh call under a
  wall-clock deadline (`deadlineMs`, passed by `migration-apply-guard.mjs` via `hookDeadlineMs(15000,
  3000)`), caps each call by the time left, and refuses — while it can still speak — once too little
  remains. The apply script, which has no hook limit, gives it a minute.
- **HIGH — the merge command was not bound to the reviewed head.** A push racing the merge could land
  unreviewed. `ghMergeRequest` now reads `--match-head-commit` (value positions honoured, last value
  wins), and both `pr-merge-guard.mjs` and the Codex `production-action-guard.mjs` deny any merge into
  `main` whose pin is missing or differs from the head they checked; REST and connector merge routes
  cannot carry it and are refused. Armed autopilot's merge shape now requires the pin exactly once.
- **MED — a repeated StatusContext was judged by list order.** `newestCheckRollup` keeps the WORSE state
  of a repeated status context.

Real runs on PR #804 through the branch's merge guard: no pin and a wrong pin were refused with the
exact head to pin; the correct pin passed that check and stopped at "CodeRabbit has not APPROVED".

## 2026-09-26 — close CodeRabbit's review of the GPT-6 guidance change (PR #797)

CodeRabbit reviewed PR #797 at `d5586ab1` and requested changes (four findings). Three were
confirmed against the current files and fixed here; the fourth was already fixed by the merge with
PR #796.

- `.claude/commands/ship.md` — a required gate that ran degraded or could not run is no longer
  listed with actions Mason can approve. It now has its own rule: do not land, do not self-certify,
  stop and hand over per the `AGENTS.md` stop rule; approval never replaces the gate.
- `.claude/commands/ship.md` — the Trivial light path, the one exception to the review fan-out, now
  also excludes inventory, auth, permission, and other business-critical changes, so a one-file
  permission change cannot skip the Sol review that `AGENTS.md` requires.
- `.claude/hooks/codex-gauntlet-reminder.mjs` — defaults to per-change mode only when the *mode* is
  unclear, matching `codex-gauntlet.md`; the command's own scope rule picks what to review.
- Already fixed: the decision-log and changelog claims that every Codex command still used GPT-5.6
  were rewritten when #796's GPT-6 pins were merged in. The decision-log entry now also says Sol
  builds money and database units.

**Proof observed (cloud session):** `npm run test:agent-workflows`, `scripts/check-agent-guidance.mjs`,
`scripts/check-doc-drift.mjs`, and all 53 top-level hook and script test files passed.

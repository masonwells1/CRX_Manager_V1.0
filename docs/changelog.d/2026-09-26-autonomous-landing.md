## 2026-09-26 — autonomous landing: agents merge and apply non-destructive migrations once the final reviews are clean

**What Mason decided.** In this session, after the rule was restated to him, Mason replied "Yes I
approve": when CodeRabbit has approved the exact final head, a fresh exact-SHA `gpt-6-sol` review of
it is clean, and every required check is green, the agent merges by itself and applies that change's
non-destructive migration live, in any session. Destructive migrations, Edge Function deploys, and
secrets/auth/billing/permissions changes stay his. He gets a daily plain-English summary. Recorded in
`docs/manual/DECISION_LOG.md` (2026-09-26), which supersedes the relevant parts of the 2026-06-16,
2026-07-13, 2026-07-17, 2026-09-02 and 2026-09-20 entries.

**What changed.**
- **Merge gates** (`.claude/hooks/pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`,
  shared `codex-push-lib.mjs`): a merge into `main` now needs CodeRabbit's latest verdict APPROVED on
  the exact head (`coderabbitApprovedHead`), the NEWEST run of every reported check green with
  `mergeStateStatus` CLEAN (`newestCheckRollup` — an older failed lifecycle run, which no rerun could
  clear, no longer blocks forever), and a fresh Sol proof for EVERY diff, not only risky ones.
  `--auto` into `main` is refused. The Claude gate now makes one `gh` call instead of three.
- **Migration apply gate** (`migration-apply-lib.mjs`, `scripts/apply-migration-file.mjs`): the
  formerly hands-free-only proof set (content binding, both reviewer names, fresh content-bound Sol
  proof) applies in every session, and there is no longer an in-chat ask for a non-destructive
  migration. Destructive SQL is refused for agents in every session; the only door is Mason's in-chat
  yes plus `--mason-approved-destructive`, unarmed only, every proof still required. New
  `migration-landing-gate-lib.mjs` (from the exact-SHA Sol review's HIGH) binds every apply to its PR:
  a clean checkout of the PR branch, migration committed at the open PR's head, CodeRabbit APPROVED,
  green checks and a fresh Sol merge proof — so no migration reaches production before its PR's final
  reviews. The merge gate also ranks an unfinished (queued) check run as newest (Sol's MEDIUM).
- **Armed autopilot** (`autopilot-lib.mjs`, `unattended-autopilot.mjs`): lets exactly two whole-command
  shapes — a plain `git push origin <work-branch>` and a plain `gh pr merge <n>` — through to the push
  and merge guards; every other push or merge spelling is still denied (50-case bypass corpus in the
  tests).
- **CodeRabbit lifecycle** (`.coderabbit.yaml`, `.github/scripts/coderabbit-final-review.cjs`,
  `.github/workflows/coderabbit-final-review.yml`): the summary goes in the walkthrough comment so a
  review no longer re-runs CI; the gate waits out running checks (80 x 15 s) instead of failing; an
  unrelated edit during a dispatch is a neutral pass, not a permanent red row; the provider label is
  released once a review lands and a relabel reconciles from the receipt; a push records a trusted
  candidate epoch so a fix on the SAME PR earns one follow-up review (`auto_incremental_review: true`);
  and a stale CodeRabbit objection on an older commit no longer blocks its own follow-up review. The
  pre-merge check "Edit to an already-applied migration" is a warning — the required CI check
  `check-migration-hard-rules` is the hard gate and knows the applied boundary.
- **Daily summary** (`scripts/daily-landing-summary.mjs`, `.github/workflows/daily-landing-summary.yml`):
  read-only; posts one @-mention comment a day to a "Daily landing summary" issue.
- **Docs**: `AGENTS.md`, `docs/manual/OWNER_PLAYBOOK.md` (Mason's list is now exactly: destructive
  migrations, Edge Function deploys, secrets/auth/billing/permissions), `.claude/commands/ship.md`,
  `docs/reference/coderabbit-native-review.md`, `docs/reference/agent-guardrails.md`,
  `docs/reference/gotchas.md`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, and the `deploy-check`,
  `codex-review`, `create-migration` and `new-rpc` skills (Codex adapters regenerated).

**Not done here, stated plainly.** `.claude/settings.json` still lists `Bash(gh pr merge:*)` in its
`ask` tier, which the repo's `defaultMode: "dontAsk"` turns into a silent denial in an ordinary
session; the agent could not edit its own permission file (the auto-mode classifier refused it), so
removing that one line is Mason's. This PR changes the merge gate and lifecycle workflow themselves,
so it cannot pass its own new rules — Mason merges it by hand, once.

**Proof.** `node .github/scripts/coderabbit-final-review.test.cjs` 251 passed (30 new);
`npm run test:correction-guards` all passed (pr-merge-guard 184, autopilot-lib 314, migration-apply-lib
256, migration-apply-guard 123, codex-bot-review-lib 124, prompt-hooks 274); real-data runs of the branch's
guards: merging #804 was refused (no CodeRabbit approval), `--auto` refused, PR #794's real 54-row
rollup was "blocked forever" under the old rule and green under the newest-run rule, and the landing
gate refused an apply from #804's branch (not approved) and from `main` (not a PR branch); `npm run test:agent-workflows` passed
(production action guard, manifest parity, daily summary 24); `npm run lint` and `npm run typecheck`
clean; a real read-only dry run of the daily summary against GitHub listed the last 72 hours' four
merges and posted nothing.

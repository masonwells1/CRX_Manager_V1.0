## 2026-09-28 — CodeRabbit follow-up clearance: a clean re-review after an approval can land on its own

**Problem (handoff item 3, seen on PR #820).** After CodeRabbit APPROVES a pull request, a later
push that CodeRabbit re-reviews and finds nothing in creates **no new review record**. It only
edits its summary comment and sets its `CodeRabbit` commit status on the new head to
`Review completed`. Both exact-head gates needed a CodeRabbit review whose commit equals the new
head, so neither could clear: the lifecycle check (run `36303041057`) reported "no completed
exact-head review", the documented relabel (run `36303473943`) reported "no second dispatch will be
posted", and every PR with a post-approval fix needed Mason to merge by hand.

**Change.** A head now also counts as cleared when, from data only CodeRabbit can write:
(1) CodeRabbit's latest verdict is APPROVED; (2) nothing CodeRabbit submitted at or after that
approval carries content (empty thread-reply artifacts are tolerated); and (3) the newest
`CodeRabbit` status on the exact head was created by the `coderabbitai[bot]` Bot account, is
`success` with the description exactly `Review completed`, and is newer than the approval (in the
lifecycle workflow, also newer than the head's verified dispatch receipt).

- `.claude/hooks/codex-push-lib.mjs`: new `coderabbitFollowUpClearedHead()` (pure) and
  `coderabbitClearedHead()` (exact-head approval, else one `gh api …/commits/<head>/statuses` read;
  any read failure refuses). `pr-merge-guard.mjs`, `migration-landing-gate-lib.mjs` and the Codex
  `production-action-guard.mjs` now call `coderabbitClearedHead()`.
- `.github/scripts/coderabbit-final-review.cjs`: `inspectExactHeadCodeRabbitReview()` accepts the
  same follow-up through `inspectCodeRabbitFollowUp()`, only when a dispatch receipt supplies
  `requestedAfter` (the pre-dispatch lookup is unchanged, so an unattributed completion neither
  credits nor blocks a request).
- Docs: `AGENTS.md` (one clause in the autonomous-landing rule), `.claude/commands/ship.md` Step 8,
  `.claude/skills/deploy-check/SKILL.md`, `docs/reference/coderabbit-native-review.md` (new
  "Follow-up after an approval" section), `docs/reference/agent-guardrails.md`,
  `docs/manual/DECISION_LOG.md`.

**Still refused:** a stale approval carried forward (the head's newest CodeRabbit status is
missing, `Review in progress`, `Review skipped …`, or older than the approval); an approval of a
different SHA with no completion on this head; an approval followed by findings, an objection or a
dismissal; a `CodeRabbit` status written by any other account, or a newer one from anyone else.

**Evidence the ordering is safe.** On every observed follow-up that DID find something (#797
`d5586ab1` and `cb037319`, #800 `c4144b4b`, #806 `17acac79`, #810 `c86c7685`, #816 `47632834`,
#818 `ac3249de`), CodeRabbit's review was submitted 6-8 seconds BEFORE its `Review completed`
status, so a completion with no newer review record means the run posted no findings.

**Proof observed.** New tests use #820's real reviews and statuses. Against the old code, the
three "should clear" cases fail (the bug reproduced); with the change all pass:
`.github/scripts/coderabbit-final-review.test.cjs` 266/266, `pr-merge-guard.test.mjs` 251
assertions, `migration-apply-lib.test.mjs` 277, `production-action-guard.test.mjs`,
`codex-bot-review-lib.test.mjs`, `migration-apply-guard.test.mjs` and `codex-push-lib.test.mjs`
all green.

**Not verified here.** Written in a cloud session with no Codex CLI and no `gh`: no Luna round and
no Sol proof have run, and the live gates have not yet cleared a real post-approval push. Because
this changes the merge gates and the trusted workflow, it is judged by the copies already on
`main` and cannot pass its own new rules: Mason merges this PR by hand once. The first later PR
with a post-approval fix is the live proof that it lands on its own.

**Noticed, not changed.** GitHub reported #820's approval (submitted 06:24 on `2d231b66`, where
CodeRabbit's `Review approved` status sits) with `commit_id` `ffb400b2`, the "Update branch" merge
made at 06:47. A review's `commit_id` is not always the commit it was submitted on; the older
exact-head approval rule relies on it. Recorded in `docs/reference/coderabbit-native-review.md` as
a follow-up to evaluate.

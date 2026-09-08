## 2026-09-08 — landing workflows: stop requiring the CodeRabbit label path

The companion entry (`2026-09-08-pr-merge-guard-coderabbit-request-path.md`) fixed the two
messages inside `pr-merge-guard.mjs`. That was not enough, and the Codex GitHub App said so
on the PR — a P1 that was verified against source and is correct.

`.claude/commands/ship.md`, `.claude/skills/deploy-check/SKILL.md`, and
`.claude/skills/codex-review/SKILL.md` all still specified **apply `ready-for-coderabbit`** as a
required landing step. Those are the instructions an agent reads *first*. The guard's corrected
warning is what it reads *last*, immediately before merging. So an agent would follow the
canonical workflow down the path that produces no review, wait on a review that never arrives,
and only meet the contradiction at the merge hook. The sign at the destination had been fixed
while the sign at the trailhead still pointed the wrong way.

**What changed in all three.** The landing path is now stated as **push a branch → open a PR →
finish required checks → freeze the candidate → merge the frozen head with
`--match-head-commit`**. Each file now says plainly that CI is the merge gate and an approving
review is not required, names the hourly `crx-hourly-coderabbit-slot` task as the review-request
path, and instructs agents not to apply the label and not to hand-post `@coderabbitai review`.
The measured reason travels with the instruction — bot-authored commands go unanswered
(2026-09-07: ~24 uses, zero reviews; #535 unanswered for 104 minutes, versus 5–11 seconds from
Mason's account) — because an instruction without its reason is what got "corrected" back to the
broken path in the first place. The ~1 grant/hour fleet-wide rationing is stated too, so the
harm of a hand-posted second request is legible: it collides with the job and consumes the slot
another PR was waiting for.

**Approval verification.** Where these files told agents to match a CodeRabbit approval against
the label workflow's hidden "gate marker SHA", they now match the authenticated `APPROVED`
review's `commit_id` against the final `headRefOid`. The marker does not exist on this path, and
the authenticated review was always the part doing real work; the generic Actions-authored marker
was only ever dedupe evidence.

**A missing CodeRabbit review is no longer written as a blocker anywhere, because it never was
one.** `required_pull_request_reviews` came off `main` on 2026-09-02. What did not change:
`CHANGES_REQUESTED` still blocks, both agent merge gates still refuse to merge over one, and the
exact-SHA `gpt-5.6-sol` proof remains the hard gate for risky money/RLS/migration diffs.

**Generated adapters.** `node scripts/sync-agent-workflows.mjs --write` regenerated the Codex-facing
copies under `.agents/` (37 files synced), so both agents read the same instructions.
`npm run test:agent-workflows` passes, including the "Codex workflow adapters match Claude
sources" parity assertion. `npm run agent-health` passes with one unrelated warning (the schema
registry trails four migrations that arrived with #592; no SQL is touched here).

**Documentation only.** No control flow, no guard behaviour, and no CI gate changed.

Scope deliberately stops at these three files. `AGENTS.md` carries the same stale label-path text
in its standing-policy section, but it is the hand-maintained shared contract and is flagged for
Mason rather than rewritten as a side effect of this change.

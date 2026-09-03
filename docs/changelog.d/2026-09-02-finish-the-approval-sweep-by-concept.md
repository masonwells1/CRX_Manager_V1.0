## 2026-09-02 - Finish the approval sweep: four more guides, found by concept not phrasing

Third Codex pass on this branch's head. The previous commit fixed the phrasings a grep matched and
declared the sweep done; Codex then named three more files still requiring formal approval, in
wording that pattern never covered. A fourth surfaced once the search moved from the phrase to the
concept.

This is a failure mode the repo already has a name for — sweeping one phrasing instead of the
concept. Recorded here because it was repeated inside a single pull request.

## Fixed (all files this branch already edits)

- `.claude/commands/ship.md:141` — told the operator to verify `main` protection "still requires a
  current branch, one current approval with stale-review dismissal, and last-push approval", then
  to require an authenticated `APPROVED` `commit_id` unconditionally. It also named "the formal
  exact-head GitHub approval" as the authorization for landing regular code.
- `.claude/skills/deploy-check/SKILL.md:143` — "GitHub requires one current formal approval and
  dismisses it after a new commit", plus the same protection check.
- `docs/reference/gotchas.md:315` — "GitHub requires a current formal approval, so a misleading
  green CodeRabbit status cannot unlock the merge by itself: the missing approval keeps the PR
  blocked."
- `docs/workflows/SAFE_DEVELOPMENT_RULES.md:236` — required the marker SHA, "authenticated
  CodeRabbit approval SHA", and live head to match, with no approval-optional branch.

## The gotchas entry was backwards, so it was inverted rather than deleted

Its subject is that a green CodeRabbit status row can mean the review never ran. It leaned on the
missing approval as the backstop that keeps such a PR blocked. That backstop disappeared on
2026-09-02, which makes the check it describes **more** load-bearing than when it was written, not
less: nothing else now stands between "CodeRabbit never actually ran" and a merge. The entry now
says exactly that.

## Unchanged

`CHANGES_REQUESTED` still blocks, both agent merge gates still refuse to merge over one, CodeRabbit
must still actually review the frozen candidate, an approval that does exist must still equal
`headRefOid`, and risky diffs still require the exact-SHA `gpt-5.6-sol` proof.

`.agents/` adapters regenerated with `node scripts/sync-agent-workflows.mjs --write`.
`npm run test:agent-workflows` passes (37 adapters match) and `npm run check:docs` passes.

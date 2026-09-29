## 2026-09-27 - push-guard branch: drop the `--disable-auto` denial wording that #804 made obsolete

Follow-up to `2026-09-23-push-guard-bundled-short-option-cluster.md`, on the same branch.

Merging current `main` conflicted in `.claude/hooks/pr-merge-guard.mjs` and
`.claude/hooks/codex-push-lib.mjs` with #804 (agents merge once final reviews are clean). #804
rewrote the red-pipeline denial to "wait for the checks to finish, fix any that failed, and retry"
and now refuses `--auto` outright. The sentence this branch had fixed, which told a
`--disable-auto` caller to "use `gh pr merge --auto`", therefore no longer exists on main.

Resolution: take main's merge guard unchanged and remove this branch's `disableAuto` field from
`ghMergeRequest` together with its tests, since nothing would read it any more. The merge guard,
its tests, and `ghMergeRequest` are now byte-identical to main; how a `--disable-auto` merge is
gated is exactly main's. This PR's remaining changes are the push-guard option fix, its tests, the
relocated `--disable-auto` comment in `.codex/hooks/production-action-guard.mjs` (its pointer to
`ghMergeRequest` still holds), and these changelog entries.

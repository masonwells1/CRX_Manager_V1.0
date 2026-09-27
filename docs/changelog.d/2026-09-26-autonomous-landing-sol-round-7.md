## 2026-09-26 - autonomous landing: refuse a PR that is behind main; flag unreadable migrations

**Sol HIGH, round 7 on PR #804.** The Codex merge guard already refused a pull request whose head does
not contain the base it merges onto, but the Claude merge guard and the new migration landing gate did
not. Where GitHub allows merging a behind branch, the merge would land `main` commits that the Sol
proof never reviewed alongside the change. Both Claude paths now ask GitHub's compare API
(`compare/<base>...<head>`, `behind_by` must be `0`) through the new shared
`headContainsBaseOnGitHub()` in `codex-push-lib.mjs`, and refuse — failing closed on any unanswerable
call. The merge guard's call spends the same hard-gate time budget as its PR lookup. Checked against
real GitHub: PR #804's head contains its base; an old `main` commit is refused.

**Sol MEDIUM, round 7.** `scripts/daily-landing-summary.mjs` treated a migration whose diff GitHub did
not return (too large to show) as empty SQL, so it could say nothing needed Mason. An unreadable
migration is now listed as waiting on a check.

Also fixed a stale line in the landing gate's refusal text that still said a destructive migration
could apply after Mason's yes.

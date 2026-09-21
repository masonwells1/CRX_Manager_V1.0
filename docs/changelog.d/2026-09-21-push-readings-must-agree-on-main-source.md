## 2026-09-21 - A push whose shell readings disagree on its source is refused

The push guards read a command two ways, POSIX and PowerShell, because they
cannot tell which shell will run it. The Windows-path exemption added on PR #630
let a trailing backslash through the composition check, and then the two readings
could name different refs as the one landing on main.

`git push origin --repo C:\x\ evil:main` pushes `evil` to main under PowerShell.
The POSIX reading binds the escaped space into one word and reads the source as
`C`, and the guard took the first answer it found, so the review proof was
checked against `C`. Main refuses the command outright as shell-ambiguous.

The composition check now also refuses a push whose readings name a different
source for main. Ordinary Windows local-repo pushes such as
`git push C:\scratch\repo.git HEAD:feature` read the same both ways and still
pass. Both guards call this one check, so the fix covers
`.claude/hooks/codex-push-guard.mjs` and `.codex/hooks/production-action-guard.mjs`
together. Locked in by assertions in `.claude/hooks/codex-push-lib.test.mjs`, and
checked through both real guard processes.

Found by the `gpt-5.6-sol` exact-SHA review of `572c5b7de` (HIGH) on PR #630.

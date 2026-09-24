## 2026-09-21 - A push the two shell readings split differently is refused

The push guards read each push twice, as POSIX and as PowerShell, because they
cannot tell which shell will run it. An earlier fix the same day refused a push
only when the two readings named a different source ref. Codex then found the
same root cause through a second consequence:
`git push --repo C:\x\ <crx-url> HEAD:main` split differently, the destination
vanished, and the CRX proof gate stood down. Main refuses the command.

The check now refuses any push whose two readings split the arguments into
different words, which closes every consequence of that disagreement at once.
Ordinary Windows paths, bare or quoted and with or without spaces, split the same
both ways and still pass. Locked in by assertions in
`.claude/hooks/codex-push-lib.test.mjs` and end-to-end denials through both the
Claude and Codex guards in `.codex/hooks/production-action-guard.test.mjs`.

Found by the `gpt-5.6-sol` exact-SHA review of `73dcb1135` (HIGH) on PR #630.

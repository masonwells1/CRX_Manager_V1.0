## 2026-09-30 - Guards: fish's `--command` and `--init-command` are unwrapped (PR #795)

Codex's GitHub reviewer found that `fish --command='gh pr merge 1 --admin'` passed both merge guards,
and the same spelling carrying `git push --force` passed the push guard. fish reads its options with
getopt, so `-c`/`--command` and `-C`/`--init-command` take attached, detached or abbreviated values
(`-c'…'`, `--comm=…`), and each value runs; only the POSIX `-c '…'` spelling was read. Every such value
is now a nested command the guards check in full.

Proof with the real hooks: seven fish merge spellings (including `-C '<merge>' -c 'echo hi'`) are refused
by both merge guards, the push spelling by both push guards, and `fish -c 'echo hello'` and
`fish scripts/x.fish` pass. A rerun of every earlier attack and control shows no change.

Not verified: fish itself was not run (it is not installed here); the option rules come from fish's documentation, and the guard reads command text only.

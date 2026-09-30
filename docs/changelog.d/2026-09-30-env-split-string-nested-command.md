## 2026-09-30 - Guards: `env --split-string` is unwrapped like `bash -c` (PR #795)

Codex's GitHub reviewer found that `env --split-string='gh mm 1'` ran an existing gh alias past both
merge guards. Testing the real hooks showed it was wider: `env --split-string='gh pr merge 123 --admin'`,
`env -S'…'`, `env -iS'…'` and `env -Sgh mm 1` all ran an administrator merge that both merge guards
allowed. Only the detached `env -S '…'` spelling was read.

GNU env's split string (attached, detached, clustered, or an abbreviated `--sp=`), followed by the rest
of the line, is now one of the nested commands every guard unwraps and checks in full. Proof with the
real hooks: all six forms are refused by both merge guards, the push form is refused by both push
guards, and `env --split-string='gh pr view 12'`, `env FOO=1 npm test` and `env -u HOME node …` pass.

Not verified: the guard reads command text only; GNU env was not run (this machine is Windows), and BSD env's own `-S` rules were not tested.

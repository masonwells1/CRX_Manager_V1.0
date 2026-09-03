## 2026-09-01 — second review round: read-only heads that write, `..` traversal, and an unwired ratchet

A second exact-SHA `gpt-5.6-sol` review of the fail-closed allowlist returned BLOCKED with two HIGH
findings and one MEDIUM. All three are closed here.

**H-1 — read-only heads that write a named file.** Hook probes returned ALLOW for
`node -e "…writeFileSync('.husky/pre-push'…)"`, `sed -n 'w .husky/pre-push' /dev/null`,
`sort -o .husky/pre-push /dev/null`, `find … -fprintf .husky/pre-push …`, and
`awk -v p=.husky/pre-push '… > p'`. These are not the documented hidden-indirection residual — the
target is in the command text. `sed`, `awk`, and `sort` are removed from the read-only heads
entirely (reads never need them; `cat`/`head`/`grep`/`git show` cover it). `node`/`npm`/`npx`/`pnpm`/
`yarn` stay, because `node <script>` is how these suites run, but the inline-code flags
(`-e`, `-p`, `--eval`, `--print`, `--input-type`) are refused. `find`'s action list gained `-fprintf`,
which the old `fprint\b` missed because the trailing `f` is a word character.

**H-2 — `..` traversal, both channels.** `.claude/commands/../hooks/review-proof-guard.mjs` resolves
onto the real hook, and separators were normalized while dot segments never were, so both the shell
scan and the path-field check returned ALLOW. Both now resolve dot segments before matching. This
bypass had been found and closed once already, in the lock this rule replaced; not porting the
resolution re-opened something its own history classified HIGH.

**M-1 — the guard-claim ratchet ran nowhere.** It was invocable by hand only — absent from
`test:correction-guards`, the pre-push hook, and CI, so a new unannotated safety claim failed nothing.
It and its mutation test now run in `test:correction-guards`, which the pre-push gate executes.

**Also fixed, found by the rule breaking a real command rather than by review:** the git subcommand
parser skipped global flags but not the VALUE of flags that take one, so `git -C <dir> add …` read
`<dir>` as the subcommand, found it unknown, and failed closed on an ordinary stage. It now skips the
flag and its value before taking the first bare token. `-C`, `-c`, `--git-dir`, `--work-tree`,
`--namespace`, `--exec-path`, `--config-env`, and `--super-prefix` are covered, with tests.

Verified live against the real hook, not only in tests: `sort -o .husky/pre-push /dev/null` and
`cp /dev/null .claude/commands/../hooks/…` are both refused; `node <script>` and ordinary reads still
pass. The guard also refused this change's own `sed` read of the file being edited, which is the
removal of `sed` working as intended.

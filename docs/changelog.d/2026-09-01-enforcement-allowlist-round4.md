## 2026-09-01 — fourth review round: a protected path as a flag's VALUE is a write, whatever the flag is called

A fourth exact-SHA `gpt-5.6-sol` review returned BLOCKED on one HIGH. The git subcommand list was
enforced but its FLAGS were not, so read-only subcommands could overwrite the files this rule exists
to protect. Probe-confirmed ALLOW:

- `git diff --output=.husky/pre-push HEAD~1 HEAD`
- `git show --output=.github/workflows/ci.yml HEAD:package.json`

**The fix is a shape rule, not another flag list.** A protected path supplied as the *value of a
flag* is an output target, whatever the flag is named; a protected path in a *positional* operand is
a read. That distinction holds for flags nobody has invented yet, which a `-o`/`--output`/`--out-file`
enumeration would not — and this file's history already contains that mistake twice.

A blanket `-o` ban was rejected for the opposite reason: `grep -o pattern .husky/pre-push` writes
nothing, and refusing it would be a false denial of an ordinary read. So the inline `--flag=value`
form always denies when the value is protected, while the space-separated form denies only for flags
that genuinely take an output path. That narrow list sits **on top of** the fail-closed head
allowlist, not in place of it: an unlisted output flag on an unlisted head was already refused.

Tests pin both directions, including the false-positive class an earlier draft of this rule created —
`git diff --stat <hook>`, `git log --oneline -5 <hook>`, and `grep -o pattern <hook>` are valueless
flags followed by positional paths and must stay allowed.

Verified live against the real hook, not only in tests: `git diff --output=.husky/pre-push …` is
refused, while `git diff --stat .claude/hooks/review-proof-guard.mjs` and
`grep -o typecheck .husky/pre-push` both still return their output.

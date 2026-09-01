## 2026-09-01 — third review round: command wrappers, output-operand utilities, and the audit failing on its own author

A third exact-SHA `gpt-5.6-sol` review returned BLOCKED. Both findings are closed here.

**BLOCKER — the newly required audit failed on this very branch.** `scripts/guard-claim-audit.mjs`
exited 1 because a comment added to `review-proof-guard.mjs` after the previous audit run contained an
unannotated "fails closed" claim. That audit had just been wired into `test:correction-guards`, which
full CI runs — so required CI could not have passed. The claim is annotated now. The lesson is the
uncomfortable one: the ratchet was added in this same branch, and its author was the first person to
break it, by editing a comment after the last green run and not re-running the check before
committing.

**HIGH — wrappers and output-operand utilities defeated the head-only allowlist.** Validation looked
only at the first token, so a wrapper hid the real program: bare `cp … .husky/pre-push` was denied
while `command cp … .husky/pre-push` was ALLOW. Probes also passed for `uniq in .husky/pre-push`
(second operand is the output file), `diff --output=…`, `yq -i`, `xxd -r`, and `npx rimraf .husky`.

`command`, `uniq`, `diff`, `yq`, `xxd`, `npm`, `npx`, `pnpm`, and `yarn` are removed from the
allowlist. `node <script>` stays — it is how these suites run — with the inline-code flags still
refused. Every other wrapper (`env`, `exec`, `nice`, `timeout`, `xargs`, `sudo`, `stdbuf`, and
anything invented later) is refused simply by never being listed, which is the allowlist working as
designed rather than another enumeration. Regression tests cover all of them, including wrappers
nobody has tried yet.

Verified live against the real hook, not only in tests: `command cp … .husky/pre-push` and
`npx rimraf .husky` are both refused; `cat .husky/pre-push` and `node .claude/hooks/…test.mjs` still
pass. The claim audit reports zero new unbacked claims.

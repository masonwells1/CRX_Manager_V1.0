## 2026-09-01 — fifth review round: path-qualified heads, command redefinition, and read tools being denied

A fifth exact-SHA `gpt-5.6-sol` review returned BLOCKED.

**HIGH — the command NAME was trusted, so it could be forged two ways.** Both probe-confirmed ALLOW:

- `scripts/cat .husky/pre-push` and `/tmp/git diff .github/workflows/ci.yml` — the basename was
  taken as the program, so any file the agent can create, named `cat` or `git`, inherited the
  allowlist. A path-qualified head is no longer vouched for at all; only a bare command name is.
- `cat(){ cp /tmp/evil "$1"; }; cat .husky/pre-push` — the definition and the call sit in *different*
  segments, and segments are judged independently, so the second one's head read as the allowlisted
  `cat` while the first had already redefined it. Command redefinition is now judged over the whole
  command rather than per segment, covering `function`, `alias`, `eval`, and `source` as well.

**MEDIUM — the guard was denying the reads it promises.** The path-field rule exempted only the
native writers and the hook is registered under `matcher: "*"`, so `Read`, `Grep`, and `Glob` against
a protected path were all DENIED — flatly contradicting this guard's own refusal text. The read-only
built-ins are exempt now. This is the third thing the deleted lock had and this port dropped
(after `..` traversal and the fail-closed shell allowlist), so the exemption is written out
explicitly rather than left to be inferred.

**A second known over-block is now pinned in the tests** alongside the `.coderabbit.yaml.bak` one:
segment splitting is not quote-aware, so `grep -E "(a|b)" <protected>` splits on the `|` inside the
quotes and the fragment after it reads as an unallowlisted head — an ordinary read, refused. Left
unfixed deliberately. A quote-aware splitter changes what counts as a segment, and mistakes in that
direction turn denials into ALLOWs, which is precisely how five rounds' worth of bypasses got in. A
false refusal with a one-line workaround is the acceptable failure; a speculative rewrite of the
splitter at the end of a long correction chain is not.

Verified live against the real hook, not only in tests: the function-shadowing and path-qualified-head
writes are both refused, a native `Read` of `.husky/pre-push` now returns the file, and
`cat .husky/pre-push | head -2` still works.

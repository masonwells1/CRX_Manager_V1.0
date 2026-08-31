## 2026-08-31 — treat a command-line `clean.requireForce=false` override as a destructive `git clean`

`git clean` refuses to delete without `-f` or `-n` **because of** the `clean.requireForce` setting.
Overriding it on the command line therefore deletes without the command ever naming `-f`:

```bash
git -c clean.requireForce=false clean -e '*.tmp'
```

`GIT_CLEAN_DESTRUCTIVE_RE` in `.claude/hooks/bash-safety-lib.mjs` now also matches a command-line
`clean.requireForce` override. Such invocations are blocked unless they match the dry-run allowlist —
which they cannot, because that grammar admits no global-option prefix at all.

Two corrections from the follow-up review of the first version of this fix (CodeRabbit, PR #527):

- **Git's false booleans are `false`, `no`, `off`, `0`, and an empty value.** Matching only the
  literal `false` let `git -c clean.requireForce=0 clean -e '*.tmp'` through (P1). A boundary
  lookahead keeps `=true` — and any other value — from matching.
- **The override alternative is now anchored to a real `git … clean` invocation** (P2). Unanchored,
  it denied read-only commands that merely contain the text, such as
  `rg -n "clean.requireForce=false" .` — a new false positive introduced while fixing false
  positives. The trailing `clean` is matched *after* the value, so
  `git -c clean.requireForce=false status` stays allowed.

**Not a regression.** The base pattern on `main` misses this too; it keys on `--force` or an `f`/`d`/`x`
option cluster, and this spelling has neither. What the same-day dry-run allowlist record
(`2026-08-31-git-clean-dry-run-allowlist.md`) got wrong was *describing* an exclude-only invocation as
"not destructive" — in its prose and in a test name. Both are corrected; the behaviour for a plain
`git clean -e '*.tmp'` with no override is unchanged from base.

**Known and not closable at this layer:** the same setting placed in a user's `.gitconfig` is invisible
to a guard that reads command text. Unchanged from base, now stated rather than implied.

Raised by CodeRabbit on PR #527 (Major) — a defect class four rounds of `gpt-5.6-sol` exact-HEAD
review did not surface, because those rounds found shell-*parsing* bypasses while this one is a git
*configuration* semantic. Further evidence for the standing rule that the two reviewers find disjoint
defects and neither substitutes for the other.

Pinned in both directions. Blocked: with an exclude, bare, whitespace-spaced, upper-case, combined
with a dry run, and each false-boolean spelling (`false`, `no`, `off`, `0`, empty). Allowed:
`=true`, `git config --get clean.requireForce`, an override with no `clean` subcommand, and
searching for the config text with `rg`/`grep`. `bash-safety` suite 445 → 460 assertions.

No product code, migration, database, money, inventory, RLS, or customer-visible change.

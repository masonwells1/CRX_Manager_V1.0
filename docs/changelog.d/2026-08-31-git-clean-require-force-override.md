## 2026-08-31 — treat a command-line `clean.requireForce=false` override as a destructive `git clean`

`git clean` refuses to delete without `-f` or `-n` **because of** the `clean.requireForce` setting.
Overriding it on the command line therefore deletes without the command ever naming `-f`:

```bash
git -c clean.requireForce=false clean -e '*.tmp'
```

`GIT_CLEAN_DESTRUCTIVE_RE` in `.claude/hooks/bash-safety-lib.mjs` now also matches a command-line
`clean.requireForce=false` (case-insensitive, whitespace-tolerant). Such invocations are blocked
unless they match the dry-run allowlist — which they cannot, because that grammar admits no
global-option prefix at all.

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

Pinned in five spellings, all blocked: with an exclude, bare, whitespace-spaced, upper-case, and
combined with a dry run. `bash-safety` suite 445 → 450 assertions.

No product code, migration, database, money, inventory, RLS, or customer-visible change.

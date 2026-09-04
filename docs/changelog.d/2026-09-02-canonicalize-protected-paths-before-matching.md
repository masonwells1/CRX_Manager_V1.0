## 2026-09-02 — every protected harness path could be reached through a `../` detour

Found by the exact-SHA `gpt-5.6-sol` review of PR #563, round 2
(`VERDICT: BLOCKED`, one HIGH). Adding a file to `PROTECTED_HARNESS_SOURCE` in
the previous commit was correct but insufficient: the matcher it joined compared
**raw strings**.

**Files:** `.codex/hooks/production-action-guard.mjs`, `.codex/hooks/production-action-guard.test.mjs`, `scripts/apply-live-testdata-maintenance-20260812.mjs`

### The hole

Two spellings of the same file produced opposite verdicts:

| path | verdict |
|---|---|
| `.claude/hooks/codex-bot-review-lib.mjs` | blocked |
| `.claude/hooks/../hooks/codex-bot-review-lib.mjs` | **allowed** |

Codex confirmed with `Resolve-Path` that both name the same file, and that the
detour worked through `Write`, a realistic `apply_patch` payload, and PowerShell
mutation. The separately configured review-proof hook allowed it too.

**This was never specific to the module that review was about.** Every entry in
`PROTECTED_HARNESS_SOURCE` — `codex-push-lib`, `production-action-guard`,
`write-codex-push-proof`, `package.json`, `settings.json` — had the same hole,
and had it before this PR existed. The new module simply made someone look.

Severity is high because both merge guards import guard code at startup: an
allowed edit could add an early successful exit, so the guard completes silently
before inspecting any action, and silent completion means ALLOW.

### The fix

`canonicalizeGuardPath()` resolves `.` and `..` segments and unifies separators
**textually**, then the matcher tests both the raw and canonical spelling. It
deliberately does not touch the filesystem: the verdict must be the same whether
or not the path exists yet, and a real resolve would follow symlinks to a
different answer than the one the tool actually writes to.

A shell command is not one path and cannot be canonicalized as one, so a
*mutating* command that carries a `../` segment **and** names a protected file's
basename is refused rather than gated — the same stance the guard already takes
on interpreter arguments built by shell expansion. Reads through a detour stay
allowed.

### Regression coverage

Seven alias spellings (interior `..`, `./`, backslashes, mixed, and detours onto
*other* protected files) across `Write`, `Edit` and `apply_patch`; three shell
mutation forms; six unit assertions on `canonicalizeGuardPath` itself including
rooted-path escape (`/a/../../b` → `/b`) and a meaningful leading `..`.

Three **negative** tests keep the fix from becoming a blunt instrument: an
unrelated file reached through a detour, a sibling in the same directory, and a
docs path all stay editable, and a read through a detour stays allowed.

### On the review's second finding

The same review reported a deleted owner deadline item in `TODO.md`. That was a
**false positive from a stale base** — `main` had gained the item in #566 after
this branch's last merge, so a two-dot diff read "main has it, the branch does
not" as a deletion. Confirmed by `git rev-list --left-right`: the branch was one
commit behind, and that commit was the one that added the section. Merging `main`
resolved it; nothing was ever deleted.

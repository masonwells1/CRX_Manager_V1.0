## 2026-09-21 — Luna advisory review fails closed on opaque (binary / `-diff`) changes

Sixth Sol pass on #750, `CODEX_PROOF_VERDICT: BLOCKERS`, one HIGH: a binary file, or a text file
marked `-diff` in `.gitattributes` — which this repo does for security-sensitive baseline SQL —
reaches the Luna payload as `Binary files … differ` with no content. Luna reviews nothing for it and
can still answer `CLEAN` with a valid tail canary, which validation accepted.

- Step 3A now refuses to run when the frozen diff contains `Binary files … differ` or a
  `GIT binary patch`, printing the files and stating that Step 3A does not cover them.
- Folded in (Mason had accepted it as a residual; a new commit was needed anyway): the filter
  neutralization loop now uses `while read` instead of an unquoted `for … in $(…)`, so a driver
  literally named `*` is overridden instead of glob-expanding against repository filenames.

**Proof (executed, recipe extracted from the skill file by script):** a changed `-diff` SQL file
stops extraction with `Binary files a/base.sql and b/base.sql differ` / `OPAQUE CHANGE`, exit 1; a
configured `filter.*.clean` helper with an attacker `.gitattributes` runs **0** times; this PR's own
`--base origin/main` extraction still captures all 22 changed files.

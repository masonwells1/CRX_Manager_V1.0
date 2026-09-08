## 2026-09-08 — PR #605: Win32 path aliases are non-canonical spellings

Codex (`gpt-5.6-sol`, exact-SHA proof on `b2988f2da`) High, probe-confirmed: the canonical-spelling
rule resolved `.`/`..` and repeated separators only, so a drive-RELATIVE prefix
(`C:.claude\hooks\review-proof-guard.mjs`), a trailing period in a directory segment
(`.claude/hooks./review-proof-guard.mjs`) and a trailing period on the file name
(`.claude/settings.json.`) passed every native editor silently although Windows opens the
protected file for each of them (the same aliases `production-action-guard`'s canonicaliser
already handled after PR #563).

Fix by class: both review-proof-guard resolvers (shell tokens and path fields) and autopilot-lib's
`canonicalToolPath()` now drop a drive-relative prefix and strip trailing periods and spaces from
every segment (a segment left empty is dropped), mirroring the sibling canonicaliser; a rooted drive
(`C:/…`) is kept because that is the spelling the editors send and the settings globs are measured
against. Deliberately over-inclusive, which for a deny-guard can only over-block.

Proof: eleven deny cases across Edit/Write/MultiEdit/NotebookEdit, an MCP path field and three shell
forms, two allow cases (unprotected paths with a trailing period) in `review-proof-guard.test.mjs`; six
armed cases in `autopilot-lib.test.mjs`; the parity test adds a drive-relative and a trailing-period
spelling of every protected sample for both the armed decision and the real hook. The previous hook
and library, swapped in place, fail the new cases.

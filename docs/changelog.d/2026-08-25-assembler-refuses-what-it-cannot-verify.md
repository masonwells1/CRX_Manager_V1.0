## 2026-08-25 — the changelog assembler refuses what it cannot verify

Second review round on the per-change changelog convention. Four findings, and the two
that mattered were both about the same risk: `--write` DELETES the fragments it consumes,
so anything it consumes wrongly is gone.

- **Untracked fragments are no longer consumed.** The assembler enumerated every file in
  the directory, so with several sessions sharing a checkout it would splice another
  session's half-written draft into the changelog and then delete the original. It now
  consolidates only fragments git already tracks, reports the skips, and refuses outright
  if it cannot list tracked files — an unreadable index is exactly when not to delete.
- **A fragment must actually be a dated section.** Empty files, prose-first files, and a
  heading whose date disagrees with the filename were all consumed anyway; an empty one
  deleted a file while adding nothing. Each is now refused by name with the reason, and
  left on disk. A run where everything was refused exits non-zero rather than reporting
  a quiet success.
- `docs/changelog.d/.markdownlint.yaml` disables MD041 for this folder only — these files
  are fragments spliced in as H2 sections, so promoting them to H1 would produce the wrong
  hierarchy in the assembled changelog. Deliberately folder-scoped, not a repo-root config.

`scripts/assemble-changelog.test.mjs` is new and wired into `test:correction-guards`:
11 assertions running the real script against throwaway git repos, asserting that the
untracked draft and all three malformed shapes SURVIVE while the valid fragment is
consumed, that a late fragment lands below a newer section, and that a fully-refused run
exits non-zero. A script that deletes files earns a test that proves what it refuses.

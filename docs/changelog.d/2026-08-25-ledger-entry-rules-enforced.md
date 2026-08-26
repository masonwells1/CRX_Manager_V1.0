## 2026-08-25 — the ledger entry rules are now enforced, not just documented

**Review round (Codex + CodeRabbit) closed three real defects in the first cut, two of
them in this change's own design:**

- The guard accepted a **modified or deleted** entry, because the CLI passed only
  filenames from `--name-only`. A session could therefore edit someone else's existing
  entry and satisfy the requirement while recording nothing about its own change —
  precisely the "write the rule as prose instead of a hard check" mistake the README
  warns against. The CLI now uses `--name-status` and an entry counts only when ADDED.
  A path supplied without a status cannot satisfy the rule; that direction fails closed
  deliberately. Mutation-tested: removing the status requirement turns the suite red.
- The documented `<YYYY-MM-DD>-<slug>.md` filename was **not enforced**, so a bare
  `notes.md` satisfied the guard while nothing would ever read it as an entry. The
  pattern is now a single exported `ENTRY_RE`, so any future consumer imports one
  definition instead of re-expressing it and drifting. The date prefix also excludes
  `README.md` by construction.

**Correction, recorded rather than rewritten.** Earlier revisions of this entry also
described a consolidation tool — that it imported `ENTRY_RE`, inserted fragments by date,
and was proven in a sandbox. That tool was **split out of this PR** and is not in the
shipped tree, so those statements described work that did not land here. They are removed
rather than left standing: a changelog that claims a script exists is exactly the kind of
false record this whole change set was written to stop.

Assertions at the time of that round: 56 (was 40); the guard now carries 83.

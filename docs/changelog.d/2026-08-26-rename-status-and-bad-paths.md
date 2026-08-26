## 2026-08-26 — rename status beats content, and a bad filename is still an attempted entry

Three more findings, two of them refinements that defeat the fixes from the previous round.

- **Rename plus a one-character edit defeated the byte-identical check.** The previous fix
  detected a pure rename by comparing bodies, but editing a single character makes the
  bodies differ while the commit is still just moving someone else's record. Git knows
  better: `git diff --cached -M` still reports it as `R<score>`. The guard now asks git
  for rename status in a second pass and refuses an added entry that is a rename
  destination, naming the file it came from. The content comparison stays as a fallback
  for when rename detection is unavailable.
- **A malformed FILENAME slipped through on trigger-free commits.** The previous round
  validated content, but only after the path already matched `ENTRY_RE` — so
  `notes.md`, a non-padded date, or a nested path were filtered out before they could be
  reported, and a `src/`-only commit could leave one in the folder unchecked. Anything
  dropped in the folder is now treated as an *attempted* entry and refused by name if it
  will never be read as one. `README.md` and dotfiles are excluded by construction.
- **This changelog claimed a script that is not in the tree.** An earlier revision of the
  2026-08-25 entry described the consolidation tool as shipped — imports, date ordering,
  sandbox proof — after that tool was split out. Corrected, and the correction says so
  rather than quietly deleting it. A changelog asserting a file exists is precisely the
  false-record class this change set exists to stop, so finding one in my own entry is
  worth recording rather than tidying away.

83 assertions (was 76). The path predicate is a plain function rather than a regex —
several attempts at the escaped form silently produced a pattern that matched nothing,
which is its own argument against clever escaping in a guard.

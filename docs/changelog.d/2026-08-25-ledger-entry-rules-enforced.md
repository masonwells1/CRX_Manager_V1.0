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
  `notes.md` satisfied the guard — and because the assembler sorted lexically in
  reverse, it would have spliced in as the NEWEST changelog block. The pattern is now a
  single exported `ENTRY_RE` that the guard and the assembler both import, so the two
  cannot drift apart. The date prefix also excludes `README.md` by construction.
- The assembler always inserted at the top, so consolidating a late fragment from an
  older PR placed it ABOVE a newer entry, contradicting the file's reverse-chronological
  contract. It now inserts by date. Proven in a sandbox: a 2026-08-25 fragment merged
  into a changelog whose newest section was 2026-08-26 lands between 08-26 and 08-20.
  Files that are not entries are reported loudly and left on disk rather than consumed.

Assertions: 56 (was 40).

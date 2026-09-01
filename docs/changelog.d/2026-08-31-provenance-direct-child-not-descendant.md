## 2026-08-31 — make the containment check mean what its comment says

Fifth and final round on the migration source-provenance gate. The exact-SHA `gpt-5.6-sol`
review of `a8efe218` returned **CLEAN — no blocker or high-severity findings**, having verified
2,889 candidate files against manifests and independently regenerated the 14-path diff. It
raised one minor observation, and it was correct.

**The discrepancy.** The per-file containment check used `withinDir()`, which admits any
descendant of the permitted directory — while the comment directly above it claimed the file
must sit "directly inside" that directory. A symlink at the permitted path whose target lived
in `supabase/migrations/<subdir>/` therefore passed.

**This was not a bypass.** The target stayed inside the allowlisted tree, and the content
binding still held: only bytes the repository already contains could be transmitted.

**It is fixed anyway, by tightening the code rather than softening the sentence.** The check is
now parent-equality: `dirname(realFile)` must equal the real permitted directory. Every
candidate is constructed as `path.join(dir, "<stem>.sql")`, so a genuine migration is always a
direct child and nothing legitimate is lost.

The reason to bother, given it was minor: **a check that is looser than the sentence describing
it is how the next reader inherits a wrong mental model** — and this file has now been reopened
twice on exactly that pattern. Round 2's bypass was itself defended by a comment rationalising
the tolerance that made it exploitable. Prose that overstates a guard is not a documentation
bug; it is the mechanism by which the guard's real shape gets forgotten.

**Proof observed.**

- `migration-apply-lib.test.mjs` **171**, `migration-apply-guard.test.mjs` **107** — green after
  the tightening, so no legitimate path was narrowed out.
- Real path, read-only: a pending return-credit migration still passes provenance and advances
  to the ordering gate; a parked wave-A migration is still refused by name.

**Not verified.** The new descendant-target regression test needs a *file* symlink, which
Windows will not create without elevation, so it prints `SKIP descendant-target case` here
rather than passing silently. Two of the three link-shaped cases in this suite now skip on this
machine; only the directory-junction case executes. Recorded rather than counted.

**Also corrected this round.** An earlier entry in this series claimed the migration rejected on
2026-08-31 was "still armed" in `supabase/migrations/` on `main`. That was stale by the time it
was written: the branch parking it landed as PR #525 (squash-merged, so the branch was deleted
and a `git log` glance made it look unmerged). Verified from `main` itself — the file is at
`scripts/.staging-migrations/20260827223000_enforce_global_migration_ledger_order.sql.REJECTED`
and is therefore now refused by this guard, which is the outcome the guard exists for.

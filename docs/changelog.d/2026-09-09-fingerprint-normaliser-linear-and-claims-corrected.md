## 2026-09-09 - the fingerprint normaliser is linear and shared, and four claims are corrected

Follow-up to `2026-09-09-sweep-predicates-recognised-by-fingerprint.md`, after
the pinned `gpt-5.6-sol` review of PR #648.

**What the review confirmed.** Across more than 1,000,000 generated inputs there
was **zero disagreement with base whenever the fingerprint did not match** — the
central claim of the design. No missing, empty, corrupt, `{}`, `null` or
attacker-shaped manifest became a wildcard allowance; each recognises nothing.
And it independently read all 29 predicates and confirmed every one is a single
top-level `SELECT` / `WITH ... SELECT` with no executable write, no
`SELECT INTO`, and no data-changing CTE. That last point is the question a
fingerprint cannot answer about itself, so having it answered by something other
than me matters.

**The one real defect, which this change introduced.** The trailing-whitespace
trim was `/\s+$/`, which backtracks. Every input now passes through the
normaliser on its way to the classifier, so a long run of *leading* whitespace
became a denial of service on the hook itself: 80,000 spaces cost 1.06 s and
quadrupled per doubling, enough to exceed the hook timeout. `trimEnd()` strips
the identical character set (WhiteSpace plus LineTerminator) natively in linear
time; the same input is now under a millisecond.

The test asserts the **shape** rather than a wall-clock number — quadrupling the
input must not quadruple the time — because a timing threshold tuned on one
machine is a flake everywhere else.

**The generator now imports the guard's normaliser** instead of restating it.
Two copies drifting would mean the manifest recorded different bytes than the
guard computes, which is the single failure this design cannot detect from the
inside.

**The count assertion was a floor and is now pinned.** `>= 29` would have let a
reviewed predicate be deleted from *both* the directory and the manifest, with
nothing noticing, once the suite grew past 29.

**Four claims corrected.**

| claim | reality |
|---|---|
| "every predicate opens with prose like `-- predicate`" | 19 of 29 do; the other 10 open with a `-- ===` banner and are refused a line further down for the same reason |
| "the C1 control had no working execution path anywhere" | `run-sweeps.mjs` has a direct `psql` path given `SUPABASE_DB_URL` and a local `psql`. The blocked path was the MCP/guard one |
| "exact bytes" / "no other input is classified differently" | the match is on the sha256 **after** normalisation, so the accepted set is each predicate plus its line-ending, BOM and trailing-whitespace variants. The defensible claim is that no NON-MATCHING input is classified differently |
| "cannot drift silently" | too broad. A coordinated SQL-plus-manifest edit passes the test; reviewing that combined diff is the actual gate |

A fifth: the previous entry referenced the deployed-hook harness as though it
were a checked-in artifact. It is a local scratch tool that takes the checkout
path as its first argument, and that is now said plainly.

**Added coverage** for the gaps the review named: normaliser linearity, Unicode
trailing whitespace (NBSP, en quad, ideographic space and line separator are
stripped; the same characters in the MIDDLE or LEADING position are not, and a
trailing NUL is not whitespace), and normalisation-stability of the hash.

**Proof.** `predicate-fingerprints.test.mjs` 142 → 154; full
`npm run test:correction-guards` green. The deployed hook process still clears
**29 of 29** predicate files with `REAL-DATA-OK` absent (main: 0 of 29) and
still denies all 15 must-deny shapes. The manifest hashes are **unchanged** by
this commit, so the normaliser swap is behaviour-preserving on every predicate.

**Worth recording:** on the abandoned PR #639 the review kept finding defects in
the code. Here it found the design sound and the defects almost entirely in what
I wrote *about* it. That is a better failure mode, and it is still a failure
mode — the fix is to state the narrow verifiable claim, not the satisfying one.

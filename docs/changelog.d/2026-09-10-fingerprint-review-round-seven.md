## 2026-09-10 - fingerprint allowance: round-seven review corrections

The seventh pinned `gpt-5.6-sol` review of PR #648 (at `018db64be`) returned
BLOCKERS with seventeen findings. Each was checked against the code before
anything changed, and every one reproduced. None changes how the guard treats a
real hook payload: the same review confirmed zero disagreements with `main`
across 1,250,169 non-recognised inputs, a generator with no file-writing path,
and all 29 fingerprints correct.

**A claim that was false.** Comments, the test and the PR said all 29
predicates are refused because their header prose reads as a call to
`predicate()`. Counted against `main`'s guard: 8 are refused as `predicate()`,
19 as other apparent calls (`suite()`, `expected()`, `key()`,
`pg_get_triggerdef()` and more), and 2 by the audit-log write check. "All 29
refused" was true; the stated cause was not. Corrected everywhere it appeared.

**Generator** (`write-predicate-fingerprints.mjs`):

- refuses two predicates that share a fingerprint, instead of printing a block
  that could never match the files;
- treats a marker as a whole line, so a near miss (`...FINGERPRINTSX`) is
  refused rather than taken as the marker;
- folds a lone CR like CRLF, matching what the predicate normaliser folds;
- compares the Set the guard actually exports as well as the marked text, so
  code after the markers that changes the list is reported, never "current";
- converts each value once, so what it prints is what it validated.

**Guard** (`live-testdata-lib.mjs`): `classifySql` converts its input once, as
`main` did, so recognition and classification judge the same string. Comment
corrections only otherwise: the refusal cause above, the long-deleted manifest
still named as the list's home, and two accepted consequences of normalisation
now stated (line endings fold inside a literal too; a BOM variant shares a
fingerprint while being a syntax error, which executes nothing).

**Tests** (231 → 243 assertions). The test that the generator never writes had
only run on an already-current guard, which is not the path the old code wrote
on. It now copies the generator, guard and predicates into a scratch tree and
runs the copied generator on a stale list and on ambiguous markers, asserting
the exact printed block and a byte-identical guard each time. Codex had written
a stale-path write the static tripwire cannot see; a mutation run confirmed the
new behavioural test catches that write and the tripwire does not. The same
mutation run broke each other fix in turn, and the suite caught all eight
mutations. Three section-10 assertions that only showed normalising twice
changes nothing were replaced by one that checks the generator uses the guard's
normaliser itself, not a copy.

**Docs.** `scripts/db-invariant-sweeps/README.md` and
`docs/reference/agent-guardrails.md` no longer say "exact text" or "any change":
the fingerprint ignores line endings, a BOM and trailing whitespace. The
add-a-predicate steps now state the filename rule, that exit 1 with a printed
block is the expected result, and to run the fingerprint test afterwards.

**Not changed.** Commit `27002e271` cites a deployed-hook harness that is a
local scratch tool, not checked in; a pushed message cannot be amended without
a force-push, so the PR body says so instead. That harness was rerun on this
change: 15 of 15 must-deny shapes denied, a plain read allowed, 29 of 29
predicates cleared, with `REAL-DATA-OK` absent.

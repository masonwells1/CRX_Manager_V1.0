## 2026-09-09 - the authorised fingerprints move inside the guard, closing a real bypass

Fifth round on PR #648, and the first finding that was about the design rather
than about something I wrote. It was right, and it was High.

**The bypass.** The authorised hashes lived in
`scripts/db-invariant-sweeps/predicate-fingerprints.json`. That is an ordinary
writable file, while `.claude/hooks/**` is an approval-gated enforcement
surface. So the route was:

1. compute the sha256 of a destructive statement;
2. append it to the manifest with a permitted ordinary edit;
3. call `execute_sql`.

Every hook invocation is a fresh process that reloaded the manifest, and the
allowance short-circuits **before** the audit-log, TRUNCATE, DDL/GRANT,
sequence, RPC, DELETE and UPDATE checks. The test suite would have noticed
afterwards, which is worth nothing once the rows are gone. I had put the trust
list outside the thing that protects it.

**The fix.** The hashes are now a `Set` literal inside
`.claude/hooks/live-testdata-lib.mjs`, between generator markers. Adding an
allowance is an edit to a hook file, protected by whatever protects the guard.
The generator rewrites only the marked region, so a regeneration reads in review
as a list of hashes and nothing else. The JSON manifest is deleted.

There is now **no runtime file read in the guard at all**, which also retires
three things the manifest version carried: the cache-lifetime question (a
repaired manifest stayed cached as empty), the path-resolution question
(symlinks, `--preserve-symlinks`, working directory), and every
malformed-manifest failure mode.

**Proven, not argued.** Against the built guard:

- the destructive statement is blocked (`real-delete`);
- the guard performs no `readFileSync` — checked against its source;
- **recreating the deleted manifest with the destructive statement's hash in it
  changes nothing** — still blocked;
- the only construction that grants the allowance is editing the guard's own
  source, and the suite fails on that, because the generated region must be
  byte-identical to what the generator emits from the current predicate files.

That last assertion is new and matters: a hand-edited hash inside the guard is
caught even though it sits in the right file, so the two ways to forge an
allowance — edit the list, or edit a predicate — both fail the suite.

**Also fixed:** the generator now emits the region using the file's existing
line ending, so regenerating on a CRLF checkout does not rewrite the whole file;
the test compares line-ending agnostically; and the dead `readFileSync` import
is gone.

**Proof.** `predicate-fingerprints.test.mjs` 174 → 176; full
`npm run test:correction-guards` green. The deployed hook process still clears
29 of 29 predicate files with `REAL-DATA-OK` absent (main: 0 of 29) and denies
all 15 must-deny shapes. Codex independently re-confirmed, on the previous head,
that 100,000 non-matching inputs classify identically to base and that all 29
predicates are single read-only statements.

**Worth recording:** five rounds, and the reviewer's value changed shape as it
went. Rounds 1–3 found my claims running ahead of the diff. Round 4 found the
actual architectural mistake — a trust list stored outside the trust boundary —
which no amount of care about wording would have surfaced. The lesson is not
"write more carefully"; it is that a standing allowance belongs in the same
protected surface as the thing it exempts.

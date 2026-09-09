## 2026-09-08 - the live-data guard's dollar-quote lexer now matches PostgreSQL's scanner instead of approximating it

**Why:** the same-day comment-aware change (see
`2026-09-08-live-data-guard-comment-aware.md`) made comment removal part of
classification. That is only sound if the text reaching the comment stripper
still carries the statement's TRUE comment structure — and twice it did not.
Two rounds of the pinned `gpt-5.6-sol` adversarial review found six SQL shapes
that `main` blocked and the branch allowed. Every one was reproduced locally
against both git blobs, and the first two against the deployed hook process,
before being fixed.

The defect was always the same: `$tag$` recognition did not match PostgreSQL's
own scanner, and BOTH failure directions are dangerous.

- **Opening a span PostgreSQL would not.** `foo$x$a` is ONE identifier — `$` is
  a legal identifier continuation character. Treating the embedded `$x$` as a
  delimiter made `indexOf` find the "closing" tag inside a LATER string literal,
  deleting the real SQL between them and manufacturing a comment the strip then
  removed. `SELECT 1 AS foo$x$a, '$x$--'; DELETE FROM customers;` classified as
  `SELECT 1 AS foo`.
- **Missing a span PostgreSQL would open.** The body's inert `--` or `/*` text
  then reaches the strip as if it were real comment syntax and erases whatever
  follows. `SELECT $é$--$é$; DELETE FROM customers;` classified as
  `SELECT $é$`.

Round 1 fixed only the first direction and asserted that declining to open a
delimiter is inherently fail-safe. **That claim was wrong**, and round 2
disproved it with four more regressions: a non-ASCII identifier absorbing the
`$` (the round-1 boundary check was ASCII-only, so it re-created the original
bypass verbatim), a non-ASCII tag, a tag longer than 64 characters (a 66-char
match window silently stopped recognizing legal tags), and a backslash-escaped
quote ending a literal early.

**What changed:**

- One shared `openDollarTag()` helper, used by BOTH lexers, so they cannot
  disagree about where a dollar-quoted span begins.
- Character classes follow `scan.l`, non-ASCII bytes included
  (`ident_start`/`ident_cont`, `dolq_start`/`dolq_cont`); the tag has NO length
  limit.
- The `$` is absorbed only by a run that actually STARTED like an identifier, so
  a number cannot absorb it — PostgreSQL's rule is "keyword or identifier", and
  `SELECT 1$x$body$x$` really does open a span.
- `stripDollarQuotedCore` copies quoted identifiers verbatim, so a tag-shaped
  column name (`SELECT "$x$"`) cannot open one.
- A backslash is read as an escape in ordinary strings too. A PreToolUse hook
  cannot see the session's `standard_conforming_strings`, and assuming an escape
  can only EXTEND a literal — which both lexers copy verbatim — so any statement
  that follows stays visible to classification.
- The `classifySql` header no longer claims that stripping a comment cannot hide
  a write. It records instead that the strip's safety rests entirely on this
  helper matching the real scanner.

**Proof.** `guards.test.mjs` 196 -> 201, covering all six shapes plus the digit
boundary and a genuine-body control; full `npm run test:correction-guards`
green. The deployed hook process still DENIES all twelve must-deny shapes with
`REAL-DATA-OK` absent, and the same 12 of 29 sweep predicates still clear it.

**Worth recording:** the unit tests written alongside the original change did
not catch either regression — both were found by the second-model review, and
only then turned into tests.

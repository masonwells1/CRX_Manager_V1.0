## 2026-09-08 - live-data guard no longer reads SQL comments as function calls, unblocking 12 of the 29 db-invariant sweeps

**Why:** the `db-invariant-sweeps` C1 control could not run at all through
`execute_sql`. Every one of its 29 predicates was refused by the LIVE-DATA
GUARD — verified 2026-09-08 by running `classifySql` over all 29 predicate
files, and observed live three times as real `execute_sql` denials.

The cause was pure false positive. `findNonReadFunctionCall` scanned comment
text, and every predicate opens with prose like `-- predicate (f): overloads`,
which reads as a call to a function named `predicate`. Others tripped on
`suite (`, `expected (`, `key (`, `id (`, `arm (`. A second group called
`pg_get_function_identity_arguments` / `oidvectortypes` / `pg_get_triggerdef`
/ `to_regprocedure` — pg_catalog definition formatters whose siblings
(`pg_get_functiondef`, `format_type`, `to_regclass`) were already trusted.

Combined with `db-sweeps:strict` still lacking an authenticated CI path
(`docs/manual/KNOWN_ISSUES.md`), the sweep had **no working execution path
anywhere**.

**What changed:**

- `classifySql` now runs its pattern checks against comment-stripped text,
  using the existing quote-aware `stripCommentsQuoteAware` (string literals,
  quoted identifiers, and dollar-quoted spans are copied verbatim, so the
  `SELECT '/*'; DELETE FROM customers;` swallow from Codex P1 2026-07-13
  round 5 stays impossible). A comment never executes, so stripping one
  cannot hide a real write.
- The `[E2E]` fake-data marker is now read from the comment-BEARING text, so
  the documented, tested `UPDATE ... -- [E2E]` form still exempts. It stays
  dollar-stripped, so an `[E2E]` buried in a re-emitted machine body still
  cannot exempt a real write — identical to the previous behaviour.
- Added the read-only pg_catalog formatters to the builtin list, and
  plpgsql_check's static analyser to `READONLY_FN_NAMES` with a dated audit
  note. The profiler/tracer entry points are deliberately NOT trusted.

**Not changed:** names appearing inside string literals still block. 17 of the
29 predicates remain unrunnable for that reason. Teaching the scanner to skip
literals is a genuinely different risk (dynamic SQL can execute literal text),
so it was deliberately left for a separate, owner-approved decision rather than
folded in here.

**Proof.** `guards.test.mjs` 168 → 183 assertions; full
`npm run test:correction-guards` green. Beyond the unit tests, the DEPLOYED
hook process was driven with real PreToolUse payloads (`REAL-DATA-OK` absent):
it still DENIES deleting customers, changing an invoice total, hand-writing
`financial_audit_log`, TRUNCATE, raw DDL, GRANT, a mutating RPC via SELECT,
`setval`, and an unknown app function — including the two regression shapes
where a `--` or `/*` hidden inside a string literal precedes a real `DELETE`
on the same line. 12 of 29 predicate files now clear the real hook; the same
12 were then executed read-only against live and all passed (the four returned
rows are exact, dated allowlist entries).

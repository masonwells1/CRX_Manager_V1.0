## 2026-09-24 — buildSweepQuery requires a SELECT, a false smoke-coverage claim I introduced is removed, and the cutover header matches its gate

PR #790 review round (CodeRabbit: three Minor). All three addressed. The only SQL change is comment
text in an unapplied migration.

## A false coverage claim I introduced earlier this session

Earlier today I moved `post_invoice_group` out of a spec whose chain had **0** occurrences and into
the `unpost_invoice_group` spec, citing "14 occurrences". Measured again, properly: **all 14 of those
matches are `unpost_invoice_group`** — my grep counted the substring. That chain calls
`post_invoice` (6 occurrences) to create posted members and **never** calls `post_invoice_group`. I
removed one false coverage claim and introduced another.

The claim is now removed. **No coverage is lost:** `smoke-field-app-split-penny-exact.sql` genuinely
calls `post_invoice_group` twice, and the `save_field_app_invoice` spec already declares it — verified
by counting exact matches, not substrings. So the RPC keeps real, correctly-registered coverage and
the `unpost_invoice_group` spec now claims only what its chain exercises.

This is the third naive-matching mistake of mine caught in this delivery — after `/[a-z]/` for "is
this a name" and `includes(';')` for "is this a statement break". The pattern is consistent enough to
be worth naming: a substring test standing in for a structural one.

## `buildSweepQuery` accepted a single statement that was not a SELECT

`hasStatementBreak()`, added in the previous head, rejects multi-statement input but says nothing
about statement *type*: `VALUES (1)` has no statement break, so it was inlined into `FROM (...)`
and produced rows with no `violation_key`, surfacing downstream as a confusing allowlist failure
rather than a bad-predicate error at the boundary.

`buildSweepQuery` now requires the first executable keyword to be `SELECT` or `WITH`, read through a
new `stripLeadingComments()` so a predicate that opens with commentary is not misjudged. Measured
across the shipped set: **7 open with `SELECT`, 22 with a `WITH` prelude**, so both forms must stay
accepted — and the existing test that builds every shipped predicate proves the guard did not become
too strict. `VALUES (1)` and `TABLE pg_proc` are now refused by name.

`ACTOR_ALLOWLIST_MATCH_PASS` — **545 assertions** (was 541).

## The cutover header contradicted its own gate

`20260914101300`'s header still said the scan refuses "ANY ... still-valid save_invoice receipt" and
told the operator to "Wait for natural receipt expiry". After the narrowing, an operator reading only
the header would wait out unrelated chemical-sale receipts for nothing — precisely what
`docs/reference/rpc-functions.md` now tells them not to do. I had updated the inline `SCOPE` note and
the reference doc but not the file's own header.

The header now names exactly which receipts block (field-application, and unidentifiable ones) and
says the others do not. **SQL behaviour is unchanged** — comment text only. Row 933's pin moves to
`26fed9e34186615c2060d616b1c0e8522f0ec51765e226761f3c535fd27ab4c3` (was `6bc6480025d8…`, retained
there as history), and the prover was re-observed afterwards: it extracts the gate predicate from the
file rather than restating it, so a header-only edit cannot quietly invalidate it.

## Proof

- `node scripts/smoke/prove-generic-field-cutover-receipt-gate.mjs` →
  **`RECEIPT_GATE_NARROWING_PROOF_PASS`**, re-observed after the header rewrite.
- `ACTOR_ALLOWLIST_MATCH_PASS` **545 assertions**.
- Exact-match counts behind the coverage correction: `smoke-unpost-invoice-group.sql` → 13
  `unpost_invoice_group`, 1 `_unpost_invoice_group`, **0** `post_invoice_group`, 6 `post_invoice`;
  `smoke-field-app-split-penny-exact.sql` → **2** `post_invoice_group`.
- `typecheck`, `lint`, `npx vitest run` (**5,448 passed** / 123 skipped), `build`,
  `test:correction-guards`, `test:agent-workflows`, `check:docs` all green.

## Live impact

**None.** All four field-season candidates remain LOCAL CANDIDATE / UNAPPLIED.

## 2026-10-04 — sweep-query guard: Luna round 1 fixes

Follow-up to `2026-10-03-live-data-guard-recognises-wrapped-sweep-queries.md`, same PR.

- BLOCKER (agreed): the bare-predicate allowance still read a derived `KNOWN_SWEEP_PREDICATE_SHA256`
  Set that the generator's "overridden" check no longer compared, so code after the marked block
  could add a hash unseen. The Set is removed; both allowances read `KNOWN_SWEEP_PREDICATES`.
- MED (agreed): contract keys were limited to lower-case identifier characters, which would refuse a
  valid signature with a schema-qualified type or a quoted identifier. Keys now allow printable ASCII
  except `'` and `\`; a test pins the backslash case, the one the byte-equal rebuild cannot catch.
- Raised as BLOCKER, assessed LOW: CRLF folding could in principle change a value inside a multi-line
  literal. It cannot turn a read into a write, and it is the existing, previously accepted rule for
  bare predicates. The supporting claim ("no predicate has a line break inside a literal") is now an
  enforced test over all 29 files rather than a comment.

Proof: `predicate-fingerprints.test.mjs` 526 assertions; a mutation run that removes each rule
(rebuild equality, key charset, backslash exclusion, name binding, semicolon check) fails the suite
every time; `npm run test:correction-guards` and `npm run test:agent-workflows` pass.

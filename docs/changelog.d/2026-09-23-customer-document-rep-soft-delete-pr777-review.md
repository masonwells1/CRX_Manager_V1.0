## 2026-09-23 - soft_delete_customer_document: PR #777 review fixes

CodeRabbit (CHANGES_REQUESTED), four Minor findings, all valid. No migration SQL changed.

- **The path-shape guard added in the previous round FAILED OPEN.** If its extraction regex did not
  match, `assertFixturePathsSurviveParkedShapeCheck()` returned and passed. So the moment
  `20260914100700` respelled its CHECK (`~*`, `E'...'`, a doubled quote, `SIMILAR TO`) or a later
  edit rewrote it, the guard would go vacuous — and the prover would pass right up until the
  prerequisite applied and the registered chain broke at setup. That is precisely the failure the
  guard was written to prevent, in the guard itself. It now fails closed: if the file names
  `customer_documents_storage_path_shape_check` at all, the extraction MUST succeed.

- **The same guard compared dialects, not verdicts.** The constraint is a PostgreSQL ARE;
  `new RegExp()` is not. POSIX classes (`[[:alnum:]]`) and ARE escapes (`\m`, `\Y`) mean different
  things in JavaScript, so a JS verdict was not evidence about the database's verdict. CodeRabbit
  suggested banning ARE-only syntax; instead **PostgreSQL is now asked directly**. The container is
  already up when this runs, so the prover evaluates every sample and both known-bad paths with
  the database's own `~` against the extracted regex and requires the two verdicts to agree
  path-by-path. Banning syntax guesses at the divergence; comparing verdicts measures it. Measured
  this run: PostgreSQL and JavaScript agree on all nine fixture paths and both rejections.

- **`docs/manual/KNOWN_ISSUES.md` contradicted itself.** The 2026-09-21 entry's heading still read
  `OPEN` while its body said it was superseded. The heading is now `SUPERSEDED`.

- **The ledger row's review summary was scoped too broadly.** It said every round closed with no
  BLOCKER and no HIGH. True for candidate-local findings, but the specialist round also recorded
  HIGH findings about migration ORDERING, outside this candidate and surfaced to Mason separately.
  Row 936 now states that scope explicitly, so a reader cannot mistake "clean" for "clean
  everywhere".

- **`scripts/smoke/smoke-specs.json`**: this chain certifies `guard_customer_document_update`,
  `check_idempotency_intent` and `customer_documents` as well as the RPC, but `covers` listed only
  the RPC, so `run-smoke.mjs --spec` could not select it by the surfaces it actually protects. All
  four tokens are now listed.

Proof: the prover re-ran end to end to `CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS`, including
the fail-closed extraction, the PostgreSQL/JavaScript verdict cross-check, the shadow-helper fault
case, the registered chain and both mutation tests. `check:docs` and `test:correction-guards` pass;
`smoke-specs.json` re-parses as valid JSON.

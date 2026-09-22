## 2026-09-21 - soft_delete_customer_document: Codex review round 3 fixes

Codex `gpt-5.6-luna` xhigh review, round 3, of the parked
`20260921180000_soft_delete_customer_document_rpc.sql`.

**Fixed.**
- **Guard trigger preflight (MED):** the preflight now also requires that
  `customer_documents_guard_editable_fields` has no WHEN clause and no column list, and that
  `guard_customer_document_update` still contains both of its refusals: editing a removed row, and
  forged removal attribution.
- **Helper ACL preflight (MED):** `check_idempotency_intent` must now be executable by its owner
  only. The preflight checks this for any role, not just three named ones.
- **Helper search path (LOW):** the helper must also carry `search_path=public, pg_temp`.
- **Header wording (MED):** the header no longer says every extra grant fails the apply. Grants to
  PUBLIC, anon, authenticated and service_role are revoked, which clears the Supabase defaults.
  A grant to any other role is left in place, fails the postflight, and a human reviews it.
- **Prover skip (LOW):** the prover refuses to skip PR #761's `20260914100450` if that file ever
  changes this table's policies, triggers or grants. Today's version passes.

A read-only live check on 2026-09-21 confirmed the stricter preflight passes on production: the
trigger is unconditional and covers all columns, the guard body still refuses both edits, the
helper ACL is `{postgres=X/postgres}` with the expected shape, and both tables are owned by
postgres without forced row security.

**Refuted.**
- *(BLOCKER) "prompt injection"*: `idempotency-body-check: exempt` is the repo's own marker for its
  idempotency hook, used the same way by `20260911120000`. The body enforces the key, and the
  prover exercises it.
- *(MED) "removed document stays on screen"*: the success path filters it out of the list, and the
  page test that asserts it disappears passes.

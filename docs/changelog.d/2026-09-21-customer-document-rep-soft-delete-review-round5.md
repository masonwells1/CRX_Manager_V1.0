## 2026-09-21 - soft_delete_customer_document: Codex review round 5 fixes

Codex `gpt-5.6-luna` xhigh review, round 5, of the parked
`20260921180000_soft_delete_customer_document_rpc.sql`.

**Fixed (HIGH).** A rep could reuse their own key on a different document after losing the
customer. The shared helper's `IDEMPOTENCY_INTENT_MISMATCH` would then carry the earlier receipt
(document and customer ids) in DETAIL. The function now re-raises that refusal with the same
message and SQLSTATE `22023` but no DETAIL. The prover asserts that the refusal contains neither
id and has no DETAIL line. The page keys per document, so it never reaches this path.

**Disputed BLOCKER, surfaced to Mason.** For the third round, Luna calls the
`-- idempotency-body-check: exempt` line a prompt injection. Claude disagrees:
- It is the repo's marker for `.claude/hooks/idempotency-body-check.mjs`.
- That hook does not recognize `check_idempotency_intent` plus a bound direct INSERT, so the
  marker is required. The live `20260911120000` carries the same line.
- The body enforces the key, and the prover exercises it.

**Refuted again.**
- *(MED) "removed document stays visible":* the success path filters it out, and the page test
  proves it.
- *(MED) "the prover should enforce #761's apply order":* apply order is enforced by the
  migration-ordering guard at apply time.
- *(MED) "preflight profiles/idempotency_keys RLS and ownership":* each drift named fails closed
  (`INSUFFICIENT_ROLE`, or the receipt INSERT rolls the removal back), so no access is gained.

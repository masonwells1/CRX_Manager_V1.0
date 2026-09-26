## 2026-09-21 - soft_delete_customer_document: Sol gate follow-up

The `gpt-5.6-sol` high gate on the parked `20260921180000_soft_delete_customer_document_rpc.sql`
returned CLEAN, with no BLOCKER or HIGH findings, **bound to head `1789c72b3`**, and again to
`8069cd45a` after the parked-header fix.

**THOSE PROOFS ARE VOID for the current head.** Every commit after a proof unbinds it, and this
branch has since taken the review rounds recorded in the 2026-09-22 entries - including a
signature change. The Codex CLI then hit its account usage limit (retry 2026-09-26), so no Sol pass
exists for the current head and the gate is still required before any merge or apply.

- *(MED, fixed)* The header comment allowed `psql -1` as an apply path. It now says live applies
  go only through `scripts/apply-migration-file.mjs`, and that `psql -1` is for the local prover.
  The change is to the comment only; the SQL is unchanged.
- *(LOW, deferred)* The prover pins its Docker image by tag, not by digest. This is the same
  deferral recorded in earlier rounds.

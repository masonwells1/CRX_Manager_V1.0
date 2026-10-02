## 2026-09-21 - soft_delete_customer_document: Codex review round 6 fixes

Codex `gpt-5.6-luna` xhigh review, round 6, of the parked
`20260921180000_soft_delete_customer_document_rpc.sql`. It returned one MED finding and nothing
higher.

**Fixed (MED).** The prover could build a schema that differs from production.
- A read-only ledger query found `20260914100500` and `20260914100600` applied live later, on
  2026-09-22 UTC (ledger versions `20260922015509` and `20260922020038`).
- The prover still skipped both as parked, so its schema lacked two live migrations.
- They are now replayed, and the proof passes against that schema.
- A by-name comparison of every local post-baseline file against the live ledger found only
  `20260914100800`, `20260914100900` and this candidate unapplied.
- The migration's apply-order note and the ledger docs now name only `20260914100450` (PR #761),
  `100800` and `100900` as the files it must follow.

**Refuted.** The four field-season files the finding named (`20260908190000`, `20260912165758`,
`20260913040359`, `20260913152700`) are not in `supabase/migrations/`. The prover cannot apply
them.

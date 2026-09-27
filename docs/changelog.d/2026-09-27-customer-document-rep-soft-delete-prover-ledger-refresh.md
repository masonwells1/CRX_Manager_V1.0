## 2026-09-27 - soft_delete_customer_document: prover refreshed against the live ledger

This addresses Sol's MED on #800 as far as the ledger allows today. The prover's skip list said three
prerequisites were unapplied. A read-only ledger read (2026-09-27 06:48Z, by name) found two of them live:
`20260914100700` (`20260926163005`) and `20260914100800` (`20260927060531`). `20260914100900` and the field-app
season files `20260914101000`..`101300` are not live yet. No SQL change.

- **`20260914100800` is now replayed**, so the proof runs through production's
  `trg_idempotency_keys_require_transfer_intent_20260908` receipt trigger. The prover asserts it is installed
  and enabled after replay.
- **`20260914100700` stays skipped: it cannot replay here.** Measured: replaying it fails with
  `permission denied for table objects`, because it rewrites `storage.objects` policies and the container's stub
  storage schema cannot host them. Its only `customer_documents` change, `customer_documents_storage_path_shape_check`,
  is now installed verbatim from the file before seeding. The prover checks that the constraint is validated
  and that it really refuses a `[SMOKE]` path, citing the constraint by name.
- **`20260914100900` stays skipped** (not live).

**Proof.** The prover passed (`CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS`, 96 migrations replayed, live shape
CHECK installed, bad path refused).

**Still to do before `20260921180000` applies.** Merge `main` once #793 lands. Drop `20260914100900` from the
skip list when it is live. Confirm `20260914101300` in the live ledger (Mason's ordering hold). Then re-run
the prover. Under the landing flow `main` adopted in #804, fixes stay on #800: push, wait for checks, relabel for one follow-up CodeRabbit review, and run `gpt-6-sol` last, on the head CodeRabbit approves.

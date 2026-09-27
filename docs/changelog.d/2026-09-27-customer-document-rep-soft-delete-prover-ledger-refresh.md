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

**Apply authority (Mason, 2026-09-27).** Asked whether this migration should still need his separate in-chat
yes now that `main` carries the autonomous-landing rule (#804), Mason answered "auto is fine". Once the ordering
hold lifts, it applies under that rule's gates with no separate ask. `CURRENT_STATE.md`, `KNOWN_ISSUES.md` and
migration-history row 936 now say so.

**Luna round (`gpt-6-luna`/xhigh, advisory, whole branch after the `main` merge): 7 findings.**
- *Fixed (LOW):* the registered chain matched refusal tokens with `LIKE`, where `_` is a one-character wildcard. It
  now uses `starts_with` / `strpos`. The prover re-ran: PASS, and the chain still fails against the mutant.
- *Refuted with live evidence (HIGH):* the claim that a role inheriting `authenticated` could forge `auth.uid()`.
  A read-only live query (2026-09-27) found exactly two members: `authenticator` (`inherit_option = false`, the
  API's login role, whose password the platform holds) and `postgres` (which already owns this function and
  every table). Nobody gains anything. This is the same platform-wide item previously deferred to the grants audit.
- *Deferred (MED):* the helper preflight matches the operation/actor/fingerprint comparisons as substrings of the
  helper's source. It is a drift tripwire on a postgres-owned, owner-only helper. The RPC also re-checks a
  replayed receipt's `document_id` and `customer_id` against the call and re-authorizes the rep, and the prover
  drives the real helper.
- *Deferred (LOW):* the chain runs as `postgres` with claim GUCs rather than `SET ROLE authenticated`. The prover
  covers invocation as `authenticated`.
- *Deferred by name, as before (LOW):* control characters in the key, the cross-operation error naming the other
  operation, and the image pinned by tag.

**Still to do before `20260921180000` applies.** Merge `main` once #793 lands. Drop `20260914100900` from the
skip list when it is live. Confirm `20260914101300` in the live ledger (Mason's ordering hold). Then re-run
the prover. Under the landing flow `main` adopted in #804, fixes stay on #800: push, wait for checks, relabel for one follow-up CodeRabbit review, and run `gpt-6-sol` last, on the head CodeRabbit approves.

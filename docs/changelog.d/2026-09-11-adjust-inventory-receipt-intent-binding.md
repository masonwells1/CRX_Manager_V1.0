## 2026-09-11 — adjust_inventory checks who is calling before it replays a saved result (LOCAL CANDIDATE, not applied)

> **STATUS SUPERSEDED 2026-09-20:** this migration is now **APPLIED LIVE** (ledger version
> `20260920052149`). The "not applied" wording below is the record as it stood on 2026-09-11 and is
> kept for history; for the apply itself, its gates and its postflight evidence, see
> `2026-09-20-adjust-inventory-receipt-binding-applied-live.md`.

Follow-up to CRX-IDEM-01 from the gpt-5.6-sol exact-SHA review of PR #624 (severity Low). The live `adjust_inventory` looks up a saved idempotency receipt first and returns it before it checks who is calling or whether they are an admin. Anyone who can call the function and holds an unexpired adjustment key could read that adjustment's product and new quantity. That includes a sales rep, a deactivated admin, or a script running on the same site. It could not make a new stock change.

New migration `20260911120000_bind_adjust_inventory_receipt_to_intent.sql`, **not applied**:

- **Order of checks:** sign-in, then the caller may name only themselves, then an active admin profile is required, then a non-blank key. Only after all of that is a saved receipt looked at. The receipt lookup goes through `check_idempotency_intent`, which queues same-key calls behind each other. It replays a receipt only for the same person and the same request (inventory row, quantity, reason). Another admin gets `IDEMPOTENCY_ACTOR_MISMATCH` with no result attached. The same person changing the request gets `IDEMPOTENCY_INTENT_MISMATCH`.
- **Quantity check:** refuses a missing, NaN or infinite quantity. PostgreSQL sorts NaN above every number, so today's body would write it straight into stock. The stock column has no constraint to catch it.
- **Receipts:** each new receipt records who made it and a fingerprint of the request.
- **Cutover safety:** a new trigger refuses any adjust_inventory receipt that lacks the owner and fingerprint. So an old-version call that is caught mid-flight **and carries a key** is rolled back entirely — stock change and ledger row together — because writing its unbound receipt is what the trigger refuses. **Residual, known and accepted:** an old-version call that carries NO key never touches the receipt table at all, so neither the cutover lock nor the trigger sees it, and it can commit one unreceipted adjustment during the install. That is an authenticated admin making an adjustment the live function already allows on every keyless call today, and both screens that call this always send a key. Detect it afterwards read-only by comparing `adjusted` ledger rows written during the install window against bound receipts written in the same window; inspect any extra row, do not reverse it blindly.
- **Refuses to install while old-style receipts exist:** it will not apply while any unexpired old-style adjust_inventory receipt exists. There were none on live on 2026-09-11.
- **Unchanged:** the function's inputs, its result shape and the stock/ledger logic. No screen changes.
- **Not covered:** someone using the same signed-in admin session is, to the database, the same person.

Review follow-ups, 2026-09-11 to 2026-09-13:

- **Expiry dates:** the pre-install check now also counts receipts with no expiry date, because the cleanup never removes those.
- **Trigger timing:** the post-install check confirms the trigger fires before insert on each row.
- **Header:** the wording about the cutover race is corrected, a read-only post-apply check is described, and the header notes that an adjustment made mid-apply can make the migration refuse (safely) for 24 hours.
- **Line endings:** the three new files are pinned to Unix line endings in `.gitattributes`.
- **Proof:** a second active admin is now shown reading the receipt before the fix and refused after it.

Proof, re-observed 2026-09-13 after rebasing onto `main`, with `node scripts/smoke/prove-adjust-inventory-intent-binding-real-schema.mjs`. It ran in a network-disabled throwaway copy of the 2026-07-27 production schema plus all 93 later migrations. The live body's fingerprint was confirmed identical first. The run ended with `ADJUST_INVENTORY_INTENT_REAL_SCHEMA_PASS` and these results:

- **before the fix:** a signed-in sales rep and a second admin, each calling with the first admin's key, received `{"status":"adjusted","product_id":…,"new_quantity":105}`, and stock did not move;
- **old test, old body:** the new rolled-back test fails against the old body (`SMOKE_FAIL: receipt not bound`);
- **old-style receipt:** the migration refused to apply over that receipt (`PREFLIGHT_LEGACY_RECEIPTS`) and left the old body and triggers untouched;
- **cutover:** an old-version call was confirmed blocked mid-flight. The migration then committed, and the resumed call was rolled back by the trigger: no stock change, no ledger row, no receipt;
- **after the fix:** the same sales rep got `INSUFFICIENT_ROLE: Only active admins can adjust inventory`, the second admin got `IDEMPOTENCY_ACTOR_MISMATCH` with no result attached, and the admin's own retry replayed the same result;
- **smoke test:** the rolled-back test `SMOKE_PASS_ROLLBACK`;
- **two sessions, same key:** the second was confirmed waiting on the first. Result: one stock change and one ledger row, both sessions got the same result, and the receipt is bound to the admin;
- **re-run:** the migration applied a second time cleanly;
- **trigger check:** with the trigger deliberately switched off, the test fails on the cutover case.

**Apply order.** A read-only ledger read on 2026-09-11 found 1001 rows and 994 distinct names. The newest version is `20260909023300` and the effective high-water is `20260908120000_close_pr535_live_gaps`, which this file sorts above. PR #624's `20260908130000` migration sorts below this file, so it had to go live first; it was applied live on 2026-09-15 03:32Z (ledger version `20260915033227`, 1002 rows). PR #704 restamped SEVEN migrations (`20260914100100`, `100200`, `100300`, `100400`, `100500`, `100600`, `100900`), but the `20260914100*` band holds EIGHT files: PR #721 later added `20260914100800_bind_transfer_invoice_intent`, which is not one of those restamps. Writing the band as the range `20260914100100`..`20260914100900` while calling it seven undercounts it. All eight sort above this file, so this one had to apply before every one of them — the ordering requirement is unchanged by the corrected count.

**Error tokens.** The two new refusal tokens, `INVALID_ADJUSTMENT_QUANTITY` and the cutover-only `ADJUST_INVENTORY_UNBOUND_RECEIPT`, are registered in `RpcErrorCodes` in `src/lib/db.ts`, as the canonical token rule requires. The exact-head Codex review of 2026-09-15 raised this as a LOW finding. The live-ledger capture in `migration-history.md` and the ledger sentence in `CURRENT_STATE.md` have been updated to match that read. They use the same wording as open PR #646, so the two branches merge without conflict. Both manual docs' "Last verified" stamps now read 2026-09-11.

Still required before any live apply: migration review, a fresh exact-SHA gpt-5.6-sol review, and Mason's explicit approval in chat. Once applied, the comment in `src/pages/InventoryPage.tsx` that says this RPC "replays on the key alone" is out of date. PR #624 rewrites that block, so whoever lands #624 should update it.

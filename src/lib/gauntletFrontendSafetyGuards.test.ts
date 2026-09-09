/**
 * Caller-side prevention contracts for the Section 5/6/15 gauntlet fixes.
 *
 * These are deliberately source-level: each bug is a sequencing or intent
 * binding rule between React and an existing RPC, where a mocked RPC response
 * cannot prove that the caller retained the required key or wait barrier.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Windows checkouts materialize these sources with CRLF (core.autocrlf=true), so
// multi-line toContain assertions written with LF would fail there while passing
// in CI. Normalize for the same reason scripts/normalize-eol.mjs exists.
const source = (path: string) =>
  readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');

describe('gauntlet caller-side safety guards', () => {
  it('serializes cycle-count edits and completes only after a fresh authoritative read', () => {
    const page = source('src/pages/CycleCounts.tsx');
    expect(page).toContain('itemWriteQueuesRef');
    // Completion waits on the pending writes OF THE COUNT BEING COMPLETED, never
    // the component-wide set. `pendingItemWritesRef` outlives the detail modal, so
    // an unscoped await made completing count B hang on a stalled save from count
    // A, with nothing to time it out. Pin the scoping and not merely the await:
    // the unscoped `Promise.all([...pendingItemWritesRef.current])` IS the bug, and
    // it satisfies any assertion that only looks for an await on that ref. Both
    // halves of the pairing are named, and the old unscoped form is denied
    // outright so this cannot silently regress back to it.
    expect(page).toContain('const completingCountId = activeCount.id;');
    expect(page).toContain('.filter((entry) => entry.cycleCountId === completingCountId)');
    expect(page).not.toContain('await Promise.all([...pendingItemWritesRef.current])');
    expect(page).toMatch(/waitForAuthoritativeCountItems[\s\S]*refreshCountItems/);
    expect(page).toContain('disabled={preparingCompletion || completing}');
    expect(page).toContain('onConfirm={() => { void executeComplete(); }}');
  });

  it('keeps bulk field-import RPC intents stable per imported row and refuses re-entry', () => {
    const component = source('src/components/fields/BulkFieldImport.tsx');
    expect(component).toContain('uploadInFlightRef.current');
    // NO RETAINED IDEMPOTENCY KEY ON THIS SCREEN. A fresh UUID per call, deliberately.
    //
    // This pin protects a SETTLED decision, not an implementation detail. Retaining a
    // content-derived key so a lost response can be replayed sounds strictly safer and
    // is not: every scheme tried has silently corrupted a DIFFERENT field, for a
    // structural reason.
    //
    //   * Keyed on the payload alone, two rows with the same customer, name and stated
    //     acreage but different ground share a key. save_field replays, returns the
    //     first row's id, and the second row's boundary write overwrites that field.
    //   * Keyed on the payload AND the geometry, a corrected boundary changes the key,
    //     so re-importing one fixed row creates a SECOND field.
    //
    // Those two cases are textually identical - same customer, same name, same payload,
    // different geometry - so nothing computable from the row can tell a correction from
    // a genuinely different field. Settled 2026-09-05 after two independent gpt-5.6-sol
    // rounds, and re-confirmed on 2026-09-08 when CodeRabbit and the Codex bot each
    // found a fresh corruption path in a fresh scheme.
    //
    // A per-call UUID duplicates instead of replaying, which is the VISIBLE and
    // recoverable failure: an admin can delete a duplicate field, while a rewritten
    // boundary is silent data loss on a field that imported correctly.
    //
    // The real fix is one atomic server-side RPC creating field + boundary + override in
    // a single transaction. That is a migration and it is Mason's call.
    expect(component.match(/p_idempotency_key: crypto\.randomUUID\(\),/g) ?? []).toHaveLength(3);
    // Deny every retained-key form by SHAPE, not by naming the three variables a
    // previous version happened to use.
    expect(component).not.toMatch(/p_idempotency_key:\s*\w*[Ii]dem\./);
    expect(component).not.toContain('useIdempotencyKey(');
    expect(component).not.toContain('getKeyFor(');
    expect(component).not.toContain('resetKeyFor(');
    // The position-derived scope this PR originally shipped must not come back either.
    expect(component).not.toContain('import:${fieldIndex}');
    expect(component).not.toContain('digestIntentPayload(');
    expect(component).not.toContain('fingerprintIntentPayload(');
    // The operator-facing half is what makes the duplicate acceptable: a row whose
    // outcome was never learned must be reported as unknown, not as safe to re-import.
    expect(component).toContain('let unknownOutcome = 0;');
    expect(component).toContain('OUTCOME UNKNOWN');
    // The override step must tell a lost response apart from a refusal: "billing on
    // the measured acres instead" is a false statement about BILLABLE acres when the
    // override committed and only its answer was lost.
    expect(component).toContain('let overrideUnknown = true;');
    expect(component).toContain('if (rpcDefinitelyRolledBack(ovStatus, ovErr)) overrideUnknown = false;');
    // Both halves of the re-entry pairing, pinned SEPARATELY and anchored.
    //
    // This was previously a single whole-file toContain of
    // 'if (uploadInFlightRef.current) return;'. That string is the DISMISSAL
    // guard in handleClose; the upload guard reads
    // 'if (!profile || uploadInFlightRef.current) return;' and never matched it.
    // So the assertion named "refuses re-entry" was satisfied entirely by the
    // close guard: deleting the upload guard left this test green while a rapid
    // double-submit ran two import pipelines.
    //
    // 1. handleUpload refuses re-entry — anchored to the handler's first line so
    //    deleting or relocating the guard fails here.
    expect(component).toMatch(
      /const handleUpload = async \(\) => \{\n\s*if \(!profile \|\| uploadInFlightRef\.current\) return;/,
    );
    // 2. every dismissal path stays disabled until the import reaches a terminal screen.
    expect(component).toContain('if (uploadInFlightRef.current) return;');
    expect(component).toContain('closeDisabled={uploading}');
  });

  it('binds duplicate recipes and negative-inventory reconciliation to a row-specific retry intent', () => {
    const recipes = source('src/pages/BlendRecipes.tsx');
    const integrity = source('src/components/integrity/IntegrityCleanupPanel.tsx');
    expect(recipes).toContain('duplicateInFlightRef.current.has(scope)');
    // The duplicate key is bound to the fetched recipe snapshot, so editing the
    // source recipe and duplicating again cannot replay the earlier receipt.
    expect(recipes).toContain('p_idempotency_key: duplicateRecipeIdem.getKeyFor(intentScope)');
    expect(recipes).toContain('const intentScope = `${scope}:${fingerprintIntentPayload([');
    expect(recipes).toContain('duplicateItems,');
    expect(integrity).toContain('reconcileInFlightRef.current.has(scope)');
    expect(integrity).toContain('p_idempotency_key: reconcileIdem.getKeyFor(scope)');
  });

  it('deduplicates damaged-receipt alerts by receipt IDs with server-side intent binding', () => {
    const triggers = source('src/lib/notificationTriggers.ts');
    const detail = source('src/pages/PurchaseOrderDetail.tsx');
    const quickReceive = source('src/components/receiving/QuickReceivePanel.tsx');
    expect(triggers).toContain("JSON.stringify([...receiptIntentIds].sort())");
    expect(triggers).toContain('damaged-receiving:${poId}:${receiptIntentDigest}');
    expect(triggers).toContain("globalThis.crypto.subtle.digest(\n    'SHA-256'");
    const migration = source('supabase/migrations/20260831233000_bind_section9_replays_to_intent.sql');
    expect(migration).toContain("'items_summary', p_items_summary");
    expect(migration).toContain("'actor_id', v_actor");
    expect(detail).toContain('await notifyDamagedReceiving(po.po_number, damagedItems, po.id, damagedReceiptIntentIds)');
    expect(quickReceive).toContain('await notifyDamagedReceiving(firstPO, damagedInfo, firstPOId, damagedReceiptIntentIds)');
  });

  it('keeps extension-only overloads excluded without hiding a mixed extension/application collision', () => {
    const predicate = source('scripts/db-invariant-sweeps/predicates/overloads.sql');
    expect(predicate).toContain('AND bool_or(NOT EXISTS');
    expect(predicate).not.toMatch(/WHERE p\.pronamespace[\s\S]*?AND NOT EXISTS[\s\S]*?GROUP BY p\.proname/);
  });

  it('classifies known legacy-tab redirects as intentional crawl outcomes', () => {
    const crawl = source('tests/crawl/route-crawl.spec.ts');
    expect(crawl).toContain("intentionalRedirectTo: '/integrity'");
    expect(crawl).toContain("status = 'intentional-redirect'");
    expect(crawl).toContain("r.status !== 'intentional-redirect'");
    // Assert BOTH markers exist before comparing their positions. `indexOf`
    // returns -1 for a missing marker, and -1 is less than any real index, so
    // deleting the `network-errors` classification entirely would leave this
    // ordering assertion green — the guard would pass by being absent. The
    // `intentional-redirect` marker is independently required by the
    // `toContain` above; `network-errors` was not, which is the hole.
    const networkErrorsAt = crawl.indexOf("status = 'network-errors'");
    const intentionalRedirectAt = crawl.indexOf("status = 'intentional-redirect'");
    expect(networkErrorsAt).toBeGreaterThanOrEqual(0);
    expect(intentionalRedirectAt).toBeGreaterThanOrEqual(0);
    expect(networkErrorsAt).toBeLessThan(intentionalRedirectAt);
  });

  // A lost reverse_receiving_record response leaves the reversal COMMITTED and
  // the row DELETED server-side. The catch used to rotate the key and report an
  // error, so the operator's retry hit "Receiving record not found" and neither
  // refresh ran — the already-reversed row stayed on screen and clickable. The
  // committed receipt arrives in the IDEMPOTENCY_INTENT_MISMATCH DETAIL; redeem
  // it instead, and only when it belongs to the record actually on screen.
  it('redeems the committed receipt when a receiving reversal response is lost', () => {
    const page = source('src/pages/PurchaseOrderDetail.tsx');

    expect(page).toContain(
      "const receipt = getIdempotencyMismatchResult(err, 'reverse_receiving_record');",
    );
    // The id comparison is the whole safety of the branch: without it a receipt
    // for a DIFFERENT record would close this modal and claim this row handled.
    expect(page).toContain('if (receipt && receipt.record_id === reverseRecord.id) {');
    // Redeeming means the screen is brought back in line with the server. If the
    // refreshes are dropped the stale row survives, which is the original bug.
    const branch = page.slice(page.indexOf('if (receipt && receipt.record_id === reverseRecord.id) {'));
    const branchBody = branch.slice(0, branch.indexOf('} else {'));
    expect(branchBody).toContain('setReverseOpen(false);');
    expect(branchBody).toContain('fetchPO();');
    expect(branchBody).toContain('fetchReceivingHistory();');
  });

  // Negative-inventory rows write an ABSOLUTE quantity_available, so a stale one
  // left on screen is a second absolute write, not a cosmetic artifact. Two
  // separate holes produced that: the reconciled row was only removed by the
  // refresh, and a Supabase failure on the negatives query arrives FULFILLED as
  // { data: null, error }, which the rejected-only Sentry loop never sees.
  it('retires a reconciled negative-inventory row locally and clears the list when its query fails', () => {
    const integrity = source('src/components/integrity/IntegrityCleanupPanel.tsx');

    // Removed immediately after the receipt is retired, BEFORE the refresh, so a
    // failed refresh cannot leave the row clickable.
    expect(integrity).toMatch(
      /reconcileIdem\.resetKeyFor\(scope\);\n(?:\s*\/\/.*\n)*\s*setNegatives\(\(prev\) => prev\.filter\(\(r\) => r\.id !== row\.id\)\);/,
    );
    // The fulfilled-with-error path must report and clear, not fall through.
    expect(integrity).toContain('if (negRes.error) Sentry.captureException(negRes.error);');
    expect(integrity).toContain('setNegatives([]);');
  });

  // Regression guard for the Sol BLOCKERS verdict on ef82064a. The server still
  // replays these RPCs on the key alone, but hold and adjustment now bind a key
  // and payload together in a durable intent record. Their RPCs must therefore
  // use the frozen request, never live form state: this is not a reduction back
  // to a bare getKey(). Retirement and PO actions retain payload-scoped keys.
  it('keeps replay-on-key-only RPCs bound to their current payload', () => {
    const inventory = source('src/pages/InventoryPage.tsx');
    const purchaseOrder = source('src/pages/PurchaseOrderDetail.tsx');

    expect(inventory).toContain('const request = await createHoldIntent.beginIntent({');
    expect(inventory).toContain('const idemKey = createHoldIntent.getIdempotencyKey();');
    expect(inventory).toContain('createHoldIntent.classifyFailure(error)');
    expect(inventory).toContain('await createHoldIntent.resolveIntent();');
    expect(inventory).toContain('const request = await adjustIntent.beginIntent({');
    expect(inventory).toContain('const idemKey = adjustIntent.getIdempotencyKey();');
    expect(inventory).toContain('adjustIntent.classifyFailure(error)');
    expect(inventory).toContain('await adjustIntent.resolveIntent();');

    const holdRpcStart = inventory.indexOf("supabase.rpc('create_inventory_hold', {");
    expect(holdRpcStart).toBeGreaterThan(-1);
    const holdRpc = inventory.slice(holdRpcStart, inventory.indexOf('});', holdRpcStart));
    expect(holdRpc).toContain('p_product_id: request.productId');
    expect(holdRpc).toContain('p_quantity: request.quantity');
    expect(holdRpc).toContain('p_notes: request.notes as string');
    expect(holdRpc).not.toContain('p_product_id: holdProductId');
    expect(holdRpc).not.toContain('p_quantity: parseFloat(holdQty)');
    expect(holdRpc).not.toContain('p_notes: holdNotes');

    const adjustRpcStart = inventory.indexOf("supabase.rpc('adjust_inventory', {");
    expect(adjustRpcStart).toBeGreaterThan(-1);
    const adjustRpc = inventory.slice(adjustRpcStart, inventory.indexOf('});', adjustRpcStart));
    expect(adjustRpc).toContain('p_inventory_id: request.inventoryId');
    expect(adjustRpc).toContain('p_delta: request.delta');
    expect(adjustRpc).toContain('p_reason: request.note as string');
    expect(adjustRpc).not.toContain('p_inventory_id: selectedId');
    expect(adjustRpc).not.toContain('p_delta: qty');
    expect(adjustRpc).not.toContain('p_reason: adjustNote');

    expect(inventory).toContain('const scope = `retire:${fingerprintIntentPayload([deleteConfirmId])}`');
    expect(inventory).toContain('retireIdem.getKeyFor(scope)');

    expect(purchaseOrder).toContain('savePOIdem.getKeyFor(saveScope)');
    expect(purchaseOrder).toContain('fingerprintIntentPayload([poPayload, itemsPayload])');
    expect(purchaseOrder).toContain('cancelPOIdem.getKeyFor(cancelScope)');
    expect(purchaseOrder).toContain('fingerprintIntentPayload([cancelReason || \'Cancelled\'])');

    // The scoped retirement/PO calls still have no durable request record.
    expect(inventory, 'retireIdem must not use a bare getKey()').not.toContain('retireIdem.getKey()');
    for (const idem of ['savePOIdem', 'cancelPOIdem']) {
      expect(purchaseOrder, `${idem} must not use a bare getKey()`).not.toContain(`${idem}.getKey()`);
    }
  });

  // The PO-overage branch runs entirely inside one save handler: beginIntent(),
  // the RPC rejection, classifyFailure(), then the decision. `unresolvedIntent`
  // is React state and still holds its render-time value (null) at that point,
  // so branching on it makes the "another claimant holds this bill" message dead
  // code and the confirmed retry silently drops p_confirm_po_overage. The
  // classifyFailure() return value cannot substitute: it reports 'definitive'
  // both when the record was deleted and when a peer kept it alive.
  it('detects a surviving vendor-bill intent from the ref, not from render-time state', () => {
    const page = source('src/pages/NewVendorBill.tsx');
    const hook = source('src/hooks/useUncertainMutationIntent.ts');

    expect(hook).toContain('const getUnresolvedIntent = useCallback(() => intentRef.current, []);');
    expect(page).toContain('await createBillIntent.classifyFailure(error);');
    expect(page).toContain('if (createBillIntent.getUnresolvedIntent()) {');
    expect(
      page,
      'the overage branch must not read the stale unresolvedIntent state field',
    ).not.toContain('if (createBillIntent.unresolvedIntent) {');
  });

  // Detecting the surviving claim is only half the fix. ReasonModal's confirm path
  // calls handleSave(true, reason), and beginIntent() discards those flags while a
  // pending record exists — so opening the modal here prompts for a reason that is
  // guaranteed to be thrown away, and every confirmation returns to this branch.
  // The blocker must render as a plain banner with no confirmation control.
  it('reports a surviving pending intent without opening the overage reason prompt', () => {
    const page = source('src/pages/NewVendorBill.tsx');

    const branch = page.slice(page.indexOf('if (createBillIntent.getUnresolvedIntent()) {'));
    const branchBody = branch.slice(0, branch.indexOf('return;'));

    expect(branchBody).toContain('setOverageBlockedMessage(');
    expect(
      branchBody,
      'the blocked branch must not set overageMessage — that opens ReasonModal, whose confirmation cannot reach the server',
    ).not.toContain('setOverageMessage(');
    expect(
      page,
      'ReasonModal must stay driven only by overageMessage',
    ).toContain('open={overageMessage !== null}');
  });
});

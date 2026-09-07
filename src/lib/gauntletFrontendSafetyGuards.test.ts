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
    // The scope must bind the row's CONTENT, not just its position and name.
    // A lost save_field response keeps the key cached while the modal stays
    // mounted, so a position-only scope would let a later import of different
    // geometry replay the earlier field_id and overwrite that field.
    expect(component).toContain(
      'const intentScope = `import:${fieldIndex}:${pf.customer_id}:${pf.field_name}:${fingerprintIntentPayload([',
    );
    expect(component).toContain('pf.full_boundary_geojson,');
    expect(component).toContain('pf.stated_acres ?? null,');
    expect(component).toContain('saveFieldIdem.getKeyFor(intentScope)');
    expect(component).toContain('setBoundaryIdem.getKeyFor(intentScope)');
    expect(component).toContain('setOverrideAcresIdem.getKeyFor(intentScope)');
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

  // Regression guard for the Sol BLOCKERS verdict on ef82064a. This branch
  // removed six per-open resetKey() calls and replaced them with retained keys,
  // on the assumption that the server would answer a changed intent with
  // IDEMPOTENCY_INTENT_MISMATCH. For these five RPCs it does not: the live
  // catalog shows create_inventory_hold / adjust_inventory /
  // retire_inventory_item / save_purchase_order / cancel_purchase_order carry
  // no actor or payload binding, and none of the six 20260831 migrations add
  // one. A retained key therefore has to be scoped to the payload on the client
  // or a reopened dialog on a DIFFERENT target replays the earlier receipt and
  // reports a hold, adjustment, retirement, PO edit or PO cancellation that
  // never happened. Never reduce these back to a bare getKey().
  it('scopes retained keys for the RPCs that replay on the key alone', () => {
    const inventory = source('src/pages/InventoryPage.tsx');
    const purchaseOrder = source('src/pages/PurchaseOrderDetail.tsx');

    expect(inventory).toContain('const holdIntentScope = (force: boolean, forceReason: string | null) =>');
    expect(inventory).toContain('createHoldIdem.getKeyFor(scope)');
    expect(inventory).toContain('const scope = `adjust:${fingerprintIntentPayload([selectedId, qty, adjustNote || null])}`');
    expect(inventory).toContain('adjustIdem.getKeyFor(scope)');
    expect(inventory).toContain('const scope = `retire:${fingerprintIntentPayload([deleteConfirmId])}`');
    expect(inventory).toContain('retireIdem.getKeyFor(scope)');

    expect(purchaseOrder).toContain('savePOIdem.getKeyFor(saveScope)');
    expect(purchaseOrder).toContain('fingerprintIntentPayload([poPayload, itemsPayload])');
    expect(purchaseOrder).toContain('cancelPOIdem.getKeyFor(cancelScope)');
    expect(purchaseOrder).toContain('fingerprintIntentPayload([cancelReason || \'Cancelled\'])');

    // The unscoped form is what regressed; keep it out of these two files for
    // the five unbound RPCs.
    for (const idem of ['createHoldIdem', 'adjustIdem', 'retireIdem']) {
      expect(inventory, `${idem} must not use a bare getKey()`).not.toContain(`${idem}.getKey()`);
    }
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

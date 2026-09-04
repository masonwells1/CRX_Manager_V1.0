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
    expect(page).toContain('await Promise.all([...pendingItemWritesRef.current])');
    expect(page).toMatch(/waitForAuthoritativeCountItems[\s\S]*refreshCountItems/);
    expect(page).toContain('disabled={preparingCompletion || completing}');
    expect(page).toContain('onConfirm={() => { void executeComplete(); }}');
  });

  it('keeps bulk field-import RPC intents stable per imported row and refuses re-entry', () => {
    const component = source('src/components/fields/BulkFieldImport.tsx');
    expect(component).toContain('uploadInFlightRef.current');
    // ── Each RPC stage carries its OWN intent scope ──────────────────────
    //
    // These three RPCs previously SHARED one scope built from the row's file
    // position plus the boundary geometry plus the stated acreage. save_field
    // COMMITS before the other two run and consumes none of that, so when the
    // boundary call failed and the operator corrected the geometry and
    // re-imported just that row, the position AND the geometry both changed, a
    // fresh key was minted, save_field ran again with p_field_id: null, and the
    // retry created a SECOND field while the first, boundary-less one stayed
    // orphaned (fields_delete RLS is admin-only — a sales_rep cannot remove it).
    //
    // save_field's scope is therefore built ONLY from the columns save_field
    // itself writes. A per-identity occurrence counter replaces the file
    // position: it keeps two genuinely identical rows on separate keys while
    // staying stable when only the failed row is re-imported.
    expect(component).toContain('const saveIdentityDigest = fingerprintIntentPayload(fieldIdentity);');
    expect(component).toContain('const saveScope = `import:save:${saveIdentityDigest}:#${saveOccurrence}`;');
    // Pin the counter's MECHANISM, not merely its appearance in the scope string.
    // Codex (gpt-5.6-sol, 2026-09-04, finding 24) showed that asserting only the
    // scope string is vacuous: replacing the whole counter with `const
    // saveOccurrence = 0;` left this guard AND the behavioral suite green while
    // every identical row collapsed onto one key. Verified by running that exact
    // mutation. Pin the read and the increment so a neutered counter fails here.
    expect(component).toContain('const saveIdentityOccurrences = new Map<string, number>();');
    expect(component).toContain('const saveOccurrence = saveIdentityOccurrences.get(saveIdentityDigest) ?? 0;');
    expect(component).toContain('saveIdentityOccurrences.set(saveIdentityDigest, saveOccurrence + 1);');
    // total_acres is deliberately OUTSIDE the identity: excluding it is what lets a
    // corrected-geometry retry replay onto the field already created. NOT because
    // "the seed never survives" — that rationale was false (Codex round 1, finding
    // 3): a SUCCESSFUL set_field_boundary overwrites it, but on the failure path the
    // seed persists on the boundary-less field. Pinned as the spread that adds it
    // back, so moving it into fieldIdentity fails here.
    expect(component).toContain('const fieldPayload = { ...fieldIdentity, total_acres: pf.total_acres };');
    expect(component).not.toMatch(/const fieldIdentity = \{[^}]*total_acres/);
    // Stages 2 and 3 bind to the field id save_field ACTUALLY returned plus
    // their own exact payload — never a sibling stage's data.
    expect(component).toContain(
      'const boundaryScope = `import:boundary:${fieldId}:${fingerprintIntentPayload(pf.full_boundary_geojson)}`;',
    );
    expect(component).toContain("const overrideScope = `import:override:${fieldId}:${pf.stated_acres ?? 'none'}`;");
    expect(component).toContain('saveFieldIdem.getKeyFor(saveScope)');
    expect(component).toContain('setBoundaryIdem.getKeyFor(boundaryScope)');
    expect(component).toContain('setOverrideAcresIdem.getKeyFor(overrideScope)');
    // No stage may fall back to one shared scope again.
    expect(component).not.toContain('intentScope');

    // ── Stage retirement, pinned as a PAIRING with the getKeyFor calls above ──
    //
    // The previous version of this test asserted only the three getKeyFor calls.
    // Deleting all three resetKeyFor lines left it GREEN while every key leaked
    // for the modal's lifetime — the assertion was satisfied by the half of the
    // pairing that was never in doubt.
    //
    // One anchored match pins all three halves at once: each stage retires with
    // its OWN scope, all three together, immediately after the row is counted a
    // success. That placement is load-bearing. Retiring save_field's key at its
    // own success instead would RE-CREATE the duplicate-field bug: save_field has
    // already committed by the time the boundary call fails, so a retry would find
    // the key gone, mint a fresh one, and insert a second field.
    // Retirement is additionally gated on overrideOk. Codex (finding 2, confirmed
    // from source at 100% rather than its stated 75%) showed the ungated form let a
    // boundary-success/override-FAILURE row retire its save key while the row was
    // unfinished — so retrying the acreage minted a fresh key and inserted a SECOND
    // field. The gate is pinned inside the same anchored match as the three resets,
    // so removing it fails here rather than silently reopening the duplicate path.
    expect(component).toContain('let overrideOk = true;');
    // BOTH failure paths must clear it, not just the RPC rejection. A stated acreage
    // the CLIENT rejects as out-of-band never reaches the server, but the requested
    // billing acreage still did not land — and correcting it and re-importing is the
    // same retry shape (Codex round 2, finding 1). Pinned as two occurrences so
    // deleting the out-of-band one fails here.
    expect(component.match(/overrideOk = false;/g)).toHaveLength(2);
    expect(component).toMatch(
      /if \(!isAcreInBand\(pf\.stated_acres\)\) \{\n\s*overrideOk = false;/,
    );
    expect(component).toMatch(
      /\n\s*success\+\+;\n(?:\s*\/\/[^\n]*\n)*\s*if \(overrideOk\) \{\n\s*saveFieldIdem\.resetKeyFor\(saveScope\);\n\s*setBoundaryIdem\.resetKeyFor\(boundaryScope\);\n\s*setOverrideAcresIdem\.resetKeyFor\(overrideScope\);\n\s*\}/,
    );
    // Exactly one retirement per stage, so none can ALSO be retired earlier.
    expect(component.match(/saveFieldIdem\.resetKeyFor\(/g)).toHaveLength(1);
    expect(component.match(/setBoundaryIdem\.resetKeyFor\(/g)).toHaveLength(1);
    expect(component.match(/setOverrideAcresIdem\.resetKeyFor\(/g)).toHaveLength(1);
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
    expect(crawl.indexOf("status = 'network-errors'"))
      .toBeLessThan(crawl.indexOf("status = 'intentional-redirect'"));
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

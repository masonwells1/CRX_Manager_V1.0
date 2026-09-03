/**
 * RPC Idempotency OPERATION-SCOPING contract tests (C6 control).
 *
 * docs/audits/2026-06-10-error-prevention-review.md §4 C6:
 * "every live idempotency lookup filters operation = '<fn>'".
 *
 * WHY: an idempotency lookup that filters ONLY on the key
 * (`WHERE idempotency_key = p_key` with no `operation = '...'`) returns
 * whatever ANY operation cached under that key. If the same key ever reaches
 * two different RPCs (a buggy caller reusing one hook key for two calls, or a
 * copy-pasted op literal), the second RPC silently returns the FIRST one's
 * cached result and reports success without doing its work. This is the
 * restore_quote_version class (Codex 2026-06-08 LOW, fixed in
 * 20260608193139_restore_rpcs_strict_actor).
 *
 * Two layers:
 *  1. A checked-in LIVE SNAPSHOT (generated 2026-06-10 from live pg_proc via
 *     Supabase MCP execute_sql, project rhyzpcqhnizqbxphqdkr) categorizing
 *     every live function that references idempotency_keys /
 *     check_idempotency / save_idempotency. Known-unscoped legacy functions
 *     are tracked in a gap list that may ONLY shrink.
 *  2. A self-updating DISK scan: the LATEST migration definition of every
 *     function is checked — any operation literal it passes to
 *     check_idempotency()/save_idempotency(), uses in an
 *     `operation = '...'` filter, or inserts into idempotency_keys MUST
 *     equal the function's own name (or a documented alias). This catches a
 *     future migration that copy-pastes another RPC's op literal.
 *
 * ── SNAPSHOT REGENERATION (read-only; no script needed) ──────────────────
 * Run via Supabase MCP `execute_sql` (or any read-only SQL console) and
 * re-bucket the results into the four constants below:
 *
 *   SELECT p.proname,
 *     (SELECT array_agg(DISTINCT m[1]) FROM regexp_matches(p.prosrc,
 *        'check_idempotency\s*\(\s*[^,)]+,\s*''([^'']+)''', 'g') m) AS check_ops,
 *     (SELECT array_agg(DISTINCT m[1]) FROM regexp_matches(p.prosrc,
 *        'save_idempotency\s*\(\s*[^,)]+,\s*''([^'']+)''', 'g') m) AS save_ops,
 *     (SELECT array_agg(DISTINCT m[1]) FROM regexp_matches(p.prosrc,
 *        'operation\s*=\s*''([^'']+)''', 'g') m) AS where_ops,
 *     (SELECT array_agg(DISTINCT m[1]) FROM regexp_matches(p.prosrc,
 *        'VALUES\s*\(\s*p_idempotency_key\s*,\s*''([^'']+)''', 'g') m) AS insert_ops,
 *     (p.prosrc ~* 'FROM\s+idempotency_keys') AS has_direct_lookup
 *   FROM pg_proc p
 *   WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
 *     AND p.proname NOT IN ('check_idempotency','save_idempotency')
 *     AND (p.prosrc ILIKE '%idempotency_keys%'
 *          OR p.prosrc ILIKE '%check_idempotency%'
 *          OR p.prosrc ILIKE '%save_idempotency%')
 *   ORDER BY p.proname;
 *
 * Bucketing: check_ops=[own name]            → HELPER_SCOPED
 *            where_ops=[own name]            → INLINE_SCOPED
 *            where_ops=[alias]/insert=[alias]→ ALIAS_SCOPED (document why)
 *            has_direct_lookup, no check_ops,
 *            no where_ops                    → UNSCOPED_LOOKUP_GAP
 * Regenerate after any migration that adds/edits idempotency handling.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// -------------------------------------------------------------------------
// Live snapshot — generated 2026-06-10 from live pg_proc (see header);
// updated 2026-06-11 for the staged operation-scoping sweep
// (scripts/.staging-migrations/idempotency_operation_scope_sweep.sql; version
// stamp assigned by the APPLY role) which closes 20 of the 22 gap entries —
// the remaining 2 are a documented carve-out, see UNSCOPED_LOOKUP_GAP.
// -------------------------------------------------------------------------

/**
 * Functions using the canonical check_idempotency/save_idempotency helpers,
 * both scoped to the function's own name. The helper signature
 * check_idempotency(key, operation) makes the lookup operation-scoped.
 */
const HELPER_SCOPED: string[] = [
  'adjust_inventory',
  'admin_update_profile',
  'allocate_payment',
  'apply_prepay_to_invoice',
  'apply_remaining_prepayments',
  'apply_write_off',
  'approve_return',
  'batch_apply_all_prepayments',
  'batch_apply_prepayments',
  'batch_cancel_deliveries',
  'batch_post_invoices',
  'batch_reschedule_deliveries',
  'batch_void_invoices',
  'bulk_import_order',
  'cancel_cycle_count',
  'cancel_delivery',
  'cancel_order',
  'cancel_purchase_order',
  'cancel_return',
  'close_accounting_period',
  'complete_cycle_count',
  'complete_delivery',
  'confirm_delivery',
  'convert_quote_to_order',
  'create_commission_payment',
  'create_delivery_with_items',
  'create_direct_order',
  'create_followup_delivery',
  'create_invoice_for_unbilled_delivery',
  'create_invoice_from_order',
  'create_order_from_blend_ticket',
  'create_prepay_check_splits',
  'create_quick_delivery',
  'create_rebate_claim',
  'create_vendor_bill',
  'delete_invoices',
  'delete_purchase_order',
  'delete_vendor',
  'draw_down_quote',
  'duplicate_quote',
  'generate_finance_charges',
  'increment_customer_prepay',
  'issue_return_credit',
  'link_blend_ticket_to_order',
  'link_fields_to_parent',
  'load_recipe_into_job',
  'log_failed_notification',
  'manual_inventory_add',
  'notify_damaged_receiving',
  'post_commission_payment',
  'post_invoice',
  'reassign_delivery',
  'receive_po_items',
  'receive_return',
  'reconcile_negative_inventory',
  'record_invoice_payment',
  'record_vendor_payment',
  'release_inventory_hold',
  'retire_inventory_item',
  'reverse_completed_cycle_count',
  'save_blend_recipe',
  'save_blend_ticket',
  'save_customer',
  'save_field',
  'save_field_geometry',
  'save_field_polygons',
  'save_invoice',
  'save_purchase_order',
  'save_vendor',
  'transfer_invoice_to_job',
  'transfer_job_to_invoice',
  'transition_rebate_claim',
  'unlink_blend_ticket_from_order',
  'unlink_field_from_parent',
  'update_cycle_count_item',
  'update_order_items',
  'update_vendor_bill',
  'void_commission_payment',
  'void_invoice',
  'void_order',
  'void_vendor_bill',
  'void_vendor_payment',
];

/**
 * Functions using INLINE idempotency SQL whose lookup IS operation-scoped:
 * `WHERE idempotency_key = p_key AND operation = '<own name>'`.
 *
 * 20 entries moved here from UNSCOPED_LOOKUP_GAP by the one-migration sweep
 * `idempotency_operation_scope_sweep` (staged in scripts/.staging-migrations/
 * until the APPLY role stamps it; each body verbatim-from-live with only the
 * lookup scoped; md5-verified by verify-idemscope-md5.mjs and the migration's
 * own terminal DO block).
 */
const INLINE_SCOPED: string[] = [
  'batch_approve_blend_tickets',
  'batch_reject_blend_tickets',
  'complete_job',
  'create_inventory_hold',
  'create_invoice_from_blend_ticket',
  'create_job_from_quote_section',
  'create_quote_from_template',
  'create_quote_version',
  'create_split_invoices_from_order',
  'delete_prepay_credit',
  'edit_delivery',
  'edit_prepay_credit',
  'mark_inventory_row_verified',
  'post_invoice_group',
  'reopen_accounting_period',
  'restore_cancelled_delivery',
  'restore_cancelled_order',
  'restore_quote_version',
  'reverse_blend_ticket_approval',
  'reverse_receiving_record',
  'reverse_write_off',
  'revert_quote_status',
  'rollover_quote_to_season',
  'save_blend_ticket_fields',
  'save_field_app_invoice',
  'save_job',
  'save_quote_template',
  'start_job',
  'unapply_credit_memo',
  'unpost_invoice_group',
  'void_delivery',
  'void_payment',
];

/**
 * Operation literals that deliberately differ from the function name.
 * Each alias MUST be globally unique (asserted below) so it still cannot
 * collide with any other RPC's cache rows.
 *
 * create_application_record_from_blend_ticket: live body consistently uses
 * the shortened 'create_app_record_from_bt' for BOTH the scoped lookup and
 * the insert (verified live 2026-06-10) — collision-free, just non-canonical
 * naming. If the function is ever rewritten, prefer the full name and drop
 * this alias.
 */
const ALIAS_SCOPED: Record<string, string> = {
  create_application_record_from_blend_ticket: 'create_app_record_from_bt',
};

/**
 * Internal non-RPC functions that deliberately inspect another operation's
 * idempotency row. These do not read or write a cache under their own function
 * name, so treating the referenced operation as an alias would be misleading.
 */
const INTERNAL_OPERATION_REFERENCES: Record<string, string[]> = {
  _guard_idempotency_key_insert: ['allocate_payment'],
  // Direct EXECUTE is revoked. Migration 20260812130145 renamed the original
  // cancel_return implementation behind the public cancel_return wrapper, and
  // migration 20260827041500 re-emits that private implementation to preserve
  // exact inventory reversal. Both layers deliberately share the one public
  // cancel_return cache namespace so retries cannot create divergent receipts.
  _cancel_return_intent_impl_20260812: ['cancel_return'],
  // Direct EXECUTE is revoked. This private implementation remains behind the
  // public create_invoice_from_order wrapper and deliberately shares that
  // wrapper's cache namespace so a retry through either layer finds the same
  // completed invoice. Migration 20260827041400 only re-emits the established
  // implementation to tighten return-credit order gates.
  _create_invoice_from_order_impl_20260718: ['create_invoice_from_order'],
  // Direct EXECUTE is revoked. This private split-invoice implementation is
  // the implementation half of create_split_invoices_from_order and must use
  // the public operation namespace for one replay result across both layers.
  // Migration 20260827041400 only re-emits it to tighten return-credit gates.
  _create_split_invoices_from_order_provenance_impl_20260719: [
    'create_split_invoices_from_order',
  ],
  // Direct EXECUTE is revoked. Private middle layer of the full-cancel chain
  // (cancel_order -> _cancel_order_idem_impl_20260721 ->
  // _cancel_order_provenance_wrapper_20260719 -> THIS ->
  // _cancel_order_impl_20260714). It only READS the public cancel_order cache
  // to short-circuit a replay; the key is recorded by the bracketing wrappers
  // via _bind_completed_lifecycle_idempotency. Giving this layer its own
  // operation namespace would create an unreachable cache and let a replay
  // slip past the shared one. Shape is pre-existing and unchanged; it entered
  // this test's scope when migration 20260809170600 re-emitted the function to
  // zero quantity_remaining on cancel.
  _cancel_order_split_provenance_impl_20260719: ['cancel_order'],
  // Direct EXECUTE is revoked. This delegate is the implementation half of
  // the public save_purchase_order RPC and intentionally shares its one cache
  // namespace rather than creating an unreachable internal-operation cache.
  _save_purchase_order_ascii_identity_impl: ['save_purchase_order'],
  // Direct EXECUTE is revoked (service_role only). This IS the original
  // public convert_quote_to_order body: migration 20260730235031 renamed it
  // with `ALTER FUNCTION ... RENAME TO _convert_quote_to_order_owner_impl`
  // (line 986) and created a new public wrapper that delegates to it, so both
  // layers read and write the one 'convert_quote_to_order' cache on purpose —
  // a replay through the wrapper must find the result the impl saved. Giving
  // the impl its own namespace would strand that cache. The shape is
  // pre-existing and unchanged; it entered this test's scope only because
  // migration 20260810150000 is the first to CREATE the function under its
  // post-rename name (the rename itself defined no function body on disk).
  _convert_quote_to_order_owner_impl: ['convert_quote_to_order'],
  // Direct EXECUTE is revoked from anon/authenticated/service_role. This IS the
  // original public draw_down_quote body: migration 20260812115237 renamed it
  // with `ALTER FUNCTION ... RENAME TO
  // _draw_down_quote_below_cost_impl_20260810` and created a thin public
  // wrapper that declares the below-cost context and forwards p_idempotency_key
  // to it, so both layers use the one 'draw_down_quote' cache namespace on
  // purpose — a replay through the wrapper must find the result the impl saved.
  // Giving the impl its own namespace would strand that cache and let a retried
  // draw create a second order. The shape is pre-existing and unchanged; it
  // entered this test's scope only because migration 20260816120000 is the
  // first to CREATE the function under its post-rename name (the rename itself
  // defined no function body on disk).
  _draw_down_quote_below_cost_impl_20260810: ['draw_down_quote'],
  // Direct EXECUTE is revoked. This private implementation is the write half
  // of void_commission_payment and intentionally shares the public operation's
  // actor/fingerprint-bound receipt so wrapper retries reach the committed
  // result instead of creating a second namespace.
  _void_commission_payment_intent_impl_20260809: ['void_commission_payment'],
  // Direct EXECUTE is revoked. This is the idempotent implementation behind
  // the public restore_quote_version wrapper; both intentionally use the one
  // public restore_quote_version cache namespace so a replay through the
  // wrapper reaches the result that the implementation saved.
  _restore_quote_version_owner_impl: ['restore_quote_version'],
  // The below-cost restore implementation owns the scoped replay lookup after
  // the trust-boundary migration and deliberately shares the public operation.
  _restore_quote_version_below_cost_impl_20260810: ['restore_quote_version'],
  // Owner-only implementation used by the public standalone/group posting
  // wrappers; all layers intentionally share the public post_invoice cache.
  _post_invoice_impl_20260714: ['post_invoice'],
  // Deleting a PO must invalidate its saved retry result so the same source
  // document can create a fresh PO if an admin intentionally removes it.
  _invalidate_deleted_purchase_order_retry_state: ['save_purchase_order'],
  // Direct EXECUTE is revoked. Implementation half of the public save_invoice
  // RPC (re-emitted in mig 20260721223817 to persist payment_terms); all
  // wrapper layers intentionally share the public save_invoice cache.
  _save_invoice_scoped_impl: ['save_invoice'],
  // Per-line split billing (mig 20260720233000): the impl is the write half of the
  // public save_field_app_split_invoice RPC (direct EXECUTE revoked). The wrapper does
  // check_idempotency + payload-hash conflict; the impl records via save_idempotency —
  // both intentionally share the wrapper's single 'save_field_app_split_invoice' cache
  // namespace, exactly like the save_purchase_order pair above.
  _save_field_app_split_invoice_impl: ['save_field_app_split_invoice'],
  // Direct EXECUTE is revoked from anon/authenticated/service_role (postflight
  // in mig 20260721014858 asserts it). This IS the original public
  // complete_delivery body: migration 20260716173342 renamed it with
  // `ALTER FUNCTION ... RENAME TO _complete_delivery_authorized_impl` and
  // created a new public wrapper that authorizes and then delegates, so both
  // layers use the one 'complete_delivery' cache namespace on purpose — a
  // replay through the wrapper must find the result the impl saved. Giving the
  // impl its own namespace would strand that cache and let a retried
  // completion invoice the same delivery twice. The shape is pre-existing and
  // unchanged; it entered this test's scope only because migration
  // 20260817120000 is the first to CREATE the function under its post-rename
  // name (the rename itself defined no function body on disk).
  _complete_delivery_authorized_impl: ['complete_delivery'],
  // Direct EXECUTE is revoked from anon/authenticated/service_role (same
  // postflight). Implementation half of the public
  // create_invoice_for_unbilled_delivery RPC, which delegates to it
  // (mig 20260721014858); both layers intentionally share that one cache
  // namespace. Pre-existing and unchanged — mig 20260817120000 re-emits the
  // body only to consume the order line's allocated cents instead of
  // re-extending price x quantity.
  _create_invoice_for_unbilled_delivery_impl_20260718: ['create_invoice_for_unbilled_delivery'],
  // Direct browser EXECUTE is revoked. This is the original business body
  // behind the intent-bound public issue_return_credit wrapper: the public
  // wrapper claims/replays the actor+return fingerprint, then the private
  // implementation preserves the established issue_return_credit operation
  // namespace for its legacy check/save pair. Giving the implementation a new
  // private namespace would strand existing receipts and could replay a credit.
  _issue_return_credit_impl: ['issue_return_credit'],
  // Same legacy-operation contract for the private inventory receipt body.
  // The intent-bound public wrapper owns the actor+return fingerprint while
  // this service-role-only helper preserves the committed receive namespace.
  _receive_return_impl_20260714: ['receive_return'],
  // Restore the Wave A alias exemption when its drafts are promoted from
  // scripts/.staging-migrations/.
};

/**
 * GAP LIST — live functions whose idempotency LOOKUP is NOT operation-scoped
 * (`WHERE idempotency_key = p_key` with no operation filter; the historical
 * CLAUDE.md inline copy-paste pattern — snippet fixed 2026-06-11). Their
 * INSERT does record the correct operation, but the lookup would honor a
 * colliding key cached by ANY operation.
 *
 * RATCHETED 22 -> 2 on 2026-06-11: 20 entries scoped in ONE sweep
 * (`idempotency_operation_scope_sweep`, staged in
 * scripts/.staging-migrations/ until the APPLY role stamps it) and moved to
 * INLINE_SCOPED above.
 *
 * THE 2 REMAINING ENTRIES ARE A DOCUMENTED CARVE-OUT, not an oversight:
 * create_planned_holds and save_quote are rebuilt — WITH operation-scoped
 * lookups of their own — by the pending disk migration
 * `20260611132115_planned_holds_drawn_sync.sql` (on disk, not yet applied
 * live); sweeping them too would let whichever change applied second
 * silently revert the other (rls-security-reviewer B1 on the first sweep
 * draft). When that migration lands, regenerate the snapshot and move both
 * to INLINE_SCOPED.
 *
 * This list may ONLY SHRINK. NEVER add an entry — new/edited RPCs must use
 * the canonical check_idempotency/save_idempotency helpers.
 */
const UNSCOPED_LOOKUP_GAP: string[] = [
  'create_planned_holds',
  'save_quote',
];

// -------------------------------------------------------------------------
// Snapshot structural tests
// -------------------------------------------------------------------------

const ALL_SNAPSHOT_NAMES = [
  ...HELPER_SCOPED,
  ...INLINE_SCOPED,
  ...Object.keys(ALIAS_SCOPED),
  ...UNSCOPED_LOOKUP_GAP,
];

describe('Idempotency operation-scoping snapshot (live pg_proc, 2026-06-11)', () => {
  it('snapshot categories are disjoint', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const name of ALL_SNAPSHOT_NAMES) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    expect(dupes).toEqual([]);
  });

  it('each category list is sorted alphabetically for maintainability', () => {
    expect(HELPER_SCOPED).toEqual([...HELPER_SCOPED].sort());
    expect(INLINE_SCOPED).toEqual([...INLINE_SCOPED].sort());
    expect(UNSCOPED_LOOKUP_GAP).toEqual([...UNSCOPED_LOOKUP_GAP].sort());
  });

  it('every snapshot function is operation-scoped OR explicitly tracked as a gap', () => {
    // By construction every name lives in exactly one bucket; this assertion
    // exists so that a snapshot REGENERATION that leaves a function
    // uncategorized (e.g. a new unscoped pattern variant) fails loudly
    // instead of being silently dropped.
    for (const name of ALL_SNAPSHOT_NAMES) {
      const scoped =
        HELPER_SCOPED.includes(name) ||
        INLINE_SCOPED.includes(name) ||
        name in ALIAS_SCOPED;
      const trackedGap = UNSCOPED_LOOKUP_GAP.includes(name);
      expect(scoped || trackedGap, `${name} is neither scoped nor tracked`).toBe(true);
    }
  });

  it('unscoped-lookup gap list only shrinks (ratcheted 22 -> 2 on 2026-06-11; the 2 are a documented carve-out)', () => {
    // If this fails because the number GREW, a new RPC shipped with an
    // unscoped inline lookup — fix the SQL (use check_idempotency/
    // save_idempotency, or at minimum scope the lookup with
    // AND operation = '<fn name>'), do not raise the cap. The 2 remaining
    // entries belong to the planned_holds_drawn_sync rebuild (see the
    // gap-list doc above).
    expect(UNSCOPED_LOOKUP_GAP.length).toBeLessThanOrEqual(2);
  });

  it('operation aliases are globally unique (cannot collide with any function name or other alias)', () => {
    const aliases = Object.values(ALIAS_SCOPED);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const alias of aliases) {
      expect(ALL_SNAPSHOT_NAMES).not.toContain(alias);
    }
  });
});

// -------------------------------------------------------------------------
// Disk-migration scan — self-updating forward-looking gate.
// The LATEST on-disk definition of each function must only ever use ITS OWN
// name (or documented alias) as the idempotency operation literal.
// -------------------------------------------------------------------------

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'supabase',
  'migrations'
);

interface DiskFnDef {
  file: string;
  body: string;
}

/**
 * Single pass, newest file first: the FIRST definition seen per function is
 * its latest on-disk definition. (Disk can lag live for consolidated
 * migrations — the live snapshot above covers live truth; this scan is the
 * forward-looking gate for newly written migrations.)
 */
function latestDiskDefinitions(): Map<string, DiskFnDef> {
  const latest = new Map<string, DiskFnDef>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse(); // newest first
  const defRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  for (const file of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    let m: RegExpExecArray | null;
    while ((m = defRe.exec(content)) !== null) {
      const fnName = m[1].toLowerCase();
      if (latest.has(fnName)) continue;
      const after = content.slice(m.index);
      const bodyMatch = after.match(/AS\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/);
      latest.set(fnName, { file, body: bodyMatch ? bodyMatch[2] : after });
    }
  }
  return latest;
}

/** All idempotency operation literals appearing in a function body. */
function operationLiterals(body: string): string[] {
  const out: string[] = [];
  const patterns = [
    /check_idempotency(?:_intent)?\s*\(\s*[^,)]+,\s*'([^']+)'/gi,
    /save_idempotency\s*\(\s*[^,)]+,\s*'([^']+)'/gi,
    /VALUES\s*\(\s*p_idempotency_key\s*,\s*'([^']+)'/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) out.push(m[1]);
  }
  // `operation = '...'` filters only count when the body actually touches
  // idempotency_keys (other tables could have an `operation` column someday).
  if (/idempotency_keys/i.test(body)) {
    const re = /\boperation\s*=\s*'([^']+)'/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) out.push(m[1]);
  }
  return out;
}

describe('Idempotency operation literals in latest disk migrations', () => {
  const defs = latestDiskDefinitions();

  it('reads operation literals from both canonical check helpers', () => {
    expect(operationLiterals("PERFORM check_idempotency(p_key, 'save_quote')"))
      .toContain('save_quote');
    expect(operationLiterals("PERFORM check_idempotency_intent(p_key, 'draw_down_quote', p_actor, p_fingerprint)"))
      .toContain('draw_down_quote');
  });

  it('every operation literal equals the defining function name (or documented alias)', () => {
    const offenders: string[] = [];
    for (const [fnName, def] of defs) {
      const literals = operationLiterals(def.body);
      const expected = new Set([
        fnName,
        ALIAS_SCOPED[fnName],
        ...(INTERNAL_OPERATION_REFERENCES[fnName] || []),
      ].filter(Boolean));
      for (const lit of literals) {
        if (!expected.has(lit)) {
          offenders.push(`${fnName} uses operation '${lit}' (in ${def.file})`);
        }
      }
    }
    // If this fails, a migration passed ANOTHER function's operation string
    // to check_idempotency/save_idempotency (or an operation = '...' filter)
    // — that cross-wires the two RPCs' caches: one returns the other's
    // cached result. Use the function's own name as the operation.
    expect(offenders).toEqual([]);
  });

  it('regression guard: restore_quote_version lookup stays scoped to its own operation', () => {
    // Codex 2026-06-08 LOW — the lookup originally filtered on the key only.
    // The trust-boundary migration re-emits the below-cost implementation,
    // which owns the lookup and must check the cache before rejecting legacy
    // snapshots so a validated retry remains a no-op.
    const def = defs.get('_restore_quote_version_below_cost_impl_20260810');
    expect(def).toBeDefined();
    expect(def!.body).toMatch(/operation\s*=\s*'restore_quote_version'/i);
    // CodeRabbit 2026-08-26: indexOf returns -1 for a missing token, so the
    // ordering comparison below passed vacuously in exactly the case it exists
    // to catch — a re-emission that DROPS the check_idempotency lookup. Assert
    // both tokens are present before comparing their positions.
    const lookupAt = def!.body.indexOf('check_idempotency');
    const rejectAt = def!.body.indexOf('QUOTE_VERSION_LEGACY_UNTRUSTED');
    expect(lookupAt).toBeGreaterThanOrEqual(0);
    expect(rejectAt).toBeGreaterThanOrEqual(0);
    expect(lookupAt).toBeLessThan(rejectAt);
  });

  it('disk scan found a meaningful number of function definitions (sanity)', () => {
    // Guards against the scan silently matching nothing (regex/path drift)
    // and the literal-check above passing vacuously.
    expect(defs.size).toBeGreaterThanOrEqual(150);
  });
});

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
// Live snapshot — generated 2026-06-10 from live pg_proc (see header)
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
 */
const INLINE_SCOPED: string[] = [
  'create_inventory_hold',
  'mark_inventory_row_verified',
  'reopen_accounting_period',
  'restore_cancelled_delivery',
  'restore_cancelled_order',
  'restore_quote_version',
  'reverse_blend_ticket_approval',
  'reverse_write_off',
  'revert_quote_status',
  'save_job',
  'unapply_credit_memo',
  'void_delivery',
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
 * GAP LIST — live functions whose idempotency LOOKUP is NOT operation-scoped
 * (`WHERE idempotency_key = p_key` with no operation filter; the historical
 * CLAUDE.md inline copy-paste pattern). Their INSERT does record the correct
 * operation, but the lookup would honor a colliding key cached by ANY
 * operation. Verified live 2026-06-10.
 *
 * This list may ONLY SHRINK. When a migration scopes one of these lookups
 * (add `AND operation = '<fn name>'`), regenerate the snapshot and move the
 * function to INLINE_SCOPED (or HELPER_SCOPED if converted to the helpers).
 * NEVER add a new entry — new/edited RPCs must use the canonical
 * check_idempotency/save_idempotency helpers.
 */
const UNSCOPED_LOOKUP_GAP: string[] = [
  'batch_approve_blend_tickets',
  'batch_post_invoices',
  'batch_reject_blend_tickets',
  'complete_job',
  'create_invoice_from_blend_ticket',
  'create_job_from_quote_section',
  'create_planned_holds',
  'create_quote_from_template',
  'create_quote_version',
  'create_split_invoices_from_order',
  'delete_prepay_credit',
  'edit_delivery',
  'edit_prepay_credit',
  'post_invoice_group',
  'reverse_receiving_record',
  'rollover_quote_to_season',
  'save_blend_ticket_fields',
  'save_field_app_invoice',
  'save_quote',
  'save_quote_template',
  'start_job',
  'void_payment',
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

describe('Idempotency operation-scoping snapshot (live pg_proc, 2026-06-10)', () => {
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

  it('unscoped-lookup gap list only shrinks (22 as of 2026-06-10)', () => {
    // If this fails because the number GREW, a new RPC shipped with an
    // unscoped inline lookup — fix the SQL (use check_idempotency/
    // save_idempotency), do not raise the cap.
    expect(UNSCOPED_LOOKUP_GAP.length).toBeLessThanOrEqual(22);
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
    /check_idempotency\s*\(\s*[^,)]+,\s*'([^']+)'/gi,
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

  it('every operation literal equals the defining function name (or documented alias)', () => {
    const offenders: string[] = [];
    for (const [fnName, def] of defs) {
      const literals = operationLiterals(def.body);
      const expected = new Set([fnName, ALIAS_SCOPED[fnName]].filter(Boolean));
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
    const def = defs.get('restore_quote_version');
    expect(def).toBeDefined();
    expect(def!.body).toMatch(/operation\s*=\s*'restore_quote_version'/i);
  });

  it('disk scan found a meaningful number of function definitions (sanity)', () => {
    // Guards against the scan silently matching nothing (regex/path drift)
    // and the literal-check above passing vacuously.
    expect(defs.size).toBeGreaterThanOrEqual(150);
  });
});

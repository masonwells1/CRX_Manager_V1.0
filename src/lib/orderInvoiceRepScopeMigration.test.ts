// Static shape checks for 20261008120000_scope_order_invoices_to_rep (rep scoping
// for order invoices, Mason 2026-10-06). Supporting evidence only: the real proof
// is scripts/smoke/prove-order-invoice-rep-scope-real-schema.mjs, which applies the
// file to the replayed production schema and runs it as real users.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const rawSql = readFileSync(join(migrationsDir, '20261008120000_scope_order_invoices_to_rep.sql'), 'utf8');
const sql = rawSql.replace(/\r\n/g, '\n');
const priorSplitSql = readFileSync(
  join(migrationsDir, '20260719060256_allow_governed_split_terminal_lifecycle.sql'),
  'utf8',
).replace(/\r\n/g, '\n');
const proverSource = readFileSync(
  join(repoRoot, 'scripts', 'smoke', 'prove-order-invoice-rep-scope-real-schema.mjs'),
  'utf8',
);

/** The one `CREATE OR REPLACE FUNCTION <name>(... $function$;` statement in `source`. */
function functionStatement(source: string, name: string): string {
  const head = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = source.indexOf(head);
  expect(start, `${name} must be defined`).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(head, start + 1), `${name} must be defined once`).toBe(-1);
  const end = source.indexOf('$function$;', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + '$function$;'.length);
}
/** Index of the first occurrence of `needle`, failing if it is absent. */
function at(body: string, needle: string): number {
  const index = body.indexOf(needle);
  expect(index, `missing: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}
/** SQL with `--` comments removed, so commentary cannot satisfy or trip a check. */
function code(source: string): string {
  return source.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
}

const cifo = functionStatement(sql, 'create_invoice_from_order');
const split = functionStatement(sql, 'create_split_invoices_from_order');
const priorSplit = functionStatement(priorSplitSql, 'create_split_invoices_from_order');

describe('order-invoice rep scope migration (20261008120000)', () => {
  it('is authored with LF line endings', () => {
    expect(rawSql.includes('\r')).toBe(false);
  });

  it('re-emits both wrappers with the unchanged key, security and search_path contract', () => {
    for (const body of [cifo, split]) {
      expect(body).toMatch(/p_idempotency_key text DEFAULT NULL/);
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toContain('SET search_path = public, pg_temp');
    }
    expect(cifo).toContain('RETURNS uuid\n');
    expect(split).toContain('RETURNS uuid[]\n');
  });

  it('has no GRANT or REVOKE statement (CREATE OR REPLACE keeps the ACL; the postflight proves it)', () => {
    expect(code(sql)).not.toMatch(/\b(GRANT|REVOKE)\b/i);
  });

  it('runs every create_invoice_from_order scope refusal before the delegate is called', () => {
    const delegate = at(cifo, '_create_invoice_from_order_idem_impl_20260721(');
    expect(at(cifo, "RAISE EXCEPTION 'ORDER_INVOICE_TYPE_NOT_ALLOWED")).toBeLessThan(delegate);
    expect(at(cifo, "RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED'")).toBeLessThan(delegate);
    expect(at(cifo, "RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED'")).toBeLessThan(delegate);
    expect(at(cifo, 'COALESCE(p_salesman_id, v_order_salesman_id)')).toBeLessThan(delegate);
    // and re-checks the invoice actually returned after it
    expect(cifo.lastIndexOf("RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED'")).toBeGreaterThan(delegate);
    expect(cifo.lastIndexOf("RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED'")).toBeGreaterThan(delegate);
    expect(cifo).not.toMatch(/RETURN public\._create_invoice_from_order_idem_impl_20260721\(/);
  });

  it('runs the split type gate and owner pre-check before any claim, lock or claim row', () => {
    const typeGate = at(split, "RAISE EXCEPTION 'ORDER_INVOICE_TYPE_NOT_ALLOWED: an invoice created from an order must be chemical_sale or misc_charge'");
    const customerScope = at(split, "RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED'");
    const salesmanScope = at(split, "RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED'");
    const owners = at(split, 'JOIN public.field_billing_defaults fbd ON fbd.field_id = oifa.field_id');
    for (const guarded of [
      '_claim_bound_lifecycle_idempotency(',
      'FOR UPDATE',
      'INSERT INTO public.split_invoice_creation_claims',
      '_create_split_invoices_from_order_provenance_impl_20260719(',
    ]) {
      const index = at(split, guarded);
      for (const gate of [typeGate, customerScope, salesmanScope, owners]) expect(gate).toBeLessThan(index);
    }
    expect(split).toContain("USING ERRCODE = 'check_violation'");
    // the post-check reads the invoices actually created or replayed
    expect(split.lastIndexOf("RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED'"))
      .toBeGreaterThan(at(split, '_create_split_invoices_from_order_provenance_impl_20260719('));
  });

  it('requires the split key as its first statement, worded exactly like create_invoice_from_order (Codex P1 on PR #891)', () => {
    const keyCheck = (fn: string) =>
      `  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN\n`
      + `    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: ${fn}'\n`
      + `      USING ERRCODE = '22023';\n`
      + '  END IF;\n';
    // the cifo wrapper's live check, re-emitted unchanged, is the template
    expect(cifo).toContain(`BEGIN\n${keyCheck('create_invoice_from_order')}`);
    // the split wrapper's first statement after BEGIN is the same check
    expect(split).toContain(`BEGIN\n${keyCheck('create_split_invoices_from_order')}  IF v_actor IS NULL THEN`);
    expect(priorSplit).not.toContain('IDEMPOTENCY_KEY_REQUIRED');
    const keyRequired = at(split, "RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order'");
    for (const later of [
      "RAISE EXCEPTION 'Not authenticated'",
      'public.is_admin()',
      "RAISE EXCEPTION 'ORDER_INVOICE_TYPE_NOT_ALLOWED",
      "RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED'",
      '_claim_bound_lifecycle_idempotency(',
      'FOR UPDATE',
      'INSERT INTO public.split_invoice_creation_claims',
      '_create_split_invoices_from_order_provenance_impl_20260719(',
    ]) {
      expect(keyRequired, later).toBeLessThan(at(split, later));
    }
    // and the postflight refuses a body whose key check is missing or not first
    const postflight = sql.slice(at(sql, 'DO $postflight$'), at(sql, '$postflight$;'));
    expect(postflight).toContain("position('IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order' IN v_split_src) = 0");
    expect(postflight).toContain("> position('Not authenticated' IN v_split_src)");
  });

  it('keeps the split idempotency contract and request shape byte-identical', () => {
    const contract = "v_contract CONSTANT text := 'create_split_invoices_from_order_v1';";
    expect(priorSplit).toContain(contract);
    expect(split).toContain(contract);
    const requestStart = priorSplit.indexOf('  v_request := jsonb_build_object(');
    const request = priorSplit.slice(requestStart, priorSplit.indexOf(');', requestStart) + 2);
    expect(request).toContain("'invoice_type', p_invoice_type");
    expect(split).toContain(request);
    expect(split.match(/'create_split_invoices_from_order',/g)).toHaveLength(2);
    expect(split).toContain('NULL::text\n    );');
  });

  it('pins every reviewed live body and column in the preflight', () => {
    const preflight = sql.slice(at(sql, 'DO $preflight$'), at(sql, '$preflight$;'));
    for (const pin of [
      'a1a91643bd8866823ae359f7e0ec290e',
      '398030fbb64006b4750e7e89a61b6cb9',
      '3d393fb8639dbcb2aa38574ca9679eee',
      '454e04c4e199549a4f5be9975e397e17',
      'f671f1a3f5406cff52aedd8a5fb40b31',
      'fcb3133010fe3f4f56e3be31f709d102',
      'f8de9f000e40f7bfd8f792012f04fee0',
      'PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT',
      'PREFLIGHT_SPLIT_INVOICE_WRAPPER_DRIFT',
      'PREFLIGHT_ORDER_INVOICE_DELEGATE_DRIFT',
      'PREFLIGHT_SPLIT_INVOICE_DELEGATE_DRIFT',
      'PREFLIGHT_ROLE_HELPER_DRIFT',
      'PREFLIGHT_COMPLETE_DELIVERY_DRIFT',
      'PREFLIGHT_SCOPE_COLUMNS_MISSING',
      'CRX_REP_SCOPE_NOT_IN_TRANSACTION',
      // the exact three-role EXECUTE ACL (the third role is checked by the prover)
      "IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', '",
      "NOT has_function_privilege('anon', p.oid, 'EXECUTE')",
      "ARRAY['search_path=public, pg_temp']::text[]",
      "('customers', 'assigned_sales_rep')",
      "('field_billing_defaults', 'customer_id')",
      "('order_item_field_allocations', 'order_item_id')",
      "('order_items', 'order_id')",
      "('invoices', 'customer_id')",
      "('invoices', 'salesman_id')",
      // the public complete_delivery wrapper, and is_sales_rep's volatility and owner
      'a1e9a043f27d3566f8ecf6d5e3a809ab',
      "AND p.provolatile = 's' AND p.proowner = 'postgres'::regrole",
      // PR #889 must already be applied (stranding guard), read from the ledger by name
      'PREFLIGHT_PR889_NOT_APPLIED',
      "'20261007150000_record_deliveries_billed_outside_crx'",
      "'20261007150050_lock_soft_deleted_orders'",
      "'20261007150100_mark_spring_2026_deliveries_billed_in_chem_man'",
      "'20261007150200_release_reservations_of_deleted_spring_orders'",
    ]) {
      expect(preflight, pin).toContain(pin);
    }
    expect(preflight.match(/md5\(replace\(p\.prosrc, chr\(13\), ''\)\)/g)?.length).toBe(8);
    expect(preflight).toContain(') <> 16 THEN');
  });

  it('keeps the PR #889 ledger names in step with the prover', () => {
    for (const stem of [
      '20261007150000_record_deliveries_billed_outside_crx',
      '20261007150050_lock_soft_deleted_orders',
      '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man',
      '20261007150200_release_reservations_of_deleted_spring_orders',
    ]) {
      expect(proverSource, stem).toContain(`'${stem}'`);
    }
  });

  it('pins the same new wrapper md5s in the postflight as the prover expects', () => {
    const postflight = sql.slice(at(sql, 'DO $postflight$'), at(sql, '$postflight$;'));
    const cifoMd5 = /const NEW_CIFO_MD5 = '([0-9a-f]{32})'/.exec(proverSource)?.[1];
    const splitMd5 = /const NEW_SPLIT_MD5 = '([0-9a-f]{32})'/.exec(proverSource)?.[1];
    expect(cifoMd5).toBeDefined();
    expect(splitMd5).toBeDefined();
    expect(postflight).toContain(`= '${cifoMd5}'`);
    expect(postflight).toContain(`= '${splitMd5}'`);
    expect(postflight).toContain('POSTFLIGHT_OK');
    expect(postflight).toContain('POSTFLIGHT_DELEGATE_CHANGED');
    expect(postflight).toContain('POSTFLIGHT_ORDER_INVOICE_WRAPPER_IDENTITY');
    expect(postflight).toContain('POSTFLIGHT_SPLIT_INVOICE_WRAPPER_IDENTITY');
    expect(postflight).toContain('a1e9a043f27d3566f8ecf6d5e3a809ab');
    expect(postflight).toContain("AND p.provolatile = 's' AND p.proowner = 'postgres'::regrole");
  });
});

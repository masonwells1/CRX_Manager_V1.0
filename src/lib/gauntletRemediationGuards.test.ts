import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = (name: string) =>
  readFileSync(join(root, 'supabase', 'migrations', name), 'utf8').replace(/\r\n/g, '\n');

describe('full-gauntlet remediation contracts', () => {
  it('recovers the complete live-stamped offline migration chain and removes placeholders', () => {
    const migrationsDir = join(root, 'supabase', 'migrations');
    for (const name of [
      '20260714171331_offline_action_receipts.sql',
      '20260714171800_offline_action_receipt_stage_limits.sql',
      '20260714172135_offline_action_review_resolution.sql',
      '20260714203709_offline_action_target_lock.sql',
    ]) {
      expect(existsSync(join(migrationsDir, name))).toBe(true);
    }
    expect(existsSync(join(migrationsDir, '20260714024811_offline_action_receipts.sql'))).toBe(false);
    expect(existsSync(join(migrationsDir, '20260714070000_offline_action_receipt_stage_limits.sql'))).toBe(false);
  });

  it('serializes same-key retries and enforces receiving and commission invariants', () => {
    const sql = migration('20260714230000_gauntlet_core_guards.sql');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain("hashtextextended('crx:idempotency:' || p_key, 0)");
    expect(sql).toContain("RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'");
    expect(sql).toContain("RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED'");
    expect(sql).toContain('WHERE idempotency_key = p_key\n     AND expires_at < now()');
    expect(sql).not.toContain('WHERE expires_at < now();');
    expect(sql).toContain('IDEMPOTENCY_CROSS_OP_KEY_REUSE');
    expect(sql).toContain('CREATE TRIGGER guard_idempotency_key_insert');
    expect(sql).toContain('IDEMPOTENCY_CONCURRENT_REPLAY_RETRY');
    expect(sql).toContain('OVER_RECEIVE_ADMIN_REQUIRED');
    expect(sql).toContain('OVER_RECEIVE_REASON_REQUIRED');
    expect(sql).toContain("CASE WHEN v_over_receive\n          THEN 'OVER-RECEIVE: ' || v_over_receive_reason");
    expect(sql).toContain('NOT COALESCE(p_allow_over_receive, false)');
    expect(sql).toContain('RECEIVING_QUANTITY_MUST_BE_POSITIVE');
    expect(sql).not.toContain('IF v_qty <= 0 THEN CONTINUE');
    expect(sql).toContain('every individual line is complete');
    expect(sql).toContain('COMMISSION_PAYMENT_EMPTY');
    expect(sql).toContain('COMMISSION_PAYMENT_TOTAL_MISMATCH');
    expect(sql).toContain('PERFORM require_admin_or_sales_rep();');
    expect(sql).toContain("'update_blend_ticket_billing_status'");
    expect(sql).not.toContain("COALESCE(p_payment_status, 'unchanged')");
    expect(sql).toContain("' payment status changed to ' || p_payment_status");
  });

  it('makes blend access office-only and ticket creation atomic with bounded images', () => {
    const sql = migration('20260714230100_blend_ticket_access_and_atomicity.sql');
    expect(sql).toContain('CREATE POLICY blend_tickets_office_select');
    expect(sql).toContain('CREATE POLICY blend_tickets_office_update');
    expect(sql).not.toContain('CREATE POLICY blend_tickets_admin_delete');
    expect(sql).toContain('CREATE POLICY blend_ticket_products_office_all');
    expect(sql).toContain('CREATE POLICY blend_ticket_images_office_select');
    expect(sql).not.toContain('CREATE POLICY blend_ticket_images_office_all');
    expect(sql).toContain('enforce_linked_blend_ticket_product_lock');
    expect(sql).toContain('blend_ticket_products_finite_numbers');
    expect(sql).toContain('lease_heartbeat_at');
    expect(sql).toContain('BLEND_TICKET_SETTLED_LIFECYCLE_INVALID');
    expect(sql).toContain('BLEND_TICKET_DELETE_LIFECYCLE_LOCKED');
    expect(sql).toContain('BLEND_TICKET_DOWNSTREAM_FIELDS_LOCKED');
    expect(sql).toContain('file_size_limit = 10485760');
    expect(sql).toContain("allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']");
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.create_blend_ticket');
    expect(sql).toContain("'create_blend_ticket'");
    expect(sql).toContain('BLEND_TICKET_IMAGE_METADATA_INVALID');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.commit_blend_ticket_ocr_result');
    expect(sql).toContain('OCR_COMMIT_LEASE_LOST');
    expect(sql).toContain('OCR_COMMIT_LIFECYCLE_CHANGED');
    expect(sql).toContain('OCR_COMMIT_PRODUCT_MATCH_INVALID');
    expect(sql).toContain('BLEND_TICKET_PRODUCT_COUNT_INVALID');
    expect(sql).toContain('jsonb_array_length(p_products) > 200');
    expect(sql).toContain('manually_corrected_fields');
    expect(sql).toContain("NOT ('tank_number' = ANY(COALESCE(v_ticket.manually_corrected_fields");
    expect(sql).toContain('owner_id = (SELECT auth.uid())::text');
  });

  it('persists product add/remove only through the versioned ticket snapshot', () => {
    const sql = migration('20260714230100_blend_ticket_access_and_atomicity.sql');
    const detail = readFileSync(join(root, 'src', 'pages', 'BlendTicketDetail.tsx'), 'utf8');
    expect(sql).toContain('BLEND_TICKET_PRODUCT_SNAPSHOT_INVALID');
    expect(sql).toContain('trg_blend_ticket_product_parent_version');
    expect(sql).toContain('DELETE FROM public.blend_ticket_products btp');
    expect(detail.match(/\.from\('blend_ticket_products'\)/g)).toHaveLength(1);
    expect(detail).toContain('_expected_updated_at: ticket.updated_at');
  });

  it('blocks order effects until a ticket is completed, approved, unbilled, and fully matched', () => {
    const sql = migration('20260714230200_blend_ticket_order_lifecycle.sql');
    const implementation = sql.split('DO $verify$')[0];
    expect(sql).toContain("v_ticket.status <> 'completed'");
    expect(sql).toContain("v_ticket.review_status <> 'approved'");
    expect(sql).toContain("v_ticket.payment_status <> 'unbilled'");
    expect(sql).toContain('Every blend-ticket product must be matched');
    expect(sql).toContain('BLEND_TICKET_ORDER_LINK_EMPTY');
    expect(sql).toContain("'blend_product_id'");
    expect(sql).toContain('ON CONFLICT (product_id, location) DO UPDATE');
    expect(sql).toContain('BLEND_TICKET_UNLINK_BILLING_LOCKED');
    expect(sql).toContain('BLEND_TICKET_UNLINK_APPLICATION_EXISTS');
    expect(sql).toContain("WHERE id = p_blend_ticket_id\n     AND deleted_at IS NULL\n   FOR UPDATE");
    expect(sql).toContain('BLEND_TICKET_ORDER_LINK_RECONCILIATION_REQUIRED');
    expect(sql).toContain('ALTER COLUMN blend_ticket_product_id SET NOT NULL');
    expect(sql).toContain('DROP INDEX IF EXISTS public.uq_blend_ticket_line_order_item');
    expect(sql).toContain('i.indpred IS NULL');
    expect(sql).toContain("p.proname = 'link_blend_ticket_to_order'");
    expect(sql).toContain("p.proname = 'create_order_from_blend_ticket'");
    expect(sql).toContain("p.proname = 'unlink_blend_ticket_from_order'");
    expect(sql).not.toContain(
      'ON CONFLICT (blend_ticket_product_id, order_item_id)\n        WHERE blend_ticket_product_id IS NOT NULL',
    );
    expect(sql).toContain("public.check_idempotency(\n      p_idempotency_key,\n      'create_invoice_from_blend_ticket'");
    expect(sql).toContain("public.save_idempotency(\n      p_idempotency_key,\n      'create_invoice_from_blend_ticket'");
    expect(sql).toContain("'create_order_from_blend_ticket',\n      v_result");
    expect(sql).toContain('RETURN v_result::json;');
    expect(implementation).not.toContain('COALESCE(v_product.product_id, gen_random_uuid())');
  });

  it('bounds Edge image reads and excludes applicators from the OCR role gate', () => {
    const edge = readFileSync(
      join(root, 'supabase', 'functions', 'process-blend-ticket', 'index.ts'),
      'utf8',
    );
    const guards = readFileSync(
      join(root, 'supabase', 'functions', 'process-blend-ticket', 'guards.ts'),
      'utf8',
    );
    expect(guards).toContain('MAX_BLEND_IMAGE_BYTES');
    expect(guards).toContain('images.length > 20');
    expect(guards).toContain('readBodyWithLimit');
    expect(guards).toContain('signTimeoutMs = fetchTimeoutMs');
    expect(guards).toContain('Promise.race');
    expect(edge).toContain('fetchSignedBlendImage');
    expect(edge).toContain('lease_token');
    expect(edge).toContain('refreshLease');
    expect(edge).toContain('commit_blend_ticket_ocr_result');
    expect(edge).not.toContain('let imageUrl = image.image_url');
    expect(edge).toMatch(
      /requireActiveProfile\(adminClient, caller\.id, \[\s*"admin",\s*"sales_rep",?\s*\]\)/,
    );
    expect(edge).not.toMatch(
      /requireActiveProfile\(adminClient, caller\.id, \[[^\]]*"applicator"/,
    );
    expect(edge).not.toContain('response.arrayBuffer()');
  });
});

import { describe, it, expect } from 'vitest';
import { sanitizeError } from './errorSanitizer';

describe('sanitizeError', () => {
  it.each(['IN_PROGRESS', 'ISOLATION', 'STALE_CALL'])('explains exhausted %s cutover refusals without raw database tokens', (token) => {
    expect(sanitizeError({ code: '40001', message: `GENERIC_FIELD_CUTOVER_${token}: diagnostic detail` }))
      .toBe('No invoice was changed. An invoice update is finishing; wait a moment, then try Save again');
    expect(sanitizeError(`GENERIC_FIELD_CUTOVER_${token}_UNKNOWN`))
      .toBe(`GENERIC_FIELD_CUTOVER_${token}_UNKNOWN`);
  });

  // The two strings below are the real RAISE text from
  // supabase/migrations/20260914101000_field_app_invoice_cross_season_edit_guard.sql (lines 265,
  // 288) with the format placeholders filled, so this proves the production message is handled
  // rather than a string invented for the test. Before this mapping existed, the generic invoice
  // editor fell through to `return message` and showed the raw token. (CodeRabbit on PR #786.)
  it('explains a filed-season date refusal and keeps the allowed range', () => {
    const detail = 'this invoice is filed in season 2026, so its transaction date must stay '
      + 'between 2025-10-01 and 2026-09-30';
    const shown = sanitizeError(`INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED: ${detail}`);
    expect(shown).not.toContain('INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED');
    expect(shown).toContain('filed season');
    // The date range is the operator's actual answer, so it must survive sanitizing.
    expect(shown).toContain('2025-10-01');
    expect(shown).toContain('2026-09-30');
  });

  it('explains a bare filed-season date refusal with no detail after the token', () => {
    const shown = sanitizeError('INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED');
    expect(shown).not.toContain('INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED');
    expect(shown).toContain('Keep the original transaction date');
  });

  it('explains an immutable filed season without echoing the invoice id', () => {
    const id = '3f0c1d2e-4a5b-6c7d-8e9f-0a1b2c3d4e5f';
    const shown = sanitizeError(
      `INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED: field-application invoice ${id} is permanently filed in season 2026`
    );
    expect(shown).not.toContain('INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED');
    expect(shown).not.toContain(id);
    expect(shown).toBe('No invoice was changed. The filed season of a field-application invoice cannot be changed');
  });

  it('does not swallow a longer token that merely starts the same way', () => {
    expect(sanitizeError('INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED_SOMETHING_ELSE'))
      .toBe('INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED_SOMETHING_ELSE');
    expect(sanitizeError('INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED_SOMETHING_ELSE'))
      .toBe('INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED_SOMETHING_ELSE');
  });

  it('directs generic field creation to its supported creators', () => {
    expect(sanitizeError('FIELD_APPLICATION_VIA_SAVE_INVOICE_NOT_ALLOWED: use dedicated creators'))
      .toBe('Create this field invoice from its job, blend ticket, or the Field Application screen');
  });

  it('maps return-credit and customer-scope tokens to operator guidance', () => {
    expect(sanitizeError('CUSTOMER_SCOPE_DENIED')).toBe('You can only work with customers assigned to you');
    expect(sanitizeError('RETURN_CREDIT_UNIT_MISMATCH')).toContain('original sale');
    expect(sanitizeError('RETURN_CREDIT_INVENTORY_UNIT_MISMATCH')).toContain('warehouse inventory unit');
    expect(sanitizeError('RETURN_CREDIT_UNLINKED_COST_LINE')).toContain('Review the credit memo');
    expect(sanitizeError('RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED')).toBe(
      'Void or unapply the related return credit before moving this sale invoice out of a recognized status or deleting it'
    );
    expect(sanitizeError('RETURN_CREDIT_SOURCE_POST_REQUIRES_REISSUE')).toContain('cannot be posted');
    expect(sanitizeError('RETURN_CREDIT_HEADER_IMMUTABLE')).toContain('Use Void');
    expect(sanitizeError('RETURN_CREDIT_PARENT_IMMUTABLE')).toContain('Void or unapply');
    expect(sanitizeError('RETURN_CREDIT_LINE_TOTAL_MISMATCH')).toContain('no changes were saved');
    expect(sanitizeError('RETURN_CREDIT_CUTOVER_IN_PROGRESS')).toContain('briefly paused');
    expect(sanitizeError('ORDER_INVOICE_TERMINAL')).toContain('already final');
    expect(sanitizeError('ORDER_LIFECYCLE_BUSY_RETRY')).toContain('Wait a moment');
    expect(sanitizeError('RETURN_CREDIT_LEDGER_IMMUTABLE')).toContain('source or cost lines');
    expect(sanitizeError('RETURN_CREDIT_HEADER_RESULT_INVALID')).toContain('could not be completed safely');
    expect(sanitizeError('RETURN_CREDIT_SOURCE_CONCURRENT')).toBe(
      'A related invoice or return credit is being changed elsewhere. Wait a moment and try again'
    );
    expect(sanitizeError('RETURN_CREDIT_VOID_RELEASE_FAILED')).toContain('no changes were saved');
    expect(sanitizeError('RETURN_CREDIT_UNAPPLY_RELEASE_FAILED')).toContain('no changes were saved');
    expect(sanitizeError('RETURN_CREDIT_COGS_LEDGER_MISSING')).toContain('protected cost source');
    expect(sanitizeError('RETURN_CREDIT_REVERSAL_EXCEEDS_RECOGNIZED')).toContain('No changes were saved');
    expect(sanitizeError('RETURN_CREDIT_REVERSAL_EXCEEDS_RECOGNIZED:RMA-2026-0007:[{"product_id":"secret"}]'))
      .not.toContain('secret');
    expect(sanitizeError('RETURN_NOT_APPROVED:requested')).toContain('must be approved');
    expect(sanitizeError('RETURN_NOT_APPROVED:received')).toBe('This return is already received');
    expect(sanitizeError('RETURN_NOT_APPROVED:credited')).toBe('This return is credited and cannot be received');
  });

  it('returns generic message for null/undefined', () => {
    expect(sanitizeError(null)).toBe('An unexpected error occurred');
    expect(sanitizeError(undefined)).toBe('An unexpected error occurred');
  });

  it('handles Error objects', () => {
    expect(sanitizeError(new Error('Something went wrong'))).toBe('Something went wrong');
  });

  it('handles plain strings', () => {
    expect(sanitizeError('Failed to save')).toBe('Failed to save');
  });

  it('sanitizes duplicate key constraint violations', () => {
    expect(sanitizeError(
      'duplicate key value violates unique constraint "orders_order_number_key"'
    )).toBe('A record with this information already exists');
  });

  it('sanitizes foreign key constraint violations', () => {
    expect(sanitizeError(
      'insert or update on table "invoices" violates foreign key constraint "invoices_customer_id_fkey"'
    )).toBe('This record references data that does not exist or has been removed');

    expect(sanitizeError(
      'update or delete on table "invoice_items" violates foreign key constraint "invoice_items_return_credit_source_item_fk" on table "invoice_items"'
    )).toBe('This source invoice line is retained as return-credit accounting history and cannot be deleted or re-saved. Keep the source invoice unchanged, or permanently delete the already-voided credit memo before editing it');
  });

  it('sanitizes check constraint violations', () => {
    expect(sanitizeError(
      'new row for relation "payments" violates check constraint "payments_amount_cents_check"'
    )).toBe('The provided value is not valid');
  });

  it('sanitizes not-null constraint violations', () => {
    expect(sanitizeError(
      'null value in column "customer_id" of relation "invoices" violates not-null constraint'
    )).toBe('A required field is missing');
  });

  it('sanitizes value too long errors', () => {
    expect(sanitizeError(
      'value too long for type character varying(255)'
    )).toBe('The provided value is too long');
  });

  it('sanitizes invalid input syntax errors', () => {
    expect(sanitizeError(
      'invalid input syntax for type uuid: "not-a-uuid"'
    )).toBe('Invalid input format');
  });

  it('sanitizes relation does not exist errors', () => {
    expect(sanitizeError(
      'relation "nonexistent_table" does not exist'
    )).toBe('An internal error occurred. Please try again.');
  });

  it('sanitizes function does not exist errors', () => {
    expect(sanitizeError(
      'function save_quote(p_data jsonb) does not exist'
    )).toBe('An internal error occurred. Please try again.');
  });

  it('sanitizes permission denied errors', () => {
    expect(sanitizeError(
      'permission denied for table "invoices"'
    )).toBe('You do not have permission to perform this action');

    expect(sanitizeError(
      'permission denied for sequence "invoices_id_seq"'
    )).toBe('You do not have permission to perform this action');
  });

  // REGRESSION GUARD. Until 2026-09-02 the permission pattern required QUOTED
  // identifiers, but PostgreSQL emits them unquoted — so every real permission
  // error passed through this function and showed the operator the table name.
  // The two quoted cases above are the form this test file invented; the cases
  // below are the form the database actually produces, and the rest of the repo's
  // fixtures (criticalAction.test.ts, applicatorSheetPrintData.test.ts,
  // previousApplications.test.ts) already used them. Do not "simplify" these back
  // into the quoted-only pattern.
  it('sanitizes permission denied errors with UNQUOTED identifiers (real Postgres form)', () => {
    for (const raw of [
      'permission denied for table orders',
      'permission denied for table job_field_shares',
      'permission denied for schema public',
      'permission denied for sequence invoices_id_seq',
      'permission denied for function save_job',
      'permission denied for materialized view mv_inventory_rollup',
    ]) {
      expect(sanitizeError(raw)).toBe('You do not have permission to perform this action');
      expect(sanitizeError(raw)).not.toContain('orders');
      expect(sanitizeError(raw)).not.toContain('job_field_shares');
    }
  });

  it('sanitizes PostgREST schema-cache misses that name the missing object', () => {
    expect(sanitizeError(
      'Could not find the function public.save_job(p_job_payload, p_performed_by) in the schema cache'
    )).toBe('An internal error occurred. Please try again.');

    expect(sanitizeError(
      "Could not find a relationship between 'orders' and 'order_items' in the schema cache"
    )).toBe('An internal error occurred. Please try again.');
  });

  // The redaction above is deliberately scoped to Postgres's structural
  // `permission denied for <object>` form. A hand-written RAISE EXCEPTION that
  // happens to use the words "permission denied" still reaches the operator,
  // because those are written to be read.
  it('still passes through a hand-written permission refusal that names no object', () => {
    expect(sanitizeError(
      'Permission denied to edit this order — ask the assigned rep.'
    )).toBe('Permission denied to edit this order — ask the assigned rep.');
  });

  it('sanitizes generic schema identifier leaks', () => {
    expect(sanitizeError(
      'column "secret_column" is ambiguous'
    )).toBe('An internal error occurred. Please try again.');
  });

  it('sanitizes rate limit errors', () => {
    expect(sanitizeError(
      'Rate limit exceeded. Please wait before retrying.'
    )).toBe('Too many requests. Please wait a moment and try again.');
  });

  it('passes through safe user-facing RPC error messages', () => {
    expect(sanitizeError('Not authorized to allocate payments')).toBe('Not authorized to allocate payments');
    expect(sanitizeError('Payment amount must be positive')).toBe('Payment amount must be positive');
    expect(sanitizeError('Invoice is already voided')).toBe('Invoice is already voided');
    expect(sanitizeError('Delivery is not in a cancellable state')).toBe('Delivery is not in a cancellable state');
  });

  it('handles plain objects with message property (PostgrestError from Supabase)', () => {
    // Supabase RPC errors return plain objects {message, details, hint, code}
    expect(sanitizeError({
      message: 'Insufficient inventory for Product X: need 100 units, only 0 available',
      details: 'some details',
      hint: null,
      code: 'P0001',
    })).toBe('Insufficient inventory for Product X: need 100 units, only 0 available');

    expect(sanitizeError({
      message: 'Delivery not found',
      code: 'P0001',
    })).toBe('Delivery not found');

    // Plain objects with message that match constraint patterns should still be sanitized
    expect(sanitizeError({
      message: 'duplicate key value violates unique constraint "orders_order_number_key"',
      code: '23505',
    })).toBe('A record with this information already exists');
  });

  it('handles non-string non-Error types', () => {
    expect(sanitizeError(42)).toBe('An unexpected error occurred');
    expect(sanitizeError({})).toBe('An unexpected error occurred');
    expect(sanitizeError([])).toBe('An unexpected error occurred');
  });
});

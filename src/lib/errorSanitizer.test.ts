import { describe, it, expect } from 'vitest';
import { sanitizeError } from './errorSanitizer';

describe('sanitizeError', () => {
  it('maps return-credit and customer-scope tokens to operator guidance', () => {
    expect(sanitizeError('CUSTOMER_SCOPE_DENIED')).toBe('You can only work with customers assigned to you');
    expect(sanitizeError('RETURN_CREDIT_UNIT_MISMATCH')).toContain('original sale');
    expect(sanitizeError('RETURN_CREDIT_UNLINKED_COST_LINE')).toContain('Review the credit memo');
    expect(sanitizeError('RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED')).toContain('Void or unapply');
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

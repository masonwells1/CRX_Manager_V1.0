/**
 * Sanitize database/RPC error messages before displaying to users.
 * Strips PostgreSQL constraint names, table names, and column references
 * that could leak schema information.
 */

const CONSTRAINT_PATTERNS: Array<[RegExp, string]> = [
  [/^CUSTOMER_SCOPE_DENIED\b/i,
   'You can only work with customers assigned to you'],
  [/^RETURN_NOT_FOUND\b/i,
   'This return could not be found'],
  [/^RETURN_CREDIT_UNIT_MISMATCH\b/i,
   'The returned item unit does not match its original sale. Review the return before retrying'],
  [/^RETURN_CREDIT_UNLINKED_COST_LINE\b/i,
   'An existing credit cannot be matched safely to this return. Review the credit memo before retrying'],
  [/^RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED\b/i,
   'Void or unapply the related return credit before moving this sale invoice out of a recognized status or deleting it'],
  [/^RETURN_CREDIT_SOURCE_POST_REQUIRES_REISSUE\b/i,
   'This invoice cannot be posted because an earlier return credit was issued before enough product was invoiced. Void or unapply that credit, post this invoice, then reissue the credit'],
  [/^RETURN_CREDIT_HEADER_IMMUTABLE\b/i,
   'Use Void on the return credit memo before changing or deleting it'],
  [/^RETURN_CREDIT_PARENT_IMMUTABLE\b/i,
   'Void or unapply the return credit before deleting its return record'],
  [/^RETURN_CREDIT_LINE_TOTAL_MISMATCH\b/i,
   'The return credit lines did not match the credit total, so no changes were saved'],
  [/^RETURN_CREDIT_CUTOVER_IN_PROGRESS\b/i,
   'Return credits are briefly paused while an accounting update finishes. Retry in a moment'],
  [/^ORDER_INVOICE_TERMINAL\b/i,
   'This order invoice is already final and cannot be changed'],
  [/^ORDER_LIFECYCLE_BUSY_RETRY\b/i,
   'This order is being updated elsewhere. Wait a moment and retry'],
  [/^RETURN_CREDIT_LEDGER_IMMUTABLE\b/i,
   'Void or unapply the return credit before changing its source or cost lines'],
  [/^RETURN_CREDIT_ISOLATION_UNSUPPORTED\b/i,
   'This return credit could not be serialized safely. Retry the operation'],
  [/^RETURN_CREDIT_HEADER_RESULT_INVALID\b/i,
   'The return credit could not be completed safely. Retry the operation'],
  [/^RETURN_CREDIT_SOURCE_CONCURRENT\b/i,
   'A related invoice or return credit is being changed elsewhere. Wait a moment and try again'],
  [/^RETURN_CREDIT_VOID_RELEASE_FAILED\b/i,
   'The return credit could not be voided safely, so no changes were saved. Refresh and try again; contact support if it repeats'],
  [/^RETURN_CREDIT_UNAPPLY_RELEASE_FAILED\b/i,
   'The return credit could not be unapplied safely, so no changes were saved. Refresh and try again; contact support if it repeats'],
  [/duplicate key value violates unique constraint "[^"]+"/i,
   'A record with this information already exists'],
  [/violates foreign key constraint "[^"]+"/i,
   'This record references data that does not exist or has been removed'],
  [/violates check constraint "[^"]+"/i,
   'The provided value is not valid'],
  [/null value in column "[^"]+" of relation "[^"]+"/i,
   'A required field is missing'],
  [/value too long for type character varying\(\d+\)/i,
   'The provided value is too long'],
  [/invalid input syntax for type [^:]+:/i,
   'Invalid input format'],
  [/relation "[^"]+" does not exist/i,
   'An internal error occurred. Please try again.'],
  [/function [^\s]+\([^)]*\) does not exist/i,
   'An internal error occurred. Please try again.'],
  [/permission denied for (table|relation|schema|sequence) "[^"]+"/i,
   'You do not have permission to perform this action'],
];

export function sanitizeError(error: unknown): string {
  if (!error) return 'An unexpected error occurred';

  // Handle Error instances, plain objects with .message (PostgrestError from Supabase), and strings
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && 'message' in error && typeof (error as Record<string, unknown>).message === 'string'
        ? (error as Record<string, unknown>).message as string
        : 'An unexpected error occurred';

  const returnStatus = message.match(/^RETURN_NOT_APPROVED:([a-z_]+)$/i)?.[1];
  if (returnStatus) {
    const statusLabel = returnStatus.replace(/_/g, ' ');
    if (returnStatus === 'requested') {
      return `This return must be approved before it can be received (current status: ${statusLabel})`;
    }
    if (returnStatus === 'received') return 'This return is already received';
    return `This return is ${statusLabel} and cannot be received`;
  }
  if (/^RETURN_NOT_APPROVED\b/i.test(message)) {
    return 'This return must be approved before it can be received';
  }

  for (const [pattern, replacement] of CONSTRAINT_PATTERNS) {
    if (pattern.test(message)) {
      return replacement;
    }
  }

  // Catch-all for messages that reference schema identifiers
  if (/relation "|column "|constraint "|table "/i.test(message)) {
    return 'An internal error occurred. Please try again.';
  }

  // Rate limit error from our custom ERRCODE
  if (message.includes('Rate limit exceeded')) {
    return 'Too many requests. Please wait a moment and try again.';
  }

  // Pass through safe messages (user-facing RPC RAISE EXCEPTION text)
  return message;
}

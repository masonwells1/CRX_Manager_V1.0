/**
 * Sanitize database/RPC error messages before displaying to users.
 * Strips PostgreSQL constraint names, table names, and column references
 * that could leak schema information.
 */

const CONSTRAINT_PATTERNS: Array<[RegExp, string]> = [
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

  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : 'An unexpected error occurred';

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

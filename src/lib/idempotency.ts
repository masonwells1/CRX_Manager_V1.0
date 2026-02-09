/**
 * Idempotency key generator for critical operations.
 * Generates a unique key per action to prevent double-submissions.
 * Keys are sent to the database RPCs and checked before execution.
 */

/**
 * Generate a unique idempotency key for a critical operation.
 * Format: {operation}:{userId}:{timestamp}:{random}
 *
 * Each call generates a NEW key — call this once when the user clicks
 * the button, then reuse the same key if retrying the same action.
 */
export function generateIdempotencyKey(operation: string, userId: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `${operation}:${userId}:${timestamp}:${random}`;
}

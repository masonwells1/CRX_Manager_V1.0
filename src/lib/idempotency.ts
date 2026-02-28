/**
 * Idempotency key generator for critical operations.
 * Generates a unique key per action to prevent double-submissions.
 * Keys are sent to the database RPCs and checked before execution.
 *
 * Uses crypto.randomUUID() for cryptographically strong random IDs.
 */

/**
 * Generate a unique idempotency key for a critical operation.
 * Format: {operation}:{userId}:{uuid}
 *
 * Each call generates a NEW key — call this once when the user clicks
 * the button, then reuse the same key if retrying the same action.
 *
 * For retry-safe behavior in React components, use the useIdempotencyKey hook
 * which persists the key across retries and only resets on success.
 */
export function generateIdempotencyKey(operation: string, userId: string): string {
  const uuid = crypto.randomUUID();
  return `${operation}:${userId}:${uuid}`;
}

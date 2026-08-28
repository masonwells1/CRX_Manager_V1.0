import { vi } from 'vitest';

export type QueryResult = { data: unknown; error: { message: string } | null };
export type QueryChain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<QueryResult>;

export function buildPaginatedQueryChain(result: QueryResult): QueryChain {
  const self: Record<string, unknown> = {};
  for (const method of [
    'select', 'update', 'eq', 'gte', 'lte', 'is', 'in', 'not', 'order', 'limit',
  ]) {
    self[method] = vi.fn(() => self);
  }
  let rangeCalls = 0;
  self.range = vi.fn(() => Promise.resolve(
    rangeCalls++ === 0 ? result : { data: [], error: null },
  ));
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  return self as QueryChain;
}

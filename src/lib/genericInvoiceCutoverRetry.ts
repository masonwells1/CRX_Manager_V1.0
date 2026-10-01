type CutoverToken = 'IN_PROGRESS' | 'ISOLATION' | 'STALE_CALL';

function cutoverToken(error: unknown): CutoverToken | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code !== '40001' || typeof candidate.message !== 'string') return null;
  const match = /^GENERIC_FIELD_CUTOVER_(IN_PROGRESS|ISOLATION|STALE_CALL)(?::|$)/.exec(candidate.message);
  return match ? match[1] as CutoverToken : null;
}

/**
 * Only these phase-one refusals explicitly roll back without changing an invoice.
 * Each invocation must create a fresh RPC request using the caller's frozen data/key.
 * Never replay the whole critical action, network failures, or ordinary SQL errors.
 */
export async function retryGenericInvoiceCutover<T extends { error: unknown }>(
  request: () => PromiseLike<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request();
    const token = cutoverToken(response.error);
    if (!token || attempt === 2) return response;
    if (token === 'IN_PROGRESS') {
      await new Promise<void>((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
    // ISOLATION and STALE_CALL need a new transaction/request, not the old promise.
  }
}

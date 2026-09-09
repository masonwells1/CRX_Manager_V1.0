import { describe, expect, it } from 'vitest';
import { resolveCycleCountWriteIntent } from './cycleCountWriteIntent';

describe('cycle-count item write intent sequencing', () => {
  it('reuses an uncertain same-value retry but distinguishes A to B to A', () => {
    const firstA = resolveCycleCountWriteIntent('item-1', 10, undefined, 0);
    const retryA = resolveCycleCountWriteIntent(
      'item-1',
      10,
      firstA.intent,
      firstA.nextSequence,
    );
    expect(retryA.intent.scope).toBe(firstA.intent.scope);

    const valueB = resolveCycleCountWriteIntent(
      'item-1',
      12,
      retryA.intent,
      retryA.nextSequence,
    );
    const secondA = resolveCycleCountWriteIntent(
      'item-1',
      10,
      valueB.intent,
      valueB.nextSequence,
    );

    expect(valueB.intent.scope).not.toBe(firstA.intent.scope);
    expect(secondA.intent.scope).not.toBe(firstA.intent.scope);
    expect(secondA.intent.sequence).toBeGreaterThan(valueB.intent.sequence);
  });

  it('creates a fresh intent after a successful value was retired', () => {
    const first = resolveCycleCountWriteIntent('item-1', null, undefined, 7);
    const afterSuccess = resolveCycleCountWriteIntent(
      'item-1',
      null,
      undefined,
      first.nextSequence,
    );
    expect(afterSuccess.intent.scope).not.toBe(first.intent.scope);
  });
});

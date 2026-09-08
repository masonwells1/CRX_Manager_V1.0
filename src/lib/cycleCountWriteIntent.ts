export interface CycleCountWriteIntent {
  valueKey: string;
  scope: string;
  sequence: number;
}

export function resolveCycleCountWriteIntent(
  itemId: string,
  countedQty: number | null,
  current: CycleCountWriteIntent | undefined,
  nextSequence: number,
): { intent: CycleCountWriteIntent; nextSequence: number } {
  const valueKey = JSON.stringify([countedQty, null]);
  if (current?.valueKey === valueKey) {
    return { intent: current, nextSequence };
  }

  const sequence = nextSequence + 1;
  return {
    intent: {
      valueKey,
      sequence,
      scope: JSON.stringify([itemId, countedQty, null, sequence]),
    },
    nextSequence: sequence,
  };
}

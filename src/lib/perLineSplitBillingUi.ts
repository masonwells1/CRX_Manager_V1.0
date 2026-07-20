/** Convert decimal percentage strings to exact integer micro-percent values. */
export function percentStringsToMicro(pcts: string[]): number[] {
  const result = pcts.map((raw) => {
    const match = /^(\d{1,3})(?:\.(\d{1,6}))?$/.exec(raw.trim());
    if (!match) throw new Error('Custom percentages may use up to 6 decimal places.');
    const whole = Number(match[1]);
    const fraction = Number((match[2] ?? '').padEnd(6, '0'));
    const micro = whole * 1_000_000 + fraction;
    if (micro > 100_000_000) {
      throw new Error('Each custom percentage must be between 0% and 100%.');
    }
    return micro;
  });

  if (result.reduce((sum, value) => sum + value, 0) !== 100_000_000) {
    throw new Error('Customized percentages must total exactly 100%.');
  }
  return result;
}

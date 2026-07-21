/**
 * Property tests for the split-percent → micro-percent vector (pctsToMicro).
 *
 * Bug classes locked down (found across split-billing Codex rounds 2–3):
 *  - r2 #K: percents summing just UNDER 100 (33.3333×3) left a residual gap so the
 *    vector didn't reach exactly 100000000 and the server's exact-100% check rejected it.
 *  - r3 P2: percents summing just OVER 100 within the 0.01 UI tolerance (33.334×3)
 *    left the vector above 100000000 — same server rejection, opposite sign.
 *
 * The invariants below hold for EVERY input the UI can produce, so any future
 * re-implementation that reintroduces a residual gap fails here instead of in a
 * paid review round.
 */
import { describe, expect, it } from 'vitest';
import { pctsToMicro } from './splitVectorMath';

const TOTAL = 100_000_000;

/** Deterministic PRNG (mulberry32) — property sweep must be reproducible in CI. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertInvariants(pcts: number[], label: string) {
  const micro = pctsToMicro(pcts);
  const sum = micro.reduce((a, b) => a + b, 0);
  expect(sum, `${label}: vector must sum EXACTLY to ${TOTAL}`).toBe(TOTAL);
  expect(micro.length, `${label}: length preserved`).toBe(pcts.length);
  for (const v of micro) {
    expect(Number.isInteger(v), `${label}: integer micro-percents`).toBe(true);
    expect(v, `${label}: no negative share`).toBeGreaterThanOrEqual(0);
  }
}

describe('pctsToMicro largest-remainder invariants', () => {
  it('regression r2 #K — three-way 33.3333 (sums under 100)', () => {
    assertInvariants([33.3333, 33.3333, 33.3333], 'r2#K');
  });

  it('regression r3 P2 — three-way 33.334 (sums over 100 within UI tolerance)', () => {
    assertInvariants([33.334, 33.334, 33.334], 'r3P2');
  });

  it('common exact splits stay exact and proportional', () => {
    expect(pctsToMicro([50, 50])).toEqual([50_000_000, 50_000_000]);
    expect(pctsToMicro([100])).toEqual([TOTAL]);
    expect(pctsToMicro([25, 25, 25, 25])).toEqual([25_000_000, 25_000_000, 25_000_000, 25_000_000]);
    // 2/3 vs 1/3: residual goes to the larger fraction first
    const [a, b, c] = pctsToMicro([33.33, 33.33, 33.34]);
    expect(a + b + c).toBe(TOTAL);
  });

  it('property sweep — 500 random member counts and near-100 percent sets', () => {
    const rand = mulberry32(0xc0ffee);
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + Math.floor(rand() * 7); // 1..7 co-owners
      // Random positive weights normalized to ~100, then rounded to 4 decimals
      // (the UI's precision), which is exactly how sub-100 / over-100 drift arises.
      const weights = Array.from({ length: n }, () => rand() + 0.001);
      const wSum = weights.reduce((x, y) => x + y, 0);
      const pcts = weights.map((w) => Math.round((w / wSum) * 100 * 10_000) / 10_000);
      assertInvariants(pcts, `trial ${trial} n=${n} [${pcts.join(',')}]`);
    }
  });

  it('degenerate inputs cannot mint a negative or non-integer vector', () => {
    assertInvariants([99.99, 0.01], 'tiny member');
    assertInvariants([0.0001, 99.9999], 'tinier member');
    // Heavily uneven 6-way with repeating fractions
    assertInvariants([16.6667, 16.6667, 16.6667, 16.6667, 16.6666, 16.6666], 'six-way thirds');
  });
});

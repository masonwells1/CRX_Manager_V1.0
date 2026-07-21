/**
 * Split-vector percent math shared by the per-line split-billing editor.
 * Extracted from FieldAppSplitInvoiceEditor so the largest-remainder invariants
 * (Codex r2 #K positive-residual gap, r3 P2 negative-residual gap) are locked
 * by unit tests in splitVectorMath.test.ts.
 */

/** Percent strings → micro-percent ints summing EXACTLY to 100000000 (largest remainder,
 *  tie-break by index). Assumes the caller validated the percents sum to ~100. */
export function pctsToMicro(pcts: number[]): number[] {
  const TOTAL = 100_000_000;
  const ideals = pcts.map((p) => (p / 100) * TOTAL);
  const floors = ideals.map((v) => Math.floor(v));
  const base = floors.reduce((a, b) => a + b, 0);
  let residual = TOTAL - base;
  const result = [...floors];
  const order = ideals
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  // Distribute the ENTIRE positive residual, CYCLING largest-fraction-first. A user percent set
  // that sums just under 100 (e.g. 33.3333×3 → 99999900 micro, residual 100 across 3 members)
  // must still reach exactly 100000000; a single pass (≤1 per member) left a 97-unit gap that the
  // server's exact-100% check then rejected (Codex r2 #K).
  for (let k = 0; residual > 0 && order.length > 0; k = (k + 1) % order.length) {
    result[order[k].i] += 1;
    residual -= 1;
  }
  // Remove the ENTIRE negative residual, CYCLING smallest-fraction-first — mirroring the positive
  // branch. Percentages that sum just OVER 100 within the 0.01 UI tolerance (e.g. 33.334×3 →
  // 100002000 micro, residual -2000) must still land on exactly 100000000; a single pass (≤1 per
  // member) left the vector above 100000000 so the server rejected a payload the UI approved (Codex
  // round-3 P2). `guard` breaks only if a full lap finds no member >0 (cannot happen while
  // residual<0, since the over-100 sum guarantees some member carries a subtractable unit).
  const revOrder = [...order].reverse();
  for (let k = 0, guard = 0; residual < 0 && guard < revOrder.length; k = (k + 1) % revOrder.length) {
    if (result[revOrder[k].i] > 0) {
      result[revOrder[k].i] -= 1;
      residual += 1;
      guard = 0;
    } else {
      guard += 1;
    }
  }
  return result;
}

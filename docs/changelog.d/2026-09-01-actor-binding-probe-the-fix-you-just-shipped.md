## 2026-09-01 — Probe the reader you just hardened

After closing eight actor-laundering channels in the write-time actor-binding guard, a second probe
pass over the **fixed** reader found four more. All four are the same shape as the originals: a
construct the file already understands in the invalidation direction, or a target the reader
deliberately refuses to name, with no counterpart in the propagation direction.

- **`U&"..."` assignment, `INTO` and loop targets.** `normalizedQualifiedIdentifier()` returns null
  for that spelling *by design*, so the target could never enter the taint set — the actor went in
  and came back out untracked. `stableAuthUidBindings()` already treats a `U&` write as destroying a
  trusted `auth.uid()` binding; the propagation direction now fails closed the same way. A statement
  that writes an opaque target and mentions a tainted actor is treated as laundering; a statement
  with an opaque target and no actor reference stays allowed, which is asserted separately.
- **`DECLARE c CURSOR FOR SELECT p_performed_by` consumed by `FOR v_row IN c LOOP`.** The loop's
  iterator expression never names the actor, so nothing tainted the loop variable. The cursor *name*
  is now tainted at its definition and the existing loop rule carries it forward. `OPEN c FOR ...`
  is covered the same way.
- **`DECLARE v_id uuid := p_performed_by;` on one line.** Both declaration patterns anchor on a
  newline or `;`, so the capture group took the word `DECLARE` and the real local stayed clean.

The lesson is the process one, not the parser one. The first pass fixed every channel it was handed
and every channel it could reason about; it found four more only because the *fixed* hook was then
run against a fresh set of crafted payloads. **A guard is not done when the reported findings are
closed — it is done when a probe pass over the repaired version comes back empty.** For a
guard this shape that pass costs one throwaway script and a few minutes.

### Proof observed

- Probe cases Q1, Q2, Q4 and the same-line `DECLARE` case each flip `allow` → `deny` across the fix.
- The eight originally-closed channels and both controls (a bound routine; an uncorrelated `INTO`
  sibling) are unchanged.
- `node .claude/hooks/actor-binding-check.test.mjs` — 469 assertions, up from 463.
- `node scripts/db-invariant-sweeps/actor-forgery-predicates.test.mjs` —
  `ACTOR_FORGERY_PREDICATES_TEST_PASS`.
- `npm run typecheck`, `npm run lint`, `npm run test:agent-workflows`, `npm run check:docs` clean.

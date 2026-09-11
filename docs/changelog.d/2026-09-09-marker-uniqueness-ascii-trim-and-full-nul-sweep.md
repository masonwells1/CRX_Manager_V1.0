## 2026-09-09 - the generator refuses ambiguous markers, the trim is ASCII-only, and every predicate is NUL-checked

Sixth round on PR #648. Behaviour parity was re-confirmed at the strongest level
yet — base's entire `classifySql` body is byte-identical to this branch's
`classifySqlInner`, and **1,020,814 non-matching inputs produced zero
disagreements** — and three code defects were found.

**The generator could delete unrelated guard code.** It took the FIRST begin
marker and the FIRST end marker. A stray duplicate begin marker earlier in the
file therefore made a regeneration delete everything between it and the real end
marker, taking unrelated source with it. The script writes into an enforcement
surface, so it now requires **exactly one** of each marker and refuses
otherwise; an ambiguous file is a refusal, never a guess. The suite asserts the
marker count too.

**The trailing trim is ASCII-only now.** `trimEnd()` also strips NBSP, U+2028,
ideographic space and friends. No checkout introduces those, and PostgreSQL does
not treat them as whitespace either — so `SELECT 1;` plus a trailing NBSP shared
a fingerprint with `SELECT 1;` while being a syntax error to the server. Never
harmful (the variant cannot execute), but it made the stated rule — "only what a
checkout can change" — untrue. The rule is now what it says. **The 29 hashes are
unchanged**, so this is behaviour-preserving on every real predicate; the test
asserts both directions, including that `trimEnd()` *would* have stripped each
exotic character, so the divergence is deliberate and visible.

**The NUL check covered one predicate, not 29.** A NUL inside a leading comment
of any other predicate would let git render that SQL as binary — the reviewer
sees a hash change with no readable diff, defeating the "review the changed SQL
and its hash together" control this design rests on. It loops over every
predicate now, plus the guard.

**Claims corrected:**

- The generator's header still said it regenerates `predicate-fingerprints.json`,
  deleted earlier the same day.
- "The generated region is byte-identical to what the generator emits" — the
  assertion normalises line endings and uses containment. The load-bearing check
  is the `deepEqual` between the guard's live exported Set and the files on disk;
  the region check is a second net, not byte identity. Reworded where it appears.
- "The guard performs no `readFileSync`" — this library reads no file, but the
  hook that calls it still reads its PreToolUse payload from stdin, as every hook
  does. The precise claim is "no runtime predicate-manifest read".
- The PR body reported 166 assertions; HEAD reports 216.

**Not changed, and recorded rather than fixed:** the generator's filename pattern
`^[A-Za-z0-9._-]+$` rejects legitimate basenames such as `read only.sql` or
`café.sql`. That is a deliberate narrowing for a function that writes source code
into a security file; all 29 current names pass, and widening it is a decision
for whoever first needs it.

**Proof.** `predicate-fingerprints.test.mjs` 184 → 216; full
`npm run test:correction-guards` green; regenerating produces no change. The
deployed hook process still clears 29 of 29 predicate files with `REAL-DATA-OK`
absent (main: 0 of 29) and denies all 15 must-deny shapes.

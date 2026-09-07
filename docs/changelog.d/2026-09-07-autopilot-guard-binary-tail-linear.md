## 2026-09-07 - the new binary tail is bounded to what an extension actually is, which also makes it linear

Follow-up to `2026-09-07-autopilot-guard-binary-shape.md`, same PR (#607), found by measuring the new
grammar rather than reasoning about it.

The first draft of `BIN_TAIL` let the extension be any run of word chunks — `(?:\.${WORD_CHUNK}*)?`.
That is correct but unbounded, and `\bgit\b` can start at many positions inside one string. So the
extension swallowed the rest of the command and gave it back one character at a time, at every start
position. Quadratic, and measurable: a 20,000-character `git.git.git…` string took **414ms** to
decide, against 0-2ms for every realistic input. The option region carries a backtracking assertion
for exactly this reason; the binary tail was owed the same measurement and had not had it.

An extension is the **last dot-segment of the final path segment**, so it contains no separator, no
further dot and no quote. Saying that (`(?:\.[^\s'".\\/]*)?`) is a tighter statement of the same
shape, not a retreat to a list — `.exe`, `.EXE`, `.cmd`, `.bat`, `.ps1`, `.com`, `.anything-at-all`
and whatever `PATHEXT` gains next all still match without being named. With the extension bounded
there is nothing to give back, and the same 20,000-character input decides in **under 1ms**.

**Nothing else moved, and that is measured rather than claimed.** The 11,016-command differential
sweep returns byte-identical numbers to the previous entry — 4,125 dangerous newly denied, 240 benign
newly denied, 0 newly allowed, 0 drift in the plain-binary slice — and the classification of the 240
is unchanged (all inherited, 0 new). `node .claude/hooks/autopilot-lib.test.mjs` now reports **214
assertions passed**; against the pre-fix library the same file reports **178 passed, 32 FAILED**, the
same 32 deny-side cases as before. `npm run lint` is clean.

Two ceilings are now pinned in the test file rather than left to the next reviewer to rediscover: the
20,000-character repeated-dot string and a 100,000-character quoted binary path each decide in under
100ms.

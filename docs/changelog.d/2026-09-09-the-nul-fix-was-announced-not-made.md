## 2026-09-09 - the NUL fix was announced, not made; the property is now asserted

Fourth round on PR #648. The review re-confirmed the design for the third time —
100,000 non-matching inputs, zero classifier differences from base; all 29
predicates matching their pinned hashes and each a single read-only statement —
and found that the round-3 "fix" had not actually been made.

**The previous entry claimed the literal NUL bytes were replaced with escapes.
They were not.** Two remained. The file rendered as text on the PR only because
the bytes had moved PAST git's 8,000-byte binary-sniff window, not because they
were gone. That is luck presented as a fix, and the comment sitting directly
above the offending lines asserted the opposite.

The immediate cause is dull: the tooling writing this file emits literal control
characters where an escape is intended, so "write it as `\uXXXX`" is not a
reliable instruction — the second attempt failed exactly like the first. Every
exotic character in that block is now built from its **code point**
(`String.fromCodePoint(0x00)`), which no editor or transport can silently
mangle, and the block gained the missing paragraph separator, ogham space mark,
narrow no-break space and zero-width no-break space cases while being rewritten.

**More importantly, the property is now asserted instead of promised.** Section
11 reads this test file's own bytes and fails if any NUL is present, and checks
the manifest and a predicate file too. The control this entire change rests on
is that a predicate cannot move without the manifest moving and a person then
reading the combined diff; a test file git classifies as binary renders zero
additions and no patch, so the test enforcing that control becomes unreadable in
precisely the place it must be read. Both failures were the same defect — only
one of them was visible. An assertion does not care which.

This is the correct shape for this repository: when a rule matters, make it a
check rather than another sentence. The previous two attempts were sentences.

**Proof.** `predicate-fingerprints.test.mjs` 166 → 174, and it now fails on its
own file if a NUL reappears — verified by watching it fail on the unfixed file
(`8790 !== -1`) before the rewrite. Zero NUL bytes confirmed by byte count; the
PR diff renders 222 text additions. Manifest hashes unchanged. Full
`npm run test:correction-guards` green, and the deployed hook process still
clears 29 of 29 predicate files with `REAL-DATA-OK` absent (main: 0 of 29) while
denying all 15 must-deny shapes.

**Worth recording:** four rounds on this PR, one code defect (the backtracking
trim). Every other finding has been a claim wider than the diff — including,
twice now, a claim that a previous claim had been fixed. The design has not
moved; my description of it keeps having to.

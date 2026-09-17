## 2026-09-09 - the fingerprint test was committed as a binary file, and the PR body was never corrected

Third round on PR #648. The design held again — the review re-ran the
differential and found the branch still identical to base for every input whose
fingerprint does not match — and every finding was about the change's
reviewability and truthfulness rather than its behaviour.

**The test was unreviewable.** A trailing-NUL assertion was written with a
literal NUL byte instead of an escape, so git classified the entire file as
binary: `Bin 0 -> 8143 bytes`, zero additions, and **no patch rendered on the
pull request**. Every one of the assertions was invisible to a reviewer.

That matters more here than it would elsewhere. This design's stated control is
that a predicate cannot change without the manifest changing, and that the
combined diff is then reviewed by a person. Shipping the test that enforces it
in a form nobody can read in a diff defeats the argument the change rests on.
Every exotic character in that block is an escape now, the file renders as 196
text additions, and the block gained coverage while it was being rewritten —
including an assertion that `trimEnd()` and `/\s+$/` agree on each exotic
whitespace character, so the guard and the generator cannot quietly accept a
different set than the comments claim.

**The performance test contradicted its own description.** The prose in the
previous entry said the test asserts the shape rather than a wall-clock number.
It asserted both — a `large < 250` line sat directly under the ratio check. A
fixed millisecond threshold fails on a loaded CI worker for reasons unrelated to
this code, so the threshold was removed rather than the sentence reworded. The
measurement now takes the MINIMUM of several runs: a scheduling pause can only
make a run look slower, and an inflated baseline would let a genuinely quadratic
implementation pass the ratio.

**The PR body was never corrected.** The previous commit message said five
overstated claims were fixed "in the changelog and PR body". They were fixed in
the changelog only. The PR body still carried all five, so the most visible
description of this change was the least accurate one. Corrected, and the PR now
also carries the defect table and the known-issues list.

**One reported finding did not reproduce, and is not accepted.** The review
reported a ~1.6 KB input (1,000 leading spaces plus 100 dollar-quoted pairs)
that "did not finish the benchmark within another 60 seconds". Measured directly
against both git blobs it completes in **0 ms on base and 0 ms on head**.

The related finding — that `classifySql` as a whole is super-linear on repeated
dollar-quoted spans — is real: roughly 4× per doubling, 48 ms at 24,000
characters. But it is **identical on `main`** (base 48 ms, head 47 ms at the
same input), caused by `keepBody()` rescanning the accumulated prefix through
`stripTrailingComments()` on every dollar span. It predates this branch and is
recorded as a known issue rather than fixed inside a change whose whole value is
that it touches nothing else.

**Proof.** `predicate-fingerprints.test.mjs` 154 → 166; full
`npm run test:correction-guards` green. Manifest hashes unchanged. The deployed
hook process still clears 29 of 29 predicate files with `REAL-DATA-OK` absent
(main: 0 of 29) and still denies all 15 must-deny shapes.

**Worth recording:** three rounds on this PR, and the code defect count is one
(the backtracking trim). Everything else was a claim wider than the diff, a test
that could not be read, or a description that had drifted from what shipped. The
review is no longer finding bugs in this design; it is finding places where I
described it better than it was.

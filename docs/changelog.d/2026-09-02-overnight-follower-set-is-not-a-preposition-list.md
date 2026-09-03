## 2026-09-02 - The overnight follower set was a preposition list, not a clause test

**Class:** guard false positive (round 3). **Outcome:** ordinary prepositions no longer carry
`overnight` to a freeze; a stopping point for this matcher is recorded.

Follows `docs/changelog.d/2026-09-02-overnight-is-a-topic-word.md`, which has the full background on
why `overnight` gates the deterministic freeze at all and what the two signals are.

## What was broken

`OVERNIGHT_REQUEST` in `autopilot-intent-reminder.mjs` freezes the session when two signals agree:
NOT-NAMED (no determiner immediately before the word) and ADVERBIAL (it ends the phrase, or the next
word opens a clause). The ADVERBIAL half accepted a broad list of "adverbial" followers that
included ordinary prepositions.

CodeRabbit round 3 on PR #565, confirmed against current code before changing anything:

- **Major.** `overnight in the documentation is misspelled` latched. The sentence *opens* with the
  word, so nothing precedes it and the NOT-NAMED signal cannot fire — leaving the follower set as
  the only guard, and `in` walked straight through it.
- **Minor (MD040).** The verification fence in the companion entry had no language identifier.

## What changed

The defect was the follower set's premise, not its contents. Prepositions like `in`, `on`, `at`,
`to`, `from`, `with`, `into`, and `about` introduce noun phrases at least as often as they continue
a clause, so they are **removed entirely** rather than special-cased. What remains either

- opens a new clause — `and`, `so`, `then`, `please`, or a pronoun; or
- is time/manner flavoured in a way that only follows an action verb — `through`, `throughout`,
  `until`, `till`, `til`, `tonight`, `without`.

`for` is admitted **only** as `for me` / `for us`. That is what keeps round 2's finding fixed
("work overnight for me" is a request) without reopening round 3's ("overnight for the
documentation" is a topic).

## Verification

End to end against the real hook chain (`autopilot-intent-reminder.mjs` -> `unattended-autopilot.mjs`,
with a real `npm run build` payload — the question asked is "would this Bash call actually have been
frozen"): **all 21 cases correct**, 10 mentions allowed through and 11 real requests DENIED. The
three new negatives are `overnight in the documentation is misspelled`, `the note about overnight on
line 40 is wrong`, and `grep for overnight to see where it fires`.

`node .claude/hooks/prompt-hooks.test.mjs` — 201 assertions (was 195).
`node .claude/hooks/hook-router.test.mjs` — 47 assertions.
`npm run test:correction-guards` — exit 0.

## Stopping point (read before commissioning round 4)

This is a natural-language matcher and will never be provably complete. Each round has found a
*narrower phrasing* than the last, which is the signature of an argument that does not converge —
the same shape as the `git clean` carve-out (six rounds) and the reason Mason capped adversarial
iteration on `review-proof-guard.mjs` at six commissioned rounds (`docs/manual/DECISION_LOG.md`,
2026-09-01).

**Round 3 is the stopping point here.** Both failure directions are cheap and bounded:

- a **miss** degrades to the arm-autopilot reminder that `triggers` still injects — the pre-latch
  behaviour, not a silent loss of safety;
- a **false freeze** expires by itself in 45 minutes.

Do not commission round 4 for another phrasing. A genuinely new *class* of failure — say, the latch
firing from something other than prompt text — is a different matter and worth acting on.

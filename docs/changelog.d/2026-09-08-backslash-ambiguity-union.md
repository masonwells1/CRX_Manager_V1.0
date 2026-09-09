## 2026-09-08 - the live-data guard stops guessing standard_conforming_strings and classifies under BOTH readings

**Why:** a third `gpt-5.6-sol` review round found a shape that `main` blocks and
this branch allowed:

```
SELECT 'a\', $$[E2E]$$; DELETE FROM invoices;
```

`main` returns `financial-delete`. The branch returned `{ block: false }` — a
real DELETE against a live financial table, waved through. Two more variants of
the same shape (a business-table DELETE, and an `UPDATE invoices SET
total_cents = 0`) behaved identically. All three were reproduced locally against
both git blobs before fixing.

**The mechanism is not the comment strip.** Both strip passes leave that
statement byte-for-byte unchanged. The defect is the round-2 decision to always
read `\` as an escape inside an ordinary `'...'` literal:

1. `'a\'` no longer closes, so the literal over-runs to end of input.
2. Everything after it is therefore copied VERBATIM — including `$$[E2E]$$`,
   which `stripDollarQuoted` would otherwise have deleted as a machine body.
3. The `[E2E]` fake-data exemption is read from that dollar-stripped text. The
   marker survives, so the guard concludes the whole batch is fake test data and
   returns `{ block: false }` before any write check runs.

Round 2 justified hard-coding the escape with: *"assuming an escape can only
EXTEND the literal ... so any real statement that follows stays visible to
classification."* The statement does stay visible. It just stops mattering,
because the false exemption fires first. That is the third time in this PR that
a stated reason why a lexing shortcut "cannot hide a write" was wrong.

**What changed:** the guard no longer guesses. Both readings are individually
unsafe —

| reading | what it hides |
|---|---|
| `\` escapes | over-runs the literal, smuggling an `[E2E]` past the dollar-strip (round 3) |
| `\` is literal | ends the literal early, so `--'; DELETE FROM customers;` becomes a comment (round 2) |

— so `backslashEscapes` became a parameter threaded through both lexers, and
`classifySql` runs the entire classification twice, blocking if EITHER reading
sees a hazard. A statement is allowed only when it is harmless *however*
PostgreSQL would have lexed it. `destructiveMigrationCheck` takes the same
union, for the stronger reason: it gates an unattended migration apply, so an
ambiguous lex must resolve to "park it", never "apply it".

Inside `E'...'` a backslash always escapes regardless of the setting, so that
case stays unconditional in both passes.

**Proof.** `guards.test.mjs` 201 -> 205. Two of the added assertions fail in
OPPOSITE readings — the round-2 shape needs the escape, the round-3 shape needs
the literal — so together they pin the union: no single reading satisfies both.
A control asserts the documented `UPDATE ... -- [E2E]` exemption still works.
`migration-apply-guard.test.mjs` 113 green; full `npm run test:correction-guards`
green. The deployed hook process still DENIES all twelve must-deny shapes with
`REAL-DATA-OK` absent and ALLOWS all four must-allow shapes, and the same 12 of
29 sweep predicates still clear it — the second pass adds no false positives.

**Worth recording:** rounds 1, 2 and 3 each ended with a written argument for why
the new lexing was safe, and rounds 2 and 3 each falsified the previous one. The
pattern, not any individual bug, is why this change stopped choosing a reading.

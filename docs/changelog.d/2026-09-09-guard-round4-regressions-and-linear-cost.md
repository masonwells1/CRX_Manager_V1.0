## 2026-09-09 - four Codex round-4 regressions closed, plus the [E2E] blanket exemption and the quadratic scan

**Why:** the fourth pinned `gpt-5.6-sol` review of PR #639 returned BLOCKERS. It
named four inputs that `main` blocks and this branch allowed, one cost problem,
and three claims of mine that the diff did not support. Every one was
independently reproduced against both git blobs before being fixed, and every
one was real.

### 1. The `[E2E]` exemption was blanket, not per-statement

```
SELECT 1 AS foo$x$, '[E2E]$x$'; DELETE FROM customers;
```

The fake-data marker was checked with `text.includes("[E2E]")` over the WHOLE
batch, so a marker in an unrelated statement's string literal exempted the write
beside it. **Both backslash readings agree here, so the union added in
`4ccecd097` does not help.**

This is older and wider than the reported input. `main` allows the plain form,
`SELECT '[E2E]'; DELETE FROM customers;`, for the same reason — the reported
shape only differs in that `main`'s own mis-lex happened to delete the marker
first, which is why it read as a regression.

The exemption is now **scoped to the statement that carries the marker**. A new
`splitTopLevelStatements` splits on semicolons that are not inside a literal,
comment, quoted identifier or dollar-quoted body, and each statement is
classified with its own marker. The documented forms still work — `UPDATE …
-- [E2E]`, `VALUES ('[E2E] Farm Alpha')`, and a multi-statement batch where each
statement carries its own marker. The Hard Red Lines (audit log, TRUNCATE,
DDL/GRANT, sequence and RPC calls) were never exemptible and stay batch-wide.

### 2. A number was misread as an identifier

```
SELECT 1e2$x$--$x$;DELETE FROM customers;
```

`openDollarTag` refused to open a span if ANY character of the run before the
`$` looked like an identifier start — so the `e` in `1e2` made it decline. `1e2`
is a NUMBER, a dollar quote may follow one, and refusing to open handed the
body's inert `--` to the comment strip, which erased the DELETE.

It now checks whether the run **started** like an identifier, which is the rule
PostgreSQL's scanner actually applies. The changelog sentence that got this
wrong ("an identifier or number") is corrected in place rather than deleted.

### 3. Cost was quadratic

That boundary test walked backwards over the run on every `$`, and
classification runs twice. Measured on `1$1$1$…`: 2,000 chars 46 ms, 4,000
188 ms, 8,000 792 ms, 16,000 **3,005 ms**.

The callers now track the run start as they scan forward, so the test is O(1).
Same inputs: 0 / 0 / 2 / **4 ms**, and 64,000 chars in 20 ms.

That change also collapsed the two near-identical lexers into ONE `sqlSpans`
scanner with three consumers. Separate copies could disagree about where a
literal or a dollar span begins, and every hidden-write BLOCKER on this PR came
from exactly that kind of disagreement.

### 4. A foreign schema inherited a trusted function's exemption

`SELECT evil.pg_get_ruledef()` passed. The qualifier pattern was an optional
`public\.` that simply failed to match anything else, so matching restarted
after `evil.` and the call was read as the trusted `pg_catalog` formatter. The
qualifier is now captured; only `public`, `pg_catalog` and `information_schema`
are honoured, and anything else fails closed. Pre-existing, widened by the ten
names this PR added.

### 5. The Codex-side guard still had round 3's defect

`.codex/hooks/production-action-guard.mjs`'s `isClearlyReadOnlySql` called the
shared stripper with its DEFAULT reading, so `SELECT 'a\'||'--';DELETE FROM
customers;` still read as read-only there after the union landed on the Claude
side. It now requires read-only under BOTH readings.

### 6. Claims of mine the diff did not support

- The `4ccecd097` commit message said "two of the ADDED assertions fail in
  OPPOSITE readings". The pair does pin the union — verified again here, the
  round-2 shape needs the escape and the round-3 shape needs the literal — but
  only one of the two was added in that commit; the other came from
  `c8f3c5727`. Corrected in the changelog entry.
- "An identifier or number" — wrong, and it was the bug in item 2.
- `destructiveMigrationCheck` took the union but NO assertion exercised it. One
  now does, on a shape that is destructive only under the escaping reading.

**Proof.** `guards.test.mjs` 205 → 214; `migration-apply-guard.test.mjs` 113;
full `npm run test:correction-guards` green. Beyond unit tests, a differential
harness imported the pinned base blob `214125f4b` and the working tree side by
side: all eleven named adversarial shapes from rounds 1-4 block, and **40,000
generated inputs produced zero cases where the base blocks and this branch does
not**. The DEPLOYED hook process, driven with real PreToolUse payloads and
`REAL-DATA-OK` absent, still denies all 15 must-deny shapes, allows all 4
must-allow shapes, and clears the same 12 of 29 sweep predicates — the
schema-qualifier tightening adds no false positive to the sweep.

**Still open, unchanged by this entry:** 17 of 29 predicates remain blocked
because function names appear inside string literals; Codex's separate allowlist
still clears only 5 of the 12; and a marker in a comment ON the write's own
statement (`/*[E2E]*/ DELETE FROM customers;`) still exempts it, which is the
documented behaviour of the marker, not a hole in the scoping.

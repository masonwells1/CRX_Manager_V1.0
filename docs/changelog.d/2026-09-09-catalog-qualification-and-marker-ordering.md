## 2026-09-09 - catalog formatters must be pg_catalog-qualified, and the [E2E] marker must follow its write

Codex round 5 ran against a live PostgreSQL 17 container and returned BLOCKERS.
Seven findings, every one reproduced here before being acted on. Three were
genuine regressions against the pinned base; four were false allows that `main`
has too, and which `2026-09-09-guard-round4-regressions-and-linear-cost.md`
wrongly implied were fixed.

**The three regressions all came from one decision** — adding ten catalog
function names to the trusted list — and all three are closed:

| input | was |
|---|---|
| `SELECT pg_get_ruledef()` | trusted by NAME, so a user function of that name is what actually runs |
| `SELECT public.pg_get_ruledef()` | an explicit `public.` inherited a `pg_catalog` name's trust |
| `SELECT "é".pg_get_ruledef()` | the qualifier pattern was ASCII-only, so a non-ASCII schema was skipped entirely |

Codex created such a function in a container; the first two spellings executed
it and inserted a row while the guard said `block:false`. The eight formatters
are now trusted **only when written `pg_catalog.`** — nobody can create into
`pg_catalog`, so that spelling cannot be shadowed — and the seven sweep
predicates that called them were qualified in the same change, so all 12 still
clear. (`plpgsql_check_function`/`_tb` stay in `READONLY_FN_NAMES`, which is the
deliberate audited-by-name mechanism and carries its audit date.)

**The scoping claim was wrong.** "Scoped to the statement carrying the marker"
was true only of TOP-LEVEL statements. Three shapes still exempted a write the
marker had nothing to do with — and all three are false allows on `main`:

```
DO $$BEGIN RAISE NOTICE '[E2E]'; DELETE FROM customers; END$$;
WITH x AS (SELECT '[E2E]') DELETE FROM customers;
SELECT 1; -- [E2E]
DELETE FROM customers;
```

One rule closes all three: **the marker must FOLLOW the write it marks.** Every
documented form already does — `VALUES ('[E2E] Farm Alpha')`, `SET notes =
'[E2E] test'`, a trailing `-- [E2E]`. A marker that precedes the write is
describing something else. (`stripCommentsQuoteAware` now pads a comment to its
original length so offsets in the stripped and comment-bearing text still line
up.) The cost is a false DENY for a marker written as a LEADING comment, which
is not a documented form and which `REAL-DATA-OK` overrides.

**The scan was still quadratic**, just somewhere else: the call-detection regex
backtracked across a long identifier that never reached a `(` — 64,000
characters cost 3.0 s. It is now a single-pass tokenizer: 17 ms. That rewrite
also fixed the ASCII-only blind spot above and made `public."!"()` visible to
the default-deny scan for the first time.

**And the claim that "anything else fails closed" was false** while that regex
could not see a quoted or non-ASCII schema. Removed.

**Proof.** `guards.test.mjs` 214 → 223; migration guard 113; Codex-side guard
green with two new assertions pinning the both-readings behaviour that round 4
changed without a test. The differential harness against base `214125f4b` still
finds zero regressions across 40,000 inputs, and the deployed hook process still
denies 15 must-deny shapes, allows 4 must-allow shapes, and clears 12 of 29
predicates. Full `npm run test:correction-guards` green.

**Worth recording:** this is the third consecutive round where the defect was
not the code but a claim written about it. The code was fixed each time; the
sentence describing the fix was wider than what the diff did. That pattern, not
any single bug, is what to carry forward from this PR.

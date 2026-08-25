# Why the parked-migration scan reports PARKED STATE UNKNOWN

**Diagnosed 2026-08-20. Proven, not inferred. Implementation not yet done.**

`node scripts/fleet-status.mjs` reports `PARKED STATE UNKNOWN` for **every** worktree — all 19 —
with the same note each time:

```text
PARKED STATE UNKNOWN: <label>: branch-owned LOCAL CANDIDATE SQL named by migration history
is absent from this branch's own-draft diff.
```

This blocks WP-1 of the product data model build: that package stamps a new migration, and
stamping into a queue nobody can count is how two branches collide on the same schema.

## The mechanism

`parkedDraftPathsFrom()` in `.claude/hooks/worktree-awareness-lib.mjs:407-417` reconciles the
`LOCAL CANDIDATE — NOT APPLIED` rows in `docs/reference/migration-history.md` against the
branch's **own-draft diff** — what that branch changed since its branch point from `origin/main`.
A registered candidate the diff cannot account for yields `UNKNOWN` rather than a confident zero.
That rule is deliberate and correct in intent (added for Codex on #369): under-reporting hides
real pending work, and an extra scan only costs time.

## Why it can never be satisfied

`migration-history.md` is a **shared file on `origin/main`**. Its three current LOCAL CANDIDATE
rows are:

| Version | File |
|---|---|
| 20260816110000 | `20260816110000_draw_down_cutover_barrier.sql` |
| 20260816120000 | `20260816120000_draw_down_split_order_lines_by_price_tier.sql` |
| 20260817120000 | `20260817120000_carry_allocated_line_cents_through_lifecycle.sql` |

**All three already live on `origin/main`** — verified: the SQL files are present in
`supabase/migrations/` in the main checkout, and the history rows are accurate (none of the three
appear in the live `list_migrations` output, so they really are parked, not stale rows).

A file that is already on `origin/main` **cannot appear in any branch's diff against
`origin/main`.** So the reconciliation is unsatisfiable by construction for mainline-parked
candidates, and every worktree reports UNKNOWN forever. It is not a data problem — the history
rows are correct — and it is not caused by any one branch.

## Why the demand is also redundant

`fleet-status.mjs` already has a **separate mainline discovery path**
(`parkedMainlineDiscoveryFrom`, called at `scripts/fleet-status.mjs:342`) whose whole job is
finding parked candidates on `origin/main`. It works. Its output in the same run:

```text
• supabase/migrations/20260816120000_draw_down_split_order_lines_by_price_tier.sql — in confident-mclean-7f73d6, origin/main
• supabase/migrations/20260816110000_draw_down_cutover_barrier.sql — in origin/main
• supabase/migrations/20260817120000_carry_allocated_line_cents_through_lifecycle.sql — in origin/main
```

All three are found and counted. The per-worktree reconciliation is demanding that every branch
separately account for candidates the mainline path has **already accounted for**.

## The fix

Exempt mainline-known candidates from the per-worktree own-draft reconciliation. Own-draft
accountability should be required only for candidates that are **not** already on `origin/main`,
because those are the ones the mainline path cannot see. Two shapes, either acceptable:

1. **At the reader** — `createOwnDraftPathsReader`'s `readHistory` returns the whole
   `migration-history.md`. Have it return only the rows **this branch added** since its branch
   point. That matches the function's own stated contract — the comment at
   `worktree-awareness-lib.mjs:404` calls the registry "the branch's own claim that pending SQL
   exists", which the full shared file is not.

   **There are TWO construction sites and both must change**: `scripts/fleet-status.mjs:156` and
   `.claude/hooks/worktree-awareness.mjs:149`. Each builds its own reader from the shared factory
   at `worktree-awareness-lib.mjs:691`. Fixing only `fleet-status.mjs` repairs the report and
   leaves the SessionStart banner reporting UNKNOWN forever — the exact drift the 2026-07-29
   unification existed to prevent. Prefer putting the corrected `readHistory` behavior in the
   shared lib so neither caller can define it differently again.
2. **At the reconciliation** — pass `parkedDraftPathsFrom` a set of paths already accounted for
   elsewhere, and skip those in the loop at `worktree-awareness-lib.mjs:411`.

**Shape 1 is preferred** — it fixes the contract rather than adding a bypass around it.

## Do not get this wrong

`worktree-awareness-lib.mjs` has **two consumers**: this report and the SessionStart banner. They
were deliberately unified on 2026-07-29 so they cannot drift apart; change the rule in the shared
lib, never in one caller.

The dangerous direction is **under-reporting**: a scan that confidently says zero while real
pending migrations exist is far worse than one that says UNKNOWN. Required proof, all three:

- `npm run test` green — `worktree-awareness-lib.test.mjs` covers this reconciliation directly,
  including the case at line 784 that asserts an unaccounted candidate yields UNKNOWN. **That
  test must still pass**; the fix narrows *which* candidates are in scope, it does not remove the
  rule.
- A new test: a candidate already present on `origin/main` does **not** make a branch UNKNOWN.
- `node scripts/fleet-status.mjs` reports a real number, and that number **still lists all three
  candidates above**. If they vanish from the parked list, the fix is wrong — it hid them instead
  of attributing them.

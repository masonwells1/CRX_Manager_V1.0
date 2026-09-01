## 2026-09-01 — Two live defects moved out of buried audit files and into KNOWN_ISSUES.md

The 2026-08-31 documentation sweep (#529) surfaced two real defects that were verifiable in current
source and recorded **nowhere** an agent or owner would look: not `TODO.md`, not
`docs/manual/KNOWN_ISSUES.md`, not `docs/manual/CURRENT_STATE.md`. Each lived in a single dated
audit or handoff file — one of them headed "completed/superseded". That synthesis gap was flagged
but not closed at the time, because folding a fix into a documentation cleanup would have widened
the diff past what was asked. This change closes it.

Both were re-verified against `main` at `85266c9a` before being written down; neither entry is
copied forward from the earlier PR's description.

### F06 — a reloaded chemical line goes stale on an acreage change (billing)

A line saved as 1.5 pt/ac over 100 acres still reads 150 pt at 200 acres. The quantity is what
bills, so the rate and the billed amount silently disagree.

The re-verification changed the story in a way worth recording. This is **not an oversight** — it is
a deliberate, documented choice with sound reasoning. The `driver` field that records whether the
operator typed the rate or the total is UI-only and never persisted, so a reloaded line is
driverless and `recomputeChemRowForAcres` leaves it exactly as saved. An earlier attempt to recover
that provenance by testing `quantity == rate × acres` was reverted as unsound: `applyChemEdit`
back-solves the rate whenever a quantity is typed, so a hand-entered total satisfies the same
equality by construction. Acting on it would rewrite an operator's typed chemical amount on every
acreage change. Under-billing is bad; silently rewriting a typed chemical quantity is worse.

The entry records that reasoning, so the next reader does not "fix" it by reintroducing the unsound
heuristic. The real fix needs a migration to persist `driver` on `job_chemicals`.

It also records that **a passing test asserts the stale behaviour**
(`src/lib/chemCalculator.test.ts:723-727`), so any fix must update that test rather than be
surprised by it.

### H5 — the integrity panel offers an invoice action it cannot complete

`IntegrityCleanupPanel.tsx` renders "Create draft invoice" unconditionally for every unbilled
delivery. On a split-billing order the RPC guard correctly refuses, and the catch block surfaces the
raw `ORDER_NEEDS_SPLIT_BILLING` code to the operator. No wrong data is written — the harm is being
invited into an impossible action and handed an error code instead of a reason.

### A third finding, fixed here

`src/pages/JobDetail.tsx:252` documented the driverless case as "a loaded line follows its rate if
it has one". **It does not**, and the same file says so 1,500 lines further down in its F06 block.
A comment that contradicts both the code and the rest of its own file is worse than no comment: it
would tell someone auditing this exact billing path that the case is handled. Corrected to state
the real behaviour and point at both authorities.

### Proof observed

- `src/pages/JobDetail.tsx:1765-1777` carries an explicit "F06 IS STILL OPEN, DELIBERATELY" block
  with the same 1.5 pt/ac example.
- `src/lib/chemCalculator.ts:88` returns the row unchanged when `driver` is undefined;
  lines 91-96 record the reverted heuristic and state the driver must be persisted.
- `src/lib/chemCalculator.test.ts:723-727` asserts `'150'` at both 200 and 50 acres.
- `src/components/integrity/IntegrityCleanupPanel.tsx:684-689` renders the button unconditionally;
  line 416 surfaces `err.message` raw.
- `supabase/migrations/20260718202607_backfill_invoice_guard_durable_split_allocations.sql` defines
  both `create_invoice_for_unbilled_delivery` and its `ORDER_NEEDS_SPLIT_BILLING` guard.
- `npm run check:docs`, `npm run typecheck` and `npm run lint` pass.

## 2026-09-01 — Two live defects moved out of buried audit files and into KNOWN_ISSUES.md

The 2026-08-31 documentation sweep (#529) surfaced two real defects that were verifiable in current
source and recorded **nowhere** an agent or owner would look: not `TODO.md`, not
`docs/manual/KNOWN_ISSUES.md`, not `docs/manual/CURRENT_STATE.md`. Each lived in a single dated
audit or handoff file — one of them headed "completed/superseded". That synthesis gap was flagged
but not closed at the time, because folding a fix into a documentation cleanup would have widened
the diff past what was asked. This change closes it.

Both were re-verified against `main` at `85266c9a` before being written down; neither entry is
copied forward from the earlier PR's description.

### F06 — a reloaded chemical line goes stale on an acreage change, and the save is then REFUSED

A line saved as 1.5 pt/ac over 100 acres still reads 150 pt at 200 acres.

**The first draft of this entry called that a silent billing gap. Codex's review of PR #538 showed
it is not, and the correction landed before the entry ever merged.** For a priced line the applied
migration `20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql` compares
quantity against rate × current acreage and raises `CHEM_QUANTITY_NOT_DERIVED` **before any write**,
within a tolerance far tighter than a real acreage change. The stale quantity cannot reach an
invoice through `save_job`.

The real harm is a **blocked save** — refusing one line rolls back the whole job — plus a **margin**
residual on cost-only lines, which the money refusals skip by design (line 760 continues past any
line with zero `price_per_unit_cents`). That residual is pre-existing and already recorded in the
migration's own comment.

**This changes the remediation, which is why the correction mattered.** The first draft prescribed a
migration to persist `driver`. The server-side guard already exists, so the fix is UI-side:
reconcile the line on load or on acreage change, or surface the refusal early the way
`chemRowDefects` already does for the unit refusals. Persisting `driver` remains the cleanest way to
know which field is authoritative, but it is not required to close a billing hole.

The choice not to guess the provenance is still sound and is recorded so nobody "fixes" it by
reintroducing the reverted heuristic: `applyChemEdit` back-solves the rate whenever a quantity is
typed, so a hand-entered total satisfies `quantity == rate × acres` by construction. Acting on that
equality would rewrite an operator's typed chemical amount on every acreage change.

The entry also flags that the source comment at `JobDetail.tsx:1773-1774` justifies the choice with
"Under-billing is bad" — a stake that predates the 2026-08-20 guard and now overstates the exposure.

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
- `supabase/migrations/20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql:1157-1164`
  — the `CHEM_QUANTITY_NOT_DERIVED` guard and its tolerance
  `GREATEST(0.0001, LEAST(0.00005 × acres, 0.1))`, raised before any write; line 760 continues past
  any line with zero `price_per_unit_cents`, which is why the residual is margin and not billing.
- `src/components/integrity/IntegrityCleanupPanel.tsx:684-689` renders the button unconditionally;
  line 416 surfaces `err.message` raw.
- `supabase/migrations/20260718202607_backfill_invoice_guard_durable_split_allocations.sql` defines
  both `create_invoice_for_unbilled_delivery` and its `ORDER_NEEDS_SPLIT_BILLING` guard.
- `npm run check:docs`, `npm run typecheck` and `npm run lint` pass.

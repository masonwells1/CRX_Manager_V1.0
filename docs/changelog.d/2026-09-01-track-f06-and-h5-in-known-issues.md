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

A line saved as 1.5 pt/ac, quantity 150, over 100 acres still reads 1.5 and 150 at 200 acres — and
1.5 × 200 is 300, so the two numbers no longer agree.

**A fourth Codex finding fixed the framing.** The entry originally said the quantity "should read
300". That is true only if the operator typed the *rate*. If they typed the *total*, the correct
line at 200 acres is quantity 150 with the rate becoming 0.75 — and `applyChemEdit` back-solves the
other field either way, so both histories produce an identical saved row. Asserting 300 silently
assumes one case and would steer a fixer toward overwriting an operator's typed total: precisely the
harm the rest of the entry warns about. The entry was internally inconsistent, and now presents both
readings in a table.

**The first draft of this entry called that a silent billing gap. Codex's review of PR #538 showed
it is not, and the correction landed before the entry ever merged.** For a priced line the applied
migration `20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql` compares
quantity against rate × current acreage and raises `CHEM_QUANTITY_NOT_DERIVED` **before any write**,
within a tolerance far tighter than a real acreage change. The stale quantity cannot reach an
invoice through `save_job`.

The real harm is a **blocked save** — refusing one line rolls back the whole job.

**A third Codex finding then corrected the correction.** The second draft claimed a margin residual
on cost-only lines, reading line 760's price gate as a general exemption. It is not: that `CONTINUE`
sits inside `IF v_qty = 0 THEN` at line 758, so it exempts only zero-quantity lines. A stale
reloaded quantity is non-zero by definition and is refused whether or not the line is priced. The
only skip open to a non-zero line requires both cost and price to be zero. **F06 has no margin
residual at all** — it is purely a blocked save.

That is three rounds on the same entry, each narrowing it. Worth stating plainly: the first draft
would have sent someone to write a migration for a hole the server already closes, and the second
would have left a phantom margin exposure in the canonical issues file.

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
delivery. On a split-billing order the RPC guard correctly refuses. No wrong data is written.

**A second Codex finding narrowed this one too.** The first draft claimed the operator is handed a
raw error code instead of a reason. The guard actually raises a full sentence — *"delivery N's order
uses split billing — a single backfilled invoice would mono-bill it and mis-attribute AR. Create the
split invoices through the split-billing flow instead."* — and `PostgrestError` extends `Error`, so
`toast('error', err.message)` shows all of it. The entry now says so explicitly and warns **against**
the fix the first draft recommended: mapping codes to plain-English messages would replace better
text with worse. Only the unusable button remains, and the fix is to hide or disable it.

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
  `GREATEST(0.0001, LEAST(0.00005 × acres, 0.1))`, raised before any write.
- The same file, `:758-760` — the price gate is nested inside `IF v_qty = 0 THEN`, so it exempts
  only zero-quantity lines. A non-zero stale quantity is refused priced or not; the sole skip for a
  non-zero line requires both `cost_per_unit_cents` and `price_per_unit_cents` to be zero.
- `src/components/integrity/IntegrityCleanupPanel.tsx:684-689` renders the button unconditionally;
  line 416 surfaces `err.message` raw.
- `supabase/migrations/20260718202607_backfill_invoice_guard_durable_split_allocations.sql` defines
  both `create_invoice_for_unbilled_delivery` and its `ORDER_NEEDS_SPLIT_BILLING` guard.
- `npm run check:docs`, `npm run typecheck` and `npm run lint` pass.

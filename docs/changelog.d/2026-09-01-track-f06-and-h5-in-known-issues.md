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

**Two further Codex findings then corrected the correction, twice.** The second draft claimed a
broad margin residual on cost-only lines, misreading line 760's price gate as a general exemption —
it sits inside `IF v_qty = 0 THEN`. The third draft over-corrected to "no residual at all", on the
reasoning that a stale quantity is non-zero *by definition*. That is false exactly when the job had
**no acreage at save time**: a cost-only line then persists quantity 0, the driverless recompute
leaves the 0 after acreage rises, and the zero-price exemption lets it save with zero derived cost.
That misstates margin — one accepted shape among several, as later findings showed.

Findings **seven through eleven** then corrected the fix to the correction, repeatedly: "zero
quantity" is not the dividing line (the `customer_supplied` and no-cost-no-price exemptions sit
under a *blank unit* branch at 784-787 and accept non-zero rows); "financially harmless" is not
either (an unverifiable-quantity branch accepts a cost-bearing line whose cost can still misstate
margin); and "understates" assigns a direction that actually depends on whether the acreage rose or
fell.

**So the entry stopped enumerating the taxonomy.** Five consecutive findings corrected the same
paragraph in five different directions, each correction right. That is evidence the enumeration does
not survive restatement, not an invitation to a sixth attempt. The entry now makes **no claim** about
which accepted shapes are harmless, says only that unpriced cost-bearing lines have accepted paths
where a stale number can misstate margin, and directs anyone who needs the exact boundary to read
the function's control flow rather than any prose summary,
**including the entry's own**.

The durable lesson is not the scope. It is that a 1,700-line guard's accept/refuse set does not
belong in a bug entry: cite it, don't paraphrase it.

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

### H5 — TWO surfaces offer an invoice action they cannot complete

`IntegrityCleanupPanel.tsx` renders "Create draft invoice" unconditionally for every unbilled
delivery. On a split-billing order the RPC guard correctly refuses. No wrong data is written.

**A fifth Codex finding widened this one.** The entry named one surface; there are two.
`src/pages/DeliveryDetail.tsx:1628` renders its own "Create Invoice" button gated only by
`isAdmin && status === 'completed' && !hasActiveRelatedInvoice` — **no split-allocation check** — and
calls the same RPC at line 1119. The original handoff listed **both** callers at
`2026-07-18-gauntlet-2-6-leftover.md:78`; #529's summary named one, and I carried the summary forward
instead of re-reading the source. Fixing only the panel would have left the second dead end live.
The entry now names both and recommends a shared "can this delivery be single-invoiced?" predicate
rather than two conditions that can drift apart.

**A second Codex finding narrowed this one too.** The first draft claimed the operator is handed a
raw error code instead of a reason. The guard actually raises a full sentence — *"delivery N's order
uses split billing — a single backfilled invoice would mono-bill it and mis-attribute AR. Create the
split invoices through the split-billing flow instead."* — and `PostgrestError` extends `Error`, so
`toast('error', err.message)` shows all of it. The entry now says so explicitly and warns **against**
the fix the first draft recommended: mapping codes to plain-English messages would replace better
text with worse. Only the unusable buttons remain, and the fix is to hide or disable them on both
surfaces.

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
- The same file — the money refusals key on PRICE, so unpriced cost-bearing lines have several
  accepted paths. **This entry deliberately does not enumerate them**, for the reason given above;
  the authoritative set is the function's control flow. An earlier draft of this bullet asserted
  "refused priced or not" and a "sole skip", both of which the guard contradicts.
- `src/components/integrity/IntegrityCleanupPanel.tsx:684-689` and
  `src/pages/DeliveryDetail.tsx:1628-1636` each render the button unconditionally.
- `supabase/migrations/20260718202607_backfill_invoice_guard_durable_split_allocations.sql` defines
  both `create_invoice_for_unbilled_delivery` and its `ORDER_NEEDS_SPLIT_BILLING` guard.
- `npm run check:docs`, `npm run typecheck` and `npm run lint` pass.

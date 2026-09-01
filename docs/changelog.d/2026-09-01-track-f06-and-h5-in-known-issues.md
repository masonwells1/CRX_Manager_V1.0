## 2026-09-01 — Two live defects moved out of buried audit files into KNOWN_ISSUES.md

The 2026-08-31 documentation sweep (#529) surfaced two real defects verifiable in current source and
recorded **nowhere** an agent or owner would look — not `TODO.md`, not `docs/manual/KNOWN_ISSUES.md`,
not `docs/manual/CURRENT_STATE.md`. F06 lived only in a dated audit under a "Still open" heading; H5
only in a handoff headed "completed/superseded". #529 flagged that synthesis gap rather than closing
it, to avoid widening a documentation cleanup. This closes it.

Both were re-verified against `main` at `85266c9a`, not copied forward from #529's summary. That
re-verification changed both severities.

### F06 — a reloaded chemical line loses which field the operator typed

Changing the acreage on a saved job leaves the rate and the quantity disagreeing, and the save is
then refused. #529 called this a silent billing gap; it is not. `save_job` raises
`CHEM_QUANTITY_NOT_DERIVED` before any write, so a priced line cannot misbill through it.

The defect is the **lost provenance**: `applyChemEdit` back-solves whichever field the operator did
not type, so a saved row is identical whether the rate or the total was authoritative. Nothing on
the row says which to trust. The entry records this explicitly so nobody "fixes" it by re-deriving
the quantity — that silently rewrites an operator's typed chemical amount, and the heuristic which
did so was already tried and reverted (`chemCalculator.ts:91-96`).

### H5 — a dead-end invoice button, on two surfaces

An admin is offered "Create invoice" on split-billing orders where it cannot succeed. #529 named one
surface; there are two — `IntegrityCleanupPanel.tsx` and `DeliveryDetail.tsx`, whose
`canCreateInvoice` never consults split allocations. The original handoff listed both.

**The two surfaces do not behave the same, which took three rounds to pin down.** #529 said the
operator sees a raw error code. A review round showed the guard raises a full sentence with the
remedy — true — so the entry was corrected to say the message is fine. A later round then showed
that correction is wrong for one surface: with `@supabase/postgrest-js` 2.112.4 a `PostgrestError`
is constructed **only** under `.throwOnError()`, so an ordinary `supabase.rpc(...)` returns a plain
object. `IntegrityCleanupPanel` throws that object and its catch tests `err instanceof Error`, which
is false — the operator gets the literal `'Backfill failed'` and the reason is lost. `DeliveryDetail`
calls `sanitizeError`, which already handles object-shaped Postgrest errors, and keeps the message.

So H5 is two fixes: use `sanitizeError` in the integrity panel's catch (the helper exists and
handles this exact case — not a code→message lookup table), and gate the button on both surfaces.
The wider lesson is worth carrying: **`err instanceof Error` is unsafe after any non-throwing
Supabase call.**

### One source fix

`src/pages/JobDetail.tsx:252` documented the driverless case as "a loaded line follows its rate if
it has one". It does not, and the same file says so 1,500 lines below. Corrected. This is the only
source change and it is a comment.

### The review history, kept because the lesson is reusable

Codex raised **twelve** findings on PR #538, CodeRabbit one more. They do not collapse into a single
failure class, and an earlier draft of this very paragraph claimed they did — which Codex then
flagged as its twelfth finding. Counted from the threads rather than from memory:

- **Six** were the same mistake: restating the accept/refuse control flow of a 1,700-line migration
  in prose and getting the boundary wrong in a new direction each time. That class is why the
  paraphrase is now omitted outright instead of corrected a seventh time.
- **Three** were substantive defects in the entries — H5's second affected surface, that surface
  swallowing the refusal reason, and a summary sentence that contradicted the paragraph beneath it.
- **One** was lost edit provenance: the F06 example assumed the rate was authoritative, when the
  saved row cannot say which field the operator typed.
- **One** was arithmetic: the direction of the margin error depends on whether acreage rose or fell,
  so it can be misstated either way rather than always understated.
- **One was later overturned.** An early round established that the split-billing guard's message
  reaches the operator; a later round showed that holds only for `DeliveryDetail`. Each round was
  right about what it examined, but the pair cannot both stand — so "every finding was correct" is
  itself false.
- CodeRabbit's single finding was a severity label: "cosmetic" understated H5.

Both entries were therefore **trimmed at Mason's direction** to the defect, the call sites, and a
pointer to the authoritative code — the exemption taxonomy is deliberately not paraphrased. The
operative rules:

- **Cite a guard; do not paraphrase it.** Its header comments are not a substitute for its body,
  and thorough comments are the most dangerous kind because they feel exhaustive.
- **Enumerate call sites from the code**, never from a prior write-up. That is how H5's second
  surface was missed.
- **When a reviewer reports a claim, grep the claim**, not the cited line. Several rounds were spent
  fixing a statement in one file while an identical one survived in another.
- **Do not compress a review history into one failure class.** Tidying twelve findings into "nine of
  the same mistake" was itself wrong, and cost a round to correct. If a summary of the review is
  worth writing, count it off the threads.

### Proof observed

- `npm run typecheck`, `npm run lint`, `npm run check:docs` — all clean.
- `npx vitest run src/lib/chemCalculator.test.ts` — 93 passed, including the test that asserts the
  current stale behaviour, which any fix must update.
- `git grep -l "F06\|ORDER_NEEDS_SPLIT_BILLING" origin/main -- TODO.md docs/manual/KNOWN_ISSUES.md
  docs/manual/CURRENT_STATE.md` returned nothing before this change.
- Guard and call sites read directly:
  `20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql`,
  `20260718202607_backfill_invoice_guard_durable_split_allocations.sql`,
  `IntegrityCleanupPanel.tsx:684-689`, `DeliveryDetail.tsx:201-202, 1119, 1628-1636`.

No migration, no data change, no behaviour change.

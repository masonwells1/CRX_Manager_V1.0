## 2026-08-31 — "Modifies an existing migration" is not the same as "edits an applied migration"

Codex found the branch inventory accusing a branch of Hard Rule territory it is not in. The report
had a three-way taxonomy for every branch that modifies a `supabase/migrations/*.sql` file already
on `main` — rebase artifact, abandoned edit, or applied-live-in-modified-form — and routed the
third to a forward-reconciliation procedure. **There was no slot for the case that actually
applies to one of the four branches: the file exists on `main` and has never been applied.**

`codex/pr509-source-recognition-fix-v2-20260830` modifies
`20260827041100_rebuild_return_credit_cogs_reversal.sql` and
`20260827041400_align_return_credit_order_invoice_gates.sql`. Both are marked
**`LOCAL CANDIDATE — NOT APPLIED`** in `docs/reference/migration-history.md`, at rows 895 and 898.
They are reviewed SQL staged for a governed apply that has not happened. Revising them on a branch
is ordinary in-flight work.

Two things follow, and both matter on a money and inventory path:

- **The Hard Rule is not engaged.** The rule forbids editing an *applied* migration. Nothing has
  been applied, so nothing immutable has been edited.
- **Forward reconciliation is the wrong procedure.** It exists to reconcile a branch's bytes
  against a definition already running in production. There is no live definition here to
  reconcile against, so running that procedure would be work invented by a misclassification —
  on the return-credit COGS path.

The report was protecting this branch anyway, but for the wrong reason: it has an open PR. That
protection is not durable. A PR can close while the candidate underneath it is still queued to
apply, and the branch would then fall through to a taxonomy with no correct answer for it.

### What changed

- A new first step, **"First: is the file it modifies actually applied?"**, ahead of the four
  cases, with the per-file ledger status of all five affected migrations in a table: three
  applied live (rows 885, 886, 887), two not (rows 895, 898).
- A **fourth case** — a pending revision of an unapplied candidate — treated exactly like the
  absent-migration case: unlanded work, preserve it, leave the branch alone, no rule engaged and
  no reconciliation owed.
- The forward-reconciliation section, the section intro, the totals table, the review order and
  the per-branch appendix all now say **three** applied-migration branches rather than four, and
  name the fourth as case four.
- The instruction now says explicitly that the ledger is documentation: confirm against live
  `supabase_migrations.schema_migrations` with a read-only query before acting.

### The general lesson

The measure asked *does `main` have different bytes at this path?* and the taxonomy answered as if
it had asked *is production running different bytes?* Those coincide only for migrations that have
actually run. A repository that deliberately stages reviewed-but-unapplied SQL breaks the
identification, and this one does. **Presence in `main` is not evidence of application** — the
same trap, in the other direction, as "absent from `main` is not evidence of loss".

### Proof observed

- `docs/reference/migration-history.md` row 895: `**LOCAL CANDIDATE — NOT APPLIED. MONEY/INVENTORY.**
  File: 20260827041100_rebuild_return_credit_cogs_reversal.sql`; row 898:
  `**LOCAL CANDIDATE — NOT APPLIED.** File: 20260827041400_align_return_credit_order_invoice_gates.sql`.
- Rows 885, 886 and 887 carry `APPLIED LIVE` for the three migrations the other branches modify.
- `npm run check:docs` passes.

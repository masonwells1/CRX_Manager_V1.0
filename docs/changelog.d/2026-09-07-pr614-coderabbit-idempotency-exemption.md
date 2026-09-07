## 2026-09-07 — PR #614's CodeRabbit review answered: idempotency-key exemption recorded, MD5-pin finding rejected with evidence

First CodeRabbit review #614 has ever had (requested 2026-09-07T00:19:00Z, `CHANGES_REQUESTED` at
00:26:55Z, bound to head `e0bdac7c1`). Two actionable findings. **Comment-only changes** — no
executable SQL was touched and the migration remains **PARKED, NOT APPLIED**.

**Finding 2 — ACCEPTED as a documentation gap, REJECTED as a code change.** CodeRabbit asked that
`next_invoice_number` accept and enforce `p_idempotency_key text DEFAULT NULL` per the CRX hard rule,
*or* that the exemption be recorded. The exemption is recorded — in the migration header and in
migration-history row 917. Reasons, in order of decisiveness:

1. The function is invoked as the `invoices.invoice_number` **COLUMN DEFAULT**. A column default has
   no caller that could supply a key. Live callers also invoke it with zero arguments.
2. Adding a parameter changes the **signature**, which `CREATE OR REPLACE` cannot do. It would force
   `DROP FUNCTION` — the path the migration header already documents as dangerous: the fresh
   `CREATE` takes the default `EXECUTE TO PUBLIC`, and the `DROP` hits the dependent column default.
   It would also invalidate the body md5 pins.
3. The rule guards against a retry **applying a business action twice**. This function only draws the
   next value from a forward-only per-prefix sequence: a retry consumes a fresh number, re-applies
   nothing, and moves no money or inventory. A skipped number is a cosmetic gap.
4. Out of scope: this file rewrites ONE expression (the year source) in an existing function.

Verified while answering: **no `next_%_number` generator has ever taken an idempotency key**
(`grep -rn "p_idempotency_key" supabase/migrations/` returns no generator hit), and
`SAFE_DEVELOPMENT_RULES.md:39` states the rule with no recorded exemption. So the gap was real and is
now closed in writing. Revisiting it is a deliberate change across all eight generators.

**Finding 1 — REJECTED, premise does not hold.** CodeRabbit asked the proof to strip SQL comments
before inspecting `migrationSql` and then assert both MD5 pins appear in the executable
`v_md5 NOT IN (...)` and postflight clauses. Checked against the code:

- The pins ARE already in executable SQL — the preflight list opened by `IF v_md5 NOT IN (` and the
  postflight check opened by `IF v_md5 <> '7cbf50dd`. Only the two `--` header copies are comments.
  (Anchored to the code text on purpose: the line numbers this entry first carried — 156-157, 298
  and 86-87 — were written against the pre-edit file and were already 22 lines stale when this same
  commit added the exemption header above them. Corrected 2026-09-07; see that day's second entry.)
- `scripts/smoke/prove-next-invoice-number-year-chicago.mjs` **never text-matches the pins against
  `migrationSql` at all.** It computes `md5(pg_proc.prosrc)` inside a real PostgreSQL 17 container
  and compares (lines 234, 262, 289, 341, 357). A comment cannot satisfy that, so the class of
  false-pass the finding describes is not reachable.
- The enforcement is proven behaviourally, not textually: proof step 5 drifts the body and observes
  the migration refuse with nothing changed.

Adding the requested static text assertion would be strictly weaker than the behavioural proof
already present, so it was not added.

**Proof observed.** `node scripts/smoke/prove-next-invoice-number-year-chicago.mjs` re-run AFTER the
header edit: terminal `NEXT_INVOICE_NUMBER_YEAR_CHICAGO_PROOF_PASS`. The candidate body md5 pin
`7cbf50dd…` still reproduces, which is what proves the header edit changed nothing executable —
`md5(prosrc)` covers only the text between the `$fn$` markers, and both edits are outside it.
Row 917 re-checked after editing: still exactly one row, still reads
`LOCAL CANDIDATE — … NOT APPLIED LIVE`, and no new `.sql` basename was introduced.

**What was NOT done.** No reply was posted on the PR: the dismissal reasoning for finding 1 lives
here and in the header instead, because posting to the PR via `gh` authenticates as Mason. Clearing
the `CHANGES_REQUESTED` verdict needs a fresh CodeRabbit review at the new head (or Mason's
dismissal) — a review slot is rationed fleet-wide and is the orchestrator's to schedule. The Codex
exact-SHA review is still unobtainable: the account is out of credits until 2026-09-11, confirmed on
both the CLI and the GitHub connector. The migration is still **PARKED**; applying it remains a
separate approval Mason has not given, and issue #617 (six sibling generators, same UTC-year defect,
same 31 December 2026 deadline) stays open.

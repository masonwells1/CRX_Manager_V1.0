## 2026-09-04 - Close the exact-SHA review findings on the invoice-date branch and the doc drift the renumber caused

- Fixed the `check:docs` CI failure the renumber caused. Renaming the migration to `20260904160000`
  made `20260904` the newest migration date, so `docs/manual/CURRENT_STATE.md` and
  `docs/manual/KNOWN_ISSUES.md` (both stamped `20260903`) failed the manual-freshness rule. The check
  says to re-verify against live and correct anything stale *before* bumping, so both were re-read
  rather than date-stamped — and `CURRENT_STATE.md`'s ordering high-water claim was genuinely wrong.
  It asserted `20260903150000_job_chemicals_persist_driver`; read-only `list_migrations` shows three
  newer applies, making the real high-water authored name
  `20260903230000_commission_report_snapshot_contract` (ledger version `20260904040643`). Also
  recorded that `.claude/schema-registry.json` is now behind live (three applies since its
  2026-09-03 15:34 UTC regeneration) and that refreshing it belongs to PR #594's lane, not this one.
- Strengthened `PHASE 7b` of `scripts/smoke/prove-invoice-date-fallbacks-chicago.mjs` after a
  gpt-5.6-sol exact-SHA review of `d53a43428` raised it as LOW. The phase asserted only that
  `PREFLIGHT_BODY_DRIFT` was **absent** from the mutant's output — but an unrelated failure (syntax
  error, dead connection, any other exception) also produces output with that token absent, so the
  phase could false-green while proving nothing. It now additionally requires the mutant to exit `0`,
  to reach `POSTFLIGHT_OK`, and for the drifted body to actually be **overwritten** to the candidate
  pin. That is the positive form of the claim: with the pin removed the drift is not merely
  unrefused, it is silently replaced — which is the damage the pin exists to prevent. Re-ran the
  prover: ALL PHASES PASSED with the stronger assertion.
- Redacted a live customer invoice number and its dates from four places this branch introduced —
  `docs/changelog.d/2026-09-03-invoice-date-fallbacks-chicago.md`, two spots in
  `docs/manual/DECISION_LOG.md`, and one in `docs/manual/KNOWN_ISSUES.md`. The repository is public
  and an invoice number with its dates is live business data. Confirmed all four were branch-authored
  (zero occurrences on `origin/main`) before editing, and kept the surrounding reasoning intact so
  the decision record still reads without them. The row remains identifiable from the live ledger.

### Pre-existing, deliberately NOT swept into this PR

Live invoice numbers and dollar amounts also appear in files already on `main`:
`docs/audits/2026-08-08-foundation-ultra-review.md`, `docs/audits/overnight-bug-hunt/LEDGER.json`,
`docs/CHANGELOG.md`, `docs/loops/business-workflow-fix-ledger.md`, `docs/manual/CURRENT_STATE.md`
(a different invoice number), and `tests/e2e/math-invoice-verification.spec.ts`. Those predate this
branch and are out of its scope; they are recorded here so the finding is not lost, and redacting
them belongs in its own change.

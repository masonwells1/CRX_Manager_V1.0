## 2026-09-28 - customer-document rep soft delete: second `main` sync (PR #800)

**What changed.** PR #800 merged `main` again after the docs cleanup (#830) rewrote
`CURRENT_STATE.md` and `KNOWN_ISSUES.md`. The conflict was resolved by taking `main`'s rewritten
files and re-pointing only this PR's own entries at the current facts.

- `20260914100900_repair_commission_history_label_snapshots` is now live (ledger `20260928025520`,
  read-only check 2026-09-28), so the real-schema prover REPLAYS it instead of skipping it. The
  prover passed: 97 migrations replayed, and the registered chain still fails against the mutant.
- The ordering hold now points at open PR #832, which carries `20260914101000`..`101300` after the
  closed #793. The hold is unchanged: do not merge #800 or apply `20260921180000` until
  `20260914101300_finish_generic_field_invoice_cutover` is confirmed in the live ledger.
- `KNOWN_ISSUES.md` now names the page branch (`claude/customer-document-rep-remove-page-v3`)
  instead of saying the Documents-tab change is not written.

**Still to do.** Checks green, then the follow-up CodeRabbit review (it must be APPROVED on the
final head); after the hold lifts, merge `main`, re-run the prover, a fresh `gpt-6-sol` review of
that head, the apply, and the exact-head merge.

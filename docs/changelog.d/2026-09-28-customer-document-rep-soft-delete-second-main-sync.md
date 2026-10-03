## 2026-09-28 - customer-document rep soft delete: second `main` sync (PR #800)

**What changed.** PR #800 merged `main` again after the docs cleanup (#830) rewrote
`CURRENT_STATE.md` and `KNOWN_ISSUES.md`. The conflict was resolved by taking `main`'s rewritten
files and re-pointing only this PR's own entries at the current facts.

- `20260914100900_repair_commission_history_label_snapshots` is now live (ledger `20260928025520`,
  read-only check 2026-09-28), so the real-schema prover REPLAYS it instead of skipping it. The
  prover passed: 97 migrations replayed, and the registered chain still fails against the mutant.
- The ordering hold now points at open PR #837, which carries `20260914101000`..`101300` after the
  closed #832 and #793. The hold is unchanged: do not merge #800 or apply `20260921180000` until
  `20260914101300_finish_generic_field_invoice_cutover` is confirmed in the live ledger.
- `KNOWN_ISSUES.md` now names the page branch (`claude/customer-document-rep-remove-page-v3`)
  instead of saying the Documents-tab change is not written.

**CodeRabbit on `cf15887d8` (CHANGES_REQUESTED) and the Codex connector.** Fixed: every parked file
must now appear in the replay plan (the `20260914100700` exemption is gone now that `main` carries it);
each committed race in the prover restores the rep's assignment and active flag before the next, so
the deactivation race no longer runs on an already-reassigned customer; the prover reports whether
the four ordering-hold predecessors are replayed; and this entry's sequence below. Not changed here:
the stale "`20260914100900` not applied" lines in `CURRENT_STATE.md` and migration-history row 915
belong to the lane that applied it, and open PR #836 records that apply; editing them here would
conflict with it.

**Still to do.** After the hold lifts: merge `main` (so `20260914101000`..`101300` replay), re-run the
prover and confirm it reports all four hold predecessors replayed, then on that RESULTING head get
every required check green and a CodeRabbit APPROVED review. An approval on any earlier head does not
count. Only then a fresh `gpt-6-sol` review of that exact head, the apply, and the exact-head merge.

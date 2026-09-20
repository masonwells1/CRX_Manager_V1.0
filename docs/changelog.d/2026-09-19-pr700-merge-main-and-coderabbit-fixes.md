## 2026-09-19 - PR #700: integrate current main and resolve the CodeRabbit round

Merged `origin/main` (head `cd25b48f7`) into the field-invoice filed-season candidate and
resolved the actual CodeRabbit findings from the 2026-09-14 CHANGES_REQUESTED review. No
migration byte changed; all four guard migrations remain LOCAL CANDIDATES - NOT APPLIED.

### Merge reconciliation

- `.claude/schema-registry.json`: took main's PR #722 rebuild wholesale. That file is
  regenerated `--from-introspection` against live and main's copy is a strict superset of
  the branch's stale 2026-09-12 snapshot, so the branch must not overwrite live truth.
  The resolved file is byte-identical to main.
- `docs/reference/migration-history.md`: took main's restamped rows 914-923 and its row 928
  (`20260914100800_bind_transfer_invoice_intent`) unchanged, then appended this branch's four
  candidates renumbered 928-931 -> **930-933** (929 was taken by PR #726's
  `20260908140000` when it merged on 2026-09-19), which removes the row collisions main's
  #704 restamp and #726 created. Resolution is purely additive over main; no main row was rewritten.
- The four authored stamps `20260908190000`, `20260912165758`, `20260913040359` and
  `20260913152700` all sort strictly ABOVE the current effective ordering high-water
  `20260908130000_bind_create_inventory_hold_receipt_to_intent` (applied live 2026-09-15,
  ledger version `20260915033227`). **No restamp is required.** They sort below the
  merged-but-unapplied `20260914100100`..`20260914100900` set, which is deliberate.
  NOTE: the `ordering-guard: ahead-of-pending` markers this paragraph originally cited were
  REMOVED in round 2 below, after PR #726 merged; ordering is now strict and every older
  pending migration must apply first.

### Merge-induced correction (not a CodeRabbit finding)

`docs/manual/CURRENT_STATE.md` still asserted the September 14 capture and authored-name
boundary `20260908120000` as current. The live boundary moved on 2026-09-15, so after the
merge that header contradicted `migration-history.md` and would have told a later session to
number a candidate below the real high-water - the same failure mode that stranded the seven
`20260905*` candidates. Corrected to the September 17 capture and `20260908130000`, and to
main's PR #722 registry rebuild rather than the branch's September 12 regeneration.

`docs/manual/KNOWN_ISSUES.md` had the opposite problem: git auto-merged the branch's older
2026-09-13 header ABOVE main's newer 2026-09-14 ledger verification, so the first stamp in the
file went backwards and `check-doc-drift.mjs` failed its freshness gate. The top header now
carries main's 2026-09-14 ledger verification and explicitly scopes the branch's own contract
claims to their earlier 2026-09-13 read. No stamp was bumped past a verification that exists:
both headers are present in the merged file and each says what it actually covers.

### CodeRabbit findings

- **`src/pages/FieldApplicationInvoice.tsx`** - moved the `invoiceLoadRef` route/request
  invalidation out of the render body and into the existing `[id]` effect, ahead of its state
  reset. React may discard an interrupted render; a discarded render runs no effects, so the
  render-body bump could advance `route` with no load to match it. The render gate compares
  `loadedInvoice.route` against that ref, so the page could stay on "Loading invoice..."
  permanently. Writing the ref only from an effect makes a discarded render a no-op.
  Same-instance A -> B -> A navigation is unchanged and still covered by the existing
  "invoice load ownership" tests.
- **`scripts/sync-agent-workflows.test.mjs`** - replaced token-presence assertions with a
  reusable `assertAdjudicationContract()` helper that pairs a positive `require` pattern with
  `forbid` patterns per rule, so a negated or optional-ised instruction fails. Added a
  mutation suite that applies six semantic reversals to each real command source and asserts
  the helper rejects every one, plus an `assert.notEqual` per mutation so a no-op mutation
  cannot pass the guard vacuously. Verified backwards: flipping ship.md's "Do not compare
  violation keys alone" to "Compare violation keys alone" fails with
  `ship must refuse key-only allowlisting`.
- **`docs/reference/migration-history.md`** - inserted the missing blank line before the
  superseded 2026-09-08 capture paragraph so the preceding table is terminated (MD055/MD056).
- **`docs/changelog.d/2026-09-14-invoice-capture-date-references.md`** - restored the five
  run-together tokens (commit reference, both September dates, both review limits). A sweep of
  every doc this PR touches found no other instance; the remaining letter-digit hits are
  commit-SHA fragments.
- The `has_function_privilege()` role-lookup finding on
  `20260913040359_finish_generic_field_invoice_cutover.sql` was **withdrawn by CodeRabbit**
  after Mason's source adjudication on 2026-09-14. No migration byte changed.

### Observed proof

Clean full run on the merged tree after every fix: typecheck EXIT 0, lint EXIT 0,
`vitest run` 379 files / 5405 passed / 123 skipped EXIT 0, `vite build` EXIT 0,
`npm run test:agent-workflows` EXIT 0 (37 Codex adapters match their Claude sources).

Repository merge does not apply any migration or authorize a live SQL or data change.

Round 2 of the Codex exact-head review (after PR #726 merged) is recorded in
`docs/changelog.d/2026-09-20-strict-migration-ordering-after-pr726.md`.

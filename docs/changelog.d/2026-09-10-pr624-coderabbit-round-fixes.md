## 2026-09-10 — PR #624: CodeRabbit round on `852a1a3b8` (10 fixed, 1 declined)

CodeRabbit review `5168015220` requested changes at `852a1a3b8` with eight inline and three
outside-diff findings. Fixed on the branch:

- **Durable intent when IndexedDB has lost its row (Major).** Since `87f54c096`, `beginIntent`
  always offered a fresh key, and the coordinator accepted it whenever IndexedDB had no row. A
  pending localStorage mirror (IndexedDB evicted or cleared, or a legacy record) was therefore
  overwritten, and an edited retry could run a possibly committed mutation under a second key. The
  coordinator now decides a pending mirror like an authoritative pending record, but only when it
  has no row of its own: the same request keeps its original key, and a changed one is refused with
  `DURABLE_MUTATION_INTENT_CONFLICT`. A resolved row still wins, so the 2026-09-09 stale-mirror fix
  stands. `resolveIntent` now retires its own pending mirror when no row is left to resolve, so a
  known success cannot come back as unresolved. Two new regressions in
  `useUncertainMutationIntent.test.ts` failed before the change (`promise resolved "{ quantity: 6 }"
  instead of rejecting`; `expected true to be false`) and pass after it.
- **Concurrent-replay classification.** `isDefinitiveRpcRejection` now matches
  `IDEMPOTENCY_CONCURRENT_REPLAY_RETRY` as a prefix, not a substring, because the
  `IDEMPOTENCY_CROSS_OP_KEY_REUSE` message quotes the caller-controlled key. The new case fails with
  `includes` and passes with `startsWith`.
- **Hold smoke chain.** It now replays section 1's committed false-force request with
  `p_force => NULL` and requires the same `hold_id`, backing the comment that NULL fingerprints as
  false. `smoke-specs.json` lists `bind_create_inventory_hold_receipt_20260905` in `covers`, so
  `run-smoke.mjs --spec` can find the chain by the trigger name.
- **Docs.** The 2026-09-07 "cutover race OPEN" entry is marked superseded: history row 924, the
  candidate still unapplied, and the keyless-call residual kept. Row 923 became 924 in the 09-07
  merge entry and `CURRENT_STATE.md`. `CURRENT_STATE.md` no longer calls the 09-05 row the current
  high-water, no longer says row 916 is stale, and no longer says the bare-name row left the
  boundary unmoved. The fixed entry, `KNOWN_ISSUES.md` and row 924 now describe the cutover proof as
  an equivalent-path smoke plus a before/after same-key race, not a literal pause/resume test. Row
  924 and the 09-08 changelog record the prefix match.
- **Tests.** `gauntletFrontendSafetyGuards.test.ts` asserts that both slice markers exist before
  slicing. The `InventoryPage` product-identity mock keeps one scoped-key map per operation across
  renders and clears it per test.

**Declined:** sharing the IndexedDB schema between the hook and
`QuickReceivePanel.productIdentity.test.tsx` (Trivial). That test covers the recovery UI. The
precedence between IndexedDB and the mirror is pinned directly by the hook's own tests, including
the two added here.

Also merged `origin/main` at `9a648f566` (#637, `DeliveryDetail` only, no conflicts).

### Proof observed

- Full `vitest run`: 375 files, 5241 passed, 123 skipped, exit 0. `npm run typecheck` and
  `npm run lint` were clean; `npm run test:correction-guards` and `npm run check-doc-drift` passed.
- Container prover: `CREATE_INVENTORY_HOLD_INTENT_REAL_SCHEMA_PASS pre_chain=FAIL
  pre_race=1_hold_loser_errors legacy_receipt=REFUSED post_chain=PASS post_race=1_hold_loser_replays
  rerun=PASS`, with 91 post-baseline migrations replayed and the new NULL-force replay inside the
  passing chain.
- Mutation check: with the wrapper fingerprinting the raw `p_force`, and the text-level
  `POSTFLIGHT_FORCE_NORMALIZATION` check neutered so the apply proceeds, the prover failed
  `hold smoke chain failed after candidate: ... ERROR:  IDEMPOTENCY_INTENT_MISMATCH` at the new
  replay. The migration file was restored byte-identical before this commit.

No migration was applied, no production database was queried, and nothing was deployed. Applying
`20260908130000` remains a hard gate that needs Mason's explicit approval.

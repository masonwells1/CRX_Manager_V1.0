# Section 9 governed pre-apply proof

Date: 2026-07-26 (America/Chicago)
Verdict: **READY FOR SEPARATE LIVE-APPLY APPROVAL**

## Scope and safety boundary

This packet covers the prep-only gate for:

`supabase/migrations/20260722222742_section9_po_ap_high_remediation.sql`

No live migration was applied. No live data, migration-ledger row, feature flag,
permission, or Stage C state was changed. No migration-history repair or
`supabase db pull` was run. The sanctioned apply proof was deliberately not
minted because it expires after 30 minutes; it must be minted immediately before
an explicitly approved live apply.

## Exact candidate

| Item | Exact value |
|---|---|
| Reviewed repository SHA | `ed2c2d42d10f5e5ad218a1e807c68657b8e00149` |
| Base SHA | `f0aba859ca3b86e243be5a763f869b8910e173ac` |
| `origin/main` | `f0aba859ca3b86e243be5a763f869b8910e173ac` |
| Correction commit | `10e6850a7524a243a2a9d2c15e2a43e4fca1ae44` |
| Proof-binding commit | `ed2c2d42d10f5e5ad218a1e807c68657b8e00149` |
| Migration git blob | `d56b84e964400ac95b2da367baf208de6b336af9` |
| Migration SHA-256 | `E180B15765E6ABA23DBF780B06E6FAF99D1362FC2AD6AAD2C85A3B7186BC0032` |
| Live PostgreSQL | `17.6` |

The migration differs from the PR #218 bytes only by the reviewed vendor-row
lock described below.

## Live ledger and drift

The linked live ledger tail is:

| Version | Local | Remote |
|---|---:|---:|
| `20260722202622` | yes | yes |
| `20260722222742` | yes | no |
| `20260723193312` | yes | yes |

Section 9 is therefore pending even though a later migration is live.

The drift review found no overwrite collision with
`20260723193312_product_families_return_policy_foundation.sql`. All nine
existing target RPCs have one overload, the expected signature and return
contract, `SECURITY DEFINER`, owner `postgres`,
`search_path=public, pg_temp`, authenticated/service-role execution, and no
anonymous execution. The private Section 9 implementation functions and new
triggers are absent live, as expected before apply.

Current live PO on-order equality is clean:

- mismatch count: `0`
- stored Main Warehouse total: `14,715.0`
- authoritative open-PO total: `14,715.0`
- open POs: `10`

## Prep proof completed

| Proof | Result |
|---|---|
| `npm run test -- src/lib/section9PoApRemediation.test.ts src/lib/rpcContracts.test.ts --run` | PASS — 2 files, 88 tests |
| `npm run typecheck` | PASS |
| `node scripts/smoke/prove-section9-po-ap-concurrency.mjs` | PASS — `SECTION9_PO_AP_CONCURRENCY_PASS` |
| Exact migration plus registered full smoke in one forced-rollback live transaction | PASS — `SMOKE_PASS_ROLLBACK` |
| 29 function, trigger, vendor-policy, and vendor-grant fingerprints before/after the rollback transaction | PASS — identical; no live residue |
| Fresh current-state invariant sweep | COMPLETE — all 18 predicates executed |
| Full commit gate at exact reviewed SHA | PASS — 302 test files, 3,985 passed, 118 skipped; typecheck, build, SQL checks, guards, schema baseline, docs, and dependency checks passed |

Do not cite `SECTION9_SWEEP_PASS_ROLLBACK`: that marker was not run. The
accepted proof is the separate full 18-predicate current-state sweep.

## Full 18-predicate pre-apply sweep

The runner discovered and executed these 18 checked-in predicates:

1. `actor-forgery-fin-audit`
2. `actor-forgery`
3. `anon-exec-secdef`
4. `auth-bound-role-ungated`
5. `commission-admin-active`
6. `fin-allocations-bounded`
7. `fin-ar-statement-balance`
8. `fin-commission-split-sum`
9. `fin-invoice-balance-identity`
10. `fin-prepay-balance`
11. `fin-quote-override-survival`
12. `overloads`
13. `plpgsql-check`
14. `returns-lifecycle-rpc-owned`
15. `secdef-searchpath`
16. `section9-po-ap-controls`
17. `status-literals`
18. `ungated-secdef-mutators`

Seventeen predicates returned zero unallowlisted findings.
`section9-po-ap-controls` returned exactly the five expected pre-apply
findings:

1. `vendors:browser-mutation-privilege`
2. `vendors:browser-mutation-policy`
3. `create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text)`
4. `get_ap_aging(date)`
5. `update_vendor_bill(uuid,bigint,bigint,date,date,text,text)`

There was no inventory on-order mismatch finding and no outstanding active bill
attached to a soft-deleted vendor. `plpgsql-check` separately returned zero
rows.

## Dry-run history gate

`supabase db push --linked --dry-run` stopped before considering Section 9:

> Remote migration versions not found in local migrations directory.

The CLI printed a long historical list of remote-only versions and suggested
history repair or `db pull`. Neither action was taken. This is a pre-existing
repository/ledger tooling divergence, not authority to rewrite history. If the
candidate is eventually accepted, it must use the governed
server-assigned-version apply flow; it must not backfill the skipped
`20260722222742` ledger version or use ordinary `db push`.

## Corrected finding

The fresh independent security review found a financial-correctness race:

1. `create_vendor_bill` reads the active vendor without a row lock at migration
   lines 370–373.
2. Concurrent `delete_vendor` locks the vendor, sees zero unpaid bills, and
   soft-deletes it at
   `20260510120000_vendor_master_data_rpcs.sql` lines 151–173.
3. The bill creator then inserts an unpaid bill at migration lines 473–505.
   The foreign key succeeds because soft deletion preserves the vendor row.
4. `get_ap_aging` excludes the deleted vendor at migration lines 613–620, so
   the payable can disappear from AP aging.

A separate, network-isolated PostgreSQL 17 two-session proof reproduced the
bad state:

`VULNERABLE_RACE_REPRODUCED=1|1`

The two values mean `vendor is soft-deleted | one unpaid bill exists`.

The correction adds `FOR UPDATE` to the creator's active-vendor lookup. The
delete then waits for bill creation and rejects after seeing the unpaid bill:

`FOR_UPDATE_SERIALIZES=1|1`
`SECTION9_VENDOR_DELETE_RACE_PROOF_PASS`

The disposable container used `--network none` and tmpfs storage and was
removed after the proof. No live data was involved.

## Correction and durable proof

The corrected candidate now:

1. Locks the active vendor row before locking the purchase order and inserting
   the bill.
2. Proves create-versus-delete in both winning orders with marker-bound,
   two-session PostgreSQL 17 races.
3. Mechanically binds that disposable proof to the checked-in production
   `delete_vendor` source: active-vendor row lock, outstanding-bill definition,
   and soft-delete statement.
4. Asserts lock ordering in the focused contract suite.
5. Rejects outstanding active bills whose vendor is soft-deleted in the
   Section 9 invariant.
6. Registers the expanded concurrency semantics in the smoke contract.

The first independent exact-SHA Sol review accepted correction SHA
`10e6850a7524a243a2a9d2c15e2a43e4fca1ae44` and identified one non-blocking
hardening opportunity: mechanically bind the disposable `delete_vendor` proof
to the production source. Commit
`ed2c2d42d10f5e5ad218a1e807c68657b8e00149` closes that gap and reran the full
commit pipeline.

The required fresh independent Sol adversarial review then inspected exact SHA
`ed2c2d42d10f5e5ad218a1e807c68657b8e00149` against base
`f0aba859ca3b86e243be5a763f869b8910e173ac` and returned **ACCEPT** with no
blocking findings. The reviewer independently reran the focused contract test
(`6/6`) and disposable PostgreSQL concurrency harness
(`SECTION9_PO_AP_CONCURRENCY_PASS`), confirmed the worktree remained at the
reviewed SHA, and specifically confirmed:

- the active-vendor lock precedes PO validation and bill insertion;
- it serializes correctly with both `delete_vendor` and `save_vendor`;
- both winning-order create-versus-delete proofs assert the correct terminal
  database state;
- the harness now binds its disposable proof to the production vendor lock,
  unpaid-bill predicate, and soft-delete statement;
- the invariant covers every outstanding status and excludes only paid or
  voided historical bills; and
- no live apply, ledger write, or deployment mechanism was introduced.

## Apply boundary

This packet proves readiness to ask for approval; it is not live-apply
authorization. After Mason explicitly approves the live apply, the governed
session must:

1. Recheck the exact SHA and migration blob.
2. Mint the short-lived migration-apply proof.
3. Apply through the sanctioned server-assigned-version flow, without ledger
   repair or backfilling `20260722222742`.
4. Run the mandatory post-apply all-18 predicate sweep, target-lock checks,
   B7 rename/ledger reconciliation checks, and required registry/type/docs
   refresh.
5. Park and report immediately if any apply or post-apply gate fails.

Vendor rename after a bill has already been created is older legacy debt
because purchase orders store vendor name as text. The proposed row lock closes
the concurrent rename window during bill creation; it does not silently widen
this correction into a vendor/PO schema redesign.

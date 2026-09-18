## 2026-09-15 — create_inventory_hold receipt binding applied live (migration 20260908130000)

**What changed.** Migration `supabase/migrations/20260908130000_bind_create_inventory_hold_receipt_to_intent.sql`,
merged to main as PR #691 (`49727803d`, blob `bba9cafa`), was applied to production project
`rhyzpcqhnizqbxphqdkr` at 2026-09-15 03:32Z. Its ledger version is `20260915033227`, and the ledger has
1002 rows after the apply. Mason approved the apply in the crx-commission-migration-order session.

The apply waited for PR #704 (main `a4cd83670`), which restamped the seven stranded `20260905*`
migrations to `20260914100100`..`20260914100900`. Before that, the pending-set guard refused this file
because those older files were still unapplied.

**Gates observed.**
- A fresh `gpt-5.6-sol`/high apply proof (rls-security and migration-drift charters) was CLEAN at
  03:32:08Z.
- The `scripts/apply-migration-file.mjs` dry run printed `APPLY GATE PASSED`, with queryHash
  `3cd624cc0a0e86332fc923ae43347b915801b23ddb43be4f5bb4eb2ff8fcff71` over 47,587 bytes.
- The confirmed run returned `APPLY OK — HTTP 201` and refreshed the applied-migration snapshot to 1002
  names.

**Post-apply read-only verification.**
- The ledger row is present under that version.
- `create_inventory_hold` is SECURITY DEFINER with `search_path=public, pg_temp`, and EXECUTE is held by
  `authenticated` and not by `anon`.
- `_create_inventory_hold_intent_impl_20260905` is SECURITY DEFINER and executable by neither `anon` nor
  `authenticated`.
- The `_guard_create_inventory_hold_insert_20260913` and `_bind_create_inventory_hold_receipt_20260905`
  helper functions exist with no client EXECUTE.
- Trigger `guard_create_inventory_hold_insert_20260913` is enabled on `inventory_holds`.

**Exposure look-back, run 2026-09-15 (it was due by 2026-09-18).** This follows Mason's 2026-09-14
decision. The apply landed before the due date, so the pre-apply check was skipped and this read-only
check ran right after the apply, on 2026-09-15. All 29
`inventory_holds` rows ever created were made by an admin whose profile is active. 20 are manual holds
from 2026-03-14 and 2026-03-15, all released. 9 are crop_program holds from 2026-04-28, all active. No
hold has been created since 2026-04-28.

Neither closed defect was exercised. The first was a NULL `p_force` skipping the admin and free-stock
checks, which only matters for a non-admin. The second was holds from a missing or inactive profile. The
"active" reading is the profile's current state, not its state at hold time, but every creator is an
admin who is active today.

**Docs.** The following now record the apply:
- `docs/reference/migration-history.md`: row 927 and the current-boundary capture.
- `docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md`.
- `docs/reference/rpc-functions.md` and `docs/workflows/INVENTORY_RULES.md`.

The SQL file's own `NOT APPLIED` header was not edited, because applied migrations are immutable.

**Not verified here.** No live hold was created to exercise the new wrapper end to end; that would change
real inventory data. Behavioural proof is the isolated real-schema prover
`scripts/smoke/prove-create-inventory-hold-intent-binding-real-schema.mjs`, re-run on main `a4cd83670`
after the apply. It printed `CREATE_INVENTORY_HOLD_INTENT_REAL_SCHEMA_PASS`, with
`keyless_cutover=BLOCKED`, `post_chain=PASS`, `post_race=1_hold_loser_replays`, `rerun=PASS`, and all five
drift mutations `REFUSED`.
`20260911120000_bind_adjust_inventory_receipt_to_intent` (#664) is still unapplied. It sorts below the
seven restamped files, so it must apply before them.

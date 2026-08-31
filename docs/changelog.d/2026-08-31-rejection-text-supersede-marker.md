## 2026-08-31 — mark where the pre-decision text ends in migration-history row 900

The 2026-08-31 rejection of the global ledger-order trigger was prepended to `migration-history.md`
row 900, but the original description still ended "the migration remains absent from production until
its own reviewed rollout". That implied a pending rollout and contradicted the rejection recorded in
the same row.

The row now states explicitly where the pre-decision historical text ends, and that the
"until its own reviewed rollout" framing is superseded by the rejection at the top of the row: there
is no pending rollout, and the three reconsideration prerequisites listed there are the only route
back.

Found by CodeRabbit on PR #525 (Minor). `npm run check:docs` passes — migrations indexed 898/898,
history sequence 900/900.

Documentation only. No code, migration, database, money, inventory, RLS, or customer-visible change.

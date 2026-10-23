## 2026-10-23 - Recorded: Team Board priority order and recap time fixes (row 979 live)

- Migration `20261022086000_team_board_priority_and_recap_completed_at` (migration-history row 979, PR #1066,
  merged as `55b01bae3`) was applied live 2026-10-23 17:05:37 UTC (12:05 PM Central), ledger version
  `20261023170537`, through the migration-apply guard under the autonomous-landing rule.
- Read-only live check 17:06 UTC: `get_team_board_deliveries` and `get_yesterday_delivery_recap` bodies equal
  the postflight md5 pins, with SECURITY DEFINER, owner, search_path and ACL unchanged, and both return their
  usual shape for an active admin. The full ledger is 1055 rows; the effective ordering high-water is
  `20261022086000`.
- Row 979 in `migration-history.md` (the 17:46 UTC live capture from PR #1050 already covers this ledger), the `CURRENT_STATE.md` ledger header and
  `rpc-functions.md` now reflect live. No registry change: the migration changes two function bodies only.

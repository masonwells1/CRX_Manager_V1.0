## 2026-09-13 — PR #624: current with #647, delivered through a fresh PR

Source-only. Migration `20260908130000` is still NOT applied.

- **Current with main.** #624's branch now includes main `6c128a79a` (#647, the repaired CodeRabbit
  native review route), as merge `b36de2ad8`. The merge touched none of this change's files.
  - 56/56 focused tests pass across the shared durable-intent hook and all its consumers
    (InventoryPage, QuickReceivePanel, ReceivingHubPanel, NewVendorBill).
  - `check-doc-drift`, typecheck and build pass.
  - All required CI checks are green on `b36de2ad8`.
- **Why a fresh delivery PR.** The repaired route records a PR's head and base when the PR is opened, so it
  can only deliver a review to a PR opened after that capture existed
  (`docs/reference/coderabbit-native-review.md`). #624 predates #647. The same change is
  therefore delivered through a fresh PR, and #624 stays open with its history and findings preserved.
- **The CodeRabbit finding on #624** (review 5186763520, COMMENTED, outside the diff): an expired uncertain
  request keeps its dialog locked, with no in-app way to clear it. It was verified against the source and
  is accurate.
  - It is pre-existing on main for receiving and vendor bills; this change adds Hold and Adjust.
  - It is deferred, not fixed here. The reviewer's own constraint means the fix needs authoritative
    confirmation of whether the request committed, which is a separate admin recovery control.
  - The disposition is recorded on #624. It is tracked as the OPEN 2026-09-11 KNOWN_ISSUES entry; staff follow
    the INVENTORY_RULES "Staff recovery" steps until then.
- **Mason's decision (2026-09-13):** land the source-only fix on a real final-head CodeRabbit review,
  without building the recovery control first.
- **Collision note.** Two sessions merged the same main commit onto #624 within seconds. The duplicate
  push was rejected as non-fast-forward, and the two merges were content-identical. Nothing was forced.

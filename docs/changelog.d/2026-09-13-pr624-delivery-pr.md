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
- **CodeRabbit round on delivery PR #666** (review 5191138201, CHANGES_REQUESTED on `492331008`).
  Two findings, both verified and fixed:
  - Row 927 in `docs/reference/migration-history.md` still said "Row numbered 924 matches ... latest entry 924",
    left over from the 924 -> 927 renumber. It now says 927.
  - `stageSql` in the real-schema prover threw from its `finally` block, so a temp-file cleanup failure
    could hide the staging error that caused it. Cleanup errors are now logged when staging already failed,
    and rethrown only when cleanup is the sole failure.
  The fix changes the head, so under the #647 rules it is delivered through another fresh PR.
  #666 stays open and preserved.
- **CodeRabbit round on delivery PR #670** (review 5191350534, CHANGES_REQUESTED on `80531fb64`).
  Three findings, all verified and fixed:
  - **A reloaded hold opened with empty pickers.** The recovery effect in `InventoryPage.tsx` opened a
    reloaded hold without loading products or customers, so the frozen request showed as blanks next to an
    enabled Retry. The pickers now load whenever the hold dialog opens, however it was opened (a holdOpen effect; `fetchProducts`/`fetchCustomers` became `useCallback`), so the admin-override retry timing is unchanged.
    - A new rendered-page test reloads the page mid-hold and requires both lists to load and the frozen
      product to be named.
  - **The wrapper pin was never checked against the wrapper body.** A new test proves the LF-normalized
    sha256 of the wrapper body equals `v_wrapper_pin`.
    - It is deliberately separate from `hasIntentBindingContract`: a hash inside the contract would make
      every clause-deletion mutation test fail for the hash instead of for its own clause.
  - **The hold retry tests could pass with no key.** The ordinary and forced tests now require a real
    non-empty key before comparing keys.
  The fixes change the head, so they are delivered through another fresh PR. #666 and #670 stay open.

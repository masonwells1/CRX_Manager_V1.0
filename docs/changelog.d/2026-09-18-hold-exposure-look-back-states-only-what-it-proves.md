## 2026-09-18 — the hold exposure look-back now claims only what it proves, and the hold insert barrier is marked applied

CodeRabbit raised two findings on PR #716 (commit `ed017afc7`). Both checked out against the source and both are fixed.

- **The look-back overclaimed.** Four records said the 29 live holds showed that neither
  `create_inventory_hold` defect was ever exercised: `CURRENT_STATE.md`, `KNOWN_ISSUES.md`, the
  2026-09-15 changelog, and migration-history row 927. The look-back cannot show that. The old body
  (`20260630173022`) tested `IF p_force` and `AND NOT p_force`, so a NULL `p_force` skipped the
  free-stock check even for an admin. `p_force` is not stored on the hold, so the data cannot say
  whether that happened. Profile state was also read as of today, not as of each hold's creation. The
  records now state what is known:
  - all 29 creators are active admins today;
  - the `created_by` foreign key rules out a hold with a missing profile;
  - neither defect path can be ruled out.
  Row 927 also carried the future "2026-09-18" date. It now says the look-back was due by 2026-09-18
  and ran on 2026-09-15.
- **`rpc-functions.md` called the hold insert barrier "pending".** `_guard_create_inventory_hold_insert_20260913`
  and its trigger are part of `20260908130000_bind_create_inventory_hold_receipt_to_intent.sql`, which
  applied live on 2026-09-15. The entry now says it is applied.

Documentation only. No live database change.

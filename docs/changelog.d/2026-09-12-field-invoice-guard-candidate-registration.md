## 2026-09-12 - Field-invoice guard candidate registration correction

Corrected-head product CI rejected the new generic field-invoice creation migration as
an UNKNOWN parked candidate. The history detail named the file but its nonnumeric
"Local follow-up" row was outside the canonical LOCAL CANDIDATE parser. Register the
unchanged SQL as numbered row 928 with its actual SHA-256 pin; keep NOT APPLIED explicit.
Add the migration's LF checkout pin so its live/body fingerprints survive Windows checkout.

The existing correction guard reads the Git index, not untracked work. Its earlier local
pass ran before staging the new migration and did not certify the eventual commit.
Rerun against the corrected staged index and committed candidate; retain the original
UNKNOWN failure as evidence. Improve that assertion's diagnostic with the actual reason,
without changing its acceptance predicate, registry parser or any safety policy.

No SQL body, function contract, grant, business behavior, live state or review policy changes.
Fresh frozen whole-branch proof and corrected-head CI remain required after this fix.

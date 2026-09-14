## 2026-09-13 - Compare returned hold receipts in the disposable database race

The inventory real-schema prover now sets both authentication claims without
printing their values and labels each returned hold ID. Its race comparison
accepts only the labeled receipt output, so an administrator UUID or an absent
receipt cannot satisfy the proof. This corrects the valid CodeRabbit finding on
PR #667 without changing application or migration behavior.

The earlier migration-history reference now points to row 927. The September 7
rollout note explicitly marks its older exposure requirement as historical and
preserves the current distinction: the browser fix may ship, while the database
migration remains parked pending separate live-apply approval.

Verification observed: the full network-disabled PostgreSQL 17 prover replayed
93 earlier migrations, reproduced the old losing-call error, refused the
candidate while a legacy receipt existed, then passed the rolled-back smoke
chain and the corrected race: one hold, one receipt, both returned hold IDs
equal, and the receipt bound to the administrator. Candidate reapplication
also passed. A focused check of the actual race function rejected actor-only
and absent receipt output and selected labeled IDs with LF and CRLF output.
No live database migration or data change was performed.

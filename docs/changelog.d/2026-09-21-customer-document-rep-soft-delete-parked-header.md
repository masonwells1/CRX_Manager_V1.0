## 2026-09-21 - soft_delete_customer_document: recognizable parked header

PR #765 CI failed `test:correction-guards` on both Linux and Windows. The parked-migration
cross-reference could not recognize the candidate's status line
(`STATUS: NOT APPLIED — PARKED CANDIDATE`) as a parked marker, so its LOCAL CANDIDATE history row
had no matching file. The line now reads `STATUS: PARKED / NOT APPLIED — DO NOT APPLY without
Mason's explicit in-chat approval`. The change is to the comment only; the SQL is unchanged.

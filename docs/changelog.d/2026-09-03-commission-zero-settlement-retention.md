## 2026-09-03 - Preserve zero-dollar settlement history

- The commission-history candidate now retains a signed `$0.00` settlement in the aggregate report
  after its source commission is later deleted or otherwise becomes unearned.
- The PostgreSQL smoke proof covers post, soft-delete, aggregate/detail reporting, restore, and void
  so zero-dollar paid counts cannot silently disappear or survive a reversal.

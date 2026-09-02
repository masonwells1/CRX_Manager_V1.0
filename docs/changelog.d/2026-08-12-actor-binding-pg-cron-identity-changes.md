## 2026-08-12 — Actor-binding guard rejects pg_cron identity changes

The fresh repair cycle reproduced all three exact-head review bypasses: a migration could temporarily
rename `cron.job`, move it to another schema, or rename its `command` column, write delayed unbound
actor-function SQL through the temporary identity, and then restore the canonical name. The guard now
fails closed on those identity changes themselves, including quoted, search-path-resolved, directly
executed, and Unicode-opaque spellings, while leaving unrelated table renames, non-command column
renames, and documentation text allowed.

The real hook returned DENY for all three exploit packets and ALLOW for both safe controls. Nine
independent clause mutations each reopened their matching bypass before restoration; the restored
actor-binding suite passed 345 assertions. All 36 August migration files passed the repaired reader
with zero denials and zero internal errors. The six Wave A migrations remain parked and unapplied.


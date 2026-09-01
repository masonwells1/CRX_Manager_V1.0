## 2026-08-31 - Defer return-credit migration rollout

Recorded Mason's decision to leave the ordered six-file return-credit migration chain
`20260827041000` through `20260827041500` unapplied for now. The reviewed source files remain
unchanged under `supabase/migrations/` as repository candidates; merging this documentation does
not apply them to production.

A future production rollout must be separately authorized and rerun the migration safety gates in
force at that time. If a newer migration has overtaken this chain's timestamps, restamp all six
files above the then-current high-water, update every pinned chain reference/hash, and re-review the
restamped artifacts before pushing/applying all six in order through the governed migration channel.
No live database write or migration apply was performed by this change.

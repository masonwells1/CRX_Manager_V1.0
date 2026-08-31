## 2026-08-31 - Defer return-credit migration rollout

Recorded Mason's decision to keep the ordered six-file return-credit migration chain
`20260827041000` through `20260827041500` unapplied for now. A future live rollout requires
fresh explicit authorization and the migration safety gates in force at that time.

Moved the six unchanged SQL sources from `supabase/migrations/` to `scripts/.staging-migrations/`
so a broad Supabase migration push cannot apply the deferred chain accidentally. The disposable
real-schema verifier and focused migration contract test now read the staged sources.

The rejected `20260827223000` global ledger-order trigger is not part of the deferred queue.

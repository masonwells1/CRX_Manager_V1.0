## 2026-09-26 - autonomous landing: a replaced function keeps its earlier access

**Sol HIGH, round 10 on PR #804 (second of two).** The access classifier counted every
`CREATE OR REPLACE` function or view as created by the migration, so "replace an internal helper,
then `GRANT EXECUTE ... TO authenticated`" passed as routine even when that helper had been locked
away from logged-in users.

`.claude/hooks/migration-access-lib.mjs` now rebuilds each replaced object's access as of just
before the migration, from the earlier files in `supabase/migrations/`: it starts from Supabase's
default grants (read from live `pg_default_acl` on 2026-09-26), then applies every GRANT/REVOKE,
schema-wide grant, DROP, rename and grant hidden in dynamic SQL, in file order. The migration waits
for Mason if any role (counting access through PUBLIC) ends it with access it did not have before.
That also catches a DROP + CREATE that forgets to lock a function down again, which would hand it
back to PUBLIC. Anything the history cannot settle counts as unknown and waits: no history (the
daily summary), two overloads with the same argument count, a rename into the name, an unmodelled
`ALTER DEFAULT PRIVILEGES`, a `DROP ... CASCADE` before the replace. `migration-apply-lib.mjs`
passes the history from the migration file's own directory; only files that name the object are
parsed, and the slowest real run took 224 ms against the hook's 15-second budget.

**Measured:** over the last 60 real migrations, still 38 routine, 10 destructive and 12 access
changes. Against the real history, replacing `_create_commission_payment_intent_impl_20260809`
(locked to `postgres` in 20260811130000) and granting it to `authenticated` waits for Mason, and so
does dropping and re-creating it without a lock-down; the same replace re-granting only `postgres`,
and the house pattern on the public `create_commission_payment`, stay routine. Tests: 79 assertions
in `migration-access-lib.test.mjs` (was 53).

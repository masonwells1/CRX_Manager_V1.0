# CRX clean-rebuild schema baseline

This directory is the supported way to initialize a **new** Supabase project at
the production schema high-water recorded in `manifest.json`. The older files in
`supabase/migrations/` remain the immutable audit trail, but they are not a safe
from-zero rebuild path: some historical files intentionally bind to production
data or to byte-exact function bodies that include legacy line endings.

The baseline contains no CRX business rows. It contains schema, grants, RLS
policies, functions, triggers, Storage bucket definitions, and a compact
version/name migration ledger. `npm run test:schema-baseline` checks every
artifact hash, count, high-water, empty-ledger guard, and credential scan.
The public schema dump intentionally retains mixed line endings embedded in a
small set of legacy function bodies; `.gitattributes` stores that file byte for
byte so content-bound guards remain identical on every operating system.

## Restore a new project

Use a platform-initialized Supabase PostgreSQL 17 project. Apply these files in
the exact `manifest.json.restore_order` sequence with a fail-fast SQL client:

1. `*_extensions.sql`
2. `*_public_schema.sql`
3. `*_platform_overlay.sql`
4. `*_cron_jobs.sql`
5. `*_migration_history.sql`

The platform overlay restores the CRX-owned `auth.users` profile trigger, all
CRX Storage policies, and bucket configuration after the public functions and
tables they reference exist. The history restore refuses a non-empty
`supabase_migrations.schema_migrations` table; never clear a real ledger merely
to make it run.
The cron restore similarly refuses any existing job with one of the eight CRX
job names, then verifies each schedule and command exactly.

After the restore, apply only migration files whose version is strictly greater
than the baseline high-water. Then regenerate `.claude/schema-registry.json`
from that database and run the normal schema/live tests and DB invariant sweeps.

## Data recovery

This is a schema baseline, not a business-data backup. For disaster recovery,
restore the separately protected Supabase data backup using the official
backup/restore procedure, then run row-count and financial/inventory invariant
checks before allowing writes. Do not load production data into an ordinary
development or preview project.

## Refreshing the baseline

Refresh only from reviewed live introspection after the migration ledger has
settled. Regenerate the public dump, platform overlay, bucket snapshot, and
compact ledger together; update the manifest hashes/counts; prove a disposable
PostgreSQL 17 restore; require the history file's second application to fail;
and run `npm run test:schema-baseline`. Never edit an applied migration to make a
fresh rebuild pass.

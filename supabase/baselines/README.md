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
The public schema dump is stored as `*_public_schema.sql.br` using Brotli. Its
manifest entry binds both the compressed artifact and the exact decompressed SQL
bytes. The decoded dump intentionally retains mixed line endings embedded in a
small set of legacy function bodies, so content-bound guards remain identical on
every operating system.

## Restore a new project

Use a platform-initialized Supabase PostgreSQL 17 project. Apply these files in
the exact `manifest.json.restore_order` sequence with a fail-fast SQL client:

1. `*_extensions.sql`
2. `*_public_schema.sql.br`, streamed through the repository decoder
3. `*_acl_lockdown.sql`
4. `*_platform_overlay.sql`
5. `*_cron_jobs.sql`
6. `*_migration_history.sql`

For step 2, run the decoder from the repository root and pipe its binary-safe
stdout directly to the fail-fast SQL client:

```bash
node scripts/decompress-schema-baseline.mjs | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
```

The decoder refuses to emit SQL unless both the compressed and decompressed
manifest hashes match.

The first artifact creates the production-specific `metabase_ro` NOLOGIN role
when it is absent, before the decoded schema restores grants to that role. Run
the restore as the project owner so role creation is permitted. Every artifact
must use `ON_ERROR_STOP=1`; do not continue from a partially restored project.

Step 3 is the ACL lockdown, and it is a security control, not bookkeeping. A
schema dump can only `GRANT`. A new Supabase project ships `ALTER DEFAULT
PRIVILEGES` that hand `anon` — the unauthenticated role — full CRUD on every table
and `EXECUTE` on every function `postgres` creates, and `REVOKE ... FROM PUBLIC`
does **not** strip a role-specific grant. Restoring the schema alone therefore
leaves `anon` holding privileges production revoked, and leaves default privileges
that would re-grant them to every future migration. The lockdown revokes the
Supabase-managed roles down to nothing, re-applies production's exact grants, and
restores production's default privileges.

Those grants include **column-level** ones, and they are not optional. `REVOKE ALL ON
ALL TABLES` strips column privileges along with table ones, so the reset removes them
and only the capture puts them back. Production gives `authenticated` no table-level
`INSERT` or `UPDATE` on `public.products`; 27 column grants are its entire write path,
and a baseline that omits them restores a project where nobody can edit a Product.
Granting the table instead would fix the app and widen access in the same stroke — do
not do that. The `column_acl` fingerprint exists to catch exactly this.

The lockdown ends with two guards.
`BASELINE_ACL_ANON_OVER_GRANTED` fires if `anon` still holds anything beyond
`SELECT`/`MAINTAIN` on a table — counting privileges granted to `PUBLIC`, because
`anon` inherits those. `BASELINE_ACL_ANON_EXECUTE_DRIFTED` fires if `anon` holds
`EXECUTE` on anything other than the exact set of functions captured. Functions
cannot be guarded the way tables are: production legitimately grants `anon`
`EXECUTE` on part of the schema — that is the PostgREST `/rpc/` surface — so
"`anon` holds no `EXECUTE`" would reject live's own state. The guard therefore
embeds the captured function identities and compares the **set**, in both
directions, folding `PUBLIC`-granted `EXECUTE` in because `anon` inherits it. A
count would not do: a refreshed capture that swapped one RPC for a different,
more sensitive one leaves the total untouched while moving what an
unauthenticated caller can reach. Restoring the public
schema alone leaves `anon` holding `EXECUTE` on **all 527** non-extension public
functions; the lockdown cuts that to the **95** production grants. Extension-owned
functions are excluded throughout: they belong to `supabase_admin`, the project
owner cannot revoke them, and the baseline does not manage them. The lockdown is
idempotent and safe to re-run.

The platform overlay restores the CRX-owned `auth.users` profile trigger, all
CRX Storage policies, and bucket configuration after the public functions and
tables they reference exist. It is **not** re-appliable, and says so: it drops only
the policy names live holds today, so applying it over an older baseline's policies
would leave those retired names in force, and policies are OR'ed — a retired
unscoped policy surviving beside its scoped replacement silently widens access. A
second apply raises `BASELINE_PLATFORM_RESTORE_REQUIRES_ABSENT_BUCKETS`. The
history restore refuses a non-empty
`supabase_migrations.schema_migrations` table; never clear a real ledger merely
to make it run.
The cron restore similarly refuses any existing job with one of the eight CRX
job names, then verifies each schedule and command exactly.

After the restore, do **not** select pending migrations by filename timestamp
alone. Supabase assigns its own ledger version when a migration is applied through
the Management API, so filename timestamps and ledger versions are not in 1:1
correspondence across this repository's history. Generate the exact post-baseline
list from both version and captured name:

```bash
node scripts/list-post-baseline-migrations.mjs
```

Do not execute those files directly with `psql`: that changes the schema without
recording the migrations in `supabase_migrations.schema_migrations`. Instead,
copy only the emitted files into an isolated Supabase CLI workdir, inspect the
ledger-aware dry run, and then push that exact filtered set:

```bash
post_baseline_dir="$(mktemp -d)"
supabase --workdir "$post_baseline_dir" init
mkdir -p "$post_baseline_dir/supabase/migrations"
while IFS= read -r migration; do
  cp "$migration" "$post_baseline_dir/supabase/migrations/"
done < <(node scripts/list-post-baseline-migrations.mjs)

supabase --workdir "$post_baseline_dir" db push \
  --db-url "$DATABASE_URL" --include-all --dry-run
supabase --workdir "$post_baseline_dir" db push \
  --db-url "$DATABASE_URL" --include-all
rm -rf "$post_baseline_dir"
```

The temporary workdir is mandatory: never run an unfiltered `supabase db push`
from the CRX repository against a restored baseline. The CLI push both applies
each migration and records its filename version/name in the target ledger. If
the dry run lists anything other than the selector output, stop. After the push,
inspect `supabase migration list --db-url "$DATABASE_URL"`, regenerate
`.claude/schema-registry.json` from that database, and run the normal schema/live
tests and DB invariant sweeps.

## Data recovery

This is a schema baseline, not a business-data backup. For disaster recovery,
restore the separately protected Supabase data backup using the official
backup/restore procedure, then run row-count and financial/inventory invariant
checks before allowing writes. Do not load production data into an ordinary
development or preview project.

## Refreshing the baseline

Refresh only from reviewed live introspection after the migration ledger has
settled. **Never edit an applied migration to make a fresh rebuild pass.**

All capture is read-only against production. Capture into a scratch work
directory, then assemble; keeping the two steps apart is what makes the assembly
deterministic and reviewable.

1. **Public schema** — raw `pg_dump --schema=public --schema-only
   --quote-all-identifiers --no-owner`, normalized by
   `scripts/build-schema-baseline-public.mjs` into `public_schema.sql`. Do not use
   `supabase db dump` here: it post-processes the dump and strips `--` comment
   lines out of function bodies, which silently changes the source of every
   function that carries an inline comment.
2. **ACL lockdown** — `psql -At -f scripts/schema-baseline-acl.sql` against live,
   piped to `scripts/build-schema-baseline-acl.mjs`. That SQL emits one `GRANT`
   per (object, grantee) plus production's `ALTER DEFAULT PRIVILEGES`, in a
   deterministic order, for `anon`, `authenticated`, `service_role`,
   `metabase_ro`, and `PUBLIC`. Table, column, routine, and default-privilege
   grants are each split by `is_grantable` so a `WITH GRANT OPTION` is reproduced
   rather than flattened into a plain grant. Production holds none today, so this
   changes no output — which is the point: the capture must not be the reason a
   future one is lost.
3. **Platform overlay, bucket snapshot, and compact ledger** — as before, via
   `scripts/build-schema-baseline-platform.mjs` and
   `scripts/build-schema-baseline-history.mjs`.
4. **Fingerprints** — `psql -At -F'=' -f scripts/schema-baseline-fingerprints.sql`
   against live into `live_fingerprints.txt`. The manifest binds this file's own
   SHA-256, so redefining what "matches production" means fails the gate.

Then prove it. Restore the artifacts in `restore_order` into a throwaway
PostgreSQL 17 container (`public.ecr.aws/supabase/postgres`), and require **all
twelve fingerprints to match live**, not just the counts. Two of them exist because
the obvious eight missed real drift: `column_acl` covers production's column-level
grants, which `relations_and_acl` cannot see because it records only table-level
`relacl`, and `view_definitions` covers each view's query and `reloptions`, without
which a view could lose `security_invoker` and start running with owner privileges
while every other digest stayed identical. Five of the twelve also carry fields the
obvious definition omits, all for one reason — a catalog's rendered text describes what an
object *is*, not whether it is *in force*:

| Digest | Extra fields | What is otherwise invisible |
| --- | --- | --- |
| `columns` | `attidentity`, `attgenerated` | identity/generated semantics live in `pg_attribute`, not in type/not-null/default |
| `indexes` | `indisvalid` | a failed `CREATE INDEX CONCURRENTLY` renders the same definition and enforces no UNIQUE constraint |
| `relations_and_acl` | `relforcerowsecurity`, `relpersistence` | RLS enabled without FORCE still lets the owner bypass every policy; an `UNLOGGED` table loses its rows on crash |
| `triggers` | `tgenabled` | a disabled or `REPLICA`-mode trigger describes itself identically and fires for nothing |
| `function_security` | `pg_get_function_arguments`, `pg_get_function_result`, `prokind`, `proisstrict`, `proleakproof` | the identity form drops argument defaults and never mentions the result type; strictness, `CALL`-vs-`SELECT`, and leakproofness (which lets the planner push a function below an RLS predicate) are all out-of-body behavior |
| `cron_contracts` | `active`, `username` | a deactivated job, or one running as a different role, has the same schedule and command | Also require the history
file's second application to raise `BASELINE_HISTORY_RESTORE_REQUIRES_EMPTY_LEDGER`,
the cron file's second application to raise
`BASELINE_CRON_RESTORE_REQUIRES_ABSENT_JOBS`, the platform overlay's second
application to raise `BASELINE_PLATFORM_RESTORE_REQUIRES_ABSENT_BUCKETS`, the ACL
lockdown to re-apply cleanly, and any post-baseline migration to replay onto the
result. Five of the required proofs are **negative** tests, because a positive match
cannot show that a guard would have noticed anything. On the restored database:

1. Swap one captured `anon` `EXECUTE` grant for a different function and confirm
   `BASELINE_ACL_ANON_EXECUTE_DRIFTED` still raises. Revoke it from `PUBLIC` as well as
   from `anon`, or the effective set is unchanged and the swap is not really a swap.
2. Flip an identity column from `GENERATED ALWAYS` to `GENERATED BY DEFAULT` and confirm
   `columns` moves. Use `SET GENERATED`, not a `DROP IDENTITY`: dropping it also destroys
   the implicit sequence, which `relations_and_acl` already catches, so it would not be
   testing `columns` at all.
3. Change one RPC argument default and confirm `function_security` moves.
4. Disable one trigger and confirm `triggers` moves.
5. Re-create one function with the same body and grants but a different result type, and
   confirm `function_security` moves.

Each of those leaves the naive form of its check untouched — the count stays at 95, and
the pre-fix `columns`, `triggers`, and `function_security` definitions returned
byte-identical digests across the last four — so a refresh that recorded only the positive
match would have proven nothing. Record each as a `true` flag in
`disposable_restore_proof`.
`verify-schema-baseline.mjs` holds a hard-coded list of the required flags and
fails if any is missing or not `true` — it does not iterate whatever keys happen to
be present, because a proof that simply omitted the checks it failed would
otherwise pass. A half-finished refresh cannot be published as if it were proven.

Finally run `node scripts/assemble-schema-baseline.mjs <work-dir> <high-water>`,
delete the superseded artifacts, and run `npm run test:schema-baseline`.

A note on the container: the stock `supabase/postgres` image ships whatever
GoTrue/storage schema it was cut at, which is not the version live runs. Drop its
`auth` and `storage` schemas and replace them with live-introspected DDL before
restoring, or the overlay will fail on columns the image's `auth.users` does not
have. In that image `postgres` is not a superuser — `supabase_admin` is — so the
platform prerequisites are applied as `supabase_admin -d postgres` and everything
else as `postgres`.

## 2026-09-26 - autonomous landing: permission-changing migrations stay Mason's

**Sol HIGH, round 9 on PR #804.** The apply gate refused only migrations that delete data, so a
reviewed migration that changed who can access what would have applied by itself, although Mason's
rule keeps permissions changes his. 48 of the last 60 migrations carry GRANT/REVOKE lines, almost all
the routine lock-down of new functions, so Mason was asked where the line sits and chose "Routine
auto, widening waits".

New `.claude/hooks/migration-access-lib.mjs` (`accessChangeCheck`), run by `migration-apply-lib.mjs`
right after the destructive check, in every session, failing closed. Routine and automatic: REVOKE on
objects the migration creates, GRANT on them to `authenticated`/`service_role`/`postgres`, `OWNER TO
postgres` on them, enabling or forcing RLS, and policies on a table it creates. Mason's: a GRANT to
anon or PUBLIC; any GRANT/REVOKE on an object the migration did not create (including IN SCHEMA and
schema grants, and tables made with IF NOT EXISTS); other grantees, WITH GRANT OPTION and role
membership; ALTER/DROP POLICY and policies on existing tables or for anon/PUBLIC; disabling RLS;
roles, owners, default privileges, SET ROLE, SECURITY LABEL, ALTER FUNCTION ... SECURITY DEFINER;
the `auth`, `storage` and `vault` schemas (except `auth.uid()`-style calls and foreign keys to
`auth.users`); and any dynamic `EXECUTE` at apply time. Function bodies are ignored (they do not run
at apply time); comments and string literals are ignored, including inside DO blocks.

Measured on the last 60 real migrations: 38 apply by themselves, 22 wait for Mason. Stated residual:
a `CREATE OR REPLACE`d function counts as created by the migration, so re-stating its grants to the
routine roles is automatic even though its earlier grants are not visible to the check.

The daily summary also lists open PRs whose migration changes access as waiting on Mason, and
escapes migration filenames (Sol MEDIUM, round 9: a crafted filename could inject an @-mention or
fake lines). `AGENTS.md` now says "routine grants only", pinned by `check-agent-guidance.mjs`.

Follow-up noted, not changed: the older destructive check reads `REVOKE ... TRUNCATE` (removing the
right to empty a table) as a TRUNCATE. That only parks more for Mason, never fewer.

# Production Migration Approval Gate

This gate lets one GitHub account serve two different capabilities safely:

- Codex's machine credential may prepare the exact inputs and inspect a migration run.
- Mason's signed-in GitHub website session is the only capability allowed to approve the
  review attestation, dispatch the workflow, approve the `production-database` environment, and
  release its secrets.

GitHub's fine-grained permission boundary is load-bearing. Creating a workflow dispatch requires
**Actions: write**, and reviewing a pending environment deployment requires **Deployments: write**.
The Codex credential must carry **read only** for both. A classic OAuth token with broad `repo`
scope is not permitted for this workflow.

Official references:

- <https://docs.github.com/en/rest/actions/workflow-runs#review-pending-deployments-for-a-workflow-run>
- <https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event>
- <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments>
- <https://docs.github.com/en/rest/repos/rules#create-a-repository-ruleset>
- <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#restrict-updates>

## Required GitHub environment

Create `production-database` with all of these settings:

1. Required reviewers: only `masonwells1`.
2. Prevent self-review: off. The human and machine use the same GitHub account but different
   credentials; capability separation comes from the machine token lacking both Actions write and
   Deployments write. Mason must be able to approve the workflow he manually dispatched.
3. Allow administrators to bypass configured protection rules: off.
4. Deployment branches: protected branches only.
5. Environment secrets: `SUPABASE_ACCESS_TOKEN`, `PRODUCTION_DB_PASSWORD`, and
   `PRODUCTION_BRANCH_FREEZE_TOKEN`.

The workflow verifies settings 1-4 before it can reach its approval job. Secrets are referenced
only by the approved job and are never stored in the repository.

This is intentionally a one-account design. Mason's normal website session performs the manual
release actions; the separate safety boundary is the much narrower credential available to Codex
on the workstation.

## Required Codex fine-grained token

Create a fine-grained personal access token owned by `masonwells1`, limited to only
`CRX_Manager_V1.0`, with the minimum permissions needed for normal delivery:

- Actions: **read only** (inspect runs; never dispatch, rerun, cancel, or approve).
- Contents: read and write.
- Pull requests: read and write.
- Issues: read and write (PR comments use the issues API).
- Workflows: read and write.
- Checks and commit statuses: read.
- Deployments: **read only**.

Do not grant Actions write, Deployments write, Administration write, Environments write, or Secrets access. Never
paste the token into chat, a tracked file, or a command argument. Enter it only through the GitHub
CLI's hidden token prompt, then remove the old broad OAuth login.

## Protected branch-freeze credential

Create a second fine-grained token under Mason's same GitHub account, limited to
`CRX_Manager_V1.0`, with **Administration: read and write** and **Contents: read only**. Grant no
Actions, Deployments, Pull requests, Issues, Workflows, or Contents write permission. Store it only as the
`PRODUCTION_BRANCH_FREEZE_TOKEN` secret in `production-database`; do not install it in Codex or the
local GitHub CLI.

After Mason approves the protected environment, the workflow uses this narrow credential to create
an active, no-bypass ruleset that temporarily forbids every update to `main`. It verifies the exact
ruleset and unchanged `main`, runs the database transaction, and then deletes only the ruleset named
for that exact workflow run. A failed or cancelled cleanup deliberately leaves `main` frozen. Inspect
and remove that exact stale freeze through GitHub's Rulesets page only after confirming no migration
run remains active. This administrative token cannot push code because it has no Contents write
permission, and Codex cannot retrieve it because protected environment secrets remain sealed until
Mason's website approval.

## Boundary proof before first use

1. Attempt to dispatch `Production approval boundary canary` through the Codex machine credential.
   GitHub must return `403 Forbidden`; any success is a release blocker.
2. Dispatch the canary from Mason's GitHub website session.
3. Confirm its harmless job is waiting on `production-database`.
4. Attempt the pending-deployment approval through the Codex machine credential. GitHub must return
   `403 Forbidden`; any success is a release blocker.
5. Approve the canary from GitHub's website. It must complete with the message that no production
   system was contacted.
6. Re-check that the canary file contains no Supabase command or environment-secret reference.

Repeat this proof whenever the Codex GitHub credential is replaced or its permissions change.

## Human dispatch plus authenticated review provenance

Before merging a migration PR, the existing local `gpt-5.6-sol`/high exact-head review remains the
hard pre-push gate. The PR must also receive CodeRabbit's authenticated GitHub App review on that
same exact head, and the latest exact-head CodeRabbit review state must be `APPROVED`. A plain
`CodeRabbit` success status is insufficient because it can coexist with a `CHANGES_REQUESTED`
review.

After the PR merges, Codex gives Mason four workflow inputs: current-main commit, reviewed PR-head
commit, migration stem, and migration SHA-256. Mason enters those inputs and presses **Run
workflow** in GitHub's website. No caller-supplied review text, hash, or artifact is accepted.

The production workflow accepts the dispatch only when all of these are true:

1. GitHub records a manual `workflow_dispatch` by the repository owner.
2. The exact reviewed commit is the head of one merged PR into `main`.
3. That PR's recorded merge commit is an ancestor of the exact current `main` commit.
4. The migration path is absent from the merge commit's first parent, proving that exact reviewed PR
   newly added it. It is a regular `100644` Git blob, identical at the reviewed PR head, that PR's
   merge commit, and current `main`; symlinks are rejected.
5. GitHub's PR review API reports the latest review for that exact commit from
   `coderabbitai[bot]` (type `Bot`) as `APPROVED`. The verifier paginates to exhaustion rather
   than trusting only the first page.
6. Every repository migration newer than the baseline but older than the selected migration is
   already represented in the locked live migration ledger.

Conditions 3 and 4 allow an unchanged migration to retain the approval from the exact PR that added
it after unrelated work reaches `main`; it cannot borrow approval from another PR. The expected
current-main commit and exact blob hash are checked again immediately before SQL execution. The
workflow event does not replace technical review; it durably records that Mason released the exact
artifact whose separate authenticated GitHub review is clean. The local Sol/high proof remains
required by the branch push guard. The second environment approval keeps secrets sealed until Mason
makes the final release decision.

## Migration run

The migration workflow accepts the exact current `main` commit, exact reviewed PR-head commit,
exact timestamped migration stem, and lowercase SHA-256 of that file.
It refuses dispatches whose workflow definition was not loaded from `main`. Before approval it
verifies current-main binding, the merged-PR and durable-review bindings,
unchanged regular Git-blob and file/hash bindings, environment protection, parser deny paths, and
atomic-batch compatibility. After Mason's website approval, it re-queries the exact CodeRabbit
approval and rebuilds the batch directly from the same immutable Git blob, reconfirms current main,
verifies the installed Supabase CLI version, obtains the environment secrets, then rechecks remote
`main` and the exact Git-blob SHA-256 immediately before executing one transaction.

Inside that transaction, the workflow locks the live migration ledger and refuses the selected
migration if any earlier post-baseline migration in current `main` is missing. A newer migration
therefore cannot skip and permanently strand an older pending migration.

The automated path refuses every migration classified as destructive by the repository's existing
fail-closed detector, including top-level `DELETE`, `TRUNCATE`, `DROP TABLE`, dropped columns,
`MERGE`, and schema/type/domain/extension drops. An intentional destructive migration remains
outside this workflow and requires a separate current-conversation approval and recovery plan.
The same path also rejects top-level `SELECT` (which could invoke a mutating function), all top-level
`DO` blocks, dynamic SQL execution, and every unquoted client backslash command. These conservative
refusals park unusual migrations for a separately reviewed manual path.

Admission is otherwise default-deny: only `COMMENT ON` statements are allowed. This makes the
automated path intentionally metadata-only until each additional DDL family has its own executable
semantic proof.
Top-level DML, `VALUES`, `COPY`, query-executing `CREATE TABLE AS`, materialized views, CTEs, index
builds, trigger DDL, `ALTER TABLE`, extensions, direct migration-ledger references, and unknown
statement forms are parked. Migration blobs are normalized from CRLF to LF and rejected if any lone
carriage return remains; the top-level tokenizer also ends line comments on either carriage return
or line feed. New or changed tables, functions, procedures, policies, grants, and
revokes are also parked because they require semantic proof of RLS, actor binding, fixed search
paths, deliberate access, and mutating-RPC idempotency. `CREATE SCHEMA` is parked because PostgreSQL
permits embedded grants and trigger declarations inside that single statement. `CREATE VIEW` is
parked because owner-run views can bypass underlying RLS and inherit permissive default relation
grants. `CREATE TYPE` and `CREATE DOMAIN` are parked because their definitions can persist function
calls or lifecycle semantics that this gate does not yet prove. Every candidate-supplied `SET LOCAL`
statement is parked so a reviewed migration cannot disable the gate's timeouts or alter parsing and
resolution behavior. Every `ALTER TYPE` and `ALTER SEQUENCE` is parked because those statements can immediately
rewrite lifecycle meaning or live numbering behavior; view and index drops are parked as operationally
destructive. `CREATE SEQUENCE` is also parked because the production baseline can grant browser roles
access to newly created public sequences, while this automated path deliberately refuses the corrective
`REVOKE`. The wrapper obtains the migration-ledger table lock before its advisory lock, matching the
ordinary ledger-insert trigger's lock order and avoiding a cross-path deadlock. Quoted or
unquoted references to the migration schema are denied before tokenization. PostgreSQL Unicode-escape
syntax is denied anywhere in an automated migration, including inside stored-function bodies, so an
escaped identifier cannot disguise a protected schema reference.

The transaction requires the exact reviewed global ledger-order trigger—name, event shape,
SECURITY DEFINER setting, fixed search path, and function-body hash—both before candidate SQL and
immediately before its ledger insert. This deliberately means many valid migrations cannot use the
automated gate; safety takes priority over coverage.

## One-time ledger-guard bootstrap

The workflow remains inert until
`20260827223000_enforce_global_migration_ledger_order.sql` is applied through the existing reviewed
manual path. Resolve or apply every older approved pending migration first; installing the guard
intentionally makes any later attempt to insert an older authored timestamp fail and roll back.

The guard runs for every ledger insert, regardless of whether it came from GitHub, Supabase MCP, or
another client. It takes the same transaction-scoped advisory lock, requires the ledger `name` to
carry the authored 14-digit timestamp, recomputes the live row-by-row effective high-water, and
rejects an authored timestamp at or below that value. This closes stale workstation-snapshot races
without trusting one client to invalidate another client's local files.

While the transaction runs, the protected no-bypass ruleset holds `main` at the exact verified
commit. This closes the cross-system race in which a newly merged older-timestamp migration could
otherwise appear between the last Git check and the database transaction and become permanently
stranded by the global ordering trigger.

That transaction locks the migration ledger, refuses duplicate versions, names, or exact SQL
content and refuses out-of-order versions, runs the migration SQL, writes the content-bound ledger
row, verifies it, and commits. A second 14-digit timestamp anywhere in the filename suffix is also
rejected, closing the stale-migration alias/replay form. SQL that cannot safely run in that
transaction remains parked for a separately reviewed manual path.

## Emergency stop

Removing any environment secret or disabling `Approved production migration` makes the gate
inert. Do not bypass a waiting approval, add Actions or Deployments write to the Codex token, or move production
credentials back into the local shell.

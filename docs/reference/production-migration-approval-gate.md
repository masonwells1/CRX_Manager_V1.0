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

## Required GitHub environment

Create `production-database` with all of these settings:

1. Required reviewers: only `masonwells1`.
2. Prevent self-review: off. The human and machine use the same GitHub account but different
   credentials; capability separation comes from the machine token lacking both Actions write and
   Deployments write. Mason must be able to approve the workflow he manually dispatched.
3. Allow administrators to bypass configured protection rules: off.
4. Deployment branches: protected branches only.
5. Environment secrets: `SUPABASE_ACCESS_TOKEN` and `PRODUCTION_DB_PASSWORD`.

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
3. That PR's recorded merge commit is still the current `main` commit.
4. The migration is a regular `100644` Git blob, identical at the reviewed PR head and current
   `main`; symlinks are rejected.
5. GitHub's PR review API reports the latest review for that exact commit from
   `coderabbitai[bot]` (type `Bot`) as `APPROVED`. The verifier paginates to exhaustion rather
   than trusting only the first page.

Condition 3 deliberately makes the release window fail closed: if another PR reaches `main`, rerun
the release preparation against current state rather than approving stale evidence. The workflow
event does not replace technical review; it durably records that Mason released the exact artifact
whose separate authenticated GitHub review is clean. The local Sol/high proof remains required by
the branch push guard. The second environment approval keeps secrets sealed until Mason makes the
final release decision.

## Migration run

The migration workflow accepts the exact current `main` commit, exact reviewed PR-head commit,
exact timestamped migration stem, and lowercase SHA-256 of that file.
Before approval it verifies current-main binding, the merged-PR and durable-review bindings,
unchanged regular Git-blob and file/hash bindings, environment protection, parser deny paths, and
atomic-batch compatibility. After Mason's website approval, it re-queries the exact CodeRabbit
approval and rebuilds the batch directly from the same immutable Git blob, reconfirms current main,
verifies the installed Supabase CLI version, obtains the
environment secrets, and executes one transaction.

The automated path refuses every migration classified as destructive by the repository's existing
fail-closed detector, including top-level `DELETE`, `TRUNCATE`, `DROP TABLE`, dropped columns,
`MERGE`, and schema/type/domain/extension drops. An intentional destructive migration remains
outside this workflow and requires a separate current-conversation approval and recovery plan.
The same path also rejects top-level `SELECT` (which could invoke a mutating function), all top-level
`DO` blocks, dynamic SQL execution, and every unquoted client backslash command. These conservative
refusals park unusual migrations for a separately reviewed manual path.

That transaction locks the migration ledger, refuses duplicate versions, names, or exact SQL
content and refuses out-of-order versions, runs the migration SQL, writes the content-bound ledger
row, verifies it, and commits. A second 14-digit timestamp anywhere in the filename suffix is also
rejected, closing the stale-migration alias/replay form. SQL that cannot safely run in that
transaction remains parked for a separately reviewed manual path.

## Emergency stop

Removing either environment secret or disabling `Approved production migration` makes the gate
inert. Do not bypass a waiting approval, add Actions or Deployments write to the Codex token, or move production
credentials back into the local shell.

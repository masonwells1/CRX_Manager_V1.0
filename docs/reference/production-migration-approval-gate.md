# Production Migration Approval Gate

This gate lets one GitHub account serve two different capabilities safely:

- Codex's machine credential may prepare, dispatch, and inspect a migration run.
- Mason's signed-in GitHub website session is the only capability allowed to approve the
  `production-database` environment and release its secrets.

GitHub's fine-grained permission boundary is load-bearing. Reviewing a pending environment
deployment requires **Deployments: write**. The Codex credential must carry **Deployments: read**
only. A classic OAuth token with broad `repo` scope is not permitted for this workflow.

Official references:

- <https://docs.github.com/en/rest/actions/workflow-runs#review-pending-deployments-for-a-workflow-run>
- <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments>

## Required GitHub environment

Create `production-database` with all of these settings:

1. Required reviewers: only `masonwells1`.
2. Prevent self-review: off. The human and machine use the same GitHub account but different
   credentials; capability separation comes from the machine token lacking Deployments write.
3. Allow administrators to bypass configured protection rules: off.
4. Deployment branches: protected branches only.
5. Environment secrets: `SUPABASE_ACCESS_TOKEN` and `PRODUCTION_DB_PASSWORD`.

The workflow verifies settings 1-4 before it can reach its approval job. Secrets are referenced
only by the approved job and are never stored in the repository.

This is intentionally a one-account design. The reviewer is Mason's normal website session; the
separate safety boundary is the much narrower credential available to Codex on the workstation.

## Required Codex fine-grained token

Create a fine-grained personal access token owned by `masonwells1`, limited to only
`CRX_Manager_V1.0`, with the minimum permissions needed for normal delivery:

- Actions: read and write (dispatch and inspect runs).
- Contents: read and write.
- Pull requests: read and write.
- Issues: read and write (PR comments use the issues API).
- Workflows: read and write.
- Checks and commit statuses: read.
- Deployments: **read only**.

Do not grant Deployments write, Administration write, Environments write, or Secrets access. Never
paste the token into chat, a tracked file, or a command argument. Enter it only through the GitHub
CLI's hidden token prompt, then remove the old broad OAuth login.

## Boundary proof before first use

1. Dispatch `Production approval boundary canary`.
2. Confirm its harmless job is waiting on `production-database`.
3. Attempt the pending-deployment approval through the Codex machine credential. GitHub must return
   `403 Forbidden`; any success is a release blocker.
4. Approve the canary from GitHub's website. It must complete with the message that no production
   system was contacted.
5. Re-check that the canary file contains no Supabase command or environment-secret reference.

Repeat this proof whenever the Codex GitHub credential is replaced or its permissions change.

## Durable migration review attestation

Before merging a migration PR, run the repository's trusted migration review wrapper against the
clean exact PR head. Only after both required reviewer charters and the independent
`gpt-5.6-sol`/high review return clean, post the canonical eight-line attestation as an issue
comment on that PR. The attestation binds the reviewed PR-head commit, migration stem, and exact
SHA-256. It records `trusted-migration-review-wrapper-v1` as its producer.

The production workflow accepts the comment only when all of these are true:

1. The comment body is the exact canonical form, with no added or omitted text.
2. GitHub identifies its author as the repository owner.
3. The comment belongs to the one PR whose exact head was reviewed.
4. That PR's recorded merge commit is still the current `main` commit.
5. The migration's Git blob is identical at the reviewed PR head and current `main`.

Condition 4 deliberately makes the release window fail closed: if another PR reaches `main`, rerun
the release preparation against current state rather than approving stale evidence. The established
honest-agent residual still applies: the same account can write an attestation comment, so the
trusted wrapper, exact-head adversarial review, PR review, and Mason-only deployment approval all
remain required; the comment is durable evidence, not a new human identity.

## Migration run

The migration workflow accepts the exact current `main` commit, exact reviewed PR-head commit,
durable review-comment ID, exact timestamped migration stem, and lowercase SHA-256 of that file.
Before approval it verifies current-main binding, the merged-PR and durable-review bindings,
unchanged Git-blob and file/hash bindings, environment protection, parser deny paths, and
atomic-batch compatibility. After Mason's website approval, it rebuilds the batch from the same
commit, reconfirms current main, verifies the installed Supabase CLI version, obtains the
environment secrets, and executes one transaction.

That transaction locks the migration ledger, refuses duplicate versions, names, or exact SQL
content and refuses out-of-order versions, runs the migration SQL, writes the content-bound ledger
row, verifies it, and commits. A second 14-digit timestamp anywhere in the filename suffix is also
rejected, closing the stale-migration alias/replay form. SQL that cannot safely run in that
transaction remains parked for a separately reviewed manual path.

## Emergency stop

Removing either environment secret or disabling `Approved production migration` makes the gate
inert. Do not bypass a waiting approval, add Deployments write to the Codex token, or move production
credentials back into the local shell.

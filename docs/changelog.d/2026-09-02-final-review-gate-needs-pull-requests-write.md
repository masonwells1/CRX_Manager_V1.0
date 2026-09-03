## 2026-09-02 — the CodeRabbit final review gate could not touch its own labels; `pull-requests: write`

`.github/workflows/coderabbit-final-review.yml` declared `issues: write` and `pull-requests: read`.
Labels and comments on a **pull request** are authorized against the pull-requests scope, not the
issues scope, even though the REST routes the gate calls live under `/issues` — GitHub's workflow
syntax reference says it outright: "`pull-requests: write` permits an action to add a label to a
pull request." The explicit `pull-requests: read` did not merely fail to grant the scope, it pinned
the one scope the gate needs at read.

Every reset event — `synchronize`, `reopen`, `converted_to_draft`, a base edit, an auto-merge change
— routes through `resetCandidate()` → `resetLabels()`, which calls `issues.removeLabel` for **both**
workflow labels unconditionally, whether or not they are attached. So every push to every open pull
request produced `Resource not accessible by integration`, and the gate failed before it did anything
— and before it could clear its own labels. Red on `claude/actor-forgery-triage-20260902`,
`claude/codex-pr-auto-comments-ca5068`, `claude/docs-gate-decision-20260902`,
`claude/todo-pricing-preseason-test` and `claude/ignore-codex-import-skill-dirs` from 21:48Z onward.
The single green run in that window (33690831272) was an event that never touched a label.

**The label-cleanup message in those logs is the symptom, not the cause**, and it is a convincing
decoy: it names the two labels and says the integration cannot reach them, which reads as a missing
*label* permission on a workflow that already holds `issues: write`. The failing call is
`issues.removeLabel` in the reset path; the run never reaches the actor check further down.

**The gate is not a required status check**, which is why an outage this total went unnoticed —
`main` requires only `Vercel`, `Lint, Type Check, Test, Build`, and `SQL Migration Validation`. The
gate has been failing openly rather than blocking. Whether it should become required is an owner
call and is deliberately not made here.

### The fix in flight for this is wrong and would break the workflow file outright

Open PR #563 (`claude/codex-pr-auto-comments-ca5068`, commit `512c46208`) adds `administration: read`
to this same block, attributing the outage to a 403 on `repos.getCollaboratorPermissionLevel`.

**`administration` is not a valid key in an Actions `permissions:` block.** The GITHUB_TOKEN cannot
hold repository-administration permission at all; the accepted keys are `actions`,
`artifact-metadata`, `attestations`, `checks`, `code-quality`, `contents`, `deployments`,
`discussions`, `id-token`, `issues`, `packages`, `pages`, `pull-requests`, `security-events`,
`statuses`, `vulnerability-alerts`.

Not deduced — observed. Pushes to that branch produce runs of this workflow under event `push`, which
its `on:` block cannot subscribe to, carrying **zero jobs** and `name` set to the file path: GitHub's
startup-failure shape for a workflow file it cannot load. Run 33696773987 reports "This run likely
failed because of a workflow file issue." Only that branch — the one editing this file — produces
them. Landing #563 as it stands would replace a broken gate with an unloadable one.

That hunk should come out of #563. Nothing else in that pull request is implicated, and its conflict
against `main` is one line of `package.json` where both sides appended a test to
`test:correction-guards` — keep both additions.

### The actor check is untested, not fixed

`runGate()` calls `repos.getCollaboratorPermissionLevel` on the ready-label path to confirm the actor
who applied `ready-for-coderabbit` holds write or admin. No run has ever reached that line, so
whether the Actions token can call it is **unknown**, and no guess about it is encoded here. If it
403s, the gate blocks the candidate and posts nothing — a safe failure, and a visible one. It is the
next thing the end-to-end proof exercises.

**Verification.** `pull-requests: write` is the documented scope for the failing operation and the
YAML keys above are documented and confirmed against a live startup failure. The behavioural proof —
a push to a real pull request turning the gate green, then one `ready-for-coderabbit` label producing
exactly one `@coderabbitai review` comment and the `coderabbit-review-requested` marker — runs on this
pull request itself, because a `pull_request_target` gate can only be proven by the default branch's
copy after merge.

Also corrected in this worktree (config only, nothing committed): `core.hooksPath` was again seeded
pointing at `C:\Users\mason\.codex\worktrees\pr432-multitarget-20260825\CRX_Manager\.husky`, a
different checkout's hook code, so this worktree's commit and push guards were not running. The
worktree-scoped value overrides the repository one and is invisible to `git config --local --get`;
read it with `git config --show-origin --get-all core.hooksPath`.

## 2026-09-01 — Manual review override on `main`, with an agent lockout

### What changed

Mason asked for a way to merge a pull request into `main` himself when the
required review is stuck. Two things were needed, and both landed together.

### 1. GitHub: "Include administrators" turned OFF on `main`

Classic branch protection on `main` had `enforce_admins: true`, so nobody —
Mason included — could merge without a current approval. It is now `false`.
Nothing else about the protection changed: still 1 approval, still stale
approvals dismissed on every push, still approval-from-someone-other-than-the-
last-pusher, still branch-must-be-up-to-date, still no force-push and no
deletion.

The `protect-main` ruleset was **not** touched. Its bypass list stays empty, so
its rules — PR required, and the `Vercel` / `Lint, Type Check, Test, Build` /
`SQL Migration Validation` checks — still apply to everyone including Mason.
The ruleset requires 0 approvals, which is why the review requirement lived
entirely in classic protection and why disabling admin enforcement there is
enough to reach the override.

Net effect: **Mason can skip the review, not the tests.** The override appears
as GitHub's "Merge without waiting for requirements to be met (administrators
only)" control on the PR page.

### 2. Both merge gates refuse the override

The bypass is granted by admin rights on the account, and every Claude and
Codex session runs on Mason's token — so opening it for him opened it for them.
Two changes close that:

- **`--admin` is denied outright** in `.claude/hooks/pr-merge-guard.mjs` and
  `.codex/hooks/production-action-guard.mjs`. The deny lands *before* the pull
  request is resolved: there is no base branch and no diff for which an agent
  asking GitHub to skip review is correct. `--admin=false` (which requests no
  bypass) stands down. Parsing lives in `ghMergeRequest()` in
  `.claude/hooks/codex-push-lib.mjs` and its Codex-side twin.
- **The approval is now verified directly** rather than inferred. Both gates
  require `reviewDecision === "APPROVED"` from `gh pr view`
  (`pullRequestApproved()`). Previously the `mergeStateStatus === "CLEAN"`
  check stood in for "somebody approved this", because GitHub itself made an
  unapproved merge impossible. The override removed that floor. `--auto` is
  exempt on the Claude side: GitHub holds an auto-merge until every requirement
  is met, and auto-merge never uses the admin bypass.

### 3. Raw merge transports, denied by destination (Codex proof finding)

The exact-SHA Codex review of this branch found the lockout bypassable: both
guards only recognised merges that named the `gh` binary. The Codex guard did
not deny raw REST merge calls at all, and **neither** guard caught the
`mergePullRequest` GraphQL mutation carried over curl or Invoke-RestMethod.

That gap predates this change and was survivable while it existed, because
GitHub itself refused an unapproved merge — a raw REST call just got a 405. The
override removes that backstop, so the same latent gap became a live hole: an
agent holding Mason's admin credential could merge through any transport.

Both guards now deny by **destination** — the `/pulls/<n>/merge` endpoint and
the `mergePullRequest` mutation, whatever tool names them — rather than by
enumerating curl, wget, Invoke-RestMethod, and fetch. Verified red-before /
green-after: the new assertions fail against the pre-fix guards.

**Codex's broader point stands and is not closed by this fix:** command-string
matching cannot truly distinguish Mason from an agent while both use the same
admin identity. The durable fix is a separate, non-admin credential for agents.
That is an owner decision and is deliberately left open — see
`docs/manual/KNOWN_ISSUES.md`.

### 4. Two P1 bypasses in the candidate itself (Codex PR bot)

The Codex PR bot then found two more ways past the gate this branch adds —
`--auto=false` misclassified as an auto-merge, and a recognized outer
`gh pr merge` shielding a raw merge hidden in a command substitution. Both are
recorded in `2026-09-01-merge-gate-p1-bypasses.md`.

### Load-bearing dependency

`reviewDecision === "APPROVED"` is bound to the current head **only because**
`main`'s protection sets `dismiss_stale_reviews` and `require_last_push_approval`
(both verified live on 2026-09-01). GitHub dismisses every approval when a new
commit is pushed, so APPROVED cannot be describing an older head. **If stale-
review dismissal is ever turned off, `pullRequestApproved()` is no longer
sufficient on its own** and both gates must also verify that an APPROVED
review's `commit_id` equals `headRefOid`. This is noted at both call sites.

### Verification

- `.claude/hooks/pr-merge-guard.test.mjs` — 66 assertions. Covers `--admin` in
  every spelling gh accepts (bare, `=true`, `--ADMIN`, before/after the
  selector, later in a `;` chain), `--admin=false` standing down, and
  `pullRequestApproved` on APPROVED / REVIEW_REQUIRED / CHANGES_REQUESTED /
  null / missing / undefined.
- `.codex/hooks/production-action-guard.test.mjs` — new assertions prove the
  discrimination behaviorally: the same merge command returns `blocked: false`
  with an APPROVED fixture and `blocked: true` with `REVIEW_REQUIRED`,
  `CHANGES_REQUESTED`, or a missing verdict, on both the `gh` and MCP routes.
- Mutation-tested: flipping `admin = true` to `false` in the detector, and
  making `pullRequestApproved` return `true`, each turn the suite red.
  (The Codex guard file cannot be source-mutated — its blob pin fires first —
  so its proof is the fixture discrimination above.)
- `npm run test:agent-workflows` green.

### Blob re-pin

`scripts/apply-live-testdata-maintenance-20260812.mjs` pins the blobs of both
guard sources. Both moved, so both input pins were re-pinned (verified with
`tr -d '\r' | git hash-object --stdin` against this working tree) and both
output pins taken from the producer test's printed candidate. Neither guard's
risky-producer-path anchor nor its protected-harness list changed, so both
transforms behave exactly as before.

### Residual risk

The gates only protect a session whose checkout contains them. Until this lands
on `main`, a session running from an older checkout could still use `--admin`.
Nothing in the repo invokes `--admin` today, so this requires an agent to
invent the flag on its own.

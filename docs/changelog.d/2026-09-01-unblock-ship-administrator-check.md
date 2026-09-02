## 2026-09-01 — this PR no longer ships an administrator-enforcement check that can never pass

**Scope correction, 2026-09-02 — read this first.** An earlier draft of this entry described the
bad instruction as a pre-existing claim on `main` that had gone stale. **It was not.** It does not
exist on `main` and did not exist at this branch's merge base. It was introduced by **this PR**, in
commit `9ad9e128` (2026-08-30), and removed by `4eb7cfdd` in the same PR. Verified with
`git show origin/main:<path>` for all three files. Nothing on `main` is or was broken by it, and no
other pull request is affected.

The overclaim mattered: it was used to argue that this PR fixed a live defect blocking every landing
in the merge queue. It does not. It prevents this PR from **introducing** one. That is still worth
having, but it is a regression this branch created, not a rescue.

### What the defect was

Three files in this PR — `.claude/commands/ship.md`, `AGENTS.md`, and
`.claude/skills/deploy-check/SKILL.md` — instructed the reader, immediately before merging, to verify
that live `main` protection "still requires ... administrator enforcement". Since Mason's manual
review override on 2026-09-01, classic protection sets `enforce_admins: false` **by design**, so that
prerequisite can never be satisfied. Had this PR merged as written, an agent following `ship.md`
literally would have refused **every** otherwise-ready landing. Live state read before correcting:
`enforce_admins=false approvals=1 dismiss_stale=true last_push=true strict=true`.

All three now verify a current branch, one current approval with stale-review dismissal, and
last-push approval, and state plainly that administrators are exempt and **no agent may act on that
exemption** — the lockout the 2026-09-01 decision depends on. Codex adapter regenerated via
`node scripts/sync-agent-workflows.mjs --write`.

Reported by Codex as a P1 on this PR, and it was right about the defect. Two of the three copies were
corrected in one pass and `ship.md` was missed until Codex flagged it — when a policy sentence is
restated per file, correcting it means grepping the *concept* across the tree, not the phrasing that
happened to appear in the file being edited.

### The lesson that generalises

The mis-attribution came from grepping the **worktree** and reporting the hit as a property of
`main`. A working tree is the PR branch; a defect found there is the branch's own until
`git show origin/main:<path>` says otherwise. This is the mirror image of the stale-base trap, where
files `main` gained read as deletions the branch caused — same root error, opposite direction. Before
claiming a defect exists on `main`, cite `origin/main`, not the checkout you are standing in.

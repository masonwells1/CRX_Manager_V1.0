## 2026-09-01 — /ship no longer requires an administrator-enforcement rule that is deliberately off

`.claude/commands/ship.md` told every `/ship` run, immediately before merging, to verify that live
`main` protection "still requires ... administrator enforcement". Since Mason's manual review
override on 2026-09-01, classic protection sets `enforce_admins: false` **by design** — so that
prerequisite can never be satisfied, and an agent following the instruction literally would block
**every** otherwise-ready landing. Read live before correcting:
`enforce_admins=false approvals=1 dismiss_stale=true last_push=true strict=true`.

Corrected to verify a current branch, one current approval with stale-review dismissal, and last-push
approval, and to state plainly that administrators are exempt and **no agent may act on that
exemption** — the lockout the 2026-09-01 decision depends on. Codex adapter regenerated via
`node scripts/sync-agent-workflows.mjs --write`.

This is the third copy of the same stale claim, after `AGENTS.md` and
`.claude/skills/deploy-check/SKILL.md`. Reported by Codex as a P1 on PR #516, and it was right: the
first sweep for this claim missed the one place where it would have done real damage. When a policy
sentence is restated per file, correcting it means grepping the *concept*, not the phrasing that
happened to appear in the file being edited.

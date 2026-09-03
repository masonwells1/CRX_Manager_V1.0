## 2026-09-02 — seven orphaned audits and handoffs land on `main` (drafted as eight; one withdrawn)

1,125 lines of documentation whose bannered versions existed only on an unmerged branch. Every
file is absent from `main` at any path; none overwrites anything. Bodies are preserved verbatim,
with a `SUPERSEDED` banner added at the top of each naming what actually happened to the work it
describes. (The source copies of five still sit on their original branches; what lands here is the
bannered version, which is what makes them safe to find by grep.)

**Withdrawn before landing:** `docs/audits/2026-08-04-pending-doc-updates.md` (276 lines, PR #317).
It measured as absent from `main`, but `main`'s history shows it was added on 2026-08-04 and
**deliberately deleted by PR #331 on 2026-08-07** once its entries had been applied. Restoring it
would have undone a completed cleanup. A `gpt-5.6-sol` review caught this on 2026-09-02; the rule it
leaves behind is that "absent from `main`" has a third meaning — consumed and removed on purpose —
and `git log --diff-filter=AD -- <path>` is the one-command check for it.

| Lines | Document | Rescued from |
|---:|---|---|
| 392 | `docs/handoffs/2026-08-09-actor-binding-guard-review-cap-handoff.md` | PR #373 |
| 174 | `docs/audits/2026-08-24-claude-to-codex-pr432-ci-handoff.md` | PR #432 |
| 171 | `docs/handoffs/2026-08-09-pricing-audit-local-finish.md` | PR #350 |
| 158 | `docs/audits/2026-08-24-pr432-park-handoff.md` | PR #432 |
| 79 | `docs/handoffs/2026-08-27-crx-autonomy-plan-to-build-handoff.md` | PR #513 |
| 76 | `docs/audits/2026-08-08-product-pricing-full-audit-and-strategy.md` | PR #350 |
| 75 | `docs/audits/2026-08-24-codex-to-claude-dynamic-hardlink-bypass-handoff.md` | PR #432 |

### Why the banners are not optional

Every one of these describes work that did not land as written, and three of them describe file
paths and symbol names that do not exist. Landing them unmarked would put confident, detailed,
**wrong** instructions into `docs/` where the next reader would find them by grep and act on them.

Each banner states what is actually true now, verified rather than assumed:

- **PR #432 (three documents)** — closed unmerged and the work deliberately frozen by
  `docs/manual/DECISION_LOG.md` (2026-08-25).
- **PR #350 (two documents)** — the below-cost feature **did** ship, under different names:
  `BelowCostApprovalModal.tsx` / `BelowCostApprovalContext.tsx` / `belowCostApproval.ts` on `main`,
  not the branch's `BelowCostConfirmModal.tsx` / `belowCostRpc.ts`. Its three migrations are applied
  live as `20260812145628`, `20260812151606`, `20260812154028`, confirmed against
  `supabase_migrations.schema_migrations`.
- **PR #373** — actor-binding hardening is live work in **open PR #449**; the three migrations named
  in the handoff are staged under `scripts/.staging-migrations/` and are not applied.
- **PR #513** — closed unmerged; its autopilot-hook changes never landed.

The PR #432 park record (`docs/audits/2026-08-24-pr432-park-handoff.md`) matters beyond its line
count: it is the record that Mason deliberately **parked** a 130-commit lineage on 2026-08-24, and
until now it lived only on branches that are themselves parked or unmerged. Anyone auditing from
`main` saw 130 commits, no PR, and would have concluded "stale". Landing it makes the park decision
discoverable from the default branch.

### Deliberately excluded

Seven `docs/changelog.d/` fragments from the same branches were **not** rescued. Each describes a
change that was closed and never shipped, so landing them would make the changelog assert behavior
the code does not have — worse than not having them at all. They remain reachable on their branches.

This is the second such pass; PR #542 landed eleven documents on 2026-09-01 under the same contract.
Both came out of the branch inventory in `docs/audits/2026-09-01-closed-pr-branch-disposition-plan.md`.

### Lessons-to-checks ratchet — why no executable check ships here

The pre-commit ratchet flags this change because
`docs/audits/2026-08-24-claude-to-codex-pr432-ci-handoff.md` names BLOCKER/HIGH findings with no
sibling predicate, hook, or test. That is the correct trigger and the correct answer is an
exemption, not a check:

**Nothing was closed by this change.** It moves existing documents from unmerged branches onto
`main` byte-for-byte. The findings those documents describe belong to PR #432, which
`docs/manual/DECISION_LOG.md` (2026-08-25) closed unmerged with the agent-self-protection work
**deliberately frozen** — they were not fixed, and writing a test asserting they are fixed would be
false. Their status is unchanged by this landing; only their location changed.

Writing a check here would encode a claim the repository does not support. If that frozen work is
ever resumed, the ratchet applies to *that* change, where a real check can assert a real fix.

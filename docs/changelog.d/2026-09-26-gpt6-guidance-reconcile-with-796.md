## 2026-09-26 — reconcile the GPT-6 guidance change (PR #797) with the GPT-6 routing change (PR #796)

PR #796 (Luna builds and reviews, Sol gates money) merged to `main` while PR #797 was open, and the
two conflicted in `AGENTS.md`, `ship.md`, the `codex-review` skill, and `DECISION_LOG.md`. `main` was
merged into the #797 branch and resolved in #796's favor wherever the two disagreed on models:

- `docs/reference/codex-model-tuning.md` now lists the live `gpt-6-*` pins and where each is set,
  instead of a "pinned now / GPT-6 target" table and a pending switch checklist, which #796 made
  obsolete. It keeps Astra for plan review (by hand, advisory) and adds the rules for changing a
  pinned model later, taken from #796's lessons.
- The 2026-09-25 decision-log entry no longer proposes Sol at `medium` as the default builder; #796's
  Luna builder stands. The owner playbook drops the "still on GPT-5.6" note.
- `AGENTS.md` keeps #797's ID-free wording and priority order; `ship.md` and the `codex-review` skill
  keep #796's `gpt-6-*` IDs and point at the model document.

No gate code or model pin changed in this reconciliation.

**Proof observed (cloud session):** `npm run test:agent-workflows`, `scripts/check-agent-guidance.mjs`,
`scripts/check-doc-drift.mjs`, and all 53 top-level hook and script test files passed after the
merge; the 37 Codex adapters re-synced.

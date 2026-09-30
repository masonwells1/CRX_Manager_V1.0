## 2026-09-28 — PR #823: merged `main` (#830) and resolved the agent-guardrails conflict

The docs cleanup in #830 (`4b6ff62`) and PR #823 both edited `docs/reference/agent-guardrails.md`.
Each added a note to one of two adjacent table rows (review-proof-guard, pr-merge-guard), so git
could not merge them.

The conflict was resolved in merge commit `ab64ea8` by keeping both sides, and a word-level diff
confirmed nothing else differed:

- The review-proof-guard row keeps PR #823's "Unreadable input (2026-09-27)" note. Apart from that
  note, the row is byte-identical to `main`'s.
- The pr-merge-guard row keeps #830's "Codex GitHub App review (PR #563, 2026-09-03)" note and its
  `codex-bot-review-lib` references. PR #823 did not change that row.

No code changed in the merge.

**Proof observed (cloud session):** on the merged tree:

- all 35 `.claude/hooks` and `.codex/hooks` test files pass
- `npm run test:agent-workflows` passes
- `scripts/check-doc-drift.mjs` passes
- `docs/manual/KNOWN_ISSUES.md` still carries PR #823's RESOLVED entry

**Not verified here:** the Luna and Sol Codex reviews and CodeRabbit have not run on this head.
They need a session with the Codex CLI and `gh`.

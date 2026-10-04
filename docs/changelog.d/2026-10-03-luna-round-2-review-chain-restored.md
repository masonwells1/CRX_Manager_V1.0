## 2026-10-03 — Luna round 2: review-chain rules restored to AGENTS.md and pinned

Second follow-up to `2026-10-03-slim-agent-guidance.md`, on the same PR. Luna round 2 found 13 more
details the slimming had cut (3 HIGH, 4 MED, 6 LOW). All 13 are accepted and restored in compact form.

- `AGENTS.md` › Safety and Protected Delivery again carries these rules:
  - Luna's exit bar: no BLOCKER or HIGH remains, and every MED/LOW is fixed, refuted, or named as a deferral.
  - A fresh exact-SHA Sol review is required for every merge. Its proof binds to HEAD and GitHub's real base.
  - Only pinned reviewer models count; never one the gates do not accept.
  - Never "disable" a gate.
  - CodeRabbit fixes stay on the same PR.
- Smaller restorations:
  - the `do not write` limit and current grants as evidence;
  - flagging a request that seems mistaken;
  - the code-clarity specifics;
  - a parked change records its reason and owner;
  - command changes update the docs;
  - `CLAUDE.md` notes that `agent-pr-comment` is dry-run by default.
- `scripts/check-agent-guidance.mjs` now pins the six review-chain rules, so a future trim fails CI instead of silently dropping them.
- The first entry's claim that nothing was lost is corrected.

Net size: `AGENTS.md` 11,995 → ~10,000 bytes and `CLAUDE.md` 3,283 → ~2,200 bytes, about 20% smaller overall. Everything removed duplicated `ship.md`, `codex-model-tuning.md`, or the global rules.

**Proof observed:** `check-agent-guidance` all PASS (including the 6 new pins), `check-doc-drift` and `test:agent-workflows` exit 0.

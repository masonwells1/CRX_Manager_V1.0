## 2026-10-04 — guard reference documents the wrapped sweep-query allowance

Follow-ups in PR #881, from the Codex connector:

- **P1:** `docs/reference/agent-guardrails.md` described only the bare predicate fingerprint
  allowance. It now also describes the wrapped `buildSweepQuery` form that `isKnownSweepQuery`
  allows, and the four conditions it checks.
- **P2:** the doc states how contracts are treated. Contract keys are not bound to allowlist entries;
  they only parameterise a read-only catalog lookup. `--adjudicate` handles contracts as follows:
  - An unrequested or repeated contract is rejected.
  - A missing contract only leaves dependent violations flagged.
  - A packet with no violations and no contracts passes.

  The first wording said every missing contract fails `--adjudicate`, which the code does not do.

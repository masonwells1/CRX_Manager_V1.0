## 2026-10-04 — guard reference documents the wrapped sweep-query allowance

Follow-up in PR #881 (Codex connector P1): `docs/reference/agent-guardrails.md` described only the bare
predicate fingerprint allowance. It now also describes the wrapped `buildSweepQuery` form that
`isKnownSweepQuery` allows, and the four conditions it checks. It also states that contract keys are not bound to
allowlist entries, and why that is safe: a read-only catalog lookup, and `--adjudicate` rejects
missing or extra contracts.

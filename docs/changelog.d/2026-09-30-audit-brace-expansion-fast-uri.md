## 2026-09-30 — patched `brace-expansion` and `fast-uri` so the CI audit passes again

The `Lint, Type Check, Test, Build` job's `npm audit --audit-level=high` step began failing on every
head of PR #836 after new advisories were published. The PR's own tests passed; the job failed only
at the audit:

- `brace-expansion` 4.0.0–5.0.11, **high** (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7,
  GHSA-6j4f-fj2g-mc7p: denial of service through crafted brace patterns). `package.json` pinned it
  with an `overrides` entry at exactly `5.0.9`; the pin now names the patched `5.0.12`.
- `fast-uri` 3.0.0–3.1.7, moderate (GHSA-hrr3-gc8f-f4qj), a build-time dependency of
  `workbox-build` through `ajv`. The lockfile now resolves `3.1.8`.

Both reach the app only through build and lint tooling (`minimatch` and `workbox-build`), not the
shipped bundle. The lockfile was regenerated with npm 11 so only these two entries changed;
`npm audit --audit-level=high` now reports 0 vulnerabilities.

Also in this change (Codex review of PR #836):
- `docs/manual/CURRENT_STATE.md`: the rollout paragraph that still called `20260914100900` "the one
  still parked" now records its 2026-09-28 apply.
- `docs/reference/coderabbit-native-review.md`: a "Base scope" note. Neither the exact-head approval
  nor the follow-up completion is bound to a base SHA. CodeRabbit reviews only PRs based on `main`,
  and the exact-SHA Sol proof binds the merge to GitHub's real current base.

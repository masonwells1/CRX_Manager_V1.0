## 2026-09-08 — PR #605: `bun pm` is a namespace, so `bun pm pkg set` now denies like `npm pkg set`

Codex (`gpt-5.6-sol`, exact-SHA push proof on `cbd986732`) returned BLOCKED with one High:
`review-proof-guard.mjs` listed `pm` in the read-only subcommand set, so
`bun pm pkg set scripts.test=…` — which rewrites `package.json` without naming it — was
"not a manifest write", while the same command through npm denied. Probe-confirmed silent
(also `bun pm version patch`, `bun pm trust left-pad`).

Fix by class: `pm` is a NAMESPACE, and what follows it is classified as if the manager had
been invoked directly, so every existing rule applies (`pkg get` allowed; `pkg set|delete|fix`,
`version <bump>`, unknown subcommand → refused). `trust` (writes `trustedDependencies`) joined
the manifest editors; bun's read-only leaves (`hash`, `untrusted`, `default-trusted`) joined
the read set so `bun pm ls|bin|cache|hash|whoami|pkg get` and bare `bun pm` stay silent.

Proof: ten new deny cases and seven new allow cases in `review-proof-guard.test.mjs`; the
previous hook fails the suite at `must deny: bun pm pkg set scripts.test=x` by direct probe.

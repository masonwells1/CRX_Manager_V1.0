## 2026-09-08 — PR #605: `agent-guardrails.md` no longer says `package.json` is unprotected

Codex (`gpt-5.6-sol`, exact-SHA proof on `6b2a9d3a4`, LOW) and the GitHub Codex connector (P2 on the
same head) both flagged that the `review-proof-guard.mjs` row in `docs/reference/agent-guardrails.md`
still carried the 2026-09-01 sentence "`package.json`/`package-lock.json` deliberately stay OUT" while
the same row, further on, records that `package.json` joined the shell and path-field patterns in this
PR. The row also said `npm install` / `npm pkg set` "stay silent", which stopped being true at
`c6f210b62`.

Fix, documentation only: the exclusion sentence now names `package-lock.json` alone and marks the
`package.json` half as superseded; the "stay silent" clause now describes the shape-matched
package-manager rule (every manager token classified, unknown subcommands refused, from-manifest and
read/run forms silent). No hook, test, or settings change.

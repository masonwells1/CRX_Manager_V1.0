## 2026-09-07 — PR #605: the package-manager rule fails closed, and the parity test models the measured glob

Codex (`gpt-5.6-sol`, high effort) reviewed `fc36b2d28` for the exact-SHA push proof and returned
BLOCKERS with one High and one Medium. Both probe-confirmed against the committed files before the fix.

### High — only the first manager token was classified, and an unknown subcommand read as "not a write"

`npm exec -- npm pkg set scripts.probe=true`, `npm x -- npm install left-pad`, `npm audit fix`,
`npm dedupe --save`, `yarn set version stable`, `pnpm patch-commit …`, `yarn unplug …` all passed
`.claude/hooks/review-proof-guard.mjs` silently.

Fix, in the shape Codex asked for:

- **Every** token that names npm/pnpm/yarn/bun is classified, not just the first, so a manager nested
  behind another manager's `exec`/`x`/`dlx` is seen in its own right.
- **Fail closed:** a subcommand that is neither in a writing family nor on the explicit read-or-run
  allowlist is refused. `create`, `patch-commit`, `unplug`, `yarn set`, `audit fix`, and
  `dedupe`/`prune --save` join the writing side; launcher subcommands (`exec`, `x`, `dlx`,
  `workspace`) are refused when a writing word follows them (`yarn workspace api add x`).
- Still silent: `npm audit`, `npm dedupe`, `npm prune`, `npm outdated`, `npm ls`, `npm view`,
  `npm exec -- vitest run`, `npm config set`, `pnpm dlx create-vite`, and everything the earlier
  entries list. An unknown subcommand now costs a refusal, never a silent manifest write.

Accepted residual, stated in the hook: arbitrary code (`npx <tool>`, `node -e`) can write any file.
That is beyond a lexical hook and is what the exact-SHA Codex review and the parity test stand for.

### Medium — the parity test modelled a single `*` as stopping at `/`

PR #605 F3 measured that a Claude settings glob such as `scripts/check-*` DOES cross `/`
(`scripts/check-probe/nested.txt` was denied), and the hook regex was widened to match. The test's
model said the opposite, which would shrink the settings-protected set it checks and let a nested path
that settings protects but the hook misses go unreported. `*` and `**` now both model as `.*`;
two nested samples are pinned against the real hook. The reverse-direction check deliberately does not
include the risky-path set: that set is the merge-time review superset (migrations, edge functions,
money and RLS code), so "risky but no ask entry" is the designed state, not a divergence; the test now
says so.

### Proof

- `review-proof-guard.test.mjs`: fourteen new deny cases (the new deny cases fail against the previous
  hook at `must deny: npm exec -- npm pkg set scripts.probe=true`), fourteen new allow cases, two
  nested-glob samples.
- `protected-surface-parity.test.mjs` passes with the corrected model over every tracked path.

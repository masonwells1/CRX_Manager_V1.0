## 2026-08-31 — Restore approval on every surface that can switch enforcement off

Corrects the same-day entry above. An exact-SHA `gpt-5.6-sol` high-effort review blocked that
change HIGH, and the finding was confirmed from source before acting on it.

The hole: live `execute_sql`, live `apply_migration`, and pushes are all auto-allowed in the
permission manifest, so their only protection is the PreToolUse hooks — and `review-proof-guard.mjs`
deliberately permits ordinary hook and settings edits (its own comment states that
`.claude/settings.json` and `.claude/hooks/*.mjs` stay allowed). Dropping the approval requirement
on those files therefore opened a two-step silent path: rewrite a guard, then run the operation that
guard used to gate, with no prompt at either step. Keeping approval on the final deploy and merge
tools does not close it, because the guard can be weakened first. The earlier claim that
"the deterministic hooks are the enforcement layer, and none of them changed" was true but
insufficient — the hooks can be edited so they no longer run.

Per Mason's decision, approval is restored for every surface that can disable enforcement: the hook
scripts and their Codex counterparts, the Codex config, both permission manifests, the Husky
directory, the CI workflows, the CodeRabbit config, `package.json` (it defines the `typecheck` and
`build` scripts the pre-push hook runs), and the check/validate/verify and proof-generation scripts.

Net change from `origin/main` is thirteen lines. What remains removed cannot disable a guard: the
`mcp__Desktop_Commander__*` and `mcp__filesystem__*` write entries, which grant no capability the
session lacks via `Bash`/`Edit`/`Write`, and the two prose contract files `AGENTS.md` and
`CLAUDE.md`.

This is deliberately a small result. The prompt reduction Mason originally asked for is not
achievable by relaxing this list, because the files he is prompted on are the guardrail files
themselves. Doing it safely needs a self-protection guard that hard-denies guard edits behind an
explicit unlock, which is not built here and remains open.

`npm run test:agent-workflows` and `node scripts/agent-manifest-parity.mjs` pass. The `deny` list is
untouched. No hook logic, schema, or live data changed.

# Claude disposition — Codex adversarial review of the 2026-07-13 guard hardening

**Scope reviewed:** the operating-manual sprint's guard/tooling changes on `claude/agent-operating-manual-25f32a` (new `mcp-tool-guard.mjs`, extracted `bash-safety-lib.mjs`, cross-worktree `registry-freshness-lib.mjs`, idempotency/live-testdata/staleness hook hardening, skill + policy doc updates). No `src/`, no migrations.

**Process:** five successive `codex review --uncommitted` rounds (gpt-5.6, `approval_policy=never`), each round re-reviewing the tree with the previous round's fixes applied. Every finding was adjudicated by Claude, and every accepted fix landed with a regression test (`npm run test:correction-guards`, 472 assertions, wired into `.husky/pre-commit` and CI).

**Threat model note (applies to several dispositions):** these hooks are honest-mistake nets, not malicious-adversary proof — that boundary is documented in `docs/reference/agent-guardrails.md` and `docs/manual/KNOWN_ISSUES.md` §4b.

## Tally

| Round | P1 | P2 | Fixed | Dispositioned |
|---|---|---|---|---|
| 1 | 3 | 2 | 5 | 0 |
| 2 | 4 | 3 | 7 | 0 |
| 3 | 3 | 3 | 6 | 0 |
| 4 | 2 | 3 | 5 | 0 |
| 5 | 3 | 2 | 4 | 1 |
| **Total** | **15** | **13** | **27** | **1** |

## Round 5 (final) — finding-by-finding

1. **P1 — `/ship` contradicted the standing push policy** (`.claude/commands/ship.md`). The Step 8 rewrite said green-pipeline code auto-pushes; the untouched opening "autonomy boundary" still said every prod push needs fresh approval. **FIXED**: opening boundary now states the 2026-06-16 standing authorization and the actions it never covers (force-push, non-green push, migrations, edge deploys, deletion, secrets/auth).
2. **P1 — stale-flag cutoff race in `/regen-schema-registry`**. Using the regenerated registry's mtime as the clear-flag cutoff would delete the flag of a migration applied *mid-refresh* (after a query ran, before the registry was written). **FIXED**: Step 1.0 now stamps `registry-refresh-start.txt` *before* the first introspection query; Step 5 uses that stamp as `cutoffIso`, and a missing stamp means redo the refresh, never substitute a newer time.
3. **P1 — MCP writes could CREATE migrations unguarded** (`mcp-tool-guard.mjs`). The guard only denied writes to *existing* migration files, but the SQL/RLS/enum/generated-column/idempotency content guards are wired to native Write/Edit only — so an MCP `write_file` creating a new migration skipped all of them. **FIXED**: any MCP write/move touching `supabase/migrations/*.sql` (new or existing) is denied with a pointer to the native guarded path. Test flipped accordingly.
4. **P2 — Codex adapter swallowed fail-open warnings** (`.codex/hooks/codex-hook-adapter.mjs`). `normalizeHookOutput()` dropped allow payloads whole, including the loud "registry unreadable — check SKIPPED" `systemMessage`. **FIXED**: the adapter now forwards a swallowed payload's `systemMessage` (top-level or nested) to stderr; 3 new adapter tests.
5. **P2 — npm value-taking options (`--prefix`, `--workspace`) escape the script-body guard**. **DISPOSITIONED** to KNOWN_ISSUES §4b: correct handling requires parsing option values *and* resolving a different package.json than cwd's; CRX is a single-package repo where these forms never occur, and the threat model is honest mistakes. Revisit if the repo becomes a workspace.

## Rounds 1–4 (summary — all fixed with tests)

- **R1:** `move_file` source path unchecked; npm-resolved script bodies skipped the migration-immutability check; dual stale-flag locations not both cleared; `applied_migration_names` dropped on a Q1–Q5-only refresh (carry-forward added); no-space `.env` redirect bypass.
- **R2:** guard was Desktop-Commander-only while `mcp__filesystem__*` twins were allow-listed (made server-agnostic); AP/prepay tables missing from BUSINESS/FINANCIAL table sets; idempotency check/save operation-literal mismatch; `.claude/sub/../settings.json` traversal (resolved-path surfaces); sibling-worktree flags not swept; concurrent-refresh race (cutoff keep-logic); Windows `import("C:/…")` ESM-scheme failure (`pathToFileURL`).
- **R3:** whole-directory moves of protected trees; npm option forms (`--silent`, `-s`, `run-script`); quoted SQL qualification `"public"."customers"`; mixed-version worktree flag write/read fan-out; full idempotency check↔save pairing (set equality); registry-freshness instructions said Q1–Q5 after Q6 existed.
- **R4:** `mcp-tool-guard` absent from `.codex/hooks.json` (Codex side unprotected); `inventory`/`inventory_holds` missing from table sets; npm `pre`/`post` lifecycle scripts ride along unchecked; skill cutoff env-var unset trap; `.env.example/.template/.sample` false positives.

## Verdict

Convergence was real: round 5's findings were a policy-text contradiction, a timing corner, one genuine wiring gap, and two diminishing-returns items — no new bypass *classes*. With round 5 fixed, Claude assesses the guard net as consistent with its documented threat model. Residual risks are enumerated in `docs/manual/KNOWN_ISSUES.md` §4b.

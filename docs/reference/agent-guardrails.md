# Agent guardrails — hooks & review subagents (CRX Manager)

> Extracted from `CLAUDE.md` on 2026-06-15 to keep the always-loaded file lean. This is the full reference for the
> automated safety net; `CLAUDE.md` keeps only a short summary + a pointer here. Regenerate the schema registry the
> hooks read after schema changes: `node scripts/regenerate-schema-registry.mjs`.

---

### Schema-Aware PreToolUse Hooks (`.claude/hooks/`)
These run when Claude Code tries to Write or Edit a file — they refuse the write if it violates a known bug pattern. They read `.claude/schema-registry.json` (regenerate via `node scripts/regenerate-schema-registry.mjs`).

| Hook | What it blocks | Bug it prevents |
|------|----------------|-----------------|
| `sql-safety.mjs` | `pg_get_functiondef`, wrong idempotency columns, `updated_at` on tables that lack it | March 2026 40-bug incident |
| `money-safety.mjs` | `parseFloat()` on `*_cents` variables | Float rounding in money math |
| `idempotency-body-check.mjs` | RPC declares `p_idempotency_key` but body doesn't read/write `idempotency_keys` | `9b36cd2` — `issue_return_credit` regression |
| `rls-on-new-tables.mjs` | New table without `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` | Prevents future RLS regressions |
| `status-enum-check.mjs` | Writing a status string that isn't in the DB CHECK constraint | `4a25aea` — `'void'` vs `'voided'` |
| `generated-column-check.mjs` | UPDATE on a GENERATED column (e.g. `invoices.balance_cents`) | `a419da8` — `reverse_write_off` |
| `env-guard.mjs` | Any write/edit of `.env*` files; hard-coded JWT-shaped literals or `service_role` references in `src/` | Service-role-key leakage into frontend / transcripts |
| `migration-apply-guard.mjs` | Supabase MCP `apply_migration` calls — refused unless `.claude/session-state/migration-review-<name>.json` proof exists from a recent (<30 min) `rls-security-reviewer` + `migration-drift-reviewer` run | B7/B8/B9 class — applying migrations without parallel-session review |

### UserPromptSubmit Hooks (`.claude/hooks/`)
These run when Mason submits a prompt, BEFORE Claude reads it. They inject extra context via `additionalContext` — they don't block — so Mason's intent is preserved while Claude is forced to slow down on risky wording.

| Hook | What it warns on | Why |
|------|------------------|-----|
| `dangerous-phrase-warning.mjs` | "drop/delete migration", "drop/truncate table", "force push", "no-verify", "service_role in frontend", "disable RLS", "rebase published", "auto-commit/push/deploy", "bypass check_period_open", "edit financial_audit_log" | Forces Claude to explain consequences + offer safer alternative + get explicit confirmation before acting on phrasing that has caused incidents |

### SessionStart Hooks (`.claude/hooks/`)
Run when a new session begins. Inject `additionalContext` so Claude sees state-drift warnings up front.

| Hook | What it surfaces |
|------|------------------|
| `session-snapshot.mjs` | Git porcelain snapshot (so Stop hook can tell session-scoped changes from prior WIP) |
| `session-staleness.mjs` | Schema registry >7 days old, CLAUDE.md count drift vs reality, uncommitted files from a prior session |

### Stop Hooks (`.claude/hooks/`)
Run when a session ends. Block until Claude addresses loose ends.

| Hook | What it surfaces |
|------|------------------|
| `stop-verify.mjs` | Code files changed this session — forces `npm run build` + `npm run test` before declaring done |
| `stop-wrap.mjs` | Uncommitted files, written-but-unapplied migrations, edited-but-undeployed Edge Functions, learning-capture prompt on substantive sessions |

### PostToolUse Hooks (`.claude/hooks/`)
These run AFTER a successful Write/Edit. They can't block (file is already written) but they surface issues back to Claude immediately.

| Hook | What it does | Why |
|------|--------------|-----|
| `posttooluse-migration.mjs` | Reminds Claude to update migration-history.md + regenerate schema registry after a migration edit | Prevents doc drift |
| `eslint-autofix.mjs` | Runs `npx eslint --fix` on edited `.ts`/`.tsx` files in `src/` (skips tests, migrations, edge functions) | Catches import-order/local-rules/lint issues at edit time instead of at pre-commit |

### Subagents (`.claude/agents/`)
Specialized reviewers invoked via the `Agent` tool. They run in their own context window and return only a summary — perfect for parallel review without polluting the main session.

| Agent | When to invoke | Bug class it prevents |
|-------|----------------|-----------------------|
| `rls-security-reviewer` | After writing any migration, BEFORE `apply_migration` | B7/B8/B9 (2026-05-26) — anon-EXECUTE-able SECDEF DML, missing `search_path`, missing RLS on new tables, actor-forgery anti-pattern |
| `migration-drift-reviewer` | After writing any migration that touches an existing table/function | March 2026 (40-bug incident) — CHECK-constraint regression, function-overload collision, column-name drift |
| `typescript-types-drift-reviewer` | After applying any migration that adds/changes columns; or sprint-cadence health check | Silent type drift between `src/types/index.ts` and live DB schema (code "works" until a real query hits a missing field) |
| `pdf-output-reviewer` | After editing any file under `src/` that imports `jspdf` / `jspdf-autotable` | Off-brand colors, page overflow, missing image assets, undivided cents in customer-facing PDFs (tank labels, invoices, statements) |
| `compliance-reviewer` | After editing `src/` or a migration — auto-dispatched by `/ship` and available to `/preflight` | CLAUDE.md red-line drift the other 4 don't cover — float money, missing `assertRpcResult` / `checkMutationResult`, `confirm()`/`alert()`, `@sentry/react` import, service_role in frontend, lifecycle violations |

**Rule:** Dispatch both subagents in parallel via a single message with two `Agent` tool calls. They are independent — running them sequentially is wasted time.

To exempt a specific file from a PreToolUse hook, add the marker comment named in the hook's error message.

### Correction-mined guards (added 2026-07-01)

Built from a workflow that mined the last 50 sessions (524 Mason-typed messages → 70 corrections → 12 recurring themes). Each targets something Mason repeatedly had to correct. All are **fail-open / off-by-default** — a read error or missing state file never blocks work. Lessons also live as auto-loading `memory/` files. Tests: `npm run test:correction-guards` (99 assertions across `stop-verify-lib.test.mjs`, `worktree-awareness-lib.test.mjs`, `autopilot-lib.test.mjs`, `guards.test.mjs`).

| Hook | Event | What it does | Correction it prevents / escape hatch |
|------|-------|--------------|----------------------------------------|
| `stop-verify.mjs` (+ `stop-verify-lib.mjs`) | Stop | When session code changed, BLOCKS "done" unless the transcript shows real verification (a `PROOF —` block, or a preview/WebFetch/prod-fetch/`execute_sql`). "Tests pass" is no longer accepted as proof. Bounded to 2 blocks/change-set (fails open). | #1 correction (16×): "is it really live?", "the icons still aren't there", "are the branches merged?". Escape: post `PROOF — Ran: … · Saw: … · Not verified: …`. |
| `worktree-awareness.mjs` (+ `-lib`) | SessionStart | Injects the list of sibling worktrees, each with branch + merged-into-origin/main + dirty count. Silent when solo. | "I have another session working on that", "is it already merged?" — claiming done blind to parallel work. |
| `codex-push-guard.mjs` (+ `-lib`) | PreToolUse(Bash) | Blocks `git push` from `main` when the diff (`origin/main...HEAD`) touches `supabase/migrations|functions` (or RLS/policy files) unless a fresh, HEAD-bound Codex proof (`.claude/session-state/codex-review-<sha>.json`, <30 min, `codex_ran:true`, clean verdict) exists. Non-risky pushes pass. | "has codex reviewed all of these?" — shipping risky code with the Codex gate skipped or treated as queued. |
| `unattended-autopilot.mjs` (+ `-lib`, `autopilot-arm.mjs`) | PreToolUse(*) | OFF unless an unexpired `.claude/session-state/AUTOPILOT.on` flag exists. When armed, auto-approves tool calls EXCEPT a hard deny-set (push, deploy, live migration, destructive delete, secret write) so an overnight loop never stalls on prompts. Arm: `node .claude/hooks/autopilot-arm.mjs --hours N`; disarm: `--off`. | "it keeps asking for permission… I'm going to bed" — reassurance instead of actually granting hands-free permission. |
| `autopilot-intent-reminder.mjs` | UserPromptSubmit | On "run it overnight / never ask / going to bed", tells Claude to ARM autopilot, not just reassure. | Same as above — makes the complaint drive an action. |
| `hold-latch-prompt.mjs` + `hold-latch-guard.mjs` (+ `-lib`) | UserPromptSubmit + PreToolUse(*) | "stop / pause / cancel background / just scoping" latches `hold.json`; the guard then blocks build/commit/migrate/deploy tools (reads, tests, and session-state/SCOPE.md writes stay allowed). Any next message clears it — can't stick across turns. | "lets just stop here, cancel all background work" — momentum past an explicit stop. |
| `live-testdata-guard.mjs` (+ `live-testdata-lib.mjs`) | PreToolUse(*) | Blocks `execute_sql` that INSERTs into a live business table without `[E2E]`, or DELETE/void of a financial table. Override: create `.claude/session-state/REAL-DATA-OK`. | "use only fake fields/customers… delete them after"; cancel/void of real financial records is Mason's job. |
| `active-area-guard.mjs` | PreToolUse(Bash) | Blocks destructive ops (`rm -rf`, `git worktree remove`, `git branch -D`, `git clean -f`, force-push) against a folder/branch listed in `.claude/active-areas.json`. Inert when that file is absent. | "we're working in beyond-parity now, don't mess with it" — sweeping a folder marked active. |

**Full audit (manual):** `scripts/validate-sql-migrations.sh` — scans ALL migration files. Run with `--idempotency-only` for focused check.

**Refresh schema registry after schema changes:** `node scripts/regenerate-schema-registry.mjs` (or ask Claude Code to do it via Supabase MCP).

**Refresh AGENTS.md after CLAUDE.md changes:** `node scripts/regenerate-agents-md.mjs`.

**Refresh architecture map:** `npm run generate-map` (or `node scripts/generate-workflow-map.mjs`). Auto-runs in pre-commit hook and stages `docs/app-workflow-map.html` automatically.


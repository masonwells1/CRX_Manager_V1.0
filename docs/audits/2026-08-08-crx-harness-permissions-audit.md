# CRX Harness and Codex Permissions Audit — 2026-08-08

## Verdict

**PARTIAL — maximum Codex access is verified, but one protected-harness BLOCKER remains.** Codex itself has the
maximum practical local access: no approval prompts, unrestricted filesystem access, enabled
network access, trusted CRX project configuration, and a current 0.147.0 CLI. The collaboration
harness is synced and all existing health/correction suites pass. The remaining blocker is in the
shared Claude live-SQL classifier: several allow-by-name/table/text rules can still misclassify a
live mutation as safe under Claude's `dontAsk` posture. Codex's own production guard is stricter
and rejects non-read-only SQL, but the shared harness cannot be called complete until the Claude
side is converted to a structural/default-deny classifier in a separately reviewed guardrail change.

## Scope and ground truth

- Baseline: `HEAD = origin/main = 6bdcc0e3925d5662df4840dc707f9cc44dd7e61f` at audit start.
- Worktree: clean, detached checkout promoted to `codex/harness-permissions-audit-20260808` before edits.
- Graphify: refreshed at commit `6bdcc0e3` (8,886 nodes, 18,363 edges). Query used:
  `what connects Codex hooks, Claude hooks, agent workflow sync, push guards, and agent health checks?`
- Surfaces inspected: global config/hooks, project Codex config/hooks, Claude settings/hooks,
  generated agent skills, workflow sync/health scripts, CLI/auth/MCP/plugin state, Git/worktrees,
  and the current permissions-overhaul handoff.
- Official permission baseline: [OpenAI Permissions](https://learn.chatgpt.com/docs/permissions) and
  [Codex configuration basics](https://learn.chatgpt.com/docs/config-file/config-basic).
- Production, live database data, migrations, deployments, secrets, and GitHub state were not mutated.

## Effective permissions

| Surface | Verified state | Verdict |
|---|---|---|
| Codex approvals | `never` | Maximum autonomy |
| Filesystem sandbox | `danger-full-access`; Doctor reports unrestricted | Maximum local access |
| Command network | Enabled | Maximum local access |
| Windows sandbox | `elevated` configured; bypassed by full-access mode | Correct fallback configuration |
| Project trust | `C:\`, `C:\Users\mason`, and `C:\CRX_Manager` trusted | Project config/hooks load |
| Web/search/tools | 40 feature flags enabled after CLI update; plugins/apps enabled | Broad capability surface |
| Project MCP | Supabase and Sentry configured; Supabase explicitly `read_only=true` | Intentional production boundary |
| External writes | Branch/PR path available; direct GitHub writes, live migrations, deploys remain gated | Keep gated |

Do not combine the newer beta `default_permissions` profile with the existing `sandbox_mode`:
the current OpenAI manual says those configuration styles do not compose. The existing
`sandbox_mode = "danger-full-access"` plus `approval_policy = "never"` is therefore retained.

## Findings

### BLOCKER (1 open)

1. **The shared live-SQL guard is still allow-by-omission.** Current source proves four bypass
   classes in `live-testdata-lib.mjs`:

   - `READONLY_FN_PREFIX_RE` trusts `preview_`, although the documented
     `preview_product_cost_basis_changes` function performs durable writes.
   - DML catch-alls are built from a hand-maintained `BUSINESS_TABLES` list; a live table omitted
     from that list is not covered, and raw `MERGE` is not classified.
   - any occurrence of `[E2E]` exempts the entire batch instead of being tied to a demonstrably
     synthetic row predicate;
   - the smoke-abort exception accepts a textual `RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'` marker,
     while DDL recognition omits statement families such as `SELECT ... INTO` and `COMMENT ON`.

   Why it matters: Claude's `defaultMode: dontAsk` auto-allows `execute_sql` and relies on this
   deterministic guard. A false allow can change live data or schema without Mason seeing a prompt.

   **Recommendation:** make the classifier default-deny for every non-recognized read statement,
   use an authoritative function mutation catalog, bind test-data exemptions per statement and row,
   and regression-test every documented bypass. This component is a protected security boundary and
   must be changed through a separate reviewed maintenance branch with a fresh exact-SHA Sol proof.

### HIGH (2: one fixed, one open)

1. **Open — Codex's self-protection parser denies safe commands.** Three paths were reproduced:
   Node's ordinary `--test` flag was classified as eval/stdin mode; a multiline read-only config
   command containing the literal `<redacted>` was classified as a harness mutation; and the first
   attempt to write this audit report was denied because protected component names appeared only in
   documentation prose. Source confirms raw-text first-hyphen, `>`, and multiline checks run without
   first isolating executable syntax and patch destinations.

   **Recommendation:** parse the executable and exact Node eval flags, distinguish a standalone
   stdin `-` from ordinary options, strip inert quoted arguments before redirection detection, and
   classify structured patches only by destination headers. Preserve denial of real `node -e`,
   piped-stdin execution, and actual harness writes. The guard protects itself, so this belongs in
   the same separately reviewed maintenance change as the BLOCKER above.

2. **Fixed — the global full-access backstop missed destructive Git variants.** The June global
   hook did not cover option-interleaved reset/clean/push forms, force checkout/switch,
   `read-tree --reset -u`, forced `checkout-index`, Git push plumbing, or shell writes to `.env`.
   The global hook now covers those forms with 18 focused assertions; ordinary branch creation,
   targeted restore, dry-run clean, `node --test`, and `.env.example` writes remain allowed.

### MED (1 fixed)

1. **Linked worktrees falsely reported that no database backup existed.** The hook looked only
   under the active worktree even though backups are gitignored and live under the canonical
   checkout. It now resolves Git's common directory. Current truthful state: the marker exists,
   but the last dump was 10 days old and should be refreshed.

### LOW (1 fixed)

1. **Terminal Codex CLI was behind.** Updated npm-backed Codex from 0.145.0 to 0.147.0. Version,
   Doctor, authentication, network, hooks, and a fresh nested session smoke all passed.

## Additional follow-ups outside this harness change

- `npm audit --omit=dev` reports 7 production dependency advisories (6 high, 1 moderate), including
  direct `pdfjs-dist` and `react-router-dom` advisories. Treat this as a separate application
  dependency/security task; no automatic `npm audit fix` was run.
- Codex Doctor reports 3,431 active rollout files using about 1.40 GB. Cleanup would delete local
  history and therefore was not performed.
- The database backup marker is truthful now but stale. Run `/backup-db` in a dedicated backup task.
- `npm run check:docs` is currently red on unchanged `origin/main`: four 2026-08-08 migrations are
  missing from the migration index, and `CURRENT_STATE.md` / `KNOWN_ISSUES.md` still carry
  2026-08-07 schema stamps. This unrelated baseline drift blocks a clean pre-commit pipeline for
  this branch and was not silently widened into the harness change.

## Proof run

- `npm run graph:refresh` — PASS; graph built from `6bdcc0e3`.
- `npm run test:agent-workflows` — PASS; 37 synced Codex workflow files and all manifest checks.
- `node scripts/agent-health-check.mjs` — PASS with only the session-staleness warning.
- `npm run test:correction-guards` — PASS; all hook, proof, registry, baseline, and safety suites.
- `node .claude/hooks/session-staleness.test.mjs` — PASS, 15 assertions.
- Global hook suites — PASS: command safety 18 assertions, env guard 4 assertions, session ledger 7 tests.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `npm run build` — PASS; production bundle and PWA service worker generated.
- `npm run check:docs` — FAIL on the pre-existing `origin/main` migration-index and schema-stamp drift above.
- `codex doctor --summary` — PASS, 17 OK / 0 warnings / 0 failures; unrestricted filesystem,
  enabled network, approval Never.
- Fresh `codex exec` from `C:\` returned `CODEX_MAX_ACCESS_SMOKE_OK` under CLI 0.147.0 and loaded hooks.
- Independent `gpt-5.6-sol` high-effort review — UNAVAILABLE: two read-only review attempts returned
  no verdict before their 2-minute and 10-minute timeouts. This was not counted as a clean review.

## Prioritized next actions

1. Land the protected live-SQL/default-deny and Codex false-denial repairs through a separate,
   exact-SHA-reviewed harness maintenance PR.
2. Run `/backup-db`; the current local dump is 10 days old.
3. Open a separate dependency-security update for the 7 production advisories and verify the
   affected PDF/router paths in the real app.

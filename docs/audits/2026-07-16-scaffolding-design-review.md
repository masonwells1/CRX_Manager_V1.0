# CRX Manager — Scaffolding Design Review for Junior Handover

**Date:** 2026-07-16 · **Reviewed at:** origin/main @ 5070fa1f · **Mode:** read-only (nothing changed)
**Method:** 10 parallel review dimensions (41 agents total), every BLOCKER/HIGH finding adversarially verified by an independent agent before it counted; the 4 sharpest claims additionally re-verified by hand against origin/main file contents. Grounded first in the repo's own checks (`agent-health`, `test:agent-workflows`, `check:docs`).

---

## Verdict in one paragraph

The safety architecture is genuinely strong — among the best-designed owner-protection setups this reviewer has seen for a non-coder-owned production app. The deterministic guard layer (hooks that block dangerous actions in code, not prose), the append-only decision log, the proof-gated migration apply, and the ledger pre-commit guard are all real and all working. The problem is **staleness, not structure**: the system changed twice in the last week (branch protection on 2026-07-14, new backup reality on 2026-07-12/13) and the written instructions in ~15 places still describe the old world. A senior agent shrugs those off; a junior follows them literally. Worse, three documented instructions actively route around the guard net. Fix the staleness and close three hard-layer gaps, and this setup is ready to hand to juniors.

---

## What is genuinely good — do not let juniors "improve" these away

- **The HARD-over-SOFT principle is practiced, not just stated.** Force-push, `--no-verify`, `reset --hard`, destructive SQL, `.env` writes — all blocked in code. `migration-apply-guard` is a hardened three-state gate that fails closed (stale autopilot flag = everything parks). `live-testdata-guard` really does force `[E2E]` markers on live writes.
- **Single source of truth for guard logic.** Codex invokes the same `.claude/hooks/` implementations through an adapter with path-traversal containment. No forked logic.
- **`docs/manual/DECISION_LOG.md` is real ADR discipline** — append-only, supersede-by-new-entry, each entry says what it forbids. It repeatedly prevented this review from re-litigating settled choices.
- **`AGENT_ONBOARDING.md` is an exemplary front door** — 8 recurring bug classes each with a concrete "check before claiming clean," the process-failure catalogue, and the "guard blocked you? fix the problem, never the guard" rule.
- **`check-doc-drift.mjs` (check:docs)** machine-verifies counts and hook documentation — all passing today (703 migrations, 76 pages, 33 hooks documented).
- **`validate-mission-doc.mjs` + run-loop** — loops can't launch without a spec that passes a hard validator.
- **Guard deny messages teach** — most blocks explain the incident that motivated the rule and the correct next step.
- **`OPEN_ITEMS.md` tombstone and `docs/archive/` READMEs** — the right retirement pattern, applied inconsistently (see Theme 5).

---

## The three BLOCKERs (all confirmed by independent verification + hand-checked)

### B1. Two documented paths apply SQL to the live database around every guard
- `docs/workflows/DATABASE_CHANGE_CHECKLIST.md` Step 3 (lines ~106–114) + Quick Reference: *"Open the Supabase SQL Editor … Paste the entire migration SQL … Click Run … if there are errors, fix them and run again."* This is the doc `SAFE_DEVELOPMENT_RULES.md` routes **every schema change** to. It never mentions Mason's approval, migration-review, proofs, or the Codex gate. Apply is Step 3; verification is Step 6.
- `.claude/skills/create-migration/SKILL.md` (lines 98–101) prints in its own output: *"run: `supabase db push`. Or apply it via the Supabase dashboard."* Same instruction in `new-rpc/SKILL.md:184` and `deploy-check/SKILL.md:50`.
- The hard-layer hole is one regex: `bash-safety-lib.mjs:29` blocks only `npx supabase db push` — the plain `supabase db push` the skills print sails through (the neighboring db-reset rule at line 31 is already npx-optional; this one just never got the same fix). `db push` applies **all** pending local migrations at once — with known disk-vs-live drift, that can include stale never-applied files.

**Fix:** make the regex npx-optional (one line); rewrite the apply instructions in the checklist + 3 skills to the settled path (/migration-review → `apply_migration` → Mason's OK, or armed hands-free per 2026-07-13 policy); state explicitly that the dashboard SQL editor is prohibited for schema changes.

### B2. The incident-recovery docs describe backups that do not exist
- `docs/operations/production-runbook.md` §4.1 (line ~136): *"Supabase takes daily backups for 7 days (Pro plan). Point-in-time recovery (PITR) up to 28 days back."* §4.2 walks the operator to a dashboard Restore button.
- Reality (DECISION_LOG 2026-07-12/13, CURRENT_STATE:100): the org is on the **FREE plan — no PITR, no dashboard restore.** The only real recovery paths are the weekly encrypted pg_dump → `masonwells1/CRX_Backups` and the in-DB `backup_snapshots` pg_cron table. **Neither is named anywhere in docs/operations/ or docs/runbooks/.**
- `incident-rollback.md` additionally points at a `backups/` folder that doesn't exist in a fresh checkout and the superseded `backup-via-rest.py`.
- A junior mid-data-loss follows the runbook to a restore button that isn't there, and cannot find the real backups. (Compounding: this morning's session-start check reports **no current backup exists yet** — the weekly dump hasn't produced one. Worth running `/backup-db` soon regardless.)

**Fix:** rewrite production-runbook §4 + incident-rollback preconditions from the 2026-07-12/13 decision entries: FREE plan, CRX_Backups restore steps, `backup_snapshots`, `scripts/backup-db.mjs`.

### B3. (Cluster with B1) The apply-guard's own messages teach a Mason-free live apply
- `migration-apply-guard.mjs` interactive block message lists "REQUIRED STEPS before retrying": run reviewers → write proof → **retry the apply.** It never says "get Mason's in-chat OK" — which the settled policy says is required in interactive sessions. The proof gate is a floor, not the authorization.
- Related confirmed HIGHs: `migration-review.md`/`ship.md` instruct hand-writing the Codex proof JSON that `review-proof-guard` hard-denies (a junior gets contradictory hook messages → the likely workaround is filename obfuscation, i.e., we'd be training guard evasion on the most dangerous action in the system); and `scripts/write-apply-proofs.mjs --codex-verdict clean` is an auto-allowed one-command rubber stamp of the strongest gate (the push proof already does this right: machine-minted from an actual Codex run).

**Fix:** one line added to the guard's interactive message ("get Mason's OK before retrying"); point the commands + deny message at the sanctioned proof-writer; delete the `--codex-verdict` CLI argument and mint the migration proof from a real Codex run like the push proof.

---

## The six HIGH themes (18 confirmed findings, deduplicated)

### Theme 1 — The 2026-07-14 branch-protection change never propagated (biggest cluster)
Landing work changed from "push to main" to "branch → PR → checks → merge," but:
- **The Codex-verdict gate on Claude's side still watches `git push` to main — a path that no longer exists.** The real landing action (`gh pr merge` / GitHub-MCP merge) has no risky-diff classification and no Codex-proof requirement on the Claude side; it's a bare "ask" permission. Codex's side already has the right guard (`production-action-guard.mjs` gates merges); Claude's doesn't. A Claude session can merge un-reviewed money/RLS code with one approval click.
- `ship.md` Step 8, `OWNER_PLAYBOOK.md:68`, `production-runbook.md:105`, and the `PUSH_POLICY` constant in `prompt-source-lib.mjs` (self-described as "the ONE canonical statement… can't drift again") all still instruct direct pushes to main. The prompt-reminder text and the autopilot deny rules now contradict each other in the same session.

**Fix:** port the merge gate from `production-action-guard.mjs` into a Claude PreToolUse hook (the shared lib already has the logic); one editing pass across ship.md / OWNER_PLAYBOOK / production-runbook / PUSH_POLICY; add a test asserting PUSH_POLICY mentions the PR path.

### Theme 2 — Guards wired to tool shapes, not to the protected thing
- The 8 content guards (sql-safety, money-safety, idempotency, RLS-on-new-tables…) fire only on the native Write/Edit tools. Writing a migration via `cat >`, `node -e "fs.writeFileSync(...)"`, or heredoc bypasses all of them — and Bash-writes are the *normal* path in non-interactive sessions (already project memory: "Write tool blocked → write via Bash+node"). The MCP write path was already recognized and closed (`mcp-tool-guard` denies migration writes for exactly this reason); the Bash path is the same hole, still open.
- Migration immutability ("never edit an applied migration") is similarly shape-bound.

**Fix:** move enforcement to shape-independent choke points — run `validate-sql-migrations.sh` + an "applied migrations are immutable vs origin/main" check in pre-commit/CI, so *any* creation path gets content-checked before landing.

### Theme 3 — Permission manifest has two sources of truth
- `.claude/settings.local.json` is **tracked** — it duplicates grants, takes precedence over settings.json, and the ledger pre-commit guard's regex only watches `settings.json` — so permission changes can land through it with no required written record.

**Fix:** untrack it, fold anything deliberate into settings.json, widen the ledger-guard regex to `settings*.json`.

### Theme 4 — The manual/reference freshness guarantee is prose-only, and it's already failing
- `KNOWN_ISSUES.md` lists as "parked" a row-lock fix **applied live 2026-07-14** (migration 20260714224000) and calls the gauntlet frontend "pending PR" after PR #133 merged. `CURRENT_STATE.md` missed three live ships within 48 hours of the manual layer being created. The only hard check accepts any "Last verified" date forever.
- `QUOTE_TO_DELIVERY.md` teaches **dropped money columns** (`orders.total_paid`/`balance_due`) and a wrong column name (`line_total_cents` → real: `extended_cents`) — silent wrong-report territory for a junior.
- `RLS_SECURITY_GUIDE.md`'s policy matrix is contradicted by July migrations recorded in the repo's own migration history (returns/payments write policies since revoked). A junior "fixing" reality to match the doc would re-open closed security holes.
- `codex-review/SKILL.md` claims AGENTS.md is regenerated from CLAUDE.md — the exact opposite of the settled relationship.
- `new-rpc/SKILL.md`'s canonical SQL template writes an unscoped idempotency lookup that the project's own hook **blocks** — and the hook's deny message points back at that template (circular). Template also omits REVOKE/GRANT entirely.

**Fix:** one correction sweep over the named files, then make freshness HARD per the house principle: extend `check-doc-drift.mjs` to fail when migrations newer than the manual stamps exist, and extend the ledger guard so a commit adding a migration must also stage KNOWN_ISSUES/CHANGELOG. Add a known-dropped-column denylist to check:docs.

### Theme 5 — No end-of-life story for loops, and status surfaces misreport
- `/fleet` and the SessionStart summary count **every** finished ledger as "active" (8 claimed active; the loops finished by ~2026-07-11), date them by file-mtime (= checkout date in fresh worktrees), and surface placeholder text as "last entry." `docs/build-loops/` is a second, older loop system whose STATE files still claim to be live and carry expired one-night push authorizations.
- Two roadmaps compete: newcomers find the superseded top-level `ROADMAP.md`; the real 2026-07-15 execution board is referenced by **nothing**. (The parallel docs-cleanup session is already sweeping archives/ROADMAP — coordinate, don't duplicate.)

**Fix:** add a required `Status: ACTIVE|FINISHED <date>` line to the ledger format (validator already exists to enforce it), make fleet-status read it instead of mtime, archive finished loops, tombstone-banner ROADMAP.md → point at the 07-15 plan, and link the plan from the manual layer.

### Theme 6 — Two-manifest parity and sync brittleness
- Nothing enforces parity between `.claude/settings.json` (33 hook wirings) and `.codex/hooks.json` (29). Today's asymmetries are deliberate; tomorrow's new Claude guard silently never fires for Codex — the designated builder. DECISION_LOG also wrongly records `.codex/hooks.json` as generated.
- The CRLF false-"stale" failure is back in fresh worktrees (observed live in this session: 4 adapters "stale," 6 `agent-health` failures, all noise) because the checker compares raw bytes. The `.gitattributes` fix didn't make the *checker* newline-insensitive, so every fresh worktree opens with red health checks — which trains juniors to ignore red checks.

**Fix:** newline-normalize before compare in `check-agent-workflows.mjs`; add a manifest-parity check with an explicit allowlist for deliberate one-sided hooks; append a DECISION_LOG correction entry.

### Meta-finding (observed live during this review)
A sibling session's `worktree-cleanup` hook **removed this review's own worktree mid-session** — a clean, zero-commit worktree on a merged tip is indistinguishable from a finished one. No work was lost (review outputs live outside the tree), but a junior running a long read-only session could lose an active checkout the same way. **Fix:** the cleanup hook should skip worktrees with a recent session heartbeat (e.g., mtime of the session-state dir or a lockfile the session touches), or default to `--report` and require explicit confirmation for removal of worktrees younger than N hours.

---

## Recommended fix plan (waves, smallest-risk first)

**Wave 1 — Close the live-DB side doors + incident docs (same day, small diffs, no behavior change to the app):**
regex fix in bash-safety-lib; rewrite apply instructions in DATABASE_CHANGE_CHECKLIST + create-migration/new-rpc/deploy-check skills; rewrite production-runbook §4 + incident-rollback backup reality; add "get Mason's OK" line to apply-guard interactive message; fix the proof-file contradiction (commands point at sanctioned writer; drop `--codex-verdict`). Also run `/backup-db` — no current backup exists.

**Wave 2 — Propagate 2026-07-14 branch protection (touches guard hooks — needs care + tests):**
Claude-side merge gate (port from Codex's production-action-guard); ship.md/OWNER_PLAYBOOK/production-runbook/PUSH_POLICY editing pass; PUSH_POLICY drift test; untrack settings.local.json + widen ledger-guard regex.

**Wave 3 — Make doc freshness HARD (the recurring root cause):**
migration-newer-than-stamp check; migration-commit-requires-KNOWN_ISSUES/CHANGELOG rule; dropped-column denylist; correction sweep of KNOWN_ISSUES/CURRENT_STATE/QUOTE_TO_DELIVERY/RLS matrix/codex-review skill/new-rpc template; CRLF-insensitive compare; manifest-parity check.

**Wave 4 — Loop lifecycle + information architecture (coordinate with the in-flight docs-cleanup session):**
ledger Status line + fleet-status rewrite; archive finished loops + build-loops; ROADMAP tombstone + link the 07-15 board from the manual layer; worktree-cleanup heartbeat guard.

The 26 MED and 12 LOW findings are listed below; most fold naturally into the wave that touches their file.

---

## Appendix — full finding list

Severities shown are post-verification (10 HIGHs were downgraded to MED by adversarial verifiers; none of the 31 verified findings were refuted).

### Confirmed BLOCKER
1. [reference-drift] DATABASE_CHANGE_CHECKLIST.md instructs applying migrations via the production SQL Editor — `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`
2. [junior-redteam] Scaffold skills instruct `supabase db push` / dashboard apply; bash guard only matches the npx spelling — `.claude/skills/create-migration/SKILL.md`, `new-rpc`, `deploy-check`, `.claude/hooks/bash-safety-lib.mjs:29`
3. [junior-redteam] Incident/restore docs describe Pro-plan/PITR backups that don't exist; real recovery paths undiscoverable — `docs/operations/production-runbook.md`, `docs/runbooks/incident-rollback.md`

### Confirmed HIGH
4. [governance-core] `gh pr merge` un-hooked on Claude side; Codex gate anchored to abolished push path — `.claude/hooks/codex-push-guard.mjs` (duplicate of 10)
5. [governance-core] Tracked `.claude/settings.local.json` escapes the ledger guard — `.claude/settings.local.json`
6. [commands] migration-review.md / ship.md / apply-guard deny message instruct writing a proof file review-proof-guard hard-denies — `.claude/commands/migration-review.md`
7. [skills] Three skills print `supabase db push` / dashboard apply (pairs with BLOCKER 2)
8. [skills] new-rpc canonical template writes hook-blocked SQL (unscoped idempotency), omits grants; hook deny message points back at the template — `.claude/skills/new-rpc/SKILL.md`
9. [skills] codex-review skill inverts the AGENTS.md/CLAUDE.md relationship; stale model + push claims — `.claude/skills/codex-review/SKILL.md`
10. [hooks-guards] Claude-side Codex gate watches nonexistent push path; PR merge is prompt-only — `.claude/hooks/codex-push-guard.mjs`
11. [hooks-guards] `write-apply-proofs.mjs --codex-verdict` mints the strongest proof from a CLI arg — `scripts/write-apply-proofs.mjs`
12. [hooks-guards] Content guards bound to Write|Edit tool shape; Bash/node writes bypass; migration immutability shape-bound — `.claude/hooks/` + settings wiring
13. [loops-ledgers] /fleet + SessionStart misreport: finished ledgers count as active, mtime dates, filler "last entry" — `scripts/fleet-status.mjs`
14. [manual-layer] KNOWN_ISSUES lists live-applied fix as "parked", merged PR as "pending" — `docs/manual/KNOWN_ISSUES.md`
15. [manual-layer] Manual freshness protected only by prose; stamp check accepts any date; violated 3× in 48h — `scripts/check-doc-drift.mjs`
16. [reference-drift] QUOTE_TO_DELIVERY teaches dropped/wrong money columns — `docs/workflows/QUOTE_TO_DELIVERY.md`
17. [reference-drift] RLS matrix contradicted by July migrations — `docs/workflows/RLS_SECURITY_GUIDE.md`
18. [docs-sprawl] Two roadmaps, current one referenced by nothing; newcomers find the superseded one — `docs/ROADMAP.md`
19. [sync-adapters] No hook-manifest parity guard; DECISION_LOG falsely says .codex/hooks.json is generated — `.codex/hooks.json`
20. [junior-redteam] /ship, OWNER_PLAYBOOK, production-runbook still instruct direct main pushes — `.claude/commands/ship.md`
21. [junior-redteam] Interactive live-apply approval prose-only; apply-guard block message omits Mason's OK — `.claude/hooks/migration-apply-guard.mjs`

### Downgraded to MED by verifiers (real, but overweighted)
22. PUSH_POLICY constant stale + contradicts autopilot reminder — `prompt-source-lib.mjs`
23. ship.md landing mechanics impossible as written (folded into 20)
24. Stale fat-CLAUDE.md pointers across ~7 skills + 1 reviewer agent
25. No loop lifecycle state; finished missions validate as launchable with expired push authorizations
26. docs/build-loops/ second abandoned loop system with live-looking STATE files
27. CURRENT_STATE.md stale on ship state while roadmap elevates it
28. docs/roadmap/ mixes live plan with shipped runbooks instructing live DB actions
29. docs/loops + build-loops 95% finished missions in the "active" location
30. CRLF false-stale back in fresh worktrees; pre-commit un-passable there
31. Autopilot arming is a frictionless allow-listed command (settled-design residual; verifiers note KNOWN_ISSUES §4b already documents the honest-mistake framing)

### MED (unverified, reviewer-reported)
- SAFE_DEVELOPMENT_RULES.md stale anchors: "57 pages" (real: 76), "red lines live in CLAUDE.md", "remind Mason to commit" (×2 reviewers)
- codex-gauntlet.md duplicates CODEX_REVIEW_GAUNTLET.md (already divergent); both hijack "Run preflight." trigger
- codex-gauntlet.md claims strict db-sweeps gate hasn't landed; `--strict` exists and is never used
- review-workflow.md claims .agents/.codex/generate-workflow-map.mjs "intentionally untracked" — all tracked
- backup-db.md claims its dump is "the only restorable copy" — superseded by two other backups
- preflight.md references a CLAUDE.md "Snapshot" counts section that no longer exists
- typescript-types-drift-reviewer recommends the stamp-only registry script as the staleness fix
- Zero test coverage on four wired deny-capable guards (env-guard, rls-on-new-tables, grant-change-guard, money-safety)
- agent-guardrails.md: Codex merge guard marked "Pending activation" though ACTIVE; stamp-only registry command twice recommended as "refresh"
- Armed-autopilot state invisible in every status surface
- Hardcoded edge-function inventories in two workflow prompts wrong (skip epa-lookup; audit a phantom function)
- money-inventory-hunt.js superseded copy-paste fork of overnight-bug-hunt.js (two bug-class canons)
- OWNER_PLAYBOOK still describes direct pushes (folds into Theme 1)
- DECISION_LOG format-contract violations (in-place rewrite, unbumped stamp, 60-line entries)
- 2026-07-15 execution board unreachable from manual layer (folds into 18)
- coding-guidelines.md "CRX precedence" note contradicts two settled policies
- check-doc-drift runs only in husky pre-commit, not CI
- "Add a new page" recipe drifted (PAGE_PERMISSIONS missing, wrong path, dead count instruction)
- docs/audits/ 69 entries, no status convention
- PROMPT_TEMPLATES.md 4.5 months stale, teaches superseded protocol
- Worktree-portability gate scans 12 of ~40 sources; regex misses single-backslash paths
- Autopilot arm frictionless (see 31)

### LOW (unverified)
- dangerous-phrase-warning force-push text implies conditional permission the hooks deny
- rollback.md hardcodes stale 5-function edge-function list
- claude-review.md yields same-model review when invoked from Claude
- codex-gauntlet SKILL.md frontmatter invalid YAML (unquoted colon) → harness falls back to body text
- Ledger guard accepts any docs/loops/ file as "the" ledger
- run-loop.md cites Mason's private memory files as normative sources (also flagged MED by redteam for other docs)
- AGENT_ONBOARDING dead conditional re ARCHITECTURE.md existence
- gotchas.md "Environment Quirks" fully stale; small dangling citations
- CONTRIBUTING.md points at CLAUDE.md as "full project conventions"
- agent-health sync-failure remedy points at vestigial no-op flag; duplicates CRLF-fragile byte-compare
- Generated adapters carry no in-file "do not edit" marker
- Stale environment/inventory facts in gotchas.md + rollback runbook (bash-safety db-reset message says "356 migrations"; real: 703)

---

*Raw per-agent evidence: workflow run wf_fe82905b-da8, journal at the session transcript dir. Every confirmed finding above carries file-level citations in the raw output.*

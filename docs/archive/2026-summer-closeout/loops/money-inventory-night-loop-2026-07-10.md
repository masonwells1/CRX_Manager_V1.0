# Money + Inventory Night Loop — 2026-07-10

Self-contained, self-improving overnight find→verify→fix→review→ship loop over **all workflows and everything touching money or inventory**, launched on Mason's instruction 2026-07-10 ("find bugs and flawed logic … fix all the issues and adversarial review all work and ship and commit all changes tonight while I go to sleep. You have full permission"). Autopilot armed until 2026-07-11T12:55Z (~06:55 America/Chicago).

## Driver

**Fable (this session) orchestrates; it writes no finding and blesses no fix alone.**
- **Hunt + adversarial verify:** the `money-inventory-hunt` Workflow (`.claude/workflows/money-inventory-hunt.js`) — one **Opus** finder agent per subsystem, each finding then adversarially refuted by an independent **Opus** verifier (read-only, grounded against live DB + code). Sonnet may be used for mechanical side-tasks (doc/ledger upkeep); Opus for anything money-grade.
- **Independent second model:** **Codex (gpt-5.5)** via `scripts/overnight-codex-gate.mjs` — a FINDING-GATE (only Codex-confirmed findings get fixed) and a FIX-GATE (only Codex-SHIP'd diffs get committed). Codex model tier by complexity (sol default; escalate reasoning for BLOCKER money logic).
- **Fixes:** Claude (Opus-grade) writes the minimal surgical fix through the project's PreToolUse seatbelt hooks; migrations additionally go through the `migration-review` Workflow (rls-security + migration-drift + types-drift reviewers, adversarial BLOCKER verification) before any apply.
- **Next cycle trigger:** self-scheduled via ScheduleWakeup (~20–30 min heartbeat); no owner input expected until morning.

## Granularity

One reviewed unit = **one confirmed finding's fix** (per-finding Codex fix-gate + per-finding commit). One cycle = **2–3 subsystem slices** hunted → gated → fixed → shipped, then ledger + report updated before the next cycle is scheduled. Hard cap 3 fix-gate rounds per finding — still NEEDS-WORK after 3 → revert + PARK.

## Worktree

`C:\CRX_Manager\.claude\worktrees\inspiring-proskuriakova-7d5713`, branch `claude/inspiring-proskuriakova-7d5713` (this loop owns it; merged up to `origin/main` @aa48624f at launch). Ship path: commit here → push the branch → merge/push to `main` once green (auto-push authorized 2026-06-16).

## Definition of done

The loop stops when ANY of: (a) all 9 subsystem slices hunted and **2 consecutive dry cycles** (no new confirmed findings); (b) ~06:30 America/Chicago / autopilot expiry approaching; (c) Mason says stop. At stop, EVERY confirmed finding is either **SHIPPED** (fix committed + pushed to `main`; migration fixes also applied live after the full gate stack) or **PARKED with a written reason**, the ledger (`docs/audits/overnight-bug-hunt/LEDGER.json`) and a morning report (`docs/audits/overnight-bug-hunt/REPORT.md`, new 2026-07-10 section) are complete, and `docs/CHANGELOG.md` has the session entry. Every shipped fix carries PROOF (ran + saw), a Codex verdict, and — for BLOCKER/HIGH — a regression test or invariant sweep.

## Delivery gate

Mason granted ship permission for tonight in the launch message ("ship and commit all changes tonight … You have full permission"). Concretely:
- **Frontend / docs / test fixes:** commit + push to `main` once Codex fix-gate = SHIP and `typecheck`+`build`+`test` are clean (standing auto-push policy).
- **Migration fixes:** may be **applied live** tonight ONLY after ALL of: 3-reviewer `migration-review` verdict clean → Codex verdict clean → rolled-back live smoke (`BEGIN;…;ROLLBACK;` / plpgsql_check) → apply-guard proof stamped. Anything short of a fully clean gate stack → **PARK, do not apply**.
- **Never tonight (parked for Mason regardless):** edge-function deploys, deletion/mutation of real business data (live writes only via `[E2E]` fixtures, cleaned up after), anything touching Stripe keys/secrets, `--no-verify`, unrelated files in commits.

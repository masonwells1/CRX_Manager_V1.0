# ChemMan Gap-Closeout Loop — KICKOFF & Resume Playbook

**State:** SCAFFOLDED → building. Worktree `C:\CRX_GapLoop`, branch `feat/chemman-gap-closeout` (based on `feat/fieldapp-beyond-parity`).
**Scope:** EXACTLY two sections — weather auto-fill + diluent-per-acre on the field-application invoice. Everything else from the ChemMan comparison is already built; do NOT rebuild.

## Pre-flight check (run FIRST, every start/restart)
1. **Solo check:** `git branch --show-current` == `feat/chemman-gap-closeout`; `git status` shows only your own changes (ignore `package-lock.json` install churn — never stage it). If you see edits you didn't make, STOP and tell Mason.
2. **Resume state:** re-read `LEDGER.md` + `PROGRESS.json`. The first section not `BUILT` is next.
3. **Deps:** if `node_modules` is missing, `npm install` first.
4. **Local DB:** confirm the LOCAL throwaway Supabase (`C:\Users\mason\fieldapp-local-db`) is up and carries the beyond-parity migrations through `20260630170000`. If its ledger is behind, apply NEW migrations via direct psql against the parity schema (the parity loops' established MO), not a full `db reset`. Capture the env block (DB URL / anon key / API URL) to hand to build subagents.

## First actions on kickoff
1. Build **Stage 1 (weather auto-fill)** via a fresh Opus build subagent using `BUILD-SUBAGENT-TEMPLATE.md` + its `BACKLOG.json` section (id 1).
2. Then **Stage 2 (diluent per acre)** (id 2). They're independent; Stage 1 first only keeps the two migrations cleanly timestamp-ordered.

## The loop (per section) — see `LOOP.md` for the full spec
Build → prove it RUNS (apply migration to LOCAL + rolled-back smoke; open the field-app invoice and use the new button/box) → **Codex review (fix all High/Med, park Low; max 3 rounds)** → record in `PROGRESS.json` + regenerate `LEDGER.md` → snapshot-commit both → next section. Fully hands-off until the production gate. Both stages touch the `invoices` money table → migration-drift + compliance lenses; the diluent printout → pdf-output lens. **Always run the orchestrator's own independent Codex even after a subagent self-reviews.**

## Resume after a pause/restart
- **Source of truth = `LEDGER.md`** (regenerated from `PROGRESS.json`) + this file.
- Re-read `PROGRESS.json`: continue from the first section not `BUILT`. Re-run the solo + sole-instance checks first.
- If the tracker looks reverted (an agent `git clean`/reset), restore from the latest `docs(chemman-gap-closeout): ledger snapshot` commit.

## HARD STOP — the production gate (end of run)
Never promote/deploy without Mason's explicit approval. At the gate, deliver a plain-English report (each feature + evidence; the Parked-Low list; BOTH migrations explained via `explain-migration`, to apply in TIMESTAMP order; open questions; the production-promotion plan), and **flag that beyond-parity must be on `main` first or together**. Then on his go-ahead: apply the two migrations to PROD in order → deploy code. Bind each apply-guard proof to the TRANSMITTED SQL hash (the MCP strips a trailing newline).

## Quick reference
- Plan (owner-facing): `PLAN.md` · Operating spec: `LOOP.md` · Spec: `BACKLOG.json` · State: `PROGRESS.json` → `LEDGER.md` · Subagent prompt: `BUILD-SUBAGENT-TEMPLATE.md`

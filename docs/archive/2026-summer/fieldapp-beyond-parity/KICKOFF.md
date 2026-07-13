# Field-App Beyond-Parity Loop — KICKOFF & Resume Playbook

**State:** SCAFFOLDED — not started. **Do NOT start until the ChemMan-parity rebuild is shipped to the live site.**
**Start trigger:** Mason says something like "start the beyond-parity loop" (after he's shipped parity).

## Precondition check (run FIRST, before anything)
1. **Parity is live:** confirm `feat/fieldapp-parity` is merged into `origin/main` and deployed (the parity field-app — invoice engine, chemical-entry UI, dispatch, the read-only Unbilled list — is on `main`). If not, STOP and tell Mason "parity isn't shipped yet; this loop builds on top of it."
2. **You are alone:** only ONE session/worktree runs this loop. Re-read `PROGRESS.json` + `git status` fresh; confirm no parallel session is on the same checkout (parallel sessions collide — branch can switch under you, the index is shared).

## First actions on kickoff
1. **Create the worktree + branch** off the then-current `origin/main`: `feat/fieldapp-beyond-parity` (a dedicated worktree, e.g. `C:\CRX_BeyondParity`). Run the loop from a CRX-rooted session there so `.claude` hooks + the `codex-review`/`create-migration`/`explain-migration` skills + reviewer subagents load.
2. **Refresh the LOCAL throwaway DB** (`C:\Users\mason\fieldapp-local-db`) so its migrations include everything now on `main` (the parity work). Confirm `supabase status` is healthy and capture the env block (DB URL / anon key / API URL) to hand to build subagents.
3. **Confirm the open sequencing decision with Mason** (one line): default = build the 4 internal features first (§1→§2→§3→§4→§5), then §6, then the portal (§7→§10). He may drop the portal this round or move it earlier. Lock the order, then start §1.
4. **Build §1** via a fresh subagent (`BUILD-SUBAGENT-TEMPLATE.md`) using its `BACKLOG.json` entry. Then §2, §3, … per `buildOrder`, respecting `depends_on`.

## The loop (per section) — see `LOOP.md` for the full spec
Build → prove it RUNS (open the page/do the action) → **Codex review (fix all High/Med, park Low; max 3 rounds)** → record in `PROGRESS.json` + regenerate `LEDGER.md` → snapshot-commit both → next section. Fully hands-off until the production gate. §4 (money) and §7–§10 (portal) get extra review; nothing touches prod during the run.

## Resume after a pause/restart
- **Source of truth = `LEDGER.md`** (regenerated from `PROGRESS.json`) + this file.
- Re-read `PROGRESS.json`: the first section not `BUILT` is next. Re-confirm precondition + sole-instance checks, then continue.
- If the tracker looks reverted (an agent `git clean`/reset), restore from the latest `docs(fieldapp-beyond-parity): ledger snapshot` commit.

## HARD STOP — the production gate (end of run)
Never promote/deploy without Mason's explicit approval. At the gate, deliver a plain-English report (each feature + evidence; the Parked-Low list; every migration explained via `explain-migration`, to apply in TIMESTAMP order; open questions; the money + portal risk callouts), then on his go-ahead: apply migrations to PROD in order → deploy code → (if §6) deploy edge fn with his OK → the §1 label-data load is his review task → portal go-live is his explicit sign-off. Bind each apply-guard proof to the TRANSMITTED SQL hash (the MCP strips a trailing newline).

## Quick reference
- Plan (owner-facing): `PLAN.md` · Operating spec: `LOOP.md` · Spec: `BACKLOG.json` · State: `PROGRESS.json` → `LEDGER.md` · Subagent prompt: `BUILD-SUBAGENT-TEMPLATE.md`
- Ideas source: `C:\Users\mason\Documents\CRX-FieldApp-Beyond-Parity-Opportunity-Map.md`

# Field Mapping + Per-Acre Billing — Autonomous Build Harness

A self-running, **Codex-gated** build loop that builds the field-mapping → per-acre-billing upgrades to "ready," unattended, stopping only at the gates that need the owner (Mason). Proves everything on a **disposable Supabase dev branch — never production** — so it runs safely alongside the live `feat/as-applied-invoices` session.

## Files
| File | What it is |
|---|---|
| `SCOPE-OF-WORK.md` | The spec — what to build, what already exists, the Track A / Track B split, acceptance criteria, hard gates. **Read first.** |
| `BUILD-LOOP.md` | The phased runbook — Codex helper + reviewer every phase, the per-phase recipe, the hard stops. |
| `STATE.md` | Live progress tracker; makes the run resumable. |
| `HANDOFF.md` | Written by the loop at the end — what's built + the exact steps Mason approves to go live. (Does not exist until the loop reaches a handoff.) |

## How to launch (Mason)
1. Open a **fresh session in this worktree** (`C:/CRX_FieldMapping`, branch `feat/field-acre-billing`) so it doesn't collide with other live sessions.
2. Run this one line:

   ```
   /loop Execute the field-acre-billing build per docs/build-loops/field-acre-billing/BUILD-LOOP.md — read STATE.md, do the next PENDING phase end-to-end (Codex-help → build → prove on a Supabase dev branch → subagent + Codex review to SHIP → commit → push the feature branch → update STATE.md), then continue. STOP at any BLOCKED/AWAITING phase, a stuck phase, or a hard gate.
   ```

   (`/loop` with no interval self-paces — it keeps going on its own until the loop says stop.)
3. Walk away. It builds **Track A** (the field-mapping foundation — drawing/import/acreage), proving + Codex-reviewing each phase, then writes a handoff and **stops at the live-apply gate**.

## What it will and won't do
**Will (autonomously, Track A):** refresh the schema registry, write the migrations (two-acre columns + the server-side acreage RPC), add the `.zip` importer + override UI, prove everything on a Supabase **dev branch**, get Codex + the subagent reviewers to a clean verdict every phase, commit, and push the **feature branch**.

**Will NOT (parks for your one-click OK):** apply migrations to the live database · merge/push to `main` · deploy · delete data. The whole feature lands together once you approve (the new UI calls functions that don't exist until the migration is live).

**Will NOT yet (BLOCKED by design):** the billing-engine hardening + bill tie-in (**Track B**) — those edit the same files the `feat/as-applied-invoices` session is changing. They stay BLOCKED until you confirm that session merged to `main`; then say "the as-applied session is merged" and the loop re-grounds and builds Track B.

## When it's done (Track A)
The loop writes `HANDOFF.md` and sets `STATE.md` Track A = **AWAITING-OWNER-APPROVAL**, then notifies you. `HANDOFF.md` lists the exact ordered go-live steps. Say "ship the field-mapping foundation" in that session and it runs the live-apply gate with you (you supply one real shapefile / Ops Center / FieldView export for the import proof).

## If something goes wrong
- **Codex unavailable** → the loop STOPS and hands off rather than building without the gate. Re-auth (`codex login`) and relaunch; it resumes from `STATE.md`.
- **A phase gets stuck** (same finding twice, or 3 rounds with an open BLOCKER) → STOP, both positions written to `STATE.md`.
- **Crash/restart** → relaunch the same `/loop` line; it reads `STATE.md` and continues.

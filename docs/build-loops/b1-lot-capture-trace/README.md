# B1 Lot Capture & Trace — Autonomous Build Harness

A self-running, **Codex-gated** build loop for a **fresh session** to build the B1 feature to "ready," unattended, stopping only at the gates that need the owner (Mason).

## Files
| File | What it is |
|---|---|
| `SCOPE-OF-WORK.md` | The complete, self-contained spec — what to build, what already exists, what's out of scope, acceptance criteria, hard gates. **Read first.** |
| `BUILD-LOOP.md` | The phased autonomous runbook — how to build it, with Codex as helper + reviewer every phase, the per-phase recipe, and the hard stops. |
| `STATE.md` | Live progress tracker. The loop updates it after every phase; it makes the run resumable. |
| `HANDOFF.md` | Written by the loop at the end — what's built + the exact steps Mason must approve to go live. (Does not exist until the loop finishes.) |

## How to launch (Mason)
1. Start a **fresh, dedicated session in a new worktree** (e.g. `crx-new-session`) so it doesn't collide with other live sessions.
2. In that session, run this one line:

   ```
   /loop Execute the B1 Lot-Capture build per docs/build-loops/b1-lot-capture-trace/BUILD-LOOP.md — read STATE.md, do the next phase that isn't DONE end-to-end (Codex-help → build → prove it runs → subagent + Codex review to SHIP → commit → push the feature branch → update STATE.md), then continue. Stop only at a hard gate, a stuck phase, or when all phases are DONE.
   ```

   (`/loop` with no interval self-paces — it keeps going on its own across turns until the loop tells it to stop.)
3. Walk away. It will build, prove, and Codex-review each phase, committing as it goes.

## What it will and won't do
**Will (autonomously):** create the feature branch, refresh the schema registry, write the migration, build the RPCs + UI, prove everything runs (Supabase dev branch or rolled-back smoke), get Codex + the subagent reviewers to a clean verdict every phase, commit, and push the **feature branch** to origin.

**Will NOT (parks for your one-click OK):** apply the migration to the live database · merge/push to `main` · deploy · delete data. The whole feature lands together once you approve, because the new screens call database functions that don't exist until the migration is live.

## When it's done
The loop writes `HANDOFF.md` and sets `STATE.md` to **AWAITING-OWNER-APPROVAL**, then notifies you. `HANDOFF.md` lists the exact ordered steps to take it live (apply migration → regen registry → post-apply smoke + sweeps → merge → deploy → in-app check). At that point, just say "ship B1" in that session and it runs the live-apply gate with you.

## If something goes wrong
- **Codex unavailable** → the loop STOPS and hands off rather than building without the gate. Re-auth Codex (`codex login`) and relaunch; it resumes from `STATE.md`.
- **A phase gets stuck** (same review finding twice, or 3 rounds with an open BLOCKER) → it STOPS and writes both positions to `STATE.md` for you to decide.
- **Crash/restart** → relaunch the same `/loop` line; it reads `STATE.md` and continues from the next unfinished phase.

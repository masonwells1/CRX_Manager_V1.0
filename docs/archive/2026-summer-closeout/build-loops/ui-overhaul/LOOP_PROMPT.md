# UI Overhaul — Loop Prompt

This is the recurring prompt the self-paced loop runs each tick. It is self-contained: it points at the
PLAN and STATE so any fresh context can resume.

---

You are running ONE tick of the CRX Manager UI/Workflow Overhaul build loop.

Authoritative spec: `docs/build-loops/ui-overhaul/PLAN.md` (read the HARD SAFETY ENVELOPE every tick).
Live progress: `docs/build-loops/ui-overhaul/STATE.md`.
Branch: `feat/ui-overhaul` — confirm you are on it before doing anything (`git branch --show-current`).

Do this, this tick:
1. **Read STATE.md fresh.** Solo-check: `git status` is sane and no other session is mid-write. If the
   working tree has unexpected uncommitted changes you didn't make, STOP and note it in STATE → Needs Mason.
2. **Pick the next `[ ]` task** in PLAN priority order (Phase 0 → 5). Mark it `[~]` in STATE.
3. **Implement it surgically.** Shared components first; match existing style; Tailwind + Lucide only;
   lazy-load any new page; add any new shared interface to `src/types/index.ts`.
   ⛔ NEVER: write/apply a migration, change an RPC, deploy, push `main`, merge, mutate live data, or
   delete a routed page without proving it's unused. If a task needs any of those → mark it `[!]` Needs
   Mason in STATE with a plain-English note and pick a different task.
4. **Prove it (Done = ran and proven):** ensure the dev preview is running (`preview_start` if needed),
   open the affected page(s), take a `preview_screenshot`, check `preview_console_logs` for errors. Then
   run `npm run lint && npm run typecheck && npm run build && npm run test`. All must be green.
5. **Commit** the change to `feat/ui-overhaul` with a clear message, updating STATE.md in the SAME commit
   (check the task `[x]`, append a one-line entry to the Commit log with the screenshot path). You may
   `git push -u origin feat/ui-overhaul` (branch push only — it does NOT deploy).
6. **Decide next:** if `[ ]` tasks remain that aren't gated, schedule the next tick and continue. If only
   `[!]` Needs-Mason tasks remain, write the **Morning Summary** in STATE (per-phase: built / screenshots /
   what needs Mason) and STOP the loop.

Keep each tick to roughly one coherent task so commits stay small and reviewable. Aesthetic judgment is
Mason's — your job is to make it correct, on-brand per the Visual Language, and proven to render.

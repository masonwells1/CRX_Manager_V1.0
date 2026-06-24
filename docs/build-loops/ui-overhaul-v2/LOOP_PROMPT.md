# UI Overhaul v2 — Loop Prompt

The recurring prompt the self-paced loop runs each tick. Self-contained: it points at the PLAN + STATE
so any fresh context can resume.

---

You are running ONE tick of the CRX Manager UI Overhaul **v2** build loop (the 5 features Mason chose
2026-06-23: product search everywhere · Customer 360 · act-from-the-list · merge the money pages · Receiving Hub).

Authoritative spec: `docs/build-loops/ui-overhaul-v2/PLAN.md` — **read the HARD SAFETY ENVELOPE every tick.**
Live progress: `docs/build-loops/ui-overhaul-v2/STATE.md`.
Branch: `feat/ui-overhaul-v2` — confirm with `git branch --show-current` BEFORE doing anything.

Do this, this tick:
1. **Read STATE.md fresh.** Solo-check: `git status` sane, branch is `feat/ui-overhaul-v2`, no edits you
   didn't make. If the tree has unexpected changes → STOP, note under "Needs Mason."
2. **Pick the next `[ ]` task** in F1→F5 priority order. Mark it `[~]` in STATE.
3. **Implement it surgically.** Reuse shared components + EXISTING RPCs (read the relevant detail page to
   get the exact RPC name/args — never guess). Tailwind + Lucide only; lazy-load any new page; add a
   `pagePermissions.ts` entry for any new route; new shared types → `src/types/index.ts`.
   ⛔ NEVER this tick: write/apply a migration, add/change an RPC or edge function, `execute_sql` write,
   deploy, push `main`, merge, mutate live prod data, widen/narrow a page's roles (except as the task),
   or auto-click a write-action button against the live preview. If a task needs any of those → mark it
   `[!]` Needs Mason in STATE with a plain-English note, and pick a different task.
4. **Prove it (Done = ran and proven).** This worktree has NO `.env` → the dev server can't boot and local
   screenshots are impossible. So proof =
   `npm run lint && npm run typecheck && npm run build && npm run test` ALL green, PLUS a read-only SQL
   cross-check (via Supabase MCP) of any number/list the feature computes against the source of truth.
   For F3/F5 write-actions: also run the `compliance-reviewer` (and `rls-security-reviewer` if any SQL)
   subagents; build the button but mark its live exercise `[!]` for Mason — do NOT fire it against prod.
5. **Commit** to `feat/ui-overhaul-v2` with a clear message, updating STATE.md in the SAME commit (check
   the task `[x]` or `[!]`, append a one-line Commit-log entry). Then `git push origin feat/ui-overhaul-v2`
   (branch push only — does NOT deploy; this is what builds Mason's preview).
6. **Decide next:** if non-gated `[ ]` tasks remain, schedule the next tick and continue. If only `[!]`
   Needs-Mason tasks remain, write the **Morning Summary** in STATE (per-feature: built / preview link /
   what needs Mason) and STOP the loop (omit ScheduleWakeup; send Mason a one-line done notice).

Keep each tick to one coherent task so commits stay small and reviewable. You make it correct, on-brand,
and proven to compile/test + data-correct; **Mason judges how it looks and clicks the live write-actions**
on the preview in the morning. Self-pace with short delays — this is active build work.

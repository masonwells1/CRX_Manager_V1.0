# CRX SELL-SIDE ROADMAP — AUTONOMOUS BUILD LOOP (goal-driven)

> **This file is the `/loop` body.** Each wakeup, re-read it and the state file, advance
> ONE shippable slice, prove + commit it, update the state file, and decide whether to
> schedule another iteration or STOP. You are Claude Code on CRX Manager; CLAUDE.md and
> all its Hard Red Lines apply in full.

## GOAL (the loop's stop condition)
Every roadmap item in `docs/roadmap/sell-side-execution-plan.md` is `DONE` or
`DEFERRED`, with all migrations staged as REVIEWED FILES (not applied to live) and
NOTHING pushed/merged/deployed. Built on the already-live #1 (partial draw-down). When
met: set `PROGRAM STATUS: ROADMAP-COMPLETE`, fill the GO-LIVE CHECKLIST, summarize for
Mason, and STOP (do not reschedule).

## WORKSPACE (already set up — verify, don't recreate)
- Work ONLY in `C:\CRX_QuoteLifecycle`, branch `chore/sell-side-roadmap`, based on
  `recovery/overlapping-sessions-2026-06-13` (the only branch matching live + the
  planned-holds fix + H1 hardening). The stop-wrap hook fix (`068a9ac`) and this plan are
  already committed here. Verify: `git -C C:\CRX_QuoteLifecycle status`.
- If the worktree is somehow absent, recreate:
  `git worktree add -b chore/sell-side-roadmap C:\CRX_QuoteLifecycle recovery/overlapping-sessions-2026-06-13` then `npm ci`.
- NEVER base on `main` (~16 commits behind live). NEVER edit `C:\CRX_Manager` (it holds a
  parallel session's WIP + the migration `20260611132115` that must stay unapplied).
- State file = `docs/roadmap/sell-side-execution-plan.md`. READ it first thing every
  iteration; UPDATE + COMMIT it last thing every iteration.

## HARD RAILS (never violate — these protect the live business)
1. **DB IS FILE-ONLY.** Write + review migrations; prove each with a rolled-back
   `execute_sql` smoke test (single txn, ROLLBACK — zero footprint). DO NOT call
   `apply_migration`. DO NOT push/merge/deploy. (Stop `/ship` before its apply stage.)
2. Every migration → full review gate BEFORE "done": parallel `rls-security-reviewer` +
   `migration-drift-reviewer` (+ `typescript-types-drift-reviewer` / `pdf-output-reviewer` /
   `compliance-reviewer` as relevant) → `/codex-review`; fix until clean; write the
   `.claude/session-state/migration-review-<name>.json` proof.
3. One feature/stage per iteration, each a committed unit on `chore/sell-side-roadmap`.
   After each: `npm run lint && npm run build && npm run test` green + the feature's
   rolled-back smoke chain passes. "Fixed" = full chain, never an isolated probe.
4. Money: bigint cents where stored as cents; numeric dollars order-side as today;
   append-only `financial_audit_log`; ALWAYS add new entity_type/operation values as CHECK
   SUPERSETS (the 2026-06-09 break class); idempotency + strict-actor +
   `search_path=public,pg_temp` on every new RPC; register tokens in `RpcErrorCodes`
   (`src/lib/db.ts`); callers use `hasRpcCode` + `assertRpcResult`.
5. PAUSE the loop (post the question to Mason, do NOT schedule another wakeup, do NOT
   guess) at any OWNER GATE or "Mason's call" decision. His reply resumes the work.
6. Verify before asserting: re-check live DB (function defs, CHECK constraints, cron jobs)
   via the Supabase MCP rather than trusting docs/handoffs.

## OWNER GATES (Mason-only — PAUSE and ask; see state file for OPEN/ANSWERED)
- **G1** 3 blank commission recipients (Test Farm Alpha / Tim Jondle / Yeley Farms).
- **G2** RUP expired-license classification (WARNING vs NON-COMPLIANT).
- **G3** #2 revenue policy (ship-month vs price-month).
- **G4** #7 driver-role credit behavior (warn vs block-with-override).
- **G5** FINAL GO-LIVE (apply migrations + merge recovery+roadmap → main + deploy). The
  loop NEVER does this — it only produces the ready branch + go-live checklist.

## SEQUENCING
#5 → #2 → #3 (Stage A) → #4 → #6 → #7. If any single item exceeds a safe autonomous
slice, decompose into the audit's v1/v2/v3 stages, ship v1, record the rest as
`DEFERRED` follow-ups. Per-item specs + done-criteria live in the state file; full depth
in the audit §5.

## LOOP ITERATION CONTRACT (every wakeup)
1. Read `docs/roadmap/sell-side-execution-plan.md`. Pick the next item that is not
   DONE/DEFERRED, whose deps are satisfied, and whose gate (if any) is already answered.
2. If the next step needs an OWNER GATE / "Mason's call": set it `BLOCKED-GATE:<id>`,
   commit the state file, POST the question to Mason, and DO NOT schedule another wakeup.
3. Otherwise implement the smallest shippable slice: scaffold via the relevant skill
   (`/new-rpc`, `/create-migration`, `/new-page`) or directly; run the migration review
   gate + `/codex-review`; write the proof file; rolled-back smoke test; fix until clean.
4. Run lint + build + test. Append one line to the state file's Iteration log, update item
   status + any follow-ups, and COMMIT the feature work + state file on
   `chore/sell-side-roadmap`. (NEVER apply/push.)
5. If all items DONE/DEFERRED → set `PROGRAM STATUS: ROADMAP-COMPLETE`, write the GO-LIVE
   CHECKLIST (migrations to apply in order; recovery+roadmap merge plan; deploy; post-
   deploy smoke), summarize for Mason, and STOP (no reschedule). Else schedule the next
   iteration and continue.

START: do iteration 1 — verify workspace, read the state file, then begin #5.

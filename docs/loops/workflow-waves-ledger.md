# Workflow Waves Loop — Ledger

Mission: `docs/loops/workflow-waves-loop-2026-07.md` · Worktree: `C:\CRX_WorkflowLoop` · Branch: `feat/workflow-waves-2026-07`
Driver: Codex 5.6 builds (sol/terra/luna) · Claude Fable orchestrates + reviews (Opus money/DB, Sonnet light)

**Loop start (UTC): 2026-07-09T20:12:33Z** → hard wrap target ~2026-07-10T05:12Z (~9h)

## Step 0 — setup

- Collision check: `git worktree list` clean — this session owns `C:\CRX_WorkflowLoop` @ `f467d6c5`, no foreign WIP. `origin/main` NOT moved past base (branch ahead 2 = the harness commits).
- codex-cli **0.144.0** (≥ 0.144 ✓). `npm install` → up to date.
- Wrapper self-test: Codex `gpt-5.6-terra` wrote `scripts/.codex-build-selftest.txt` with token `WAVES-SELFTEST-OK-20260709` — verified content, deleted. **Builder mechanic proven.**
- Schema registry: disk registry (generated 2026-07-07) verified FRESH against live — migrations high-water `20260707181920` identical, 135 CHECK constraints = 135 live, `quotes.status` includes `closed_short`, 5 generated cols, 7 sequences, 117 tables. No rebuild needed.
- Live migration high-water: **20260707181920** — all new migrations must timestamp above this.
- Baseline green: `npm run typecheck && npm run build && npm run lint && npm run test` → exit 0. **195 test files, 3155 passed / 125 skipped, 0 failures.**

PROOF — Ran: wrapper self-test (terra), live introspection Q1–Q5 + count cross-check, full baseline pipeline · Saw: self-test token file exact match; registry↔live counts identical; tests 3155/0 fail · Not verified: n/a.

## Units

<!-- Per-unit entries appended below: id · status · tier used · build rounds · review verdict · migration live-version · commit SHA · PROOF line · notes -->

### A1 — Finished job stays visible on My Day → SHIPPED
- **Tier:** builder `gpt-5.6-sol` (2 rounds — round 1 stalled asking for confirmation, no diff; round 2 built clean). Reviewers: Opus `rls-security-reviewer` (0 BLOCKER / 0 HIGH / 1 MED — gate comment claimed exact RLS mirror; comment corrected in-file to document the deliberate completed-tail relaxation), Opus `migration-drift-reviewer` (0 BLOCKER — re-emit verified against latest U12 base line-by-line, columns vs registry), Sonnet `compliance-reviewer` (1 MED — legacy tail anchors on `jobs.updated_at`, accepted + documented in FieldView comment).
- **Root cause (grounded live):** trigger `_close_job_location_dispatch_on_job_terminal` flips dispatch rows to 'completed' at job-terminal; `get_dispatched_list` filtered `='dispatched'` → card vanished. FieldView's legacy whole-job merge also filtered to scheduled/in_progress. (The audit finding blamed only the RPC; the trigger interaction + legacy path were found at grounding.)
- **Change:** migration `20260709190000_a1_dispatched_list_recent_completed.sql` (APPLIED LIVE **v20260709203120**) — RPC re-emit + 7-day completed tail ('cancelled' excluded so undispatched applicators don't keep seeing jobs); FieldView legacy merge widened (completed/invoiced, 7-day window); DispatchBoard filters the tail back out; stale dispatchDisplay comment rewritten; +1 unit test.
- **Independent review note:** Codex built; Claude (Fable + Opus/Sonnet subagents) reviewed — author≠reviewer preserved.
- PROOF — Ran: rolled-back live smoke (BEGIN;migration+post-checks+execution probe;ROLLBACK) · live post-apply SELECT (has_a1_tail=true, anon_can_exec=false, overloads=1, stamped v20260709203120) · overload+search_path invariant sweeps (0 rows) · live PostgREST parse-check of the nested `.or()` filter (HTTP 200) · typecheck/lint/build/targeted vitest green · Saw: all green, fn live with the tail · Not verified: a real phone completion moving a card into Done (0 live dispatch rows to exercise; behavior covered by the unit test + RPC execution probe).

### A1b — `_is_dispatched_to_me` completed tail (A1 follow-up) → SHIPPED
- **Origin:** the §4.7 push-gate Codex verdict (sol, read-only) returned P2: the RLS helper still required `dispatch_status='dispatched'`, so a split assignee's Done card showed customer "Unknown" + empty expanded detail. Verified live (helper source + the 4 dependent `*_select_location_dispatchee` SELECT-only policies) — CONFIRMED, fixed rather than argued. (Its P1 — the wrapper's `danger-full-access` — is the mission doc §1 documented, owner-accepted tradeoff; acknowledged-by-design, no action.)
- **Tier:** builder `gpt-5.6-sol` (1 round, exact-to-spec). Reviewers: Opus RLS (0 B/H/M, 1 LOW → owner policy question: should a member added to a crew AFTER completion read that crew's finished job for the remaining 7-day window? bounded/read-only) + Opus drift (0 BLOCKER, byte-diff vs base).
- **Change:** migration `20260709210000_a1b_dispatched_to_me_completed_tail.sql` APPLIED LIVE **v20260709204814** — helper re-emit with the identical 7-day completed tail; cancelled excluded; ACL untouched.
- PROOF — Ran: rolled-back live smoke (migration + 3 post-checks + probe asserting false for a random uuid) · pre-verified anon lacks EXECUTE live · post-apply SELECT (has_tail=true, anon_exec=false, stamped v20260709204814) · Saw: all green · Not verified: an actual split-assignee session rendering the Done card detail (no live dispatch rows; gated logic exercised via the probe + policy inspection).

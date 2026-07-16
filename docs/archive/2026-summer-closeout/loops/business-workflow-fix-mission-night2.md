# MISSION — Business-Workflow Fix Loop, NIGHT 2 (overnight, autonomous)

**You are the orchestrator (Fable) of Night 2 of the overnight fix run.** Mason is asleep and cannot answer questions. Night 1 (2026-07-05→06) shipped U1–U6, U9, U11 and part of U10 — all LIVE. Tonight continues the same mission with the remaining queue.

**READ FIRST:** `docs/loops/business-workflow-fix-mission-2026-07.md`. Its §1 (hard rules), §2 (model routing), §4 (per-unit pipeline), §5 (failure rules) and §6 (report spec) **remain the law verbatim** — this file only replaces the work queue (§3) and adds Night-2 specifics. Source of truth for findings: `docs/audits/business-workflow-review-2026-07/`.

**Worktree:** `C:\CRX_WorkflowFix` · **Branch:** `fix/business-workflow-2026-07` (tracks origin/main; Night 1 pushed through it to main successfully).

---

## 0. Owner authorization — Night 2 (recorded 2026-07-06, morning conversation)

After reading the Night-1 morning report, Mason said **"Set up tonight's run"**, accepting the recommendation to run a second overnight **with the same harness and the same terms**. Therefore the entire Night-1 §0 mandate carries forward unchanged:

1. All 11 report-§6 recommendations remain adopted (the ones already shipped stay shipped — do not re-flip toggles).
2. Commissions on the application channel: YES, **chemical portion only** (this is tonight's U8).
3. **Live migration applies remain PRE-AUTHORIZED, additive-only scope** — same definition and same exclusions as Night-1 §0.3. Full proof protocol per §4 still required for every apply.
4. Scope: everything left, priority-ordered below. What the night doesn't reach stays cleanly queued.

Still absolutely forbidden: edge-function deploys, `deploy_to_vercel`, deleting data, force-push, touching `.env`, modifying other worktrees/branches, committing unrelated files, editing/disabling/routing around any guard hook, arming autopilot.

## 1. Night-2 specifics (additions to the Night-1 rules)

- **STEP 0, before any unit:** (a) refresh `.claude/schema-registry.json` from LIVE introspection via Supabase MCP (the regen script alone only stamps the timestamp) — a daytime check found it stale vs the 5 newest applied migrations, and the deterministic safety hooks validate against it; (b) commit this mission file + the regenerated `docs/app-workflow-map.html` as your first housekeeping commit.
- **HEADLESS PRINT MODE:** you run as `claude -p`. The moment you end your turn, this process and every background child (including a running Codex review) dies. **Never stand by for a background task or notification.** Run Codex reviews and long commands in the FOREGROUND (`run_in_background=false`) and keep working straight through, unit after unit. If something needs a long external wait, park that unit in the ledger and move to the next. Only end your turn after the Night-2 morning report is written. An external driver script relaunches you with `--continue` if you exit early — but never rely on that; treat every turn as your last.
- **Migration timestamps:** live high-water at setup time = `20260706080738`. Re-check `list_migrations` first; every new migration filename/version must be ABOVE the current live high-water. **The parked draft migrations carry stale timestamps (`20260706060000`, `20260706100000`, `20260706090000`) that are BELOW the high-water — re-stamp them** (e.g. `202607070xxxxx`) before anything else.
- **Parked drafts are strong drafts, not gospel.** They live in `scripts/.staging-migrations/workflow-fix-parked/` (`u12/`, `u13/`, plus the U3 follow-up `20260706090000_customers_default_application_service_id.sql`). They were written last night against then-HEAD. Re-ground each against current `origin/main` (main may have moved during the day), then run the FULL §4 pipeline — reviewers, proofs, Codex, live verify — as if newly written. Patch files (`*.patch.md`) describe edits in prose+diff; apply them by editing the real files, not by `git apply`.
- **Report filename:** `docs/loops/business-workflow-fix-morning-report-night2.md` (do NOT overwrite Night 1's report). The external driver watches for this exact path to know you are done. Ledger: append a `## NIGHT 2` section to the existing `docs/loops/business-workflow-fix-ledger.md`.
- **Working-tree hygiene at start:** `docs/app-workflow-map.html` may be dirty (generated file). Run `npm run generate-map` and let it ride into the first unit's commit — do not commit it alone, do not revert blindly.
- **Already done — do not redo:** junk-customer flag list (Night 1), toggle flips (auto-draft ON, warn-not-block ON), schema-registry refresh (re-refresh only if you change schema tonight).
- **HARD WRAP — relative time, replaces Night-1's "07:00" rule:** record your start time in the ledger at step 0. When ~9 hours have elapsed since launch (or the queue empties, or 3 consecutive parks), run the wrap unit (docs sync, final whole-branch Codex review, Night-2 morning report) and end cleanly. The external driver stops relaunching 10 hours after launch — never let the report be the casualty of the deadline.
- **DAYTIME START:** Mason moved this run up to the morning of 2026-07-06. He may be awake and other sessions may land commits on main while you work — `git fetch origin main` + rebase before EVERY push (already the rule, doubly important today). Still treat the run as fully unattended: decisions come from this document, not from waiting on him.

**Night-1 hard-won gotchas (learned last night — you are a fresh session, so read these twice):**
- **Function re-emit chains:** the LIVE text is the base, never the review-era text. `transfer_job_to_invoice` lineage is now U4→U6 (live); `complete_job` is U4→U11 (live). U7/U8 and the U12/U13 drafts must re-emit on top of `pg_get_functiondef` from LIVE, and the U12 draft's `complete_job` touchpoints must rebase on post-`20260706120000` live text.
- **live-testdata-guard blocks rolled-back smokes** of any function whose body contains `INSERT INTO financial_audit_log`. Substitute: `plpgsql_check` + post-apply verification + an [E2E] DO-block ending `RAISE 'SMOKE_PASS_ROLLBACK'`, impersonating via `set_config('request.jwt.claims', json_build_object('sub', <admin_id>)::text, true)`.
- **codex-push-guard blocks the ENTIRE Bash command containing `git push`** — write the `codex-review-<sha>.json` proof file in a separate tool call first, then push in its own call.
- **Migration-apply-guard proof files:** write with Node (PowerShell adds a BOM the hook rejects); `queryHash` = sha256 of the EXACT SQL string passed to `apply_migration`; re-hash after any edit; proofs expire in 30 min — write them right before applying.
- Hold engines still have a unit-normalization gap on the reserve side (Night-1 note) — relevant if U7/U8 touch reservation math.

## 2. Night-2 work queue (execute in order)

- **N2-1 [M] U12 — Applicator "My Day"** (sonnet builder, opus adversarial read on the migration). Integrate the parked `u12/` draft: re-stamped migration + `FieldView.full.tsx` + the 7 patch files. The draft also fixes two real bugs the Night-1 builder verified: a dispatch-authorization gap and a notifications RLS bug — keep both, and make sure the RLS fix gets the full rls-security-reviewer treatment. Scope reference: Night-1 mission U12 (#22/#24-33/#64/#79/#114). Remember §0.1: NO dollar amounts on the applicator card.
- **N2-2 [L] U13 — Assignment unification** (opus builder — it has a migration with triggers). Integrate the parked `u13/` draft: re-stamped migration + 8 patch files. This fixes the confirmed real bug: **every JobDetail save silently wipes the job's dispatch assignments** (cascade delete) — prove the fix with an [E2E] job: save JobDetail, then SELECT the dispatch rows and show they survived. Scope reference: Night-1 mission U13 (#15-21/#111).
- **N2-3 [S] U3 follow-up** — per-customer default application service (`20260706090000_customers_default_application_service_id.sql`, re-stamped). Small; full pipeline anyway.
- **N2-4 [S] Security quick-win** — `generate_rup_sales_records` has NO role gate (any signed-in user can run it; found by the Night-1 sweep, pre-existing). Add the same gate its sibling report RPCs use (read 2–3 of them live first — likely `require_admin()` or the admin+sales pattern) + explicit `REVOKE ... FROM anon` + keep behavior identical for authorized roles. Prove: anon/non-admin call rejected, admin call returns rows.
- **N2-5 [L] U7 — Splits unification** (the big one; opus + extra review). Exactly as Night-1 mission U7, including its safety valve: pick the smaller safe variant if the full one resists, and **if it fights back after 2 Codex rounds, PARK it whole — never half-land split behavior.**
- **N2-6 [M] U8 — Commissions on the application channel** per §0.2 (#99). Chemical-lines profit only, exclude the application-fee line, mirror `_insert_commissions_for_order`'s void/cancel reversal.
- **N2-7 [M] U10 remainder** — `application_records.application_date` from actual start time (fallback job_date) + applicator name/license snapshot columns (#106); job-born invoices stamp season from the job (#109). (The toggle part of U10 shipped Night 1.)
- **N2-8 onward — Wave 2 in order:** U14 (phone-order fast path) → U15 (deliveries both ways) → U16 (billing home) → U17 (booking hygiene) → U18 (safety nets), then **Wave 3:** U19 (nav blueprint) → U20 (entry-point demotions). Scope text for each is in the Night-1 mission §3 verbatim — use it.
- **N2-W [wrap]** — full `npm run test` pass; docs sync (single CHANGELOG entry for Night 2, reference docs, AGENTS.md counts, schema registry via live introspection if schema changed); **final whole-branch Codex review**; write `docs/loops/business-workflow-fix-morning-report-night2.md` per Night-1 §6 spec (lead with status → ONE next step).

## 3. Failure rules delta

Night-1 §5 applies unchanged (2 Codex fails → park; 3 consecutive parks → wrap early; limits → commit everything, park, report early; non-additive need → park with a written plan). One addition: if a parked draft turns out to conflict badly with something that landed on main during the day, don't force it — park with a note naming the conflicting commit.

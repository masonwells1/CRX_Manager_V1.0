# Error-Prevention Review — Why Codex Keeps Returning NEEDS-WORK, and What to Build

**Date:** 2026-06-10
**Scope:** All work since 2026-05-20 (121 commits, 14 Codex review rounds, 52 distinct findings that slipped past internal review), every existing quality gate, plus a Codex-simulation review of the in-flight `ship/partial-quote-draw-down` branch.
**Method:** 12-agent review — Codex-finding taxonomy mined from every audit/disposition doc, quantitative git-history analysis, guardrail gap audit, in-flight diff review with adversarial verification of every significant finding, and control ranking scored by "which past findings would this have caught."

---

## 1. The headline numbers

- Of **121 commits in 3 weeks, exactly 2 are forward product progress.** 33 (27%) are remediation; among *substantive code* commits, remediation is **94%**.
- **14 distinct Codex rounds** are visible; at least 10 returned real findings. Only one batch (money-formatter consolidation) ever came back clean on round 1.
- The 2026-06-09 batch burned **3 Codex rounds**; 9 of its 16 migrations (56%) were post-Codex corrections.
- Four functions each needed **3 separate fix migrations** (`save_blend_ticket`, `batch_apply_all_prepayments`, `unapply_credit_memo`, `get_customer_transaction_review`) because each pass fixed one axis (idempotency OR actor binding OR role gate OR return shape) and internal review passed the function without checking the remaining axes.
- Three times **on 2026-06-08 alone**, an internal fix landed and Codex flagged the missing axis in the *same function within hours* (save_blend_ticket 14:42→15:26, cancel_return 15:41→18:16, restore RPCs 17:42→19:31 — the latter two cases where the internal fix itself *unmasked* the privilege escalation).
- ~13 docs commits are pure Codex-pipeline paperwork. **The cross-review loop now consumes more commits than the proactive audits themselves.**

## 2. Root causes (why internal review keeps missing what Codex catches)

Across all 52 findings, four root causes explain nearly everything:

**RC1 — No deterministic gate ever looks at the LIVE database.**
Every local SQL check (validate-sql.sh, the hooks) is regex over *migration files*. But the dominant finding classes — anon/authenticated-executable SECURITY DEFINER mutators, forgeable `p_performed_by` authorization, missing sequences/columns, phantom migration versions — live in `pg_proc`/`proacl`/`pg_constraint` on the **live** catalog. EXECUTE grants are auto-issued on CREATE FUNCTION and are invisible in migration files. Every sweep escape (`execute_`/`unapply_`/`check_`-prefix functions, the 10 ungated mutators of round 2, `create_direct_order`) was findable by one catalog query that was only ever run *after* Codex pushed back.

**RC2 — Sweeps use name-patterns and memory; the definitive predicate runs last instead of first.**
8 findings are "incomplete-sweep." The pattern repeats: declare a class swept based on a name-prefix regex or a hand-built ledger → Codex enumerates properly → more instances. The definitive predicate ("authenticated-executable SECDEF that mutates AND never references auth.uid()/a sound auth-helper") was discovered *during* round 2 — and the very next morning the sell-side audit found `create_direct_order`, a variant (auth-bound but role-ungated) that the round-2 predicate structurally cannot catch. The class still isn't closed because no standing sweep exists.

**RC3 — Reviewers review the diff; "fixed" gets declared off isolated probes.**
The reviewer subagents scope to the migration diff and explicitly defer "pre-existing" gaps as out-of-scope (this exact deferral let save_blend_ticket's actor gap ship past two clean reviews). And 8 findings are "latent-break-never-exercised": never-exercised RPCs stack *multiple* independent breaks (missing column + CHECK rejection + 42804 cast in one path); B1 was falsely declared "fixed" off a single-insert probe when only the full end-to-end chain (return → credit → statement → unapply) exposes the stack.

**RC4 — Lessons become CLAUDE.md prose, not executable checks.**
Actor-forgery recurred across **six separate dates** after its first "lesson learned" entry. The lesson text is excellent; nothing enforces it. A lesson that doesn't become a hook, predicate file, or test is a lesson that will be re-learned via the next NEEDS-WORK.

**Codex calibration (for fairness):** 3 findings were Codex false positives (it read disk bodies instead of live, over-rated a read-only hook, proposed revokes that would break frontend/cron callers). The standing "verify every claim against live before acting" rule is correct — keep it, both directions.

## 3. In-flight branch `ship/partial-quote-draw-down` — Codex-simulation verdict: **NEEDS-WORK**

The migration (`20260610145253_partial_quote_draw_down.sql`) is **already applied live**; the Codex packet (`d7c368f`) is staged for handoff. Every BLOCKER/HIGH/MED below was independently adversarially verified against the actual code and live catalog (one HIGH was *refuted* and downgraded — noted).

| Sev (verified) | Where | Issue |
|---|---|---|
| **BLOCKER (confirmed)** | `convert_quote_to_order` partially-drawn guard + `QuoteBuilder.executeConvertToOrder` | The `BOOKING_PARTIALLY_DRAWN` guard is **dead code in the real UI flow**: `executeConvertToOrder` calls `saveQuote('accepted')` *before* the RPC. That flips status to `accepted` (enforcer-legal), fires `trg_release_holds_on_quote_status` (releases ALL remaining holds), and convert then sees `accepted` + an existing draw order → returns `already_converted` pointing at the OLD draw order. Net: converting a partially-drawn booking silently closes it, destroys the remaining balance (unrecoverable — `revert_quote_status` blocks `accepted→sent` when orders exist), and toasts success. Fix: don't pre-flip status in the UI for partially-drawn quotes / make convert evaluate draws before honoring `accepted`, e.g. re-order the guard ahead of the `already_converted` short-circuit and gate the UI's pre-save. |
| **HIGH (confirmed)** | `draw_down_quote` idempotency placement | `check_idempotency` runs **before** the `FOR UPDATE` lock and the check/save pair is non-atomic → classic TOCTOU: two concurrent requests with the same key (double-click before re-render; client retry racing a slow request) both pass the check, serialize on the lock, and the second **re-draws and double-inserts the order + commissions** (normal partial-draw case has remaining ≥ qty, so the overdraw guard doesn't save you). Unlike convert, the partial path has no secondary status guard — the key is the *only* protection. Fix: move `check_idempotency` below the `FOR UPDATE` (the lock then serializes the check), per the canonical placement. |
| ~~HIGH~~ → LOW (refuted) | backfill scoped to `status='accepted'` | Claimed double-conversion via the one live cancelled-quote-with-order + `revert_quote_status`; verification confirmed the code facts but the exploit chain doesn't hold at HIGH. Keep as a backfill-completeness follow-up. |
| MED (confirmed) | `void_order`/`cancel_order` vs `quote_product_draws` | Nothing ever decrements the draw ledger. Voiding a draw order restores inventory but the booking balance shrinks forever; a fat-fingered final draw + void permanently strands the booking at `accepted`. Needs a reversal path (decrement on void/cancel of a draw order). |
| MED (confirmed) | `save_quote` vs draws | Partially-drawn quotes are freely editable; edits can set booked qty below `quantity_drawn` (excess silently forgiven) or remove a drawn product (orphan ledger row skews the fully-drawn calc). Needs an edit guard. |
| MED (confirmed) | Lifecycle consumers unaware of draws | decline/cancel/expire on a partially-drawn booking releases remaining holds with no warning; `auto_expire_quotes` targets `sent/revised` past expiry — unscheduled today but one cron away from bulk-expiring open bookings; `rollover_quote_to_season` copies FULL quantities (re-books the delivered half). |
| MED→LOW (verified, downgraded) | new `RpcErrorCodes` | `BOOKING_*`/`EMPTY_DRAW` declared but zero consumers — no `hasRpcCode` mapping in QuoteBuilder; raw Postgres text reaches the toast. |
| LOW | `canConvert`/draw button only on `sent` | RPC allows `revised` too; UI hides draw-down for revised bookings. |
| LOW | draw path skips `checkStaleQuote` | Convert flow checks price staleness; draws (months-later by design) don't. |
| NIT | `-- idempotency-body-check: exempt` self-exemption | Justified here (helpers used), but self-granted exemptions are how guardrails rot — the hook validated nothing in this file. Hook should recognize `check_idempotency()`/`save_idempotency()` helper calls. |

**Action before the Codex handoff:** fix the BLOCKER + HIGH (both are small, contained changes: a guard re-order and an idempotency-placement follow-up migration), and fold this table into the packet so Codex round 1 starts from here instead of rediscovering it.

## 4. The prevention plan — ranked by findings-caught per effort

Full ranking (C1–C15) scored against the 52 historical findings. **Build these three first:**

### Top 3
1. **C1 — `scripts/db-invariant-sweeps/` runner** (catches 14+4 historical findings; runner is small, predicates accrete one file at a time). One read-only Node runner executing per-class `.sql` predicate files against the **live catalog** via MCP `execute_sql`, each with an expected-zero-rows-or-allowlist contract. Runs: post-apply in `/ship`, **before every Codex handoff**, and weekly. Seed predicates: (a) enumerate anon-executable SECDEF (per-function disposition required); (b) authenticated-executable SECDEF with DML and zero auth.uid()/auth-helper reference — *the definitive round-2 predicate, as a standing gate*; (c) actor-forgery: role-subquery referencing any `p_*by` param; (d) auth-bound-but-role-ungated mutators vs UI route allowlists — *the create_direct_order variant*; (e) every SECDEF has `search_path`; (f) zero functions with >1 overload; (g) fold in `plpgsql_check` (Supabase-supported extension, errors-only) for the 42703/42804/missing-relation class. Allowlist entries require a one-time semantic disposition citing live `pg_get_functiondef` (the `allocate_payment` false-positive lesson).
2. **C6 — frontend contract lint + RPC contract test pack** (catches 4; same-day build). ESLint: `assertRpcResult` first arg must be data, never the raw `{data,error}` response; `p_idempotency_key` at rpc callsites must come from `useIdempotencyKey()` (ban `crypto.randomUUID()`/`Date.now()`). Tests: every live idempotency lookup filters `operation = '<fn>'`; fixture RPC arrays diffed against live `pg_proc`.
3. **C2 — rolled-back e2e smoke harness, minimal slice first** (catches 9; the ONLY control that sees the runtime constraint/trigger/double-count class — 5 BLOCKERs on 06-09 alone). `smoke-specs.json` per RPC: the required business chain (e.g. receive_return → issue_return_credit → statement single-count → unapply) + the 4 auth probes (no-auth/forged/wrong-role/anon), run in a rolled-back transaction or branch DB. **Hard rule: "fixed" requires the full chain spec to pass — never an isolated probe.** Plus: execute every report RPC against seeded data weekly.

### Build next (S/M efforts, in order)
- **C10 — lessons-to-checks ratchet** (the meta-control): closing any HIGH+ finding **requires** a sibling executable check (predicate file / hook / test) in the same branch; "class swept" claims must cite the predicate file + full result set. Enforce via `stop-wrap.mjs`.
- **C3 — schema-registry v2 + write gates**: registry dumps ALL CHECK constraints (parsed value sets), NOT NULL columns, sequences, live migration high-water; hooks validate every literal written to a CHECK-constrained column, block `SET col=NULL` on NOT NULL, verify referenced columns exist; staleness by content not mtime; B7 stamp-vs-filename reconciliation automated post-apply.
- **C5 — caller-graph map + grant-change gate**: generated map of every `supabase.rpc()` callsite, every `fetch('/functions/v1/...')` → Edge function *and action branch*, plus live `cron.job`; any migration touching GRANT/REVOKE is blocked unless caller analysis covers EVERY named function (the B10 rule); guards asserted on the Edge branch the UI *actually calls* (the B8 rule).
- **C9 — financial identity suite**: live AR invariants (statement balance == Σ invoice balance_cents; credit memo counted exactly once; Σ allocations ≤ payment) + seeded round-trip fixtures (non-tier price override survives save→reload).
- **C7 — validation integrity gate**: full-vitest-suite marker required per session (no subset greens); on lockfile changes: `npm ci` + `npm ls` + `npm install --dry-run`.
- **C8 — doc-drift scripts wired to the handoff** (stop spending Codex findings on stale counts).
- **C11 — merge-hygiene gate**; **C12 — refactor-risk classifier**; **C14 — knip after consolidation batches**.
- **C15 (prompt-only "review the whole class" rule): proven insufficient alone — 0 deterministic catches; keep only as phrasing wired to C1's output.** **C13 (shadow-DB rebuild diff): DEFER** — 306 disk-only/411 live-only historical versions make the first run a reconciliation project; C3 covers go-forward risk.

## 5. What stays with Codex (residual risk)

After the top controls, Codex's job shrinks to what an independent second model is actually good for: severity calibration (P1 requires demonstrated exploitability), novel money/AR data-flow semantics (each new catch becomes a C9 identity via C10), allowlist adjudication (give Codex the allowlist diff to attack), and genuinely novel classes. Expectation: the deterministic classes that caused 2-3 round loops get pre-cleared, and Codex drops to ~1 focused round per batch.

## 6. One-line summary

Codex isn't smarter — it's *enumerating live state while internal review pattern-matches diffs*. Make the definitive sweeps standing executable gates that run before the handoff (not after the rejection), require end-to-end smoke chains before any "fixed" claim, and force every lesson to land as a check. The 27%-remediation treadmill is the cost of certifying batches with checks that never observe the live database.

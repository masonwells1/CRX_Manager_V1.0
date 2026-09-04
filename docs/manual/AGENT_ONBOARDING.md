# Agent Onboarding — How Not to Fail Here

**Last verified: 2026-09-04**
**Update triggers: when a new recurring failure class is identified or the guard system changes.**

You are a new coding agent — possibly a smaller or cheaper model than whoever wrote this doc — starting your first session in CRX Manager. This file is the front door. It assumes you've already read the short shared contract in `AGENTS.md` and exists to make you behave like a senior engineer on this codebase instead of a junior one, on your very first turn.

CRX Manager is a **live production app** for a real agricultural chemical distributor. Real customers, real invoices, real money. Treat every mistake as one that could hit a real business tomorrow morning.

---

## Read order for your first session

1. **`AGENTS.md`** — the concise shared contract: owner communication, authority, routing, true non-negotiables, and completion standards.
2. **`docs/workflows/SAFE_DEVELOPMENT_RULES.md`** — the detailed "always do / never do" tables, migration safety, money handling.
3. **This file** — the failure modes that got past agents before you, and how to not repeat them.
4. **`docs/reference/gotchas.md`** — project-specific quirks that aren't obvious from reading code (wrong column names, non-obvious types, tables missing `updated_at`, etc.). Read the relevant section before touching an area it covers; do not load the entire file when the task is unrelated.
5. **The `docs/workflows/` file for your task area** — e.g. `QUOTE_TO_DELIVERY.md` for the billing pipeline, `INVENTORY_RULES.md` for inventory, `DATABASE_CHANGE_CHECKLIST.md` before any migration, `RLS_SECURITY_GUIDE.md` before touching policies.
6. **`docs/manual/ARCHITECTURE.md`** — orientation on how the app fits together, once it exists in your checkout. If it's missing, don't invent claims about structure — read the code directly instead.

Do not skip straight to step 5 because the task "looks simple." Steps 1–4 are what stop a simple-looking task from becoming the 91st fix commit for the same bug class.

---

## The 8 recurring bug classes

These are distilled from roughly 90 fix commits over about 20 days of this project's history (source: `.claude/workflows/money-inventory-hunt.js`, lines ~14–26). Every one of them has recurred more than once. Before you claim a change involving money, inventory, or a mutating RPC is clean, check it against every class below that applies.

**1. IDEMPOTENCY** — a mutating RPC that (a) reads/writes `idempotency_keys` with the wrong columns (correct: `idempotency_key` / `operation` / `result`; NEVER `key` / `entity_type` / `entity_id` / `result_id`), (b) does an UNSCOPED lookup not filtered by `operation='<this_rpc>'` (returns another op's cached row — the `restore_quote_version` bug class), (c) declares `p_idempotency_key` but the body never uses it, or (d) has no `p_idempotency_key` at all on a money/inventory write.
*Check before claiming clean:* grep the RPC body for `check_idempotency` / `save_idempotency` (or the canonical pattern in `gotchas.md`); confirm the operation string matches the function name; confirm the idempotency hook (`idempotency-body-check.mjs`) didn't block your write.

**2. FORGEABLE ACTOR** — a mutating financial/inventory RPC that trusts a `p_performed_by` / `p_actor` parameter instead of binding to `auth.uid()` and rejecting a mismatch. Canonical: `v_actor := auth.uid(); IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE 'ACTOR_MISMATCH'`. A forged actor landing in `financial_audit_log` is a BLOCKER.
*Check before claiming clean:* grep the function body for every use of a caller-supplied actor param; confirm it's compared against a bound `auth.uid()`, never written to the audit log unchecked.

**3. MONEY-CENTS** — `parseFloat`/float math on a `*_cents` value; dollars-vs-cents mixups; penny-drift where each share/line is rounded independently so the parts don't sum to the whole (commission splits, payment allocation, split invoices, per-acre fees); any UPDATE that writes `invoices.balance_cents` (GENERATED ALWAYS — writing it is a bug). Legacy numeric-dollar storage such as `payments.amount` or `commissions.commission_amount` is not suppressed by type alone: verify exact numeric math, clean finite whole-cent values, and an active finite whole-cent CHECK; dirty or unconstrained columns remain findings.
*Check before claiming clean:* grep the diff for `parseFloat` near a `_cents` variable; if you split a total across N rows, confirm the parts sum exactly to the header total (largest-remainder or equivalent), not N independent roundings.

**4. CONCURRENCY** — a read-modify-write on inventory, holds, prebooked quantities, a balance, or a number-reservation with no `FOR UPDATE` row lock (or advisory lock), so two concurrent calls race (double-release, double-spend, duplicate number). `cancel_delivery`/`void_delivery`/quick-delivery release paths are the known hot spot.
*Check before claiming clean:* for any function that reads a balance/quantity then writes it back, confirm the SELECT uses `FOR UPDATE` (or an equivalent lock) before the write.

**5. STALE-DERIVED-STATE** — an edit path (`update_order_items`, recipe/job edit, field-invoice edit, same-product order edit) that recomputes one total but leaves a sibling derived value stale: `total_profit` / `net_margin_pct` / commissions / `total_cost_cents` / a report-feeding per-line column. These don't throw — they're silently wrong, and they feed reports like `get_sales_detail_report`.
*Check before claiming clean:* list every derived/sibling column that depends on the value you changed; confirm each is recomputed in the same transaction, not just the primary total.

**6. LIFECYCLE / SEGREGATION** — a status string written by frontend or RPC that is NOT in the live CHECK constraint for that table (the `void` vs `voided` class); a documented lifecycle transition no trigger/RPC actually enforces; an invoice-type leak (e.g. field-application rows showing in chemical-sales lists); a route/edit-lock bypassable by direct URL or once status is past the editable point.
*Check before claiming clean:* read the live CHECK constraint (`pg_constraint`, or `.claude/schema-registry.json`) for every status string you write — don't trust memory of what values "should" exist.

**7. UNCHECKED-ERRORS / TYPE-GUARDS** — a Supabase `.update()`/`.delete()` not followed by `checkMutationResult()`; an RPC result used without `assertRpcResult()`; a Supabase `{ error }` ignored; an untyped cast or `select('*')` that silently tolerates a renamed column; a page that throws blank on a null.
*Check before claiming clean:* grep your diff for every `.update(`, `.delete(`, and `.rpc(` call; confirm each has the matching check immediately after it.

**8. AUDIT-LOG-COMPLETENESS** — a mutating money RPC (invoice create/void, payment, write-off, credit memo, commission payout) that does not write the matching `financial_audit_log` row, so the append-only ledger is incomplete. Compare each money mutator against `create_invoice_from_order` as the reference pattern.
*Check before claiming clean:* for any new or changed money-mutating RPC, confirm it inserts into `financial_audit_log` with the right `entity_type`/`operation_type` (and that those values are in the CHECK constraint — see class 6).

---

## Process failure modes that got past smart agents

These are not code bugs — they're *how an agent convinced itself something was done when it wasn't.* Each has a concrete countermeasure baked into the guard system, not just a reminder.

- **Claiming done without running it.** The Stop hook (`stop-verify.mjs`) will block "done" on any session that changed code unless the transcript shows a real `PROOF —` block or an actual preview/fetch/`execute_sql` run. "Tests pass" is not accepted proof. Countermeasure: before you say a change is complete, write a line in the form `PROOF — Ran: … · Saw: … · Not verified: …` describing exactly what you executed and what you observed.

- **Trusting a handoff or summary over live state.** A prior session's summary, a stale doc, or another agent's claim of "this is already fixed/shipped" is often wrong or outdated. Countermeasure: verify the actual code and the live database yourself before acting on any handoff claim — read the function body, query the live table, don't take the word of a prior note.

- **Parallel-session blindness.** Mason frequently runs multiple sessions/worktrees at once. Claiming something "isn't shipped yet" or "needs a fix" without checking whether a sibling session already did it wastes work and can cause conflicting migrations. Countermeasure: check the worktree-awareness SessionStart output, run `/fleet` if unsure, and check git ancestry (`git fetch origin` + `git rev-list --left-right --count origin/main...HEAD`) before claiming something is or isn't live.

- **Stale schema registry.** `.claude/schema-registry.json` powers 4 of the schema-aware hooks and 2 review subagents. If SessionStart warns it's behind a registry-relevant migration, working against it means your status/generated-column/RLS checks are checking against outdated facts. Countermeasure: regenerate it via the `regen-schema-registry` skill (live Supabase introspection → `--from-introspection` mode) before doing schema-aware work. Trap: running `node scripts/regenerate-schema-registry.mjs` with no arguments is "stamp" mode — it only bumps the date and refreshes nothing.

- **Doc-count drift.** Never hardcode counts of migrations, pages, or functions into always-loaded agent files (`AGENTS.md`, `CLAUDE.md`) — they go stale immediately and `npm run check:docs` will catch the drift. Countermeasure: put volatile counts only in `docs/reference/` files that the check validates, or don't hardcode them at all.

- **Re-emitting a function two pending migrations both touch.** If your migration does `CREATE OR REPLACE FUNCTION` on something another *not-yet-applied* migration also re-emits, whichever applies second silently clobbers the first's logic. Countermeasure: grep `supabase/migrations/` for other pending (unapplied) migrations touching the same function name before you write yours.

- **Editing an applied migration.** Forbidden, no exceptions. An applied migration is a permanent historical record; editing it means the file on disk no longer matches what actually ran against the live database, and re-running migrations elsewhere (a fresh environment, a review) produces a different schema than production has. Countermeasure: always create a new migration file, even for a one-line fix to something you wrote five minutes ago in the same session.

- **Replaying the full historical ledger into a fresh database.** The historical files are an immutable audit trail, not the current clean-build entry point. Some correctly fail-closed on production-specific data or byte-exact legacy function bodies. Countermeasure: initialize a new project from `supabase/baselines/manifest.json` in its declared order, then apply only migrations newer than that baseline. Run `npm run test:schema-baseline` before trusting the artifacts.

---

## The guard net will stop you — that's normal

This project has a real, enforced safety net: PreToolUse hooks that refuse a Write/Edit that matches a known bug pattern, a migration-apply-guard that requires a fresh review proof before `apply_migration` runs, a push-guard that requires a Codex verdict before a risky push, a pre-commit ledger guard that blocks agent-surface commits with no ledger update staged alongside, and Stop/PostToolUse hooks that force verification and flag loose ends. Full behavior is documented in `docs/reference/agent-guardrails.md` — read it, don't re-derive it here.

If a guard blocks you, the correct response is to **fix the underlying problem the guard is pointing at** — never to look for a way around it, disable it, edit the hook, or add an exemption comment you're not sure is warranted. If you genuinely believe a guard is wrong (a false positive on legitimate code), say so to Mason in plain English and let him decide — don't silently bypass it and don't unilaterally change guard config.

---

## Which review workflow do I use?

| Situation | Entry point | What it does NOT cover |
|---|---|---|
| Wrote or changed a **migration** | `/migration-review` | Produces the apply-guard proof for that migration; doesn't review unrelated frontend changes or push the migration live itself |
| Any **SQL / RLS / money / edge-fn** change, before push | `codex-review` | A real Codex verdict *this session* — not a stale/queued one; doesn't replace the migration-review proof for `apply_migration` |
| A **substantive feature** end to end | `/ship` pipeline | Includes the review fan-out; under the standing 2026-06-16 policy it may auto-push regular code once fully green. It stops before an edge-function deploy or data deletion (always), and before a live migration apply in interactive sessions — in a Mason-pre-authorized hands-free run with autopilot armed, a migration may apply via the proof gate (2026-07-13 policy; destructive migrations still stop) |
| "**Is the whole app healthy?**" | `/audit` or `spot-check-prod` (live) | A point-in-time health read; doesn't fix anything it finds, and doesn't substitute for reviewing your specific change |
| Broad **foundation safety** sweep | `codex-gauntlet` (foundation mode) / `review-workflow` | Wide and read-only; not scoped to your one change, so still run a focused review on what you actually touched |
| **Two-model reconciliation** (Claude vs Codex disagree, or you want both) | `agent-pair-review` | Compares notes between models; doesn't apply fixes itself |

Direct reviews are read-only. PR comment posting defaults to dry-run. None of these workflows may push, deploy, apply a live migration, mutate/delete live data, or expose secrets without the authorization `AGENTS.md` requires — for migrations that means Mason's in-chat OK, or a hands-free run he pre-authorized with autopilot armed (2026-07-13 policy); for deploys and deletion it always means his explicit go-ahead in this conversation.

---

## Verification standard

**Done means the changed behavior ran and was observed — not that a new test passed.** A test you wrote yourself can rubber-stamp the same misunderstanding that caused the bug in the first place.

- Small, low-risk, single-file change: a narrow check is enough (open the page and look, or run the one path).
- Money, data, auth, or multi-file/shared-logic change: run the full standard — `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, **plus** real-path proof (execute the RPC/flow and inspect the actual result, or open the page and watch it work).
- If you genuinely can't verify something (no live access, blocked tool, etc.), say exactly what you did NOT verify and what the remaining risk is. Do not round up to "done."

---

## Mason

Mason has ~0 coding background and cannot read a diff to catch your mistakes — he catches them from your plain-English description, not the code. Explain in plain English, defining any jargon the first time you use it. Lead with **one recommended next step**, not a menu of options — only ask him to choose when it's genuinely his call (a business or risk trade-off), not a technical detail you're equipped to decide yourself. Decisions about money, live production changes, and anything irreversible are his to make, not yours to assume.

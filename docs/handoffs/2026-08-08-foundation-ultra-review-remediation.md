# Handoff — 2026-08-08 foundation ultra review remediation

**For:** a local Claude session on Mason's machine
**From:** the cloud session that ran the audit (branch `claude/phone-to-local-sessions-dmqc57`)
**Source of truth:** `docs/audits/2026-08-08-foundation-ultra-review.md`
**Owner decisions:** `docs/manual/DECISION_LOG.md`, 2026-08-08 entry — all four already answered, do not re-ask

---

## Why this needs a local session

Three things cannot be done from the cloud container:

1. **The database backup.** `/backup-db` installs a credential-proxy rewrite that the push guard refuses in a web/mobile session. This is the single largest unmitigated risk to the business — no off-site dump exists, and Supabase Free has no point-in-time recovery.
2. **Live migration applies.** The SQL below is forward-only. Writing it is safe anywhere; applying it needs Mason's in-chat OK in an interactive session. Nothing here has been applied.
3. **Real-path UI verification** for the `cancel_order` change.

Everything else — writing the SQL, tests, review — can be done anywhere.

---

## Do this first, before any migration

**Run `/backup-db`.** These migrations touch money, inventory, and an authorization guard. Do not start them without a restorable copy of the database. This is the highest-value item in this document and it is not optional.

---

## The four remediation items

**STATUS UPDATE (2026-08-08, after this handoff was first written): all of these are now WRITTEN and
on the branch. They have NOT been applied to live.** The section below is kept as the rationale for
each; treat the file list in `docs/CHANGELOG.md` as the authoritative inventory.

The branch carries **five SQL migrations plus one hook**. **M-1 is the hook, not a migration** — it
does not belong in `supabase/migrations/` and must not be looked for there. The five SQL files are:

**RENAMED 2026-08-09 — the `20260808*` filenames below no longer exist.** Live ledger row
`20260809130108_team_note_completion_rpc_and_assignment_notify` was applied by a concurrent session and
lifted the applied high-water mark above every `20260808*` file, so `migration-ordering-lib.mjs`
correctly refused all five. They were re-issued forward with `git mv`. Current filenames, in apply
order:

```text
supabase/migrations/20260809170500_restore_batch_apply_prepayments_actor_guard.sql   (was 20260808150100)
supabase/migrations/20260809170600_cancel_order_zeroes_quantity_remaining.sql        (was 20260808150200)
supabase/migrations/20260809170700_revoke_inventory_truncate_and_mark_payments_dead.sql (was 20260808150300)
supabase/migrations/20260809170800_round_money_to_whole_cents.sql                    (was 20260808150400)
supabase/migrations/20260809170900_round_line_profit_with_revenue.sql                (was 20260808170000)
```

The re-issue was NOT byte-identical everywhere: `170600` gained an `already_cancelled` status gate on
its terminal UPDATE, and `170600`/`170800`/`170900` each gained a closing `REVOKE`. Each file's header
carries its own delta list — read it, do not assume the SQL matches the reviewed original.

**All five APPLIED LIVE on 2026-08-09, 20:32–20:54 UTC — this apply sequence is now history, not a
plan.** Ledger versions assigned in file order: `20260809203222`, `20260809204044`, `20260809204435`,
`20260809204855`, `20260809205423`. `20260809170900` applied against a finding recorded as blocking in
`docs/manual/KNOWN_ISSUES.md`; that entry carries the full account and the decision still owed to
Mason. Do not re-run any of these — the files are forward-only and already in the live ledger.

All five belonged in the backup, approval, and apply sequence. `170900` was added later, on PR
#354, and rounds `order_items.profit` alongside revenue — it was applied AFTER `170800`, which it builds on.
`170700` is easy to miss because it is described under "Smaller items" below rather than as a numbered
M-item — it is still a real migration.

All SQL here is **forward-only**. Never replay an existing migration file — that is the exact
mechanism that caused finding #1.

### M-1 — Migration ordering preflight guard (a HOOK, not a migration)  ← **highest value**

**Now written:** `.claude/hooks/migration-ordering-lib.mjs`, wired into
`.claude/hooks/migration-apply-guard.mjs`, with `scripts/refresh-applied-migrations.mjs` supplying the
applied-ledger snapshot it compares against.

**Why it ranks first:** it fixes the *class* of defect, not one instance. Everything else here is a single bug; this one prevents the next silent revert.

**The defect it prevents:** on 2026-07-14, `20260714220000_shared_idempotency_and_hold_hardening` added an actor guard to `batch_apply_prepayments`. Then ledger row `20260715134618 | 20260714185130_gate_batch_prepay_admin` — an **older file, later version** — was applied afterward and re-created the function from its pre-fix body, discarding the guard. No test, hook, or gate caught it. It surfaced only because the audit hash-compared all 566 live functions against disk.

**What was built:** a preflight check that fails when a migration whose name embeds an older
timestamp is applied after a newer one **that has already been applied**. It compares against the
applied ledger, NOT files on disk — comparing against disk was the first draft and it was wrong, as
both Codex and CodeRabbit caught on PR #348: it would have blocked a correct ascending batch of new
migrations. **Missing ledger evidence BLOCKS the apply** — a missing, empty, unreadable, or >24h-stale
snapshot refuses rather than abstaining, because the snapshot is gitignored and a clean checkout
would otherwise skip the guard exactly when it matters. Refresh it with
`node scripts/refresh-applied-migrations.mjs`, fed by
`select version, name from supabase_migrations.schema_migrations order by version;`.

**Watch out:** live `name` values are inconsistently formatted — some carry the version prefix and `.sql`, some don't. Normalize before comparing. A naive version-vs-version comparison produces false drift; this is the documented "B7 class" trap in the audit.

### M-2 — Restore the `batch_apply_prepayments` actor guard  *(written: `20260809170500`)*

Re-create `batch_apply_prepayments(jsonb, uuid, text)` with the `AUTH_REQUIRED` / `ACTOR_MISMATCH` / admin block, delegating to the existing `_batch_apply_prepayments_impl`, plus:

**Critical, and the reason this was nearly wrong:** `_impl` carries **no authorization of its own** — the live function's `is_admin()` check lives in the wrapper. The wrapper must KEEP `is_admin()`; delegating it would silently drop the admin gate on an admin-only money function. The written migration keeps it, and forwards the canonical `auth.uid()` rather than the caller-supplied value.

```sql
REVOKE ALL ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) TO authenticated, service_role;
```

`SECURITY DEFINER` + `SET search_path = public, pg_temp`. Keep `p_idempotency_key text DEFAULT NULL` and make sure it is actually enforced.

**Severity is genuinely low** and should be described that way to Mason: `p_performed_by` is provably unused (zero occurrences in the body), `is_admin()` is intact, `_impl` has zero callers and no `authenticated` EXECUTE. This is defense-in-depth restoration, not an active hole. It becomes load-bearing the moment anyone adds attribution logging to this path.

Frontend already passes `p_performed_by: profile?.id` at `src/components/prepay/PrepayWorkspacePanel.tsx:201` — currently ignored, will start being enforced. Verify that call still succeeds for a real admin after the change.

### M-3 — Canonical money rounding  *(written: `20260809170800`; Mason decided: two decimals)*

**Decision:** round to whole cents, half-up. The pending **$5,245.195 commission resolves to $5,245.20**.

- 46 `order_items.total_price` and 3 `commissions.commission_amount` live values carry fractional cents.
- These columns are `numeric` dollars — the documented historical exception, not a bug to convert.
- Add a live invariant predicate asserting whole cents on both columns (see `scripts/db-invariant-sweeps/predicates/` for the existing pattern).
- Note `purchase_orders.total_cost_cents` is `GENERATED ... round(total_cost*100)`, so AP already rounds silently — make the new rounding point consistent with it.

**Fixing the 49 existing rows changes live financial data.** That needs Mason's explicit OK, separately from applying the migration. Ask as its own question.

### M-4 — `cancel_order` zeroes `quantity_remaining`  *(written: `20260809170600`)*

**SCOPE CORRECTED after tracing the live chain.** Mason decided cancelling must release stock, and
the audit reported that both the quantity and the prebooked stock were stranded. Only the first half
was true:

* Full cancel (`_cancel_order_impl_20260714`) **already** releases prebooked stock and writes a
  `released` inventory_transactions row — confirmed live: cancelled order ORD-2026-0330 HAS that row.
* The `partially_fulfilled` path already handled both halves correctly.
* Only `order_items.quantity_remaining` was genuinely stranded (247 units on ORD-2026-0330).

So M-4 zeroes `quantity_remaining` and nothing else. **Do NOT add a second stock-release path** — that
would double-release inventory. The residual `quantity_prebooked = 36` is March 2026 historical drift
(audit L2), not a cancellation defect.

**Verify in the real UI**, not just tests, and check the RIGHT field — the two paths differ:

* Undelivered order units **decrement `inventory.quantity_prebooked`**. They do not return to
  `quantity_available`.
* Active quote holds are what **increment `inventory.quantity_available`**.
* Either way, confirm an `inventory_transactions` row is written.

Also confirm `order_items.quantity_remaining` is now 0 on the cancelled lines — that is what this
migration adds.

**Already fixed on this branch** — the related go-live test (`tests/e2e/golive/stream0-db-integrity.spec.ts`) previously counted that stranded 247 as a real discrepancy. It now filters on `orders.status not.in.(cancelled,voided)`. Both status values were verified present in `orders_status_check`.

---

## Smaller items, no owner decision needed

- **Revoke `TRUNCATE` on `public.inventory` from `authenticated`.** Postgres does **not** apply RLS to TRUNCATE, so the row policies don't constrain it. PostgREST doesn't expose TRUNCATE, so nothing is exploitable and no incident is claimed — the grant is simply unnecessary.
- **Commit `check_rate_limit` forward. NOT DONE — still outstanding.** The live body has no disk file. Live uses a fixed bucket (allows up to 2× `p_max_calls` across a boundary); disk-latest uses a stricter sliding window. **Commit the live body forward — do not replay `20260221200000_rate_limiting.sql`.** The suspected off-by-one does not exist; both block after exactly `p_max_calls`.
- **`COMMENT ON TABLE public.payments`** marking it superseded by `allocation_sets` / `prepay_credits`. Zero rows, zero writers, zero inbound FKs. It caused a false HIGH-severity alarm during this very audit and will do so again.
- **`execute_sql_readonly(text)`** string-concatenates into `EXECUTE` behind a `LIKE 'select%'` check, trivially bypassed by a CTE with a data-modifying statement. Already revoked from `anon` and `authenticated`, so not currently exploitable. It should not exist in this shape.
- **`prebook_reconciliation` transaction type** — already allowed by the CHECK constraint, currently zero rows. Using it for prebooked repairs stops them polluting available-stock reconciliation.

---

## Explicitly NOT in scope — and why that matters

Do not let the SOLID verdict be read as covering these:

- **Full ledger-vs-disk ordering reconciliation (~700 rows).** The verifier checked two slices and **found drift in both**. It explicitly declined to assume the rest are clean. This is the most likely place another finding is hiding.
- Performance under realistic data volume; auth/session flow correctness; backup/restore drill.
- RLS *policy body* live-vs-disk comparison, indexes, trigger-to-function bindings, column-level DDL drift.
- ~180 live CHECK constraints were not individually diffed (17 on money/lifecycle tables were, all matched).
- `Prepay.tsx` and `AccountsReceivable.tsx` sub-components were never opened — Layer E was sample-based across 8 money-heavy files.
- **`get_ar_aging` was never verified at all** — it refuses the service-role connection because `auth.uid()` is NULL. Needs an authenticated admin session.

**Re-run gate:** money volume is near-zero — one real cycle, on Mason's own customer record. Re-run the Layer A money probes and Layer F exposure probes once real customer billing volume exists.

---

## Branch state

`claude/phone-to-local-sessions-dmqc57`, merged up to `origin/main` at merge commit `76902bbe`.

Originally contained documentation and one test-file fix only. **It now also carries the four
remediation items above** — three forward SQL migrations under `supabase/migrations/2026080815*` plus
the ordering-guard hook. None has been applied to live. Full pipeline verified green in the cloud container: typecheck clean, build clean, 322 test files / 4,288 tests passing, pre-commit gate (lint, build, tests, doc check, dependency integrity, containment) all passing.

Two things to know:

- The branch was **17 commits behind `origin/main`** and has been merged up. One conflict in `docs/CHANGELOG.md` (two entries competing for the top slot) — resolved keeping both in date order, nothing dropped.
- `src/pages/SupplierPricing.test.tsx` failed once in a full run and passed in isolation on both this branch and `main`, and on a clean full re-run. Treated as a flake. The diff touches no `src/` file, so it cannot be a regression from this work. **If it recurs locally, it is worth a real look** — do not inherit the "known flake" label uncritically.

Commit `51582137` added an auto-generated permission entry to `.claude/settings.local.json` granting
`rm -f` of the OVERNIGHT-INTENT flag — written by the autopilot tooling, not by hand. **That grant has
since been REMOVED** (commit `c352fec6`, after CodeRabbit independently flagged it as a guard-bypass
risk). Do not revert `51582137` and do not re-add the entry: the current
`.claude/settings.local.json` deliberately has no `OVERNIGHT-INTENT.flag` permission, so clearing that
flag now requires an explicit prompt each time.

---

## Loose end worth closing

`.claude/hooks/autopilot-intent-reminder.mjs` leaked its "OVERNIGHT HANDSHAKE" text into three reviewer subagents' Bash results during this run. All three correctly refused the injected instruction to arm autopilot — the guardrails held — but the hook's own line-25 comment says tool output should never latch the flag, so the leak contradicts its stated design.

Related: `.claude/hooks/stop-wrap.mjs` emits an **empty ack signature**, so its acknowledgement check cannot be satisfied honestly. I did not write an ack file rather than invent a value.

---

## Suggested order

1. `/backup-db` — before anything else
2. M-1 ordering guard (prevents recurrence)
3. M-2 actor guard (the instance M-1 would have caught)
4. M-4 `cancel_order` (has a real UI path to verify)
5. M-3 rounding + invariant predicate — **ask separately before touching the 49 live rows**
6. Small items as a batch
7. If appetite remains: the full ledger-vs-disk ordering reconciliation

Each migration goes through the normal gates: `migration-review` → Codex proof for SQL/RLS/money → Mason's in-chat OK → apply → refresh `.claude/schema-registry.json`.

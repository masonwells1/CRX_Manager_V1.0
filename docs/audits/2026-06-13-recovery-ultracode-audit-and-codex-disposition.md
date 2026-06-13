# Recovery branch — Ultracode deep audit + Codex cross-review disposition

**Date:** 2026-06-13
**Branch:** `recovery/overlapping-sessions-2026-06-13` (worktree `C:\CRX_Recovery`)
**Reviewer:** Claude (Opus 4.8, ultracode multi-agent) → Codex (gpt-5.5, independent second opinion)
**Scope:** the full recovery diff `git diff origin/main...HEAD` (152 files: code + 33 migrations + docs/tooling)
**Project:** Supabase `rhyzpcqhnizqbxphqdkr` (live)

> This branch unifies `origin/main` + the H1 quick-wins branch (`feat/h1-quick-wins-2026-06-10`) +
> the partial-quote-draw-down branch (`ship/partial-quote-draw-down`) + 3 H1 fixes + one re-homed
> migration. It is 26 commits ahead / 0 behind `origin/main` (fast-forward merge). Every migration in
> the diff EXCEPT `20260613150000_planned_holds_drawn_sync` is **already applied live**; that one is the
> only **pending** migration (re-homed to sort after the live high-water `20260611211058`).

---

## 1. Verdict

**SAFE TO REVIEW → SAFE TO PUSH** (after the gated apply of the one pending migration). One real HIGH
finding was discovered and **fixed** (FE-1); everything else is clean, LOW/NIT/pre-existing, or an explicit
owner decision. No new security hole, no latent break, no financial drift, no behavioral regression in the
recovery core (auto-merge + pending migration + applied migrations). Three independent Codex (gpt-5.5)
review rounds surfaced **10 non-blocking findings in the new H1 features** — including one **real inventory
under-reservation bug** (round 2) — and **ALL 10 were implemented and committed** per Mason's direction
(§9.3). All were implemented and committed. Per Mason, the Codex round-by-round loop was then stopped (in favor of
one large review at the end) and replaced by Claude's own multi-agent self-review, which caught **2 more MED
issues** — including `void_order` having the *same* inventory bug as `cancel_order` — both now fixed (§9.4).
The change set carries **3 pending migrations** (`20260613150000` → `20260613150100` → `20260613150200`),
each proven by rolled-back `SMOKE_PASS_ROLLBACK`.

The single human gates that remain (per the standing CRX policy) are: applying the one pending migration
to live, and the prod push. Both are recommended in §8.

---

## 2. What was re-verified against live (not trusted from the handoff)

| Claim | Result |
|---|---|
| Recovery is 26-ahead / 0-behind `origin/main`, fast-forward | ✅ confirmed (`merge-base --is-ancestor` = yes) |
| Live migration high-water = `20260611211058` | ✅ confirmed via `list_migrations` |
| `20260613150000` is the ONLY pending migration | ✅ confirmed (absent from live `schema_migrations`) |
| Superseded `20260611132115` never applied / not on branch | ✅ confirmed (absent live; not in branch tree) |
| Every other branch migration is applied live | ✅ confirmed 1:1 against `list_migrations` |
| `20260613150000` §0 md5 baselines match live | ✅ `save_quote 980a624c…`, `create_planned_holds 912db30f…`, `restore_quote_version 9c5aedb1…` — all match; `_sync_planned_holds` absent live (no collision) |

---

## 3. Auto-merge correctness (`QuoteBuilder.tsx`, `db.ts`, `types/index.ts`)

Diffed against **both** merge parents (P1 = `bf9c6c0` H1 tip, P2 = `2780ed6` partial-draw tip):

- **`db.ts`** — clean union. H1 side added `LICENSE_EXPIRED/OVERRIDE_REQUIRES_ADMIN/JOB_NOT_FOUND`;
  partial-draw side added `BOOKING_CLOSED/OVERDRAWN/PARTIALLY_DRAWN/FULLY_DRAWN/DRAW_ORDER_LOCKED/EMPTY_DRAW`.
  Both present, different blocks, no collision.
- **`types/index.ts`** — clean union. H1: `Product.rei_hours/phi_days`, `ApplicatorLicense` holder XOR
  nullability. Partial-draw: `QuoteProductDraw` interface, `Order.booking_draw`. All present.
- **`QuoteBuilder.tsx`** — the merge took P2's full partial-draw feature (Partial Order modal, draw-down
  handler, convert-vs-draw routing) and grafted P1's one change (the revert-quote-status `catch` now
  Sentry-captures + toasts instead of swallowing). Wired exactly once; no dangling refs, no duplicate
  defs, no guard bypass. The 2026-06-10 BLOCKER fix (convert reads the draw ledger and fails closed
  BEFORE the destructive `saveQuote('accepted')` pre-flip) is intact. All 6 booking error codes are
  defined and the reachable ones mapped to toasts. No commits touched these 3 files after the merge.

A 9-dimension multi-agent workflow (correctness lens) **CLEAN, no findings** on this dimension.

---

## 4. Live invariant sweeps (`scripts/db-invariant-sweeps`, all 14 predicates, run read-only via MCP)

| Predicate | Result |
|---|---|
| anon-exec-secdef | 53 rows, **all allowlisted**; zero match the genuine-hole signature (`has_dml ∧ ¬self_gates ∧ ¬trigger`) |
| ungated-secdef-mutators | exactly the 2 allowlisted |
| actor-forgery | exactly the 5 allowlisted |
| auth-bound-role-ungated | **0** |
| secdef-searchpath | **0** |
| overloads | **0** |
| status-literals | **0** |
| plpgsql-check (live static analysis) | **0 errors** — the 30-break/11-function latent-break class is fully fixed |
| fin-prepay-balance | **0** (void_payment prepay-reversal fix left zero stranded credits) |
| fin-invoice-balance-identity | **0** |
| fin-allocations-bounded | **0** |
| fin-ar-statement-balance (credit-memo + balance-drift) | **0** (validates `customer_statement_blind_spots`) |
| fin-quote-override-survival | **0** |
| fin-commission-split-sum | **3 rows = the owner-pending blank-recipient defaults** (Test Farm Alpha / Yeley Farms / Tim Jondle) — NOT a regression; Mason supplies these names (§7) |

The recovery branch introduced **no new** security hole, latent break, or financial drift.

---

## 5. Pending migration `20260613150000_planned_holds_drawn_sync` — rolled-back smoke

Full migration body + the registered `scripts/smoke/smoke-planned-holds-drawn-sync.sql` were run inside a
**single transaction that always rolls back** (terminal `RAISE 'SMOKE_PASS_ROLLBACK'`; multi-statement
`execute_sql` atomicity was first proven with a throwaway probe — an INSERT before a RAISE left 0 rows).

**Result: `SMOKE_PASS_ROLLBACK` (zero prod footprint).** This proves, in one shot:

- §0 precondition passed (all three live baseline md5s matched exactly);
- §1–§4 compiled (helper `_sync_planned_holds` + the 3 re-emitted RPCs);
- §5 self-verify passed (overloads=1 each, helper delegation present, both strip-and-compare md5s equal
  the captured baselines — i.e. byte-faithful to live + exactly the two/one documented insertions, the
  operation-scope filters present, `_sync_planned_holds` not authenticated-executable);
- behavioral scenarios (a)–(f) passed: full reservation + per-item expiry, FIFO hold decrement on draw,
  **the reported double-reservation bug is fixed** (rebuild reserves `booked − drawn`, not full booked),
  Revise/Present save re-syncs, restore rebuilds holds, plan-toggle-off releases all holds.

Ordering is sound: stamp `20260613150000` sorts after the live high-water `20260611211058`, so a clean
rebuild reaches the three baseline functions in their post-sweep state before this runs (`211058`
intentionally carved out `save_quote`/`create_planned_holds`, leaving them at the asserted baselines).

---

## 6. Multi-agent deep audit (9 dimensions, every BLOCKER/HIGH adversarially verified vs live)

| Dimension | Outcome |
|---|---|
| merge-quotebuilder | CLEAN |
| rehome-migration | CLEAN (§5 strip-and-compare independently reproduced byte-for-byte) — 1 LOW (PHS-1, pre-existing) |
| drawdown-system (12 applied migrations) | CLEAN — bodies byte-faithful to live, invariants confirmed by rolled-back smokes |
| h1-applicator-rup | CLEAN — 1 NIT (set_config 'false' vs RESET; in an applied migration, correct as-is) |
| june11-column-fixes (13 applied migrations) | CLEAN — money/race ones (void_payment, commission FOR UPDATE, split_invoices, customer_statement) correct & idempotent; 1 LOW + 1 NIT (pre-acknowledged residuals) |
| idempotency-sweep (`20260611211058`, 20 RPCs) | CLEAN — only the `AND operation='<fn>'` filter added per RPC; save_quote/create_planned_holds correctly carved out |
| frontend-compliance | **1 HIGH (FE-1) — FIXED**; otherwise red-line clean |
| pdf-types-money | CLEAN — WPS PDF single-sources theme, no 404 assets, renders no money; types match live — 1 LOW (PDF-1, cosmetic) |
| tests-docs-config | CLEAN — the "test green-now/red-after-apply" hypothesis disproven (snapshots are frozen lists; can't flip) — LOW/NIT post-apply housekeeping (TST-1..4) |

### FE-1 (HIGH, FIXED) — JobDetail weather auto-capture was dead

`jobFieldCentroid` derived the field centroid from `allFields.find(...)?.centroid_geojson`, but `allFields`
is loaded via `supabase.from('fields').select('*')` and the live `fields` table has **no `centroid_geojson`
column** (it is a computed output of the `get_field_geojson` / `get_fields_with_geojson` RPCs). The optional
`Field.centroid_geojson?` type masked the miss (tsc stayed green), so `jobFieldCentroid` was always null and
the "Use current weather" button never rendered — the C4 feature was non-functional. Adversarially CONFIRMED
by two independent skeptics against the live catalog (fields has only `centroid`/`boundary` geometry; every
other consumer routes through the geojson RPCs).

**Fix** (commit on this branch): fetch the first selected field's centroid via `get_field_geojson` into
state (the pattern `FieldSetup` already uses), fail-soft (any miss just hides the button → manual entry).
Frontend-only; no migration. Verified: typecheck/lint/build/test all green.

### Non-blocking observations (no action this pass — recorded for the owner)

- **PHS-1 (LOW)** planned holds with a NULL `needed_by_date` get a NULL (never-expiring) `expires_at`.
  Pre-existing: all 9 live `crop_program` holds already have NULL expiry; the migration preserves this. Out of scope.
- **PLC-1 (LOW)** `void_payment` reversal joins prepay credits on `source_reference`; a same-customer,
  same-reference, same-season double-overpayment could over-reverse. Pre-acknowledged in the migration header;
  strictly better than the prior behavior (reversed nothing). Durable fix = add `prepay_credits.allocation_set_id`.
- **PDF-1 (LOW)** `Order.booking_draw` typed optional but the live column is NOT NULL DEFAULT false (cosmetic).
- **TST-1 (LOW)** `.claude/schema-registry.json` + `caller-graph.json` are stale vs live (high-water
  `20260610185806`; missing `products.rei_hours/phi_days`). Dev-time only (PreToolUse hooks). Resolve by
  regenerating from live as part of the push sequence (§8) — see note there.
- **TST-2/3/4 (LOW/NIT)** `rpcIdempotencyScope.test.ts` / `rpcFixtureLiveDiff.test.ts` snapshots carry
  pre-apply state + a couple of stale migration-name comments; they stay GREEN and are meant to be refreshed
  in the post-apply snapshot regen (documented in their headers).
- **H1-1, PLC-2 (NIT)** cosmetic, inside already-applied migrations (cannot edit applied migrations).

---

## 7. Owner decisions (not Claude's to make — left untouched per the task)

1. **3 blank-recipient commission defaults** — `Test Farm Alpha`, `Yeley Farms`, `Tim Jondle` each carry a
   `{"splits":[{"recipient":"","percentage":100}]}` default split (flagged by fin-commission-split-sum). Mason
   supplies the recipient names. Left unchanged.
2. **RUP expired-license legal classification** — the UI wording in `rupCompliance.ts` mirrors the server's
   `generate_rup_sales_records` classification without asserting a legal conclusion; the legal call is Mason's.

---

## 8. Recommended push sequence (all gated on Mason)

0. **Re-run Codex round-4** (`/codex-review`) once the OpenAI usage limit resets (≈12:52 PM) to confirm the
   round-3 fixes resolved findings — the loop's final confirmation before push.
1. **Apply the THREE pending migrations IN STAMP ORDER** via the Supabase MCP apply gate (`migration-review`
   proof → `apply_migration`): `20260613150000_planned_holds_drawn_sync` (creates `_sync_planned_holds`) →
   `20260613150100_cancel_order_resync_holds_on_draw_cancel` → `20260613150200_void_order_resync_holds_on_draw_void`
   (the latter two depend on the helper — each §0 hard-aborts if it's absent or the base function drifted).
   Re-confirm each with its §5 self-verify + rolled-back `SMOKE_PASS_ROLLBACK`.
2. **Regenerate** the schema registry FROM LIVE (`/regen-schema-registry` — full MCP introspection, not the
   stamp-only script) so it covers through `20260613150000` (incl. `_sync_planned_holds`, `products.rei_hours/phi_days`).
   Then re-run `check:docs`. *(Deliberately deferred to here rather than done pre-apply: a regen now would be
   immediately stale after the gated apply; doing it once post-apply captures the final state in one accurate pass.)*
3. **Refresh** the post-apply test snapshots per their headers (move `create_planned_holds`/`save_quote` from
   `UNSCOPED_LOOKUP_GAP` to `INLINE_SCOPED` in `rpcIdempotencyScope.test.ts`; fix the stale migration-name
   comments TST-3).
4. **Push** `recovery/overlapping-sessions-2026-06-13` → `main` (fast-forward) → Vercel auto-deploys prod.
5. **Retire** `ship/partial-quote-draw-down` and `feat/h1-quick-wins-2026-06-10` (their work is unified here).

---

## 9. Codex cross-review (gpt-5.5, independent)

_(Filled after the Codex CLI run — see §9.1.)_

### 9.1 Codex run + findings

Run on 2026-06-13 via the headless `codex` CLI (v0.140.0-alpha.2, gpt-5.5) against the recovery branch
WITH the FE-1 fix committed:

```
codex review --base main --title "Pre-push review: recovery/overlapping-sessions-2026-06-13 …"
```

(`--base` is mutually exclusive with an inline `[PROMPT]` in this CLI version, so CRX failure-class
context reached Codex via the repo-root `AGENTS.md`. Full log teed to
`.claude/session-state/codex-review-latest.txt`.)

**Codex returned 4 findings, NO BLOCKER** (P1×2, P2×2). Summary: "compliance-warning gaps + inaccurate
operational output + a stale registry." All four are gaps in the **new H1 features** carried in the diff
(WPS notice / RUP post-warning / daily brief / schema registry) — none is a defect introduced by the
recovery merge or the pending migration, and none changes the SAFE-TO-PUSH verdict of the recovery core.

### 9.2 Disposition (honest agree/disagree, each verified against the live code/catalog)

| # | Codex finding (file) | Claude's verdict | Disposition |
|---|---|---|---|
| 1 | **[P1]** WPS notice substitutes "see product label"/generic text for product-specific label data (`src/lib/wpsNoticePdf.ts:136-143`) | **Partly disagree — not a code defect.** The code correctly renders `rei_hours` when entered and points to each product label for active ingredients / first-aid / PPE (Required Notices §, lines 152-157). Whether the template is *legally sufficient* as a complete WPS pre-application notice is a **regulatory/legal judgment**, adjacent to the RUP expired-license classification the task explicitly reserves for the owner. | **OWNER DECISION (Mason).** If full per-product active-ingredient/REI embedding is legally required, source it from product label data in a focused follow-up. |
| 2 | **[P1]** Invoice-group posting RUP-warns only the displayed invoice (`src/pages/InvoiceDetail.tsx:167-188` + `handlePost` 506-527) | **Agree it's real; downgrade to MED.** `handlePost` does post all siblings via `post_invoice_group` when `invoice_group_id` is set, and `openPostConfirm` builds the advisory only from the displayed invoice's `items`/`customer_id`. BUT the RUP warning is explicitly *warn+confirm, NEVER a gate* (lines 170-171) — the server-side RUP sales register records every sibling's disposition correctly regardless of the UI. So this is an **advisory-completeness gap**, not a legal/data bug. Pre-existing in the H1 B1 feature. | **FOLLOW-UP (spec'd).** Fix: when `invoice_group_id` is set, aggregate `checkRUPCompliance` across all group siblings' (customer, product_ids) and surface a combined warning. Frontend-only. *Offered to implement before push if desired — held back so a compliance-UX change gets its own focused review rather than a bolt-on during consolidation.* |
| 3 | **[P2]** Daily-brief "open action items" count underreports (`src/pages/Dashboard.tsx:371`) | **Agree (P2/MED).** `data.teamActionItems` = `operational_dashboard_summary.team_action_items`, a *filtered* list (only pinned/urgent/high/overdue/assigned-to-me `team_notes`, ordered, capped) with **no total-count field** (verified live). So `.length` is "attention items (capped)", not "open action items". | **FOLLOW-UP (needs a server count field).** No clean frontend-only fix: add an unbounded count to `operational_dashboard_summary` (a gated RPC migration) and pass it to `DailyBrief`; or reword + show "N+". Pre-existing in the H1 E3 feature. |
| 4 | **[P2]** Schema registry stale (`.claude/schema-registry.json:9`) | **Agree — = the audit's own TST-1.** High-water `20260610185806` < live `20260611211058`; missing `products.rei_hours/phi_days`. Dev-time hooks only. | **PUSH-SEQUENCE regen** (§8 step 2) — regenerate from live after the gated apply, in one pass. |

**Net (round 1):** Codex confirms no push-blocker. The one confirmed *error* (FE-1) was already fixed. The
four round-1 items were non-blocking follow-up polish on the H1 features.

### 9.3 Iteration — Mason directed "implement ALL Codex findings; Codex reviews before push"

Per Mason's instruction, every Codex finding was IMPLEMENTED (not just dispositioned), then re-reviewed,
iterating until convergence. Severity shrank each round (the only serious bug — a real inventory
under-reservation — was caught in round 2 and fixed). Commits on the branch:

| Round | Codex findings | Fixes (commit) |
|---|---|---|
| 1 | WPS completeness; invoice-group RUP advisory; daily-brief count; registry stale | `200f5aa` — WPS adds PHI + on-label scope callout; `openPostConfirm` aggregates RUP across group siblings; brief counts open team_notes directly; registry regenerated from live (high-water → `20260611211058`) |
| 2 | **[P1, CONFIRMED inventory bug]** `cancel_order` under-reserved holds on a booking-draw cancel (measured live: Net Free 900→940); WPS lost label data for deactivated products; Compliance holder-name not reset on staff change | `6e0681d` — NEW pending migration `20260613150100` re-emits `cancel_order` (verbatim+§0/§5) calling `_sync_planned_holds` after the reversal, **`SMOKE_PASS_ROLLBACK`** (AFTER_CANCEL hold=100/netfree=900); WPS fetches label fields for all products unfiltered; holder-name overwrites on staff change |
| 3 | WPS print-on-failed-lookup (incomplete round-2 fix); QuoteBuilder RUP-log flood; daily-brief count included non-actionable notes (incomplete round-2 fix) | `567d088` — WPS aborts the PDF on query error OR any missing label row; QuoteBuilder dedups the RUP log per (customer, product-set) via a `lastRupLogKey` ref (matches the NewOrder flow); brief count filtered to `note_type='todo'` |
| 4 | **NOT RUN — Codex CLI hit the OpenAI usage limit.** Mason then directed: stop the Codex round-by-round loop, keep working, and he'll run one large review at the end. So Codex round-4 was replaced by Claude's own multi-agent self-review (§9.4). | — |

### 9.4 Self-review (replacing Codex round-4, per Mason) — 2 MED findings, both fixed

A 3-dimension adversarial workflow (each finding empirically verified against live, rolled back) over the
whole session diff. The new `cancel_order` migration passed all 5 inventory edge-case smokes (multi-product,
partial-delivery, multi-draw, non-draw, non-planned). Two real MED findings surfaced and were fixed:

- **VOID-1 (MED, confirmed)** — `void_order` has the **same** booking-draw inventory under-reservation as
  `cancel_order` (my earlier "void is coincidentally correct" reasoning was wrong: `complete_delivery` drains
  `prebooked` to 0 before 'fulfilled', so nothing offsets the un-rebuilt hold). Measured live: partial void
  900→940, full void 900→**1000** (sellable twice). **Fixed** by a 3rd pending migration `20260613150200`
  (`6th commit`), the symmetric twin of `150100` — re-emits `void_order` verbatim + one
  `_sync_planned_holds` call, **`SMOKE_PASS_ROLLBACK`** (AFTER_VOID netfree=900 for both partial-deliver and
  full-draw cases). The earlier claim that void was deliberately left untouched is hereby corrected.
- **DASH-1 (MED)** — the daily-brief `note_type='todo'` count is a different population than the dashboard's
  attention-filtered action-items widget; the comment misleadingly implied "same list". **Fixed** by
  relabeling the brief metric "**open to-dos**" (which the `todo` count accurately measures) and correcting
  the comment — a distinct, honest metric from the widget.

**State:** All 10 Codex findings (rounds 1–3) **+** both self-review findings are implemented, committed, and
battery-green (typecheck 0, lint 0, build clean, **1,997 tests pass**, `check:docs` PASS, `validate-sql` 0
violations in the new migrations). **Mason will run one large review** of the whole branch before push.

**Pending migrations now: 3** (apply in stamp order at the gate, each gated by §0 md5 precondition + the
helper-dependency check + a rolled-back `SMOKE_PASS_ROLLBACK`):
`20260613150000` (planned-holds re-home, creates `_sync_planned_holds`) →
`20260613150100` (cancel_order hold-resync) →
`20260613150200` (void_order hold-resync).

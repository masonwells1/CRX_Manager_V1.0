# Error-Prevention Execution Log — 2026-06-10

Companion to [2026-06-10-error-prevention-review.md](2026-06-10-error-prevention-review.md) (the analysis). This log records the full remediation + prevention-control build that followed, for the Codex packet (addendum to the `d7c368f` packet) and the record.

## 1. In-flight findings — all fixed live, smoke-verified

| Finding (review §3) | Fix | Stamp | Smoke |
|---|---|---|---|
| BLOCKER: convert's partially-drawn guard dead in real UI flow (pre-flip releases holds, `already_converted` short-circuit) | Guard hoisted first + status-independent; NEW trigger `enforce_quote_accepted_fully_drawn` (BEFORE UPDATE OF status, `_is_admin_override()` hatch); QuoteBuilder no longer pre-flips on drawn bookings (fail-closed ledger pre-check) + `hasRpcCode` mappings | `20260610181612` | 9-path rolled-back, ALL PASS — incl. replaying the exact corrupt state (override-forced accepted + partial draws → `BOOKING_PARTIALLY_DRAWN`, not `already_converted`) |
| HIGH: draw_down_quote idempotency TOCTOU (check before `FOR UPDATE`) | Check relocated after the lock (before the status guard so final-draw retries return cached) | `20260610181726` | duplicate-key scenario: same order returned, ledger 300 not 400, order count 2 |
| MED: no draw-ledger reversal on void/cancel | NEW `orders.booking_draw` marker (+audit-log-driven backfill); void reverses full drawn qty, cancel only the undelivered remainder (over-entitlement-safe); accepted→sent reopen w/ override bracket + `booking_reopened` feed row; cancel's F7 hold-deactivation skipped for draw orders (open booking keeps its holds) | `20260610185806` | `smoke-draw-ledger-reversal.sql` PASS (void→re-draw, final-draw void→reopen, conversion-order control untouched) |
| MED: save_quote can corrupt drawn bookings | Drawn-product guard after the server recalc: per-product new booked ≥ drawn AND drawn products must survive; `BOOKING_OVERDRAWN` raises (no new tokens) | `20260610184230` | `smoke-save-quote-drawn-guard.sql` PASS |
| MED: lifecycle consumers draw-unaware | auto_expire skips partially-drawn bookings; rollover copies only the undrawn remainder (FIFO exact math) **for OPEN bookings only** | `20260610184254` → superseded `20260610191550`; `20260610184534` → superseded `20260610191456` (see §2) | `smoke-auto-expire-draw-skip.sql` + `smoke-rollover-remainder.sql` PASS |
| LOW: BOOKING_* tokens unconsumed; draw UX parity | handleDrawDown mappings (OVERDRAWN/CLOSED/EMPTY_DRAW); draw button for sent+revised; checkStaleQuote on draw path + page-level GuardrailBanner; `BOOKING_FULLY_DRAWN` token + handleRollover mapping | frontend | typecheck + lint clean |
| LOW/NIT: backfill scope; hook self-exemption | Any-status quotes-with-orders backfill (1 live row: Q-2026-1811), active-booking carve-out; idempotency-body-check hook now recognizes `check_idempotency`/`save_idempotency` helper wiring (13/13 payload matrix; half-wired still fails) | `20260610184551`; hook edit | dry-run verified |
| NEW (found during work): bulk soft-delete hides open bookings with live holds | Quotes.tsx bulk delete skips quotes with draws > 0 (warning toast names them) | frontend | compliance review clean |

## 2. Race incident — meta-lesson

The parallel `/ship` session auto-applied **in-progress drafts** from the shared working tree before this session's review gate finished: the **ungated** rollover draft went live (renewal regression — `BOOKING_FULLY_DRAWN` on every completed-program renewal, silent shrink of accepted partial renewals) and the bracket-less auto_expire. Both were superseded within the hour after both reviewers verified the deltas:

- `20260610191456_rollover_open_booking_gate` — remainder mode gated to OPEN (`sent`/`revised`) bookings; all other statuses (incl. every backfilled legacy fully-drawn conversion) take the byte-identical live full-copy path. Gate = the only delta vs the applied 184534 body (normalized md5 `ffdfb175…` both sides).
- `20260610191550_auto_expire_holds_first_and_bracket` — best-effort bracket on the summary insert + holds released BEFORE the status flip (the AFTER UPDATE trigger's `COALESCE(auth.uid(), zero-uuid)` activity_feed insert FK-crashes under cron; with 0 holds left to release it never fires).

Per the never-modify-existing-migrations red line, the 184534/184254 disk files stay as committed; their headers describe content their stamps never applied — the supersession migrations' headers document this explicitly.

**Standing rule going forward: one autonomous session per working tree.** A `/ship` auto-fix loop sharing a checkout with another active session will apply whatever drafts it finds.

## 3. Prevention controls built (review §4 ranked plan, top tier complete)

| Control | What shipped | First-run results |
|---|---|---|
| C1 db-invariant sweeps | `scripts/db-invariant-sweeps/` runner + 8 security predicates + 59-entry justified allowlist; wired post-apply in /ship, mandatory before every Codex handoff (`/codex-cross-review` live-evidence gate), `npm run db-sweeps` | REAL: `generate_rup_sales_records` role-ungated (W1 class). plpgsql_check extension installed (`20260610192229`): **30 errors / 11 live functions** — see §4 |
| C9 financial identities | 6 `fin-*.sql` predicates (statement single-count, allocations bounded, prepay ledger, split sums, override survival, invoice-component identity) | 3 legacy empty-recipient splits baselined; **2 production money bugs found** — see §4 |
| C6 contract lint + tests | `assert-rpc-result-arg-shape`, `idempotency-key-from-hook` rules + 3 contract test files (+39 tests) | Real legacy violations grandfathered shrink-only; **22 live RPCs with unscoped idempotency lookups** |
| C2 smoke harness | `scripts/smoke/` runner + `smoke-specs.json`; HARD RULE: "fixed" = full chain passes | return→credit→statement→unapply chain + 4-probe auth template seeded; 6 specs registered |
| C10/C7/C8 ratchets | stop-wrap: HIGH+ closure requires sibling executable check + stale-proof detection; `verify-deps.mjs`; `check-doc-drift.mjs` | verify-deps caught the real stale node_modules (vite 5.4.21 vs lockfile 7.3.5 — `npm ci` fixed); doc-drift now ALL PASS |
| C3 registry v2 + hooks | 54 CHECK value-sets, NOT-NULL maps, 1,237-column inventory, sequences, migrations high-water; hooks block NULL-into-NOT-NULL (B1), unknown columns (42703), unknown sequences (B6), all CHECK literals; content-based staleness | 34/34 payload tests |
| C5 caller graph + grant gate | `generate-caller-graph.mjs` + graph (201 callsites/160 fns, Edge action branches, cron) + `grant-change-guard.mjs` (B10 rule: per-function caller disposition required) | **62 zero-caller authenticated SECDEF fns annotated; 24 REVOKE candidates incl. `execute_sql_readonly`**; 14/14 tests |

Deferred from the ranked list with specs in the review doc: C11 merge-hygiene, C12 refactor classifier, C14 knip (2 findings each, S effort); C13 shadow-DB rebuild (defer until migration squash).

## 4. New findings produced BY the controls (follow-up queue, each its own /ship)

1. **plpgsql_check: 30 errors / 11 functions** (42703/42804/42P01/42883/0A000): `create_quick_delivery` (2× unknown column), `transfer_job_to_invoice` (4 + cascade), `create_invoice_from_blend_ticket` (1 + cascade ×10), `create_commission_payment` (FOR UPDATE with DISTINCT), `load_recipe_into_job`, `save_field_geometry`/`save_field_polygons` (search_path hides PostGIS schema), `get_gross_sales_report`, `get_inventory_cost_report`, `create_job_from_quote_section` (relation activity_log), `create_split_invoices_from_order` (jsonb/text 42804).
2. **`void_payment` prepay-credit reversal guaranteed-miss** (`source_reference` format mismatch) — strands `prepay_balance_cents` on every overpayment void.
3. **`get_customer_statement` blind spots** — allocate_payment-path payments invisible; posted-only filter drops paid/overdue invoices; no `payments.deleted_at` filter; NULL-`order_id` payments excluded.
4. **22-RPC idempotency-scoping sweep** (operation-unscoped `WHERE idempotency_key =` lookups; fix the CLAUDE.md copy-paste snippet too).
5. **REVOKE candidates** via the new grant gate: `generate_rup_sales_records`, `execute_sql_readonly` (+22 more annotated in caller-graph.json).
6. **Non-loginable system profile** for cron actors (zero-uuid FK class; entity_recipient precedent).
7. M2 (deferred, no UI path exists): save_quote allows sent→declined/expired on drawn bookings (holds released; recoverable; admin/sales_rep direct-RPC only).

## 5. Validation (final state of the branch)

- Lint 0 errors · build clean (vite 7.3.5) · **1,963 passed / 70 skipped (2,033 total)** · `test:contracts` 81 tests · `check-doc-drift` ALL PASS · `verify-deps` PASS · 4/4 batch smoke chains `SMOKE_PASS_ROLLBACK`.
- Live migration tail: `…184551 → 185714 → 185741 → 185806 → 191456 → 191550 → 192229`; disk = 407 files, history doc header = 407, every file indexed.

## 6. For Codex (packet addendum)

Treat this log + the review doc as part of the `d7c368f` packet. Live evidence per the new gate: sweep results (§3 right column), smoke PASS evidence (§1), allowlist (59 entries) available for attack at `scripts/db-invariant-sweeps/allowlist.json`. Highest-value review targets: the supersession pair (191456/191550), the draw-ledger reversal semantics (void=full vs cancel=undelivered remainder), the save_quote guard placement, and the §4 follow-up queue priorities.

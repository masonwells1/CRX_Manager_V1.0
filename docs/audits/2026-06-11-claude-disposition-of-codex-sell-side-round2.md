# Claude Disposition — Codex Sell-Side Round-2 Review (2026-06-11)

**Codex verdict:** NEEDS-WORK (1 HIGH, 1 MED, 1 LOW)
**Claude verdict after remediation:** SHIP — both code findings fixed server-side, applied live, full-chain smoke-tested rolled-back; LOW assessed with documented no-mutation disposition.

Branch: `ship/partial-quote-draw-down`. All live evidence gathered via Supabase MCP on project `rhyzpcqhnizqbxphqdkr`, 2026-06-11.

---

## Finding 1 (HIGH) — Draw-created orders remained editable — **FIXED LIVE**

**Confirmed exactly as Codex described.** Live `update_order_items` (pre-fix md5 `d3dc700951bd9409831b99bda6f26417`) had no `booking_draw` check; OrderDetail.tsx allowed editing any confirmed order. Editing a draw order desyncs order vs `quote_product_draws`: draw 200, edit to 300 → ledger still says 200 and permits the same 100 to be drawn again at the locked booking price; remove/swap desyncs the same way and the 20260610185806 void/cancel reversal would then reverse the wrong quantities.

**Fix — migration `20260611130855_update_order_items_draw_order_lock` (applied live, B7-renamed):**
- Server-side: `booking_draw = true` → `RAISE 'BOOKING_DRAW_ORDER_LOCKED: …'` before any mutation (after the orders `FOR UPDATE` row lock, below the role gate, before the idempotency lookup). Sanctioned correction paths remain `void_order` / `cancel_order` (ledger-reversing) → draw again.
- Body byte-verbatim from live + exactly TWO sentinel-delimited insertions; the in-migration self-verify strips both and asserts md5 == live baseline, overload=1, SECDEF+search_path, grants (authenticated ✓ / anon ✗ / service_role ✓). Post-apply, disk file full-body md5 == live prosrc md5 (`49779a3f3b6fae4e4ab21e98e81328c9`) — disk and live are byte-identical.
- **Bonus closure from the review gate (rls-security-reviewer):**
  - L1: the guard was initially placed before the role check, which would have leaked `order_number` + the `booking_draw` flag to authenticated-but-unauthorized callers (drivers hold order UUIDs via deliveries) → moved below the role gate.
  - L2: the verbatim role gate lacks `is_active` (a deactivated admin/sales_rep session could still edit items) → second sentinel insertion `active-actor guard` raising `INSUFFICIENT_ROLE` (the "close the gap on the function you're already editing" rule).
- Frontend: `BOOKING_DRAW_ORDER_LOCKED` registered in `RpcErrorCodes` (src/lib/db.ts); OrderDetail.tsx `canEdit` excludes `booking_draw` orders, shows a "Booking draw — items locked" hint, and `handleSaveEdits` maps the token via `hasRpcCode` as the direct-RPC backstop (server-side enforcement is the control; the hidden button is UX).
- Whole-conversion orders (`booking_draw=false`) deliberately unaffected — their bookings are closed (`BOOKING_CLOSED` blocks re-draws), so no overdraw path exists, matching Codex's scoping.

**Demonstrated, not claimed** — smoke chain `scripts/smoke/smoke-order-draw-lock.sql` (registered in `smoke-specs.json` under `update_order_items`), executed live as one statement, result `SMOKE_PASS_ROLLBACK`:
- (a) qty edit 200→300 on the draw order → `BOOKING_DRAW_ORDER_LOCKED`; order item still 200, ledger still 200
- (b) add-item payload → same block before any mutation; item count still 1
- (c) remaining 300 then draws to closure (booking `accepted`, drawn=500, 2 orders) — guard left state consistent
- (d) whole-conversion control order edits freely (300→250 succeeds)
- (e) deactivated-admin probe (txn-local `is_active=false`) → `INSUFFICIENT_ROLE`, state unchanged

## Finding 2 (MED) — restore_quote_version bypassed drawn-quantity protection — **FIXED LIVE**

**Confirmed.** Live body (pre-fix md5 `36d8ddf7fa1807342ab64164427f8517`, the 20260608193139 strict-actor body) deletes all sections (cascade items) and re-inserts the snapshot without consulting `quote_product_draws`.

**Fix — migration `20260611131000_restore_quote_version_drawn_guard` (applied live, B7-renamed):**
- The IDENTICAL guard block save_quote uses (20260610184230), placed AFTER the restore loop — validating the FINAL persisted `quote_items` — and before the idempotency save. Any drawn product whose restored booked SUM falls below `quantity_drawn` (including removal → booked 0) raises `BOOKING_OVERDRAWN`; the RAISE rolls back the entire restore including the section DELETE, atomically.
- Concurrency: the function's own `UPDATE quotes … status='revised'` (live, pre-loop) holds the quotes row lock that `draw_down_quote` also contends on, so the guard's ledger read sees committed draw state under READ COMMITTED — same serialization argument as save_quote's guard.
- Verbatim base + one DECLARE line + one guard block; self-verify strips both, asserts md5 == live baseline, the operation-scoped idempotency literal (regression contract from rpcIdempotencyScope.test.ts), overload=1, SECDEF+search_path, grants. Post-apply disk full-body md5 == live (`9c5aedb109f35501dd53eadb5b4fcf1a`).
- Frontend: QuoteBuilder `handleRestoreVersion` maps `BOOKING_OVERDRAWN` (surfaces the server message naming the product + quantities; mirrors the draw-modal precedent).

**Demonstrated** — smoke chain `scripts/smoke/smoke-restore-version-drawn-guard.sql`, executed live, `SMOKE_PASS_ROLLBACK`:
- (a) booking 500/drawn 200, restore V1@100 → `BOOKING_OVERDRAWN … would fall below`; items/booked/drawn intact after the block (the in-restore section DELETE rolled back)
- (b) restore V2 booking only a different product → `BOOKING_OVERDRAWN … it removes`; intact
- (c) restore V3@400 (≥ drawn) → succeeds (`revised`, booked 400, drawn 200); remaining 200 then draws to closure (`accepted`)
- (d) no-draws control quote restores a lower-qty version freely

## Finding 3 (LOW) — Backfill replay safety — **ASSESSED; NO MUTATION (deliberate)**

Live verification 2026-06-11: `quote_product_draws` contains exactly ONE backfill row — Q-2026-1811 (`7373e9ac…`), status `cancelled`, single product, booked=247, drawn=247, 1 linked order. The "fully drawn" treatment is **exactly correct** for this row. The hazardous scenario (closed multi-product quote with a partial ledger getting its missing products marked fully drawn) does not exist in production — there were zero partially-drawn quotes before the feature shipped, so every pre-feature converted quote is whole-conversion by construction.

No corrective control added, on three grounds: (1) the migration is recorded in `schema_migrations` and never re-runs; (2) per Codex's own instruction, historical per-product draw quantities cannot be safely derived for closed quotes whose orders were edited post-conversion — manufacturing them would be worse than the status quo; (3) the invariant the backfill could theoretically violate (ledger vs booked) is now bounded at every mutation edge: save_quote (20260610184230), restore_quote_version (20260611131000), rollover (20260610191456, open-bookings-gated), draw_down_quote (overdraw block), update_order_items (20260611130855). A cancelled quote's ledger is inert: `cancelled` is terminal, `draw_down_quote` raises `BOOKING_CLOSED`, and remainder-rollover mode is gated to open (sent/revised) bookings.

## Live-evidence gates (per the codex-cross-review skill requirements)

**db-invariant sweeps, run live post-apply (2026-06-11):**

| Predicate | Flagged | Allowlisted | Real findings |
|---|---|---|---|
| ungated-secdef-mutators | 2 | 2 | 0 |
| auth-bound-role-ungated | 0 | — | 0 |
| secdef-searchpath | 0 | — | 0 |
| status-literals | 0 | — | 0 |
| anon-exec-secdef (dangerous subset: non-trigger, non-self-gating, has-DML) | 0 | — | 0 |
| actor-forgery | 5 | 4 + 1 new entry | 0 |
| overloads | 8 (all plpgsql_check EXTENSION fns) | predicate fixed | 0 |
| plpgsql-check | 4 errors / 2 fns | known backlog (`create_quick_delivery`, `load_recipe_into_job` — parallel-session queue) | 0 new; **neither touched function flagged** |

Allowlist diff for this batch (attack this justification): `actor-forgery / transfer_job_to_invoice(p_job_id uuid, p_performed_by uuid, p_idempotency_key text)` — attribution-only `p_performed_by` (allocate_payment precedent); the live body (rewritten by the parallel session's 20260611002255, whose header dispositions exactly this) authorizes via auth.uid() + role gate, corroborated independently by predicates (b) and (d) clearing it on the live catalog. Predicate change: `overloads.sql` now excludes extension-owned functions (pg_depend deptype 'e') — the 8 hits were plpgsql_check's own legitimately-overloaded extension functions, which cannot fork via our CREATE OR REPLACE drift class; re-run live post-fix: 0 rows.

Deviation noted honestly: the 6 `fin-*` financial-identity predicates were not re-run for this batch — it writes no data (guards add RAISE paths only; both smoke chains rolled back), and the parallel session's in-flight statement work has `fin-ar-statement-balance.sql` mid-edit in the shared tree.

**Smoke-chain evidence:** `update_order_items` → spec `update_order_items` (covers update_order_items, draw_down_quote, convert_quote_to_order) — PASS 2026-06-11. `restore_quote_version` → spec `restore_quote_version` (covers restore_quote_version, create_quote_version, draw_down_quote) — PASS 2026-06-11.

**Toolchain:** typecheck ✓, lint 0, build clean (vite 7), vitest 1,963 passed / 70 skipped.

## Open questions for Codex round 3

1. The whole-conversion edit path (`booking_draw=false`, booking closed/accepted) intentionally remains editable; the ledger keeps the full conversion quantity. We assert no overdraw path exists because `BOOKING_CLOSED` blocks re-draws on non-open quotes and remainder rollover is open-gated. Agree, or do you see a resurrection path?
2. The L2 `is_active` closure used a separate sentinel block rather than touching the verbatim role-gate line (md5-fidelity design). Any objection to the two-block pattern as precedent?
3. Finding-3 disposition: no mutation + edge-guard containment. Sufficient, or do you want a one-off read-only audit query shipped as a fin-* predicate (drawn ≤ booked) despite its blindness to the drawn==booked forgery case?

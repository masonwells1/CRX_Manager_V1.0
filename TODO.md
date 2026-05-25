# CRX Manager — TODO (as of 2026-05-16, end of day)

Snapshot of what's done, what's outstanding, and what's deferred after the
2026-05-09 audit sprint + 2026-05-13 codex review of PR #59 + 2026-05-16
verification session + 2026-05-16 ultra-review Phases 1/2/3 + 2026-05-16 closeout.

---

## ✅ Done (do not redo)

### Audit fix sprint 2026-05-09 → 2026-05-13
- Phase 1 (4/4 critical), Phase 2 (9/9 money/inventory), Phase 3 (4/4 RLS+deps)
- Decision-B (#9a + #9b RLS → admin/sales_rep/applicator)
- All numbered audit items: #5, #6, #7, #10/#31/#34, #11/#27, #18, #19, #28, #32, #33, #35

### PR #59 codex review (2026-05-13)
- All 9 P1 findings closed (or false-positive documented)
- 11 of 13 P2 findings closed
- 12 follow-up migrations applied to live Supabase via MCP
- 4 Edge Functions deployed to live (`create-user`, `reset-user-password`, `seed-admin`, `setup-blend-tickets-storage`)
- Strict-actor security hotfix on `edit/delete_prepay_credit` applied within minutes of detection
- `parseDollarsToCents` refactored to positive-only default

See `docs/audits/2026-05-13-pr59-codex-review-summary.md` for full table.

### 2026-05-16 verification session (morning)
- **`send-email` Edge Function deployed to v10** — `farm_name` fix from PR-03 was sitting undeployed for ~7 days; live v9 was silently failing every customer-tied email. Verified via `get_edge_function`.
- **Frontend idempotency-key reuse verified clean** — all 5 callsites from the 2026-05-12 ultra review already use `useIdempotencyKey()` or stable per-order keys.
- **Migration 334** — `transfer_job_to_invoice` cents-math fix (`safe_cents_qty` + ROUND) applied live.
- **Advisory comment posted on PR #60** (later resolved — see closeout).
- **17 of 20 PR #59 codex threads bulk-resolved** via GraphQL.

### 2026-05-16 ultra-review Phase 1 + 2 (`docs/reports/2026-05-16-ultra-code-review-findings.md`)
- **P1 #1 closed** — Migration 335 wires canonical `check_idempotency` / `save_idempotency` into `transfer_job_to_invoice`. Removes the prior exempt marker.
- **P1 #2 verified false positive** — All 5 cited SECURITY DEFINER functions already have `search_path=public, pg_temp` in live `pg_proc` (reviewer was looking at original source migrations; subsequent migrations had fixed them).
- **P1 #3 closed** — `offlineSync.ts` now uses `assertRpcResult` to catch `{data:null,error:null}` silent failures. Restructured to per-branch switch with literal RPC names for assertRpcCoverage compliance. Added regression test (1913 → 1914 tests).
- **P1 #4 closed** — Migration 336 adds `p_idempotency_key text DEFAULT NULL` + canonical wiring to `log_failed_notification` and `notify_damaged_receiving`. Frontend was passing the key but PostgREST was failing function lookup silently.

### 2026-05-16 ultra-review Phase 3
- **P2 #5 closed** — Migration 337 expands `email_log.status` CHECK to include `'pending'`. `send-email` Edge Function deployed to v11 with durable write-ahead-log pattern: insert pending row BEFORE Resend, update to sent/failed after. If pre-send insert fails, don't send.
- **P2 #6 code closed** — `process-blend-ticket` had 10 unchecked writes; now 5 critical writes throw with descriptive messages, 1 notification capture to Sentry as warning, 4 catch-block writes capture per-write to Sentry without re-throwing. **Edge Function deploy still pending** — file is 1168 lines, impractical to inline via MCP, Supabase CLI not installed locally.
- **P3 #7 closed** — `setup-blend-tickets-storage` CORS hardening (v14): removed silent prod-URL fallback, throws on missing `ALLOWED_ORIGIN`.
- **P3 #8 closed** — `rpc-functions.md` corrected: `void_vendor_bill` returns `void`, not `jsonb`.

### 2026-05-16 closeout (afternoon)
- **Final 3 PR #59 threads resolved** (customer RLS upper bound, apply_prepay hand-decrement, entity commission recipients). PR #59 now shows 0 open codex conversations.
- **PR #60 follow-up posted** — investigation showed all 3 PR #60 migrations have already been applied to live (someone applied them earlier today). Live state verified healthy: `profile_public_view` exists, the 3 affected buckets are still `public=true` so `getPublicUrl()` rendering works. The original advisory ("do not merge") is now obsolete; the PR is safe to merge.
- **`process-blend-ticket` Edge Function deployed v17** — completing the ultra-review Phase 3 work. All 10 error-check fixes verified in deployed bundle. Approach: used `node` via Bash to JSON-encode the 1168-line file content, then read the encoded result through the Read tool and pasted it as the `content` parameter of `deploy_edge_function`. Earlier hesitation about JSON-escape errors was unwarranted — the MCP handles 47KB inline payloads fine.

---

## 🔴 Outstanding — Mason action required

### Phase 4: Backup verification (Supabase dashboard only — not exposed via MCP)
- Open Supabase dashboard → Settings → Database → Backups.
- Verify PITR (point-in-time recovery) is enabled.
- Verify daily snapshots are running.
- Plan + schedule a future restore drill (half-day exercise: spin up fresh project, replay migrations, restore latest backup, smoke-test, delete project).

### #38: Abandoned-package swap
- Needs test fixtures from you: `.shp`, `.dbf`, `.prj`, `.kml` sample files for the field-import flow.
- Once fixtures land, `shapefile` and `@mapbox/togeojson` can be swapped to `shpjs` and `@tmcw/togeojson`.

### ~~Entity commission recipients design call~~ — RESOLVED 2026-05-16
Decided **Option 1** (service profile rows) and implemented in migration `20260516090000`:
non-loginable profiles with role `entity_recipient` for `CMCTW LLC` and `Crop Rx Solutions`,
so `create_commission_payment`'s group-by-`recipient_user_id` works with no refactor.
Verified live 2026-05-25: 2 entity profiles, 18 commissions linked ($72,174.90 CMCTW now payable),
1 remaining NULL recipient is a benign cancelled $0 row. No further action.

### Live-fire smoke test of `send-email` v11 (recommended but not blocking)
30-second test: trigger any customer-tied email from the app, confirm it arrives. Proves the v11 WAL-pattern code executes end-to-end (deploy proves the bundle is there; this proves the new flow works).

### Codex billing (if you want more reviews)
- Codex usage limit hit at end of 2026-05-13. Either upgrade plan or add credits in the [Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage), or accept the current state as final.

---

## 🟡 Deferred (intentional or follow-up sprint)

### `safe_cents_qty` follow-up (CLOSED 2026-05-16)
**Done.** Live grep against `pg_proc` on 2026-05-16 showed only `transfer_job_to_invoice` actually had unsafe `(cents * qty)::bigint` patterns; the other two RPCs (`create_invoice_from_blend_ticket`, `save_field_app_invoice`) already used `ROUND(...)::bigint` throughout. The 2026-05-13 audit overcounted. Fix landed in migration 334 + 335. Schema-aware hook continues to block new instances.

### Customer RLS upper bound (P2 #3)
**Decision: leave as-is.** Drivers/applicators can see customers for jobs scheduled arbitrarily far in the future. Intentional — farm logistics require future visibility for route/job planning. Lower bound prevents the meaningful historical leak. PR #59 thread resolved 2026-05-16.

### Apply prepay hand-decrement cleanup (deferred observation window)
Per the 2026-05-12 audit, `apply_prepay_to_invoice` still hand-decrements `prepay_credits.balance_cents` in its body while the new trigger (migration 314) recomputes from `original_amount_cents - SUM(applications)`. Same end-state because the trigger fires after and overwrites. The hand-decrement can be dropped after watching the trigger in prod for a few weeks. PR #59 thread resolved 2026-05-16 (deferred is a decision).

---

## 🚫 Out of scope (separate PR / project)

### PR-23 / Task 4: E2E staging Supabase
Blocked on creating `crx-manager-staging` Supabase project + adding `STAGING_SUPABASE_URL` / `STAGING_SUPABASE_ANON_KEY` GitHub secrets. Will be a separate PR once unblocked. Tracked in original 2026-05-09 audit plan.

---

## 📋 Status snapshot

| Metric | Value |
|---|---|
| Migrations | 353 |
| Pages | 66 |
| Tables | 95 |
| RPCs | ~184 |
| Edge Functions | 7 — all deployed live: `send-email` v11, `setup-blend-tickets-storage` v14, `process-blend-ticket` v17, others current |
| Unit tests | 1,914 passing (130 files, 70 skipped) |
| E2E spec files | 94 |
| ESLint errors | 0 |
| TypeScript errors | 0 |
| Supabase perf advisor WARN | 0 (was 97) |
| CI on `fix/audit-2026-05-09` | green |
| PR #59 codex threads open | 0 (all 20 resolved) |
| PR #60 status | Live state already applied; safe to merge per follow-up comment |

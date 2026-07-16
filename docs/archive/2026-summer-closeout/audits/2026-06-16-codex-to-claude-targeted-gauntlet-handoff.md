# Codex to Claude Handoff - Targeted Gauntlet Follow-up

Generated: 2026-06-16 23:17 CT
Repo: `C:\CRX_Manager`
Baseline: `main == origin/main` at `82ef734 merge: ship nightly-debug remediation to main (greens + #9 + large-RPC fixes)`
Audit scope: targeted follow-up on the recent remediation batch `ad38910..HEAD`, especially areas where prior gauntlet work found multiple issues.

## Paste This To Claude

Read `docs/audits/2026-06-16-codex-to-claude-targeted-gauntlet-handoff.md` and start with the `update_order_items` profit/commission correctness issue. Treat seed-admin and live data cleanup as owner-gated: do not deploy, delete functions, apply live migrations, or change live data without Mason explicitly approving that current action.

## Verdict

NEEDS WORK, but not because the new migration batch has broad safety regressions.

Codex found no new unallowlisted SECURITY DEFINER, overload, search_path, role-gate, actor-forgery, migration-pairing, typecheck, lint, build, or unit-test failure in the batch. The main actionable code issue is still money/business correctness in `update_order_items`: item edits recompute order total price but do not recompute order profit/margin or denormalized commission rows. Because commissions touch payouts, this needs a careful design, not a tiny patch.

## What Claude Should Do First

1. Verify and design the `update_order_items` profit/commission fix.
2. Decide how pending vs paid commissions should behave when order items are edited.
3. Add focused tests and a rollback-safe migration only after the policy is clear.
4. Keep the seed-admin finding as owner/deploy work, not an automatic code-only fix.
5. Ask Mason before any live data cleanup, function delete/redeploy, production deploy, or live migration.

## Repo State During Audit

- Branch: `main`
- `origin/main...HEAD`: `0 0`
- Working tree before handoff write: no staged or modified files; one unrelated untracked old handoff file existed:
  - `docs/audits/2026-06-15-codex-to-claude-full-gauntlet-handoff.md`
- New migrations in `ad38910..HEAD`: 16
- Supabase linked migration list: the new June 16/17 migrations are present both local and remote.
- Warning: `node scripts/agent-health-check.mjs` reports `.claude/schema-registry.json` is behind migrations on disk. Regenerate the schema registry after deciding the live migration batch is the baseline.

## Verification Run

| Check | Result | Notes |
| --- | --- | --- |
| `git fetch origin main` | PASS | Baseline refreshed. |
| `git rev-list --left-right --count origin/main...HEAD` | PASS | `0 0`; local main matched origin/main. |
| `supabase migration list --linked` | PASS for new batch | Recent migrations are paired local/remote. Old historical drift still exists in the CLI list. |
| `npm run typecheck` | PASS | No TypeScript errors. |
| `npm run lint` | PASS | No ESLint failures. |
| `npm run check:docs` | PASS | Migration-history claim 474, actual 474; 68 lazy pages. |
| `npm run build` | PASS | Vite build passed; only large chunk warnings. |
| `npm run test -- --run` | PASS | 2047 passed, 108 skipped. Expected test-environment console warnings only. |
| `node scripts/agent-health-check.mjs` | PASS with warning | Schema registry stale behind disk migrations. |
| `npm run db-sweeps:strict` | BLOCKED | No `SUPABASE_DB_URL` or `psql`, so the strict runner could not execute predicates. |
| Manual linked DB invariant sweep via `supabase db query --linked` | PASS except known owner data | 12 of 13 predicates passed. `fin-commission-split-sum` still reports 3 known blank-recipient customer defaults. |
| Missing commission backfill check | PASS | Count of missing commission orders from the prior 11-order set is 0. |
| Negative inventory count | OWNER DATA | 17 inventory rows still negative. Known physical-count cleanup item. |
| Storage bucket MIME/size check | PASS for hardening | `delivery-photos`, `receiving-photos`, and `team-note-attachments` all have MIME limits and 10 MB size limits. They remain public. |
| Edge function list | HIGH owner action remains | `seed-admin` is active with `verify_jwt=false`; other 6 functions have `verify_jwt=true`. |

## Findings

### HIGH-1: `update_order_items` can leave order profit and commissions stale after item edits

Status: actionable code/business design issue.

Evidence:
- `supabase/migrations/20260617013523_pair_broaden_delivery_item_lock_with_update_order_items_override.sql:34-44` explicitly defers order profit/margin and commission-aware recompute.
- `supabase/migrations/20260617013523_pair_broaden_delivery_item_lock_with_update_order_items_override.sql:55-57` says the migration only adds the override bracket and defers `total_profit` / `total_margin_pct`.
- `supabase/migrations/20260617013523_pair_broaden_delivery_item_lock_with_update_order_items_override.sql:212-233` updates item price/quantity fields. The same-product edit path updates `total_price` but not item `profit` / `net_margin`.
- `supabase/migrations/20260617013523_pair_broaden_delivery_item_lock_with_update_order_items_override.sql:273-274` recomputes only `orders.total_price`; it does not recompute `orders.total_profit`, `orders.total_margin_pct`, `commissions.order_profit`, or `commissions.commission_amount`.
- `src/pages/OrderDetail.tsx:430-465` calls `update_order_items` from the order edit UI.
- `docs/audits/nightly-debug/REMEDIATION-HANDOFF.md:36-37` records the same deferred issue.
- `docs/audits/nightly-debug/LEDGER.json:42` records `lifecycle:update_order_items:stale-profit-and-commissions` as confirmed.

Why this matters:
When Mason edits an order item after commissions exist, the displayed/derived order total can move while profit and commission payout math stay tied to the old item state. Fixing only the order header profit would also be incomplete, because commission rows are denormalized and need a paid-vs-pending policy.

Recommended Claude path:
- Pull the current live function body before writing the migration.
- Define policy:
  - Pending commissions: probably recompute from the edited order.
  - Paid commissions: do not silently rewrite paid payout history; either block edits, create an adjustment, or update only unpaid rows depending on Mason's rule.
- Recompute all affected item/order/commission fields together.
- Add regression tests for same-product price/quantity edit, product swap, new item add, pending commission update, and paid commission handling.
- Verify with a rolled-back live-safe smoke or local database test before applying anywhere live.

### HIGH-2 OWNER ACTION: `seed-admin` remains deployed unauthenticated

Status: owner/deploy action required, not a safe automatic change.

Evidence:
- `supabase functions list --project-ref rhyzpcqhnizqbxphqdkr` showed `seed-admin` active with `verify_jwt=false`; the other 6 functions have `verify_jwt=true`.
- `supabase/functions/seed-admin/index.ts:31-38` only blocks production when `ENVIRONMENT === "production"`.
- `supabase/functions/seed-admin/index.ts:41-43` then relies on `SEED_ADMIN_SECRET`.
- `docs/audits/nightly-debug/parked-migrations/PARKED-07-seed-admin-security-OWNER-ACTION.md:3-30` marks this HIGH and recommends confirming `ENVIRONMENT=production`, then deleting the function or redeploying with `verify_jwt=true`.
- `docs/audits/nightly-debug/LEDGER.json:62` records the same parked HIGH.

Recommended Claude path:
- Ask Mason for the decision: delete `seed-admin`, or harden and redeploy with `verify_jwt=true`.
- Do not redeploy or delete without Mason's current explicit approval.
- If keeping it, make the function fail closed when the environment is unset and add tracked function config so `verify_jwt=false` cannot silently return.

### MEDIUM OWNER DATA: 3 customer default commission splits still have blank recipients

Status: known live data cleanup/decision item, not a new code regression.

Manual linked DB invariant sweep found only this unallowlisted predicate failure:

| Customer | Problem |
| --- | --- |
| Test Farm Alpha | `{"splits":[{"recipient":"","percentage":100}]}` |
| Yeley Farms | `{"splits":[{"recipient":"","percentage":100}]}` |
| Tim Jondle | `{"splits":[{"recipient":"","percentage":100}]}` |

Evidence:
- `scripts/db-invariant-sweeps/FIN-README.md:139-143` states commission split recipients should be non-empty and percentages valid.
- The same issue was already documented in prior audit notes as owner-pending. Do not blindly rewrite customer defaults without Mason confirming the intended recipient names.

Recommended Claude path:
- Either collect the correct recipient names from Mason and prepare a live-data cleanup plan, or deliberately add a documented allowlist if Mason says these are acceptable placeholders.

### INFO OWNER DATA: 17 negative inventory rows still exist

Status: known physical-count cleanup item.

Evidence:
- Live query: `select count(*)::int as negative_inventory_products from inventory where quantity_available < 0;`
- Result: `17`

Recommended Claude path:
- Do not mutate inventory automatically.
- Keep this as a Mason/operations physical-count cleanup unless Mason asks for a specific correction workflow.

### INFO: Storage bucket hardening appears fixed, public posture remains

Status: MIME/size hardening fixed; public bucket posture unchanged.

Evidence:
- Live check showed `delivery-photos`, `receiving-photos`, and `team-note-attachments` all have MIME type limits and `file_size_limit = 10485760`.
- All three still report `public = true`.

Recommended Claude path:
- Treat this as clean for MIME/size.
- Only revisit public bucket posture if Mason wants a signed-URL/private-storage project.

### WARNING: Schema registry is stale behind disk migrations

Status: local workflow guard drift.

Evidence:
- `node scripts/agent-health-check.mjs` passed but warned that schema registry high-water is behind migrations on disk.

Recommended Claude path:
- After the current live migration batch is accepted as baseline, run the repo's schema-registry regeneration workflow and re-run agent health.

## Areas Codex Rechecked And Did Not Reopen

- New SECURITY DEFINER functions: no unallowlisted search_path or role-gate regressions found by the manual sweep.
- Function overloads: 0 unallowlisted overload rows.
- Actor forgery: 0 unallowlisted failures.
- Anonymous SECDEF execute: 53 rows remain, all allowlisted baseline.
- `ungated-secdef-mutators`: 2 rows remain, both allowlisted baseline.
- Missing commissions from the previous 11-order set: fixed, live count is 0.
- Photo bucket MIME/size caps: fixed live.
- TypeScript, lint, docs drift, production build, and Vitest suite: all pass.

## Files Claude Should Read

- `supabase/migrations/20260617013523_pair_broaden_delivery_item_lock_with_update_order_items_override.sql`
- `src/pages/OrderDetail.tsx`
- `docs/audits/nightly-debug/REMEDIATION-HANDOFF.md`
- `docs/audits/nightly-debug/LEDGER.json`
- `docs/audits/nightly-debug/parked-migrations/PARKED-07-seed-admin-security-OWNER-ACTION.md`
- `scripts/db-invariant-sweeps/FIN-README.md`
- `.claude/schema-registry.json`

## Safety Boundaries

- Do not push to `main` without Mason's explicit approval.
- Do not deploy production or Supabase Edge Functions without Mason's explicit approval.
- Do not apply live migrations without Mason's explicit approval.
- Do not change live data without Mason's explicit approval.
- Do not delete the `seed-admin` function without Mason's explicit approval, even though deletion is probably the safest end state.


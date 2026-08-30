# CRX Manager — Gotchas & Lessons Learned

Project-specific quirks that aren't obvious from reading the code, but have caused real bugs. Read before working in the relevant area.

---

## React & UI

| Quirk | Wrong | Right |
|-------|-------|-------|
| react-map-gl v8 import path | `from 'react-map-gl'` | `from 'react-map-gl/mapbox'` |
| Vite manualChunks for maps | put `react-map-gl` in chunks | only put `mapbox-gl` in chunks |
| Lucide icon tooltips | `<Icon title="..." />` (Lucide ignores it) | `<span title="..."><Icon /></span>` |
| JSX truthy with unknown values | `{maybeNumber && <X/>}` (renders `0`) | `{maybeNumber ? <X/> : null}` |

---

## Supabase / PostgreSQL

| Quirk | Why it matters |
|-------|----------------|
| `PostgrestError` is a plain object — NOT `instanceof Error` | When matching errors in catch blocks, walk the keys instead |
| Singular relationship joins return arrays | Cast with `as unknown as Type[]` rather than expecting a single object |
| Supabase returns `null` for missing columns; React props expect `undefined` | Use `?? undefined` when passing through |
| PostGIS RPCs need `SET search_path = public, extensions` | Without `extensions`, geometry functions are not found |
| Every SECURITY DEFINER function MUST `SET search_path = public, pg_temp` | Hard rule — not optional. Empty `''` search_path is a 2026-05 finding pattern (PR-12). pg_temp prevents temp-table hijacking. |
| A deferred trigger does not inherit the caller RPC's `SECURITY DEFINER` context | `DEFERRABLE INITIALLY DEFERRED` triggers run after the RPC returns, commonly at commit. If the trigger function must read an RPC-owned/RLS-denied table, the trigger function itself needs `SECURITY DEFINER`, a fixed `search_path`, revoked direct execution, and a proof that forces the deferred trigger to fire after the public RPC returns. A rollback-only smoke that never runs `SET CONSTRAINTS ... IMMEDIATE` cannot prove this path. |
| Browser and PostgreSQL text folding are different runtime boundaries | Never compare a browser-computed Unicode digest with a PostgreSQL digest as a correctness gate. Derive the durable cross-device claim in PostgreSQL only; browser-normalized keys may be used for local retry hints and per-user idempotency, but not as the final uniqueness boundary. Lock and require an empty claim table before changing the durable server algorithm; otherwise old and new hashes can represent the same document. |
| `payments.amount` is `numeric` dollars, NOT `bigint` cents | RPCs convert: `(p_amount_cents / 100.0)::numeric(12,2)` |
| `commissions.commission_amount` is `numeric` dollars (NOT `_cents`) | Same as payments — historical exception |
| `deliveries.scheduled_date` (NOT `delivery_date`) | Always check `information_schema.columns` before assuming a column name. Re-introduced in `complete_delivery` + `void_delivery` 2026-05-09 (PR-01); column refs crashed any closed-period warn path. |
| `customers.farm_name` (NOT `name`) | The `customers` table has no `name` column. Edge Functions selecting `name` get PostgREST 42703. Always log query errors to surface schema drift (PR-03). |
| `idempotency_keys` columns: `idempotency_key`, `operation`, `result` | NOT `key`/`entity_type`/`entity_id`/`result_id` — bug has been re-introduced 3+ times |
| `idempotency_keys.result` is `jsonb` | Do NOT cast to `::text` when inserting — pass `jsonb_build_object(...)` directly |
| `invoices.balance_cents` is a GENERATED column | NEVER UPDATE it directly — update the components (`subtotal_cents`, `tax_cents`, `total_paid_cents`) |
| `vendor_bills.balance_cents` is GENERATED ALWAYS (PR-04) | Same rule — `record_vendor_payment` writes only `paid_cents`/`status`. Pre-2026-05-10 it was plain `bigint` and could drift. |
| `orders.total_paid` / `orders.balance_due` were DROPPED | AR is derived from `invoices.balance_cents` |
| `create_direct_order` returns `{ order_id }` (NOT `{ id }`) | Destructure correctly |
| `complete_delivery` requires `p_signed_by text` | Always pass the signer's name |
| `returns.requested_by` (NOT `created_by`) | And status starts at `'requested'` (NOT `'pending'`) |
| `return_items.order_item_id` (NOT `delivery_item_id`) | Returns are linked to order lines, not delivery lines |
| `invoice_items.extended_cents` (NOT `line_total_cents`) | Naming inconsistency from early schema |
| `financial_audit_log.entity_type` allows: `invoice`, `payment`, `vendor_bill`, `vendor_payment`, `purchase_order`, `write_off` | The CHECK constraint was AR-only until PR-04 (2026-05-10) — adding new entity types means expanding the CHECK. Same for `operation_type`. |

---

## Canonical idempotency pattern (PR-02, 2026-05-09)

Five mutating RPCs were silently re-executing on network retries because they used a broken replay check (`(v_existing->>'status') = 'completed'`) that never matched the saved jsonb shape. The canonical pattern below is the only correct one — substitute `'<rpc_name>'` for the function name.

```sql
DECLARE
  v_existing jsonb;
  v_result  jsonb;  -- or uuid, depending on return type
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, '<rpc_name>');
    IF v_existing IS NOT NULL THEN
      -- For RPCs returning jsonb:
      RETURN v_existing;
      -- For RPCs returning uuid: RETURN (v_existing->>'payment_id')::uuid;
    END IF;
  END IF;

  -- ... actual mutation work ...

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, '<rpc_name>', v_result);
  END IF;

  RETURN v_result;
END;
```

**Key rules:**
- `check_idempotency` returns the BARE saved `jsonb` value (NOT `{status, result}`). Test for `IS NOT NULL` only.
- The cache key is `(idempotency_key, operation)`. Use the SAME `'<rpc_name>'` string in both `check_` and `save_`.
- For RPCs returning `uuid`, save with `jsonb_build_object('payment_id', v_id)` and unpack on cache hit.
- TS callers MUST wrap with `assertRpcResult<T>(data, 'rpc_name')` (`local-rules/require-assert-rpc-result` ESLint rule enforces it).
- TS error detection: `hasRpcCode(err, RpcErrorCodes.X)` from `src/lib/db.ts` — never substring-match (a user-supplied note containing `'BILL_VOIDED'` would false-positive).

The `idempotency-body-check.mjs` PreToolUse hook blocks RPCs that declare `p_idempotency_key` but don't reference `idempotency_keys` in the body. Add `-- idempotency-body-check: exempt` at file top to opt out (only when using the helper-function indirection above — never for raw inline lookups).

---

## Accounts Payable quirks (PR-04, 2026-05-10 — LIVE since 2026-05-10; verified live 2026-07-13: `vendor_bills.voided_at`/`voided_by`/`void_reason` columns and `balance_cents` GENERATED ALWAYS all exist in production)

The AP RPC trio (`create_vendor_bill`, `record_vendor_payment`, `void_vendor_bill`) had structural gaps that AR resolved years ago. PR-04 brings AP to parity. Important notes for anyone touching AP code:

| Rule | Detail |
|------|--------|
| Closed-period guard on bill creation | `create_vendor_bill` calls `check_period_open(p_bill_date::date)` — same gate as `post_invoice`. Bills outside the open period raise. |
| Closed-period guard on payment recording | YES since 20260712200000 (2026-07-11): record_vendor_payment gates on check_period_open(p_payment_date) — a payment belongs to its OWN period (same convention as AR allocate_payment per 20260513110000), so old bills stay payable with a current-dated payment; only backdating into a closed month raises. void_vendor_payment/void_vendor_bill gate on the original document date. (Supersedes the 2026-05-10 Q8 answer, which predated the AR payment-date gates.) |
| Idempotency on all 3 RPCs | All 3 use the canonical pattern above. Pre-PR-04 idempotency was missing entirely. |
| Audit log integration | `financial_audit_log` CHECK now allows `vendor_bill`, `vendor_payment`, `purchase_order` entity types and `vendor_bill_created`, `vendor_bill_voided`, `vendor_payment_recorded` operations. Pre-PR-04, AP RPCs couldn't write to the audit log at all. |
| `vendor_bills.balance_cents` GENERATED ALWAYS | `(total_cents - paid_cents)`. NEVER UPDATE — let it recompute. |
| `vendor_bills` UNIQUE on `(vendor_id, bill_number)` WHERE `deleted_at IS NULL AND status <> 'voided'` | Prevents duplicate bills. Voided/deleted bills don't count. |
| `vendor_bills` and `vendor_payments` have soft-delete columns | `voided_at`, `voided_by`, `void_reason` (PR-04). Pre-PR-04, `void_vendor_bill` stuffed reason into `notes`. |
| `void_vendor_bill` active-payment guard | Hard-blocks voiding ANY bill (any status) while it has active (non-voided) `vendor_payments` rows (`BILL_HAS_ACTIVE_PAYMENTS`, codex audit F3 — tightened from the original status='paid'-only check). `void_vendor_payment` now exists and is live (verified live 2026-07-13, was "PR-13, future" in earlier revisions of this doc) — void each payment first, then void the bill. |
| `vendors_select` RLS | Admin + sales_rep only post-PR-04. Drivers/applicators get empty results — any UI relying on driver vendor reads breaks silently. |

---

## E2E test environment (PR-05, 2026-05-09)

| Rule | Why |
|------|-----|
| `E2E_TEST_EMAIL` + `E2E_TEST_PASSWORD` env vars are MANDATORY | Hard-coded fallback was rotated and removed (was `mason@croprxsolutions.com` / live password). Tests now throw at startup if missing. See `docs/CONTRIBUTING.md`. |
| E2E is staging-only; production has no override | `resolveSafeE2EConfig()` requires `E2E_TARGET_ENV=staging` plus staging URL/key and categorically rejects the production project. Playwright also blocks while direct production endpoint literals remain. PR-23 staging is still BLOCKED. |
| All E2E-created entities MUST use `[E2E]` prefix | `globalSetup` creates shared `[E2E]` fixtures, `globalTeardown` deletes anything matching the prefix. Bare entity names leak across runs and pollute prod. Reuse fixtures from `tests/e2e/fixtures/e2e-constants.ts`. |

---

## Frontend safety (PR-11, PR-15, PR-16, PR-20)

| Rule | Detail |
|------|--------|
| Every `<Route>` first segment must have a `PAGE_PERMISSIONS` entry OR be in `EXEMPT_ROUTE_SEGMENTS` | `pagePermissions.test.ts` enforces by greppping App.tsx routes. ProtectedRoute fails-closed (logs + redirect) when `getPageKeyFromPath()` returns null on a non-exempt path. Adding a Route without an entry now fails CI. |
| `parseDollarsToCents` PRESERVES leading minus | Pre-PR-15 it stripped them, turning `-50` discount into `+5000` cent ADD. Use `parseDollarsToCentsPositive()` for fields that must reject negatives (default callers don't need to switch). |
| Edge Functions throw at startup if `ALLOWED_ORIGIN` is unset (and not localhost) | PR-16 removed silent fallback to `https://croprxsolutions.app`. Functions requiring the secret: create-user, process-blend-ticket, process-document, send-email (`seed-admin` — one of the original 5 — was deleted 2026-06-16 as a security cleanup; it no longer exists, verified against `supabase/functions/` 2026-07-13). reset-user-password uses a separate hard-coded array pattern; setup-blend-tickets-storage still exists on disk and is still dead code (delete pending — verified 2026-07-13). |
| `logActivity({performedBy})` requires `profile.id` (no empty-string fallback) | PR-20 patched 8 handlers: WriteOffModal, FinanceChargePreviewModal, MonthEndClose, Deliveries, InvoiceDetail. If `profile` is null, handler returns early with toast. QuoteBuilder's compliance check is the one useEffect-gated callsite (still gates on `profile?.id`). |
| Live General Invoice Detail rewrites do not preserve `invoice_items.order_item_id` until the PR #361 six-file chain is applied | Live `_save_invoice_scoped_impl` still rebuilds line items without that source field. Candidate migration `20260827041500` wraps it with server-side identity validation and restoration of line id, order lineage, historical cost, creation order, and delivery provenance. Until that candidate is reviewed and applied live, do not edit generated delivery/order invoices in the general editor; void/recreate them or use the governed source workflow. |

---

## Quick delivery soft-warn (PR-06, 2026-05-09)

Customers over credit limit no longer block quick deliveries. Per Q4 (Option C):

- AR balance includes `'draft'`, `'posted'`, `'overdue'` invoices (was: `'posted'` only)
- Projected exposure = current AR + new delivery's total
- When `projected_exposure >= credit_limit`: INSERT `activity_feed` (`event_type='credit_limit_warning'`) + INSERT `notifications` row per active admin. Delivery proceeds normally.
- Return jsonb gains `credit_warning: boolean`. `assertRpcResult<T>` ignores extra fields, so callers don't need updates.

---

## Tables WITHOUT `updated_at`

Setting `updated_at = now()` in an UPDATE on these tables will crash the RPC. The pre-commit hook blocks this, but here's the full list for reference:

`payments`, `write_offs`, `delivery_items`, `order_items`, `quote_items`, `return_items`, `purchase_order_items`, `commissions`, `finance_charges`, `prepay_applications`, `cycle_counts`, `cycle_count_items`, `activity_feed`, `financial_audit_log`, `idempotency_keys`, `receiving_records`, `inventory_transactions`, `invoice_line_allocations`, `order_line_allocations`, `invoice_shares`, `order_shares`, `commission_payment_items`, `blend_ticket_products`, `blend_ticket_images`, `blend_ticket_to_order_items`, `blend_recipe_items`, `delivery_photos`, `receiving_photos`, `email_log`, `ar_reminder_tracking`, `rup_sales_records`, `vendor_payments`, `cost_history`

---

## TypeScript & Linting

| Quirk | Right way |
|-------|-----------|
| ESLint `no-unused-vars` requires `_` prefix | `function fn(_unused: T)` |
| E2E catch clauses with unused param | `catch (_e)` (NOT `catch (e)`) |

---

## Business Logic

| Rule | Why |
|------|-----|
| Money must be exact whole cents. New storage uses `bigint` cents. Legacy PostgreSQL numeric-dollar storage is approved only after exact `numeric` math, clean finite whole-cent values, and an active finite whole-cent CHECK are verified; dirty or unconstrained columns remain findings. | Binary-float conversion, parsing, arithmetic, or rounding corrupts authoritative money. Parse decimal input into integer cents; do not casually retype legacy values. |
| Season = October 1 to September 30 | Hardcoded in commission and prepay rollover logic |
| Status enum strings are case- and value-sensitive | DB CHECK constraints enforce exact strings — `'void'` vs `'voided'` matters |

---

## Environment Quirks

_Corrected 2026-07-16: the three quirks previously listed here were stale — `gh` and `tail` are both available in the current shell, and the repo path was wrong. Verified by using both directly this session._

| Quirk | Workaround |
|-------|-----------|
| Repo lives at `C:\CRX_Manager` | Not `C:\CRX_Manager_V1.0` (older layout). Linked worktrees live under `C:\CRX_Manager\.claude\worktrees\`. |
| Shell is Git Bash (POSIX), not PowerShell/cmd | Use Unix syntax (`/dev/null`, forward slashes, `$VAR`); `gh`, `tail`, `head`, `grep`, `sed` are all available. |
| `cd` in a compound command can prompt; shell cwd can reset between tool calls | Prefer absolute paths; don't rely on a persisted `cd`. |

---

## Money-Integrity Invariants (overnight bug hunt, 2026-06-19) — RESOLVED 2026-06-20/21, re-verified live 2026-07-13

All six items originally parked here were fixed and applied live within a day or two of being found (the 2026-06-20 "Overnight bug-hunt remediation" + 2026-06-21 "As-Applied" changelog entries), and the current live function bodies were re-checked directly against `pg_proc` on 2026-07-13 to confirm the fixes are still in place. Kept here (marked resolved, not deleted) so the invariants stay documented for whoever next touches these RPCs — don't reintroduce the bugs described below.

| Area | Invariant | Resolution (verified live 2026-07-13) |
|------|-----------|----------------------------------------|
| **Prepay bulk-apply double-spend** | Every spend of prepay must ledger through `prepay_applications` in lockstep with the `customers.prepay_balance_cents` decrement. | **Closed by disabling the vulnerable path**, not by adding the ledger writes: `apply_remaining_prepayments` and `batch_apply_all_prepayments` both now `RAISE EXCEPTION 'PREPAY_BULK_APPLY_DISABLED'` as their first statement (migration `20260620200000`, live). Per-invoice `apply_prepay_to_invoice` (which already ledgers correctly) is the only live apply path. The reserved-pool redesign that would let bulk-apply come back safely is still not built — don't re-enable these two functions without it. |
| **Prepay apply → invoice status** | A prepay application that zeroes an invoice's balance must flip `status` to `'paid'`. | Same fix as above — the only functions with this gap are hard-disabled, so the gap can't be hit today. |
| **Blend-ticket re-bill guard** | Only reset a grouped blend ticket to `'unbilled'` when no live sibling invoice remains. | Confirmed live in `sync_blend_ticket_payment_status` (migration `20260620140000`): body includes `AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.blend_ticket_id = NEW.blend_ticket_id AND i.status NOT IN ('voided','cancelled') AND i.deleted_at IS NULL)` verbatim. |
| **`transfer_job_to_invoice` parity** | Strict actor, `invoice_created` audit row, header derived from summed lines, `invoice_shares` reconciled to the header unconditionally. | Confirmed live: `IF p_performed_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'ACTOR_MISMATCH'` is present; both the single-owner and multi-owner (U7 group) paths insert an `invoice_created` `financial_audit_log` row; the percentage-split share path now does `UPDATE invoices SET total_amount_cents = v_share_total` (comment: "reconcile the header to the share sum for BOTH the override AND the percentage-split path") so header and `invoice_shares` always tie. |
| **Cancel/void must not strand a batched commission** | `cancel_order`, `void_order`, `cancel_delivery` must skip zeroing a commission that's in a non-voided payout batch. | Confirmed live: all three functions reference `commission_payment_items` with a `cp.status <> 'voided'`-style guard (2026-06-20 "commission batch-freeze"). |
| **Prepay credit ↔ invoice must be same customer** | `apply_prepay_to_invoice` must reject a credit/invoice customer mismatch. | Confirmed live: function body contains a `CUSTOMER_MISMATCH` check (migration `20260620120000`). |

> Regression-test status not re-verified in this pass — if you touch any of these six functions, confirm a fails-before/passes-after test exists before assuming one does.

---

## `REVOKE … FROM PUBLIC` does NOT strip `anon` from a new function (2026-07-27)

This project carries `ALTER DEFAULT PRIVILEGES` for role `postgres` in schema `public` granting
EXECUTE on **new functions** to `anon`, `authenticated` and `service_role`. So a freshly created
function does not land with the stock PostgreSQL default — it lands with explicit per-role grants:

```text
{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
```

`REVOKE ALL ON FUNCTION … FROM PUBLIC` removes only the leading `=X/postgres` (the PUBLIC entry). The
**explicit `anon` grant survives**, and `has_function_privilege('anon', …, 'EXECUTE')` stays true. For
a `SECURITY DEFINER` function that reads `profiles`, that hands anonymous callers a bypass.

**Always name the roles explicitly:**

```sql
REVOKE ALL ON FUNCTION public.my_helper() FROM PUBLIC, anon;   -- add authenticated for trigger-only fns
GRANT EXECUTE ON FUNCTION public.my_helper() TO authenticated, service_role;
```

Proven live in a self-aborting `DO` block: `after_create anon_exec=t` → `after_revoke_public
anon_exec=t` → `after_revoke_anon anon_exec=f`. This is what rejected the first apply attempt of
`20260727174657_broad_reads_require_active_profile.sql` (its own postflight check caught it and the
whole migration rolled back). The target ACL to match is `is_sales_rep()`'s:
`{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`.

Two corollaries:

- A postflight assertion should test `has_function_privilege('anon', …)`, not just scan `proacl` for a
  PUBLIC entry — the PUBLIC entry is the case that *doesn't* apply here.
- A `BEGIN … ROLLBACK` rehearsal through `execute_sql` is **not** equivalent to the governed apply.
  The rehearsal of this migration reported the assertion passing; the real apply refused it. Treat the
  gate's apply as the proof, not the rehearsal.

---

## Hiding ONE column needs a GRANT, not a policy — and it makes the next `ADD COLUMN` a trap (2026-07-29)

PostgreSQL has **no column-level RLS**, and every signed-in user of this app shares the single
`authenticated` DB role. So "drivers may read the row but not this one column" is not expressible as
a policy. The only mechanism is a **column-privilege carve-out**, and it has two counter-intuitive
halves:

```sql
-- 1. A table-level grant implies EVERY column, and REVOKE (col) does NOT subtract from it.
--    You must revoke the whole privilege, then re-grant an explicit list.
REVOKE SELECT, INSERT, UPDATE, REFERENCES ON public.t FROM authenticated;

-- 2. A column list binds to the privilege it DIRECTLY FOLLOWS. Repeat the list per privilege.
GRANT
  SELECT     (a, b, c),
  INSERT     (a, b, c),
  UPDATE     (a, b, c),
  REFERENCES (a, b, c)
ON public.t TO authenticated;
```

The tempting short form `GRANT SELECT, INSERT, UPDATE, REFERENCES (a, b, c) ON t TO authenticated`
grants the first three **table-wide** and column-scopes only `REFERENCES` — i.e. it silently leaves
the secret column fully readable while looking like it locked it down. Proven on this database with a
rolled-back temp-table probe: short form → `has_column_privilege(…, 'SELECT')` **true**; per-privilege
form → **false**. Live example: `application_services.cost_per_acre_cents`, migration
`20260729015706`.

**The trap this leaves behind:** once the grant is an explicit list, every column added later is
invisible and unwritable to `authenticated` until someone adds it to that list. It surfaces as
PostgREST `permission denied for column …` on a field that plainly exists — reads like an app bug,
is actually a missing grant. **Any `ALTER TABLE … ADD COLUMN` on a column-carved table must ship a
`GRANT` for the new column in the same migration.** Tables in this state today:
`public.application_services` **and `public.products`**.

**`public.products` (verified live 2026-08-18).** `authenticated` has **no** table-level
`INSERT` or `UPDATE` — `has_table_privilege('authenticated','public.products','UPDATE')` is
**false** — and **27 of its 48 columns** instead carry explicit column-level `INSERT`/`UPDATE`
grants, a consequence of the phase-3 product-governance work
(`20260723193312_product_families_return_policy_foundation.sql` and successors). `SELECT`
remains table-wide. This entry previously listed only `application_services` and was stale.

Any work adding columns to `products` — the 2026-08-18 product data model plan adds density,
nickname, formulation type, safener and registration status among others — must ship
`GRANT INSERT(col), UPDATE(col) ON public.products TO authenticated` in the same migration.
**Verify by editing the field through the running app as an ordinary authenticated user:**
service-role access bypasses column grants entirely and will show a working save on a column
no real user can write.

Two more consequences worth knowing before you carve a column out:

- `.select()` with no argument is `select=*`, and `Prefer: return=representation` makes a mutation's
  `RETURNING` clause `*` too. Both then demand the revoked column and fail the **whole** statement —
  including deletes. Name columns explicitly (`.select('id')`) on any carved table.
- A `SECURITY DEFINER` function owned by `postgres` reads the column **as postgres**, so revoking
  from `authenticated` does not reach it. That is what keeps the money engine working — and equally,
  it means a SECDEF function is a live bypass of the carve-out unless it gates internally.

---

## A green CodeRabbit check does not mean a review happened (2026-08-17)

`AGENTS.md` makes reading CodeRabbit's review a standing pre-merge step. The check row is **not**
evidence that step is satisfiable. On PR #411, `gh pr checks` reported:

```text
CodeRabbit	pass	0		Review completed
```

while CodeRabbit's own comment on the same PR said:

> **Review failed** — An error occurred during the review process. Please try again later.

The review was attempted and did not complete — no findings were ever submitted — and the status
text asserted the opposite. PR #402 showed a milder version of the same thing — check green, body
reading "Review rate limited". Read the **comment body**, never the check row:

```bash
PR_NUMBER=411
REPO="masonwells1/CRX_Manager_V1.0"
gh pr view "$PR_NUMBER" --repo "$REPO" --json reviews,comments
```

Zero `reviews` plus a `coderabbitai` comment containing "Review failed" or "rate limited" means no
CodeRabbit review was submitted. Say so rather than treating green as clean. Since 2026-08-28,
GitHub requires a current formal approval, so a misleading green CodeRabbit status cannot unlock
the merge by itself: the missing approval keeps the PR blocked. Since 2026-08-30 the normal trigger
is the `ready-for-coderabbit` label, and `coderabbit-review-requested` deliberately prevents an
accidental duplicate. If CodeRabbit itself confirms a delivery failure or rate limit on the same
frozen head, deliberately remove `coderabbit-review-requested` and reapply `ready-for-coderabbit`;
that is a paid retry, not the normal path. Never merge from the check row alone — confirm an
`APPROVED` CodeRabbit review whose commit matches the PR head.

---

## The `Vercel` required status can take an hour — or a minute (2026-08-17)

`Vercel` is one of three required checks in the `protect-main` ruleset, so a PR sits at `BLOCKED`
until it posts. **How long that takes is wildly variable**, which is the whole point of this entry.
Three measurements, all on PR #411, all the same branch and same day:

| Commit | authored (UTC) | `Vercel` status posted | delay |
|---|---|---|---|
| `711aecfb` | 13:42:32 | 14:51:03 | **~69 min** |
| `8b1e86f8` | 15:23:22 | 16:19:32 | **~56 min** |
| `0a15eab4` | 16:56:51 | 17:06:02 | **~9 min** |

Do not read a fast one as normal or a slow one as broken. The two slow samples landed in a window
where GitHub's own infrastructure was visibly congested — the CodeQL job on this PR failed the same
afternoon on repeated `429 Too Many Requests` fetching `github/codeql-action` — so treat the delay
as queue depth, not as a property of the commit or of how the branch was created.

Operationally: **do not start diagnosing a missing `Vercel` status until at least an hour has
passed.** Waiting is free and is the correct action; the two slow samples both arrived on their own,
and three consecutive 10-minute polls on `711aecfb` saw nothing before it turned up. An hour is an
escalation threshold chosen to sit past the worst observed wait, not a published SLA.

Everything below was a wrong turn on this PR, recorded so nobody repeats it. The absence was read
as a causal failure of creating the remote ref through the GitHub API first (the fix
`new-branch-push-scans-full-history` prescribes for the unbounded pre-push containment scan). Two
signals looked like a fingerprint — the deployment lacked `meta.repoPushedAt`, and
`repos/.../deployments?sha=` was empty. Neither held: the status arrived anyway, on that exact
commit, with no push event of its own. A close/reopen and an extra pushed commit were both spent
chasing it and neither was what fixed anything.

Confirm the build independently instead of inferring from GitHub. A `READY` deployment for the SHA
proves only that **the Vercel deployment finished** — it says nothing about whether the other
required checks passed, so read those separately rather than concluding the PR is healthy:

```bash
REPO="masonwells1/CRX_Manager_V1.0"
SHA="711aecfb"
gh api "repos/$REPO/commits/$SHA/status" --jq '[.statuses[].context]'
```

Cross-check the SHA against Vercel's own `list_deployments` for project
`prj_cp2ZVn0RueHHYXCxNkTD0YwCBET6` (team `team_jQyqY8P8Kt3qEoT5hg5zlmpT`) and read
`state` + `meta.githubCommitSha`. Never work around a late status by relaxing the required check.

---

## Never name the worktree path in a destructive shell command — CLAUDE worktrees (2026-08-20)

**Scope: Claude-managed worktrees only.** Claude creates them at `<repo>/.claude/worktrees/<name>/`;
Codex worktrees live outside the repo (`~/.codex/worktrees/…`) and have **no such collision** — see
the Claude-only list in `scripts/agent-manifest-parity.mjs`. `review-proof-guard.mjs` itself is
wired for both agents, but only a Claude worktree path trips it this way.

Every file inside a Claude worktree carries a `.claude` path component, and `review-proof-guard.mjs`
protects any `.claude` component — that is how it stops an agent deleting or forging the
wrapper-owned review proofs and the applied-source ledger. It cannot tell "the repo's review state"
from "an ordinary scratch file that happens to live under a worktree."

The consequence is narrow and has a zero-cost workaround. **For this collision specifically**, the
guard fires only when the command **spells out** the worktree path — your shell already starts
inside the worktree, so relative paths avoid it. (That is a statement about the worktree collision,
not the guard's complete matching rule: `review-proof-guard` independently blocks commands naming
`.claude` or `.claude/session-state` anywhere, and treats `rm`/`mv`/`git clean`/`rsync --delete`
and friends as destructive verbs. See the guard row in `agent-guardrails.md` for the full rule.)

Every ✅ row below was **executed live in a worktree** while writing this page — not reasoned about,
not checked against one hook. The ❌ rows were reproduced the same way.

| | |
|---|---|
| ❌ `rm -f C:\CRX_Manager\.claude\worktrees\wt-a\scratch.tmp` | denied by `review-proof-guard` |
| ❌ `cd C:\CRX_Manager\.claude\worktrees\wt-a && rm scratch.tmp` | denied by `review-proof-guard` |
| ✅ `rm -f scratch.tmp` | ran |
| ✅ `rm probe-dir/x.txt` (nested relative) | ran |
| ✅ `mv a.txt b.txt` | ran |
| ✅ `Write` to a worktree file (relative **or** absolute) | ran |

Four things that look like this bug but are not — each is a **different layer**, so relative paths
do not help:

- **`rm -rf` never runs in a Claude session.** `.claude/settings.json` lists `Bash(rm -rf:*)` and
  `Bash(rm -fr:*)` in `permissions.deny`, so it is refused before any hook sees it, worktree or not.
  That permission layer is **Claude-side only** — Codex is governed by `.codex/hooks.json`, so check
  there rather than assuming the same list. Use a targeted `rm <file>` or `rm -r <dir>`.
- **`git clean -f`/`-fd`/`-fdx` is blocked for both agents** by the shared `bash-safety-lib.mjs`, and
  additionally for Claude by `permissions.deny` (`Bash(git clean -f:*)`). `review-proof-guard` allows
  it once the path is relative, but the command still does not run. Review with `git clean -n` first,
  then delete the specific files.
- **`find … -delete` is blocked everywhere** by a separate safety layer, with a message beginning
  "Blocked". Not `review-proof-guard`, and not `bash-safety-lib.mjs` either —
  that library allows it. Run the `find` without `-delete`, review the matches, then delete.
- **A blocked `Write` to `.claude/session-state/stop-wrap-ack.json` is a different hook.**
  `review-proof-guard` deliberately allows that write — it is the designed session-end
  acknowledgment valve.

**Lesson worth keeping:** verifying a command against ONE hook does not tell you whether the command
runs. In a Claude session a Bash call passes through `permissions.deny` in `.claude/settings.json`,
then several PreToolUse hooks, then the harness's own safety layer — any one of them can refuse it.
Codex has its own stack (`.codex/hooks.json`) that shares the hook implementations but not the
permission list, so verdicts are not automatically the same. **Run the command; do not reason about
it.** This page's first two drafts each claimed a command was "allowed"
after checking a single guard (`git clean -fd`, then `rm -rf`); both were wrong and both were caught
in review of PR #434, which is why every ✅ above is now something that was actually executed.

**Do not "fix" this by stripping the worktree prefix out of the command text.** That was attempted
on 2026-08-19/20 and abandoned after five independent `gpt-5.6-sol` review rounds found eight real
security holes in five successive versions — each a different way to spell the same path: a trailing
separator; `../..`; a `$var` descendant; a `/.` dot alias; `."."` quote-joining; an operand named
`cd`; cmd.exe expansion (`%VAR:~0%` and `!VAR!` — one finding, two spellings); and cmd.exe caret
escapes. Each round's test suite was green over the next round's hole. All eight are pinned as
denials in `review-proof-guard.test.mjs` so a future attempt trips on them immediately. See `docs/manual/KNOWN_ISSUES.md` for the options if this is ever worth fixing
properly — the leading one is moving worktrees out from under `.claude` entirely, which removes
the collision instead of papering over it.

---

## Source

This file consolidates lessons from `~/.claude/projects/.../memory/feedback.md` and historical debugging sessions. Add new entries here whenever a non-obvious quirk causes a bug.

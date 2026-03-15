# Phase 2 — Database & Security Audit Report

## Plain-English summary (for Mason)

I continued directly into Phase 2.

### What this means in business terms
Think of your database as the locked chemical cage at the warehouse:
- **RLS policies are the locks.**
- **RPC functions are the keys.**

Right now, I found several places where locks are present but too broad, and a few keys that can be misused if someone knows how to call them directly.

Big picture:
- Good: RLS is enabled across all discovered tables.
- Critical risk: Some policies allow reps to read data they likely should not see.
- Critical risk: Several privileged RPCs trust a `p_performed_by` input parameter without proving it matches the logged-in caller.

That second issue is like accepting a handwritten note saying “I’m Mason” without checking ID.

---

## DATABASE SECURITY REPORT

### 1) Schema issues (constraints, indexes, relationships)

## ✅ Strengths
- All discovered tables (`35`) have RLS enabled.
- Broad index coverage has been added over time (FK/status/date indexes).
- Core FK relationships are in place for quote/order/delivery/payment/inventory linkage.

## ⚠️ Gaps
1. **No `FORCE ROW LEVEL SECURITY` detected on any table.**
   - If privileged roles are used, this weakens defense-in-depth.
2. **Inventory quantity columns are not guarded with non-negative CHECK constraints at table level.**
   - App/RPC logic attempts to protect with `GREATEST(...)`, but schema-level guardrails are still missing.
3. **Payments table allows `amount` default 0 with no positivity CHECK.**
   - Business rule enforcement relies on function/UI, not immutable schema constraint.

Risk rating: **Caution** (schema is substantial, but critical business invariants still rely heavily on application/function logic).

---

### 2) RLS gaps (role/data isolation)

## ✅ Strengths
- All discovered tables have RLS enabled.
- Many write policies correctly restrict updates/deletes to admin or owner.

## ❌ Critical gaps
1. **Cross-tenant read exposure on quote children and addresses**
   - `customer_addresses`, `quote_sections`, `quote_items`, `quote_versions` SELECT policies use `USING (true)`.
   - Effect: any authenticated user can query these rows directly.

2. **Sales reps can read all orders/order items**
   - `orders_select` and `oitems_select` allow `(is_admin() OR is_sales_rep())` with no ownership/customer scope.
   - Effect: one rep can read another rep’s order data.

3. **`profiles_select` is globally open to all authenticated users**
   - Set to `USING (true)` in later migration.

4. **`notif_insert` globally open (`WITH CHECK (true)`)**
   - Any authenticated user can insert notifications for any user.

5. **Inventory transactions insert broadened to reps**
   - `inv_tx_insert` permits `(is_admin() OR is_sales_rep())`.
   - Combined with direct table access, this can permit audit-log pollution.

Risk rating: **Unsafe** (data confidentiality and role segregation are not production-safe yet).

---

### 3) RPC issues (authorization, transactions, idempotency, input trust)

## ✅ Strengths
- Important transactional flows exist as RPCs (`convert_quote_to_order`, `receive_po_items`, `record_payment`, `complete_delivery`, etc.).
- Idempotency framework exists (`idempotency_keys`, `check_idempotency`, `save_idempotency`) and is wired into several critical RPCs.

## ❌ Critical gaps
1. **Impersonation risk via `p_performed_by` parameter trust**
   - Multiple `SECURITY DEFINER` RPCs authorize based on supplied `p_performed_by` profile row.
   - They do not consistently enforce `p_performed_by = auth.uid()` inside the function.
   - Because execute is granted to `authenticated`, a malicious caller could pass another user’s UUID (e.g., admin UUID) if known.

2. **Privileged function grants are broad**
   - Several high-impact RPCs are executable by all authenticated users.
   - Safety depends entirely on function-internal checks, increasing blast radius if any check is incomplete.

3. **Audit trail mutability risk through direct table write policy breadth**
   - If non-admins can directly insert inventory transactions, audit trust degrades.

Risk rating: **Unsafe** (authorization model inside key RPCs must be tightened before production).

---

### 4) Edge Function issues

## ✅ Strengths
- `create-user` validates caller token and confirms admin role before creating users.
- `seed-admin` has production disable guard and secret-header requirement.
- `process-blend-ticket` requires Authorization header and valid caller.

## ⚠️/❌ Gaps
1. **`process-blend-ticket` appears to authorize authentication, not ownership/scope**
   - Caller validity checked, but ticket-level authorization for that caller is not clearly enforced before privileged service-role processing.

2. **`setup-blend-tickets-storage` has no auth gate**
   - Returns setup guidance only, low sensitivity, but still exposed.

3. **CORS policy inconsistency**
   - `create-user` currently uses wildcard `Access-Control-Allow-Origin: *` unlike others using `ALLOWED_ORIGIN` pattern.

Risk rating: **Caution** (one function appears robust, another appears over-broad on authorization scope).

---

## Evidence summary checks run in this phase

- Parsed migrations for table and RLS coverage.
- Validated policy definitions and later overrides.
- Reviewed security-definer RPC authorization patterns.
- Reviewed edge function authentication/authorization handling.

---

## Recommended immediate fixes before Phase 3 deep functional matrix

1. **RLS hardening (highest priority)**
   - Replace broad `USING (true)` policies on sensitive relational tables with ownership/role-scoped predicates.
2. **RPC caller identity hardening**
   - In every privileged RPC: enforce `p_performed_by = auth.uid()` (or remove caller param and derive from `auth.uid()` server-side).
3. **Notification and profile policy tightening**
   - Re-scope `notif_insert` and `profiles_select` to intended behavior only.
4. **Audit integrity hardening**
   - Restrict direct `inventory_transactions` inserts to trusted pathways (admin/RPC-only model).
5. **Schema invariants**
   - Add CHECK constraints for non-negative inventory/payment domain rules.

---

## Phase progression

Moving next into **Phase 3 (Functional Flow Matrix)** with these security findings as threat assumptions while testing dead wires and broken connectors.

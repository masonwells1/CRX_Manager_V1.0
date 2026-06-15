# Codex Cross-Review Disposition + Remediation — 2026-05-29

**Context:** The `/review-workflow` audit (2026-05-28) found BLOCKERs. Per Mason's standing preference, Codex independently cross-reviewed them. Codex could **not** use the Supabase MCP (it tested through the browser anon client), so every Codex claim was re-verified against the **live** DB (project `rhyzpcqhnizqbxphqdkr`) via a 4-agent read-only verification workflow before any fix. This doc records the reconciliation, what was applied live, and what is deferred.

## Plain-English summary (for Mason)
Three real problems were fixed on the live database tonight, all reversible:
1. **The big one — a privacy hole.** 37 report/dashboard functions could be called by *anyone on the internet* (no login) and would return customer names, balances, field maps, and financials. We removed public access to all 37; logged-in staff are unaffected. **Closed.**
2. **"Void Order" was 100% broken** — it crashed every time an admin clicked it. Fixed.
3. **A customer transaction report** crashed on every run. Fixed.

Codex also flagged a 4th "critical" item (`batch_void_invoices`), but when I checked the *live* function it turned out to already be safe — the vulnerable version only exists in an old file on disk, not in production. Left it alone (documented below).

Nothing here changed any customer's data or money — these were permission + crash fixes.

---

## What was applied live (3 migrations, verified)

| Live version | Migration | Effect | Verified |
|---|---|---|---|
| `20260529214355` | `revoke_anon_execute_on_report_dashboard_secdef` | REVOKE EXECUTE from anon+PUBLIC on 37 SECDEF report/dashboard/geo/financial RPCs; GRANT to authenticated+service_role | anon-executable SECDEF **89 → 52**; spot-checks `global_search`/`get_customer_year_end_summary`/`dashboard_summary`/`_check_credit_limit` all anon=false, authenticated=true; in-migration DO block asserted 0/37 leak |
| `20260529214423` | `fix_get_customer_transaction_review_running_balance_cast` | Cast window `SUM()` to bigint (fixes SQLSTATE 42804) | Live call now returns rows instead of raising 42804 |
| `20260529214538` | `fix_void_order_void_invoice_status_transitions` | `void_order`: admin_override bracket on fulfilled→voided + draft invoices→cancelled; `void_invoice`: draft/unposted→cancelled | Live bodies confirmed to contain override + cancel branch; overloads = 1 each |

Disk filenames were renamed to the MCP-assigned versions (B7 lesson) so a future rebuild won't re-apply them. Both reviewers (`rls-security-reviewer` = CLEAN; `migration-drift-reviewer` = 0 BLOCKER) cleared all three; the drift reviewer's 2 HIGHs were "couldn't run live MCP" gaps, closed here by live queries.

---

## Codex finding-by-finding reconciliation

### Finding 1 — Anon SECDEF report leak → CONFIRMED, list EXPANDED. ✅ FIXED
Codex was right and its list was incomplete (it named ~15). Live enumeration found **89** anon-executable SECDEF functions; the correct revoke set is **37** data-leakers. Codex's 3 additions (`dashboard_summary`, `get_dashboard_action_items`, `get_ap_dashboard_summary`) all confirmed and included. Two leakers **neither** the original audit **nor** Codex caught: `check_customer_credit_limit` and `_check_credit_limit` (the latter leaks farm name + AR inside an exception message, enumerable by probing UUIDs). All 37 revoked.
- **Completeness proven:** the remaining 52 anon-executable SECDEF are safe — 21 trigger functions (not API-callable), 7 RLS/auth predicates (`is_admin()` etc. — these *must* stay anon-executable or RLS evaluation errors), 7 `next_*` sequence generators (counter only), 2 pure/void helpers, 3 self-guarding mutators, and 11 role-checked reports that hard-reject anon. The last group was **proven** by calling `financial_dashboard_summary()` and `get_ar_aging()` as `anon` → both RAISE "admin role required".

### Finding 2 — `void_order` crashes on fulfilled orders → CONFIRMED. ✅ FIXED
Live-proven (0 voided orders despite 30 fulfilled). Fixed with the minimal `set_config('app.admin_override',...)` bracket around the fulfilled→voided write (the pattern `void_delivery`/`cancel_order` already use). `void_order` already had a correct strict-actor block — not weakened.

### Finding 3 — `void_invoice` crashes on draft/unposted → CONFIRMED. ✅ FIXED
Routed draft/unposted invoices to `cancelled` (an allowed transition, no financial reversal needed since they were never posted) per Codex's recommendation — *not* forced to `voided` via override. Also fixed the same draft-invoice path inside `void_order`.

### Finding 4 — Migration rebuild fidelity → CONFIRMED, still OPEN (deferred). ⏳
Codex agrees the recovered `preserve_quote_price_overrides` is now committed, but correctly notes name-level reconciliation ≠ content-level. A shadow-DB content diff is still the only way to *prove* the repo rebuilds live. **Deferred** — scheduled before the Phase-4 restore drill (see below).

### New Finding A — `batch_void_invoices` actor-spoof → REFUTED on live. ⏳ (disk hardening deferred)
Codex read the **disk** wave4 body (`20260327100000`), which trusts `p_performed_by` before the admin check — genuinely vulnerable. But the **deployed live** function was rebuilt by a later consolidation migration: it gates on `auth.uid()` via `require_admin_or_sales_rep()` + delegates to `void_invoice`'s admin check, and `p_performed_by` only labels an audit row. A non-admin supplying an admin UUID is rejected. **Not exploitable live** (Codex's own note: "no live remediation strictly required"). Left untouched rather than rewrite a working financial function autonomously. **Recommended hardening (for Mason's approval):** recreate `batch_void_invoices` on disk at the live 4-arg signature with the canonical strict-actor block, to eliminate the disk-vs-live drift so the spoof can never be re-introduced.

### New Finding B — restore RPCs (actor-spoof + crash) → CONFIRMED but ORPHAN. ⏳ (deferred)
`restore_cancelled_order` / `restore_cancelled_delivery` both use the spoofable `COALESCE(p_performed_by, auth.uid())` pattern AND crash (cancelled→confirmed/scheduled blocked, no override). **But** they are not wired to any UI (test-files only) and harmless today (they crash before any effect). **Deferred** — these need a product decision first: does Mason even want a "restore cancelled order/delivery" feature? If yes, they get the strict-actor block + override + an explicit transition; if no, drop them. Not safe to silently make dormant code functional.

### New Finding C — `get_customer_transaction_review` 42804 → CONFIRMED. ✅ FIXED
Fixed (migration `20260529214423`). It was also in the anon-revoke set, so the leak path is closed too.

---

## Deferred follow-ups (recommended, need Mason's go-ahead)
1. **Defense-in-depth on the 37 report RPCs** — REVOKE closes the public path, but these are still SECURITY DEFINER, so an *authenticated non-admin* can call the staff reports. Add internal `is_admin()`/scope guards (also protects against a future DROP+CREATE silently restoring PUBLIC execute). Medium effort, no urgency (anon path is closed).
2. **`batch_void_invoices` disk hardening** (Finding A) — eliminate disk-vs-live drift + add strict-actor defense-in-depth.
3. **Restore RPCs** (Finding B) — product decision, then fix-or-drop.
4. **Migration rebuild fidelity** (Finding 4) — shadow-DB content diff before the Phase-4 restore drill.

## Process note
This run had a clean chain of independent verification: workflow audit → Codex cross-review → live re-verification of Codex → reviewer subagents → in-migration self-assertions → post-apply live checks. Three layers (my audit, Codex, my re-verification) each caught something the others missed — the 2 extra credit-limit leakers (my re-verification), the 3 extra dashboard leakers (Codex), and the batch_void_invoices live-vs-disk distinction (my re-verification refuting Codex). Verify-against-live remained the deciding rule throughout.

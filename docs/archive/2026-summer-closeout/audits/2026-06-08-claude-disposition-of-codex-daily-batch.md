# Claude Disposition of Codex Cross-Review — 2026-06-08 Daily Batch

**Date:** 2026-06-08
**Reviewer:** Codex (independent second opinion)
**Prompt:** `docs/audits/2026-06-08-codex-daily-batch-review-prompt.md`
**Codex verdict:** NEEDS-WORK (1 HIGH, 1 LOW, 1 NIT)
**Outcome:** All three remediated live in `20260608193139_restore_rpcs_strict_actor` (+ a frontend test cleanup). HIGH independently verified against the live DB before fixing.

Per the project rule, every Codex finding was treated as a *claim to verify*, not truth, and re-checked against the live database and current code before acting.

---

## Finding 1 — HIGH: `restore_cancelled_order` / `restore_cancelled_delivery` trust caller-supplied actor

**Codex claim:** Both RPCs use `v_actor := COALESCE(p_performed_by, auth.uid())` and then gate on that actor's role, so a logged-in lower-role user can forge an admin UUID in `p_performed_by`. Same actor-forgery class as the recent strict-actor fixes.

**Verification (live + code):** CONFIRMED — and worse than my own `20260608174251` header characterized it ("attribution-only, out of scope").
- Live grant/secdef check:
  ```
  restore_cancelled_order      secdef=true   acl: authenticated=X/postgres
  restore_cancelled_delivery   secdef=true   acl: authenticated=X/postgres
  ```
  Both are `SECURITY DEFINER` (RLS bypassed) and EXECUTE-granted to `authenticated`.
- The role gate read `(SELECT role FROM profiles WHERE id = v_actor) != 'admin'` where `v_actor` = the **caller-supplied** `p_performed_by`. So a `driver`/`applicator` could read an active admin's id from `profile_public_view`, pass it as `p_performed_by`, and the gate would pass — meaning they could **actually execute the restore** (cancelled → confirmed / scheduled), not merely misattribute it. This is a privilege escalation + audit-attribution forgery.
- The functions have no `src/**` caller (dead-in-UI), but the EXECUTE grant makes them directly reachable via PostgREST, so "dead-in-UI" did not make them safe. Codex was right; my header's deferral was the recurring "close the actor gap on the function you're already editing" mistake.

**Remediation:** New follow-up migration `20260608193139_restore_rpcs_strict_actor` (not a revert, not an edit to the old migration). Replaced the `COALESCE` actor with the canonical strict-actor block on both functions:
```sql
v_actor := auth.uid();
IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role = 'admin') THEN
  RAISE EXCEPTION 'INSUFFICIENT_ROLE';
END IF;
```
Authorization scope preserved as admin-only; audit/activity rows now log the real `v_actor`. Bodies otherwise verbatim from `20260608174251`.

**Status:** FIXED + verified live (see smoke test below).

---

## Finding 2 — LOW: `restore_quote_version` idempotency is non-canonical

**Codex claim:** The idempotency check matches `idempotency_key` with no `operation` filter and returns `{'status':'duplicate'}` instead of the cached result, so a direct caller reusing a key from another operation could short-circuit a legitimate restore. Low likelihood (UI keys are unique per operation).

**Verification:** CONFIRMED (this was one of the open questions I flagged for Codex in the prompt). The sole caller `QuoteBuilder.tsx:1167` only calls `assertRpcResult(data, ...)` and reads no fields, so adding an `operation` filter is behavior-preserving for the UI.

**Remediation:** In the same migration, scoped the check to `operation = 'restore_quote_version'` (the value the save path already writes). Return shape left as-is (behavior-preserving). Its already-correct strict-actor block (from `20260608174251`) unchanged.

**Status:** FIXED.

> Note: the migration-review workflow separately raised, as a LOW, that `restore_quote_version`'s idempotency save omits `expires_at` and returns the sentinel rather than the cached result. Both are pre-existing, behavior-preserving (the `idempotency_keys.expires_at` column defaults to `now()+24h`), and were deliberately left to keep the body verbatim. Recorded for a future consistency pass; no action this migration.

---

## Finding 3 — NIT: `record_payment` still listed in `rpcContracts.test.ts`

**Codex claim:** `record_payment` (dropped live earlier today via `20260608145944`) still appears at `rpcContracts.test.ts:1392` and `:1538`. Tests pass, so non-breaking; recommended cleanup.

**Verification:** CONFIRMED. `:1392` is in `MUTATING_RPCS_WITH_IDEMPOTENCY` (82 entries); `:1538` is in `IDEMPOTENCY_BODY_EXEMPT` marking it `'non-mutating'`. Checked the consuming assertions before editing:
- `expect(MUTATING_RPCS_WITH_IDEMPOTENCY.length).toBeGreaterThanOrEqual(78)` — removing one → 81, still ≥78. ✓
- `total ≥ 81` (covered + missing) — 81 + 4 = 85. ✓
- sorted-array assertion — `record_payment` sits between `record_invoice_payment` and `record_vendor_payment`; removal keeps it sorted. ✓
- orphan check (`IDEMPOTENCY_BODY_EXEMPT` keys ⊆ `MUTATING_RPCS_WITH_IDEMPOTENCY`) — required removing from **both** lists, which I did. ✓

**Remediation:** Removed `record_payment` from both lists.

**Status:** FIXED.

---

## Codex agreements (no action required)

- `save_blend_ticket` strict-actor fix (`20260608152631`) is correct; strict actor runs before idempotency; AW-1 idempotency survived the second `CREATE OR REPLACE`.
- `restore_quote_version` strict-actor is correct for normal browser calls.
- `financial_audit_log` values (`order_restored`/`delivery_restored`, `order`/`delivery`) are valid live.
- `record_payment` is gone live with no app/Edge callers.
- Dependency bump (vitest 4 / react-router 7.17) is fine; prod audit clean; remaining advisory is the known moderate Vite/esbuild dev-server one (breaking Vite 8 fix, deferred).

---

## Live verification performed (this session)

- **Grant/secdef check** — confirmed the HIGH was real (both functions `authenticated`-executable SECDEF).
- **Overload count** — 1 each for all three functions, before and after apply (`CREATE OR REPLACE` replaced in place, no fork).
- **Both per-migration reviewers** (`rls-security-reviewer` + `migration-drift-reviewer`) returned clean on the actual file; the `migration-review` workflow (RLS + drift + types + adversarial refutation) returned **`verdict: clean`, 0 BLOCKER**.
- **Rolled-back 8-path smoke test** (simulating `auth.uid()` via `request.jwt.claims`; all paths raise before any mutation, so nothing persisted):

  | Path | Expected | Got | Verdict |
  |------|----------|-----|---------|
  | order: no-auth | `AUTH_REQUIRED` | `AUTH_REQUIRED` | PASS |
  | order: driver forges admin | `ACTOR_MISMATCH` | `ACTOR_MISMATCH` | PASS |
  | order: driver own id | `INSUFFICIENT_ROLE` | `INSUFFICIENT_ROLE` | PASS |
  | order: admin authorized | passes auth → "Order not found" | "Order not found: …" | PASS |
  | delivery: driver forges admin | `ACTOR_MISMATCH` | `ACTOR_MISMATCH` | PASS |
  | delivery: admin authorized | passes auth → "Delivery not found" | "Delivery not found: …" | PASS |
  | quote: no-auth | `AUTH_REQUIRED` | `AUTH_REQUIRED` | PASS |
  | quote: driver role | `INSUFFICIENT_ROLE` | `INSUFFICIENT_ROLE` | PASS |

- **Applied live** with MCP stamp `20260608193139`; disk file renamed `20260608190000…` → `20260608193139_restore_rpcs_strict_actor.sql` per the B7 rule.

## Process note

The first `migration-review` workflow run reviewed an empty payload (`migration: "unknown"`, "no SQL provided") — the `{file: …}` arg did not reach the reviewer subagents (a known workflow args-passing quirk). That run's "clean" verdict was for empty input and was **not** used to stamp the proof. The workflow script was edited to hardcode the real file path and re-run; the second run genuinely reviewed `20260608190000_restore_rpcs_strict_actor.sql` and returned clean. The apply-guard proof was stamped only from that genuine run + the two direct reviewer passes.

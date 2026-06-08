# Architecture-Weakness Audit — 2026-06-08

**Map worklist:** 101 nodes / 175 edges. Top fan-in (SPOF candidates): `r-invoice`, `e-invoice`,
`order-detail`, `delivery-detail` (7 each), `orders`, `e-inventory` (6).
**Live snapshot:** ~262 public functions. Of frontend-callable mutators, **idempotency / status-guards /
row-locks are near-universal**; **7** RPCs declare `p_idempotency_key` but ignore it (2 are reads); **0**
triggers write `financial_audit_log` (so the audit flag is accurate).
**Verdict:** **ROBUST** — **0 BLOCKER · 0 HIGH · 2 MED · 1 LOW** (+ 1 cosmetic). The one BLOCKER-looking
candidate (`record_payment` double-pay) was **refuted** by the gate — it's dead code.

> First run of `docs/audits/architecture-weakness-audit-prompt.md`. Read-only — nothing changed.
> Lens = *fragility* (not drift, not correctness). This audit's takeaway: the architecture is
> defensively very strong; the few weak spots are mostly contained or forensic.

## Top single points of failure (Pass 1)
| Node | Fan-in | If it fails… | Guarded? |
|------|--------|--------------|----------|
| `post_invoice` / `e-invoice` / `r-invoice` | 7 | all AR posting stops | ✅ idempotent + status-guard + row-lock + audit |
| `check_period_open()` | (gates every post) | backdated/closed-period writes blocked app-wide | ✅ central guard by design |
| `e-inventory` / `r-inventory` | 5–6 | inventory math wrong | ✅ immutable `inventory_transactions` ledger + locks |
**Finding:** the highest-fan-in nodes are also the **most heavily guarded** functions in the codebase. No unguarded SPOF.

## Summary
| Pass | Focus | Result |
|------|-------|--------|
| 1 SPOFs | fan-in blast radius | ✅ hot nodes all guarded |
| 2 Double-submit | idempotency on mutators | ⚠️ **AW-1** (5 declares-but-ignores) + **AW-3** (dead RPC) |
| 3 Silent failure | unguarded callsites | ✅ `assertRpcResult` enforced; no gap found |
| 4 Race | status-guard / lock on shared entities | ✅ every transition has both |
| 5 Atomicity | multi-write flows | ✅ all are single plpgsql fns (atomic); see coverage note |
| 6 Missing reversals | void/cancel/reverse coverage | ✅ comprehensive + guarded |
| 7 Missing defenses | audit-log connection | ⚠️ **AW-2** (`create_direct_order`) |

## Findings (ranked)

### [MED] AW-1 — "Declares-but-ignores" idempotency (false sense of protection)
- **Pass 2.** Five RPCs accept `p_idempotency_key` but their body **never touches** `idempotency_keys` / `check_idempotency`:
  - **`save_blend_ticket`** — the frontend *correctly* passes a real key (`src/pages/BlendTicketDetail.tsx:362` via `useIdempotencyKey`), but the RPC drops it. Mitigant: it's **UPDATE-by-id only** (`inserts_ticket=false, updates_ticket=true`), so re-submitting lands the same end-state → low real harm. *Confirm the products sub-write is replace- (not append-) semantics.*
  - **`generate_batch_statements`** — frontend statement generation; ignores the key. *Confirm whether it persists statement rows (double-gen → duplicates) or is display-only.*
  - **`create_invoice_from_delivery`** — internal helper (not button-reachable; runs inside the already-guarded complete-delivery flow).
  - **`generate_rup_sales_records`** — internal/post-invoice path.
- **Why it matters:** this is the **exact pattern the project's `idempotency-body-check` hook exists to block** (the `9b36cd2` `issue_return_credit` regression). These slipped past it (predate the hook or were exempted). The danger is *"the UI believes a write is double-submit-safe when it isn't."*
- **Verification:** signature vs. body diff per RPC (`pg_get_function_arguments` shows the param; `prosrc` never references the idempotency table). `save_blend_ticket` callsite read at `BlendTicketDetail.tsx:356-363`.
- **Suggested hardening (NOT applied):** wire the key through via `check_idempotency`/`save_idempotency` (the canonical helpers), or drop the param where it's genuinely unneeded. Start with `save_blend_ticket` (it advertises protection it doesn't deliver).

### [MED] AW-2 — `create_direct_order` is not connected to the audit trail
- **Pass 7.** `create_direct_order` creates an order but writes **no** `financial_audit_log` row (`audit=false`), while its sibling `convert_quote_to_order` writes an `order_created` row (`audit=true`). **No trigger backfills it** — the only trigger on `financial_audit_log` is the immutability guard, so audit writes are explicit-in-body only.
- **Why it matters:** orders created directly (not via a quote) have no creation entry in the financial audit trail — a forensic/consistency gap (the `order_created` operation type exists and is used by the other path).
- **Verification:** `audit` flag from `pg_proc.prosrc` scan; trigger inventory query returned only `trg_guard_audit_log_immutable`.
- **Suggested hardening:** add the `order_created` audit write to `create_direct_order` to match `convert_quote_to_order`. *(Note: `save_invoice` is also `audit=false` but that's defensible — it handles **draft** invoices, which are pre-financial; `post_invoice` writes the financial event.)*

### [LOW] AW-3 — Deprecated `record_payment` money RPC still live in the DB
- **Pass 2 / dead-code.** `record_payment` (SECURITY DEFINER, mutates `payments`, declares-but-ignores `p_idempotency_key`) is **deprecated and unreachable**: no frontend call, **zero** internal RPC callers, and `src/lib/rpcContracts.test.ts:307` states *"record_payment contract removed — RPC is deprecated. Use allocate_payment instead."*
- **Why it's only LOW:** you cannot double-pay through a function nothing calls. But a dead SECDEF money-mutator with no idempotency is **latent** risk if ever re-wired.
- **Suggested hardening:** `DROP FUNCTION record_payment(...)` in a migration (after a final caller check).

### Cosmetic
- `get_ap_dashboard_summary` and `get_expiring_planned_holds` carry a vestigial `p_idempotency_key` on **read-only** RPCs — harmless; optional cleanup.

## Candidate refuted by the gate
| Candidate | Looked like | Verdict | Why |
|-----------|-------------|---------|-----|
| `record_payment` ignores idempotency on a money write | **BLOCKER** (double-pay) | **→ LOW** | Dead/deprecated — no frontend or RPC caller; superseded by `allocate_payment` |

## Verified robust (so a clean verdict means work, not silence)
- **Idempotency:** near-universal on frontend mutators; the only gaps are AW-1 (mostly contained) + AW-3 (dead).
- **Race-fragility:** every state transition checked (`complete_/confirm_/cancel_/void_/post_/receive_/reassign_*`) carries **both** a status-guard and a row-lock (`FOR UPDATE`). Two-actor races are well-defended.
- **Audit trail:** all financial mutations write `financial_audit_log` (post/void/payment/prepay/write-off/commission/finance-charge); the only real gap is AW-2.
- **Reversals (Pass 6):** comprehensive and guarded — `void_*`, `cancel_*`, `reverse_*`, `restore_cancelled_*`, `revert_quote_status`, `unapply_credit_memo`, `unlink_*`, `release_inventory_hold` all exist, all with `audit + status-guard + lock`.
- **Atomicity:** every mutation is a single `plpgsql` function (atomic by default); no app-side multi-write sequence was found that needed a server transaction it lacked.

## Coverage note (honest limits)
- **Reversal *completeness*** (does each `void_*` fully unwind every downstream row — e.g. void invoice → commissions cleared) was inferred from guard-presence flags, **not** confirmed line-by-line in every body. Deep reversal correctness is `/review-workflow`'s Layer C/D — run that for the exhaustive version.
- **App-side orchestration:** Pass 5 confirmed *server-side* atomicity; a page firing several `.rpc()` calls in series (non-atomic across calls) wasn't exhaustively walked in `src/`.
- Two "confirm" items left for a human: `save_blend_ticket` products replace-vs-append semantics, and whether `generate_batch_statements` persists rows.

**Bottom line:** this is a **defensively strong architecture** — idempotency, status-guards, row-locks, audit writes, and reversals are the norm, and the busiest nodes are the best-guarded. The real work is a small, contained cleanup: wire the 5 ignored idempotency keys (or drop the params), give `create_direct_order` its audit row, and drop the dead `record_payment`. Nothing here is load-bearing-broken today.

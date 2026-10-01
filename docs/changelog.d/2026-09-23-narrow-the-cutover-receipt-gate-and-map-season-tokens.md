## 2026-09-23 — the generic-field cutover receipt gate is narrowed so phase 2 can actually apply; the filed-season tokens are mapped for the generic editor

PR #786 review round (CodeRabbit). Three findings fixed, one refuted with a measurement. No
migration is applied; all four field-season candidates remain LOCAL CANDIDATE / UNAPPLIED.

## Fixed

### Phase 2 was effectively unappliable (Major)

`20260914101300_finish_generic_field_invoice_cutover.sql` refused phase 2 while **any** unexpired
`save_invoice` receipt existed. Only the field-application branch of `save_invoice` changes in that
migration; receipts live 24 hours (`idempotency_keys.expires_at` DEFAULT
`now() + interval '24 hours'`), and the generic invoice editor saves chemical-sale and
miscellaneous-charge invoices continuously on a working system. That form therefore demanded a
**24-hour freeze on all invoice saving**, which a live distributor cannot give during application
season — the same stranding hazard migration-history row 934 already recorded.

The gate now resolves each receipt to its invoice through a guarded UUID cast of
`result->>'invoice_id'` and refuses only when the receipt could replay a field-application save.
Every one of the 16 `save_invoice` receipt writers through `20260904180000` records
`jsonb_build_object('invoice_id', …)`, so the cast target is the real key, and the regex guard keeps
a non-UUID value from raising instead of blocking.

**This is not the quiet-window scan.** Row 933's prohibition on narrowing that gate stands
unchanged: it governs the `pg_stat_activity` check, which proves in-flight *old-body requests* have
drained and still counts every backend type. This is the separate *committed-retry* gate. Row 933
now states the distinction explicitly so the two cannot be conflated.

Fail-closed is preserved where it can still matter: among receipts passing the expiry test (NULL
expiry included), one whose `invoice_id` is absent, malformed or no longer resolvable still refuses,
because an unidentifiable receipt could be a field save. Only a receipt resolving to a live invoice
of another type is allowed past.

### Operators saw a raw error token

A job- or blend-built field invoice stays in the generic `InvoiceDetail` editor — the per-acre
redirect fires only when `job_id` **and** `blend_ticket_id` are both null — and that page reports
save errors through `sanitizeError`, which had no pattern for either filed-season token. An operator
whose date edit left the filed season therefore saw
`INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED: this invoice is filed in season 2026, …`, token and all,
plus a raw invoice UUID in the immutable-season case. `FieldApplicationInvoice` was unaffected only
because it maps the tokens in its own `fieldAppError`.

Both tokens are now mapped in `src/lib/errorSanitizer.ts`. The season/date refusal keeps the
server's season and allowed-date-range text — that text is the operator's actual answer and carries
no schema identifiers — while the immutable-season refusal does not echo the invoice id.

### A filtered sweep looked like a full one

`run-sweeps.mjs --adjudicate` printed the same object whether the predicate set was complete or
filtered by `--only`, though the README states a filtered run "is NOT valid evidence for the
migration, ship, or review gates". The output now carries `"complete"`, true only when every
discovered predicate is present, and both user-facing messages say `--only` is diagnostic-only.

## Refuted, with the measurement recorded in the allowlist

CodeRabbit asked for `public._below_cost_reason_from_json(jsonb)` to be pinned on the eight
below-cost actor exceptions. The call is real — `_begin_below_cost_money_write` invokes it once, in
`COALESCE(public._below_cost_reason_from_json(p_payload), '')` — but it cannot bear on actor forgery:
the guard raises `AUTH_REQUIRED` on a NULL `auth.uid()`, `ACTOR_MISMATCH` on a non-null
`p_performed_by` that differs from it, and `INSUFFICIENT_ROLE` unless the actor is an active
admin/sales_rep, **all three before the parser is ever called**. That call site is inside the pinned
guard's own definition, so the existing digest already covers whether it is reached. The parser is
`IMMUTABLE SECURITY INVOKER`, takes no actor argument, reads no table, and returns caller-supplied
payload text the caller already controls. It also calls `_below_cost_reason_from_text`, so pinning
every transitive callee rather than every materially-relied-on dependency would expand without
bound.

Pins are live database-side digests over definition, owner and ACL. None was invented here: a wrong
digest would un-match all eight exceptions permanently and turn the sweep red. The refutation is
recorded in each of the eight justifications. **No pin value changed.**

## Proof

- **New prover** `scripts/smoke/prove-generic-field-cutover-receipt-gate.mjs` →
  **`RECEIPT_GATE_NARROWING_PROOF_PASS`**, `postgres:17-alpine` (17.10, `--network none`). It
  extracts the gate predicate **verbatim from the migration file** rather than restating it, runs it
  beside the previous form over 11 receipt fixtures, and requires behaviour to differ on exactly the
  3 cases whose only still-valid receipts resolve to a live non-field invoice. Observed:

  | fixture | old | new |
  |---|---|---|
  | unexpired FIELD receipt | BLOCK | BLOCK |
  | unexpired CHEMICAL receipt | BLOCK | ALLOW |
  | NULL-expiry FIELD receipt | BLOCK | BLOCK |
  | NULL-expiry CHEMICAL receipt | BLOCK | ALLOW |
  | EXPIRED field receipt | ALLOW | ALLOW |
  | DANGLING invoice_id | BLOCK | BLOCK |
  | NULL result | BLOCK | BLOCK |
  | MALFORMED invoice_id | BLOCK | BLOCK |
  | no receipts | ALLOW | ALLOW |
  | CHEMICAL unexpired + FIELD expired | BLOCK | ALLOW |
  | CHEMICAL unexpired + FIELD unexpired | BLOCK | BLOCK |

- **Proven backwards, twice.** A mutant dropping the `i.id IS NULL` fail-closed branch is refused by
  the extraction contract; a mutant that keeps every asserted substring but adds
  `AND k.expires_at IS NOT NULL` passes that contract and is then caught behaviourally —
  `NULL-expiry FIELD receipt BLOCK → ALLOW, MISMATCH`, exit 1.
- **Error mapping proven before/after** against the real `RAISE` text from
  `20260914101000_field_app_invoice_cross_season_edit_guard.sql`: the previous `errorSanitizer`
  returned `INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED: …` and a raw UUID verbatim; the new one returns
  plain English and retains `2025-10-01`/`2026-09-30`.
- **`complete` flag exercised through the real CLI:** `complete: true` over the full 29-predicate
  capture, `complete: false` under `--only overloads`, with `ok: true` in both — which is precisely
  why the flag was needed.
- `typecheck`, `lint`, `npx vitest run` (**5,448 passed** / 123 skipped), `build`,
  `test:correction-guards`, `test:agent-workflows`, `check:docs` all green.

## Live impact

**None.** `20260914101000`, `101100`, `101200` and `101300` remain LOCAL CANDIDATE / UNAPPLIED, and
none may apply before `20260914100900` is live. Row 933 carries the new sha256
`6bc6480025d8eb650763ac9b4f600e26b34f0f95da2306c39e8a6b68cab091bb` (was `75af12f9…`, retained there
as history).

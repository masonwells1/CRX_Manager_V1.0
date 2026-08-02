# Verification hardening — idempotency reset ordering

**Date:** 2026-08-02  
**Base:** `ea794571bd189a1dab25fabf0cb1175925e17cb8`  
**Scope:** quote, order, delivery, inventory-affecting completion, invoice,
payment, prepay, field-work, return, finance-charge, and vendor-bill callers.

## Confirmed defect

Callers across twenty-two React source files reset their per-intent idempotency key after the
Supabase RPC returned no transport error but before `assertRpcResult()` proved
that the response contained a success payload.

Supabase can return `{ data: null, error: null }` for a silently denied RPC.
In that case the UI correctly reports an apparent failure, but resetting the
key first meant a retry used a new key. If the original server mutation had
committed but its payload was lost or unusable, the new key could allow the
same money, inventory, or lifecycle mutation to execute again.

## Repair

Every mechanically safe caller in this patch now follows one order:

1. throw on the Supabase error;
2. validate the non-null payload with `assertRpcResult()`;
3. only then reset the idempotency key.

No RPC arguments, SQL, database objects, live rows, business calculations, or
lifecycle rules changed. A source-wide regression test scans TypeScript and TSX
callers and fails if `resetKey()` is placed before `assertRpcResult()`.

### Parked follow-up: `save_invoice` reconciliation

`InvoiceDetail.handleSave` is deliberately unchanged. Correctly handling an
ambiguous create response requires more than moving two lines: the UI must
distinguish authoritative database rejection from unknown commit status,
retain an independent key per actor/route/invoice, reconcile a newly created
invoice ID, and preserve edits made after the unresolved attempt. Four
adversarial review rounds proved that a small ride-along repair could either
duplicate an invoice, replay invoice A while viewing B, or pin a rejected
payload and discard corrections. The regression scan excludes only this one
handler and continues to cover every other caller in `InvoiceDetail`.

This is preserved as an independently confirmed financial-workflow follow-up;
it was not self-certified or widened inside this ordering patch.

## Workflow evidence

Graphify was queried against the current local CRX graph for the order →
delivery → inventory → invoice → payment path. Material edges were checked in
current source, including `PaymentAllocation`, `QuickDeliveryModal`,
`DeliveryDetail`, `OrderDetail`, `Invoices`, and prepay callers.

Verification on the stable candidate:

- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm run test` — pass, 312 files; 4,652 passed; 123 skipped
- `npm run build` — pass
- `npm run test:agent-workflows` — pass
- `npm run check-doc-drift` — pass
- `git diff --check` — pass

The governed Factory pilot also recorded a verified passing `npm run test`
receipt. Its typecheck evidence runner reproducibly triggered the Factory's
protected-byte emergency hold despite a stable diff, so that pilot lane was
truthfully parked and remaining verification continued through the normal CRX
guarded workflow. This was a tooling blocker, not a TypeScript failure; the
ordinary typecheck above passed after installing lockfile-pinned dependencies.

## Safety boundaries

- No migration was created or applied.
- No live database query mutated data.
- No edge function, secret, permission, billing setting, supplier-cost flag,
  or accounting-period state changed.
- No production deploy occurred during implementation or verification.

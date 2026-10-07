## 2026-10-06 - CRX-LIFE-001 fix round 1: repaired covering smoke chains and a one-transaction guard

Review round 1 of the CRX-LIFE-001 change (specialist reviewers, two adversarial reviewers with
skeptic verification, and Codex Luna) found no BLOCKER or HIGH. This round fixes what it did find;
the full record is in `2026-10-06-crx-life-001-order-invoice-type-gate.md` under **Reviews**.

- `20261006200000_refuse_field_invoice_through_order_rpcs.sql` now refuses up front, in its
  preflight, when it is not run as one transaction (the marker check is split into two IFs, because
  a combined condition fails to plan when the marker table is missing - the prover caught that).
  The wrapper body is unchanged (md5 still `a1a91643bd8866823ae359f7e0ec290e`).
- Three registered chains covering `create_invoice_from_order` were broken against the current
  schema and are repaired, because the ship rule requires every covering chain to pass after the
  apply: `smoke-govern-invoice-order-money-lifecycle.sql` and `smoke-backfill-refuse-split-billing.sql`
  now price their fresh products through the governed pricing RPCs, and
  `smoke-money-lifecycle-idempotency-required.sql` passes the Chicago business date to
  `generate_finance_charges`. The lifecycle chain also needed its commission rows linked to an
  active user, `posted_at` on the invoices it posts, the Chicago business date throughout, and
  `request.jwt.claim.sub` set; its assertions are unchanged. It now reaches `SMOKE_PASS_ROLLBACK`
  in the container for the first time against the current schema.
- `smoke-order-invoice-type-gate.sql` prices its own product the same way and invoices the rep's own
  customer and orders.
- The prover adds the autocommit refusal, the existing-CHECK preflight branch, and both repaired
  chains.
- Docs: the archive heading no longer dates the fix before its apply; the two split refusal paths are
  described exactly; a pre-existing finding (the order-invoice salesperson is caller-chosen) is
  recorded as open in `KNOWN_ISSUES.md`.

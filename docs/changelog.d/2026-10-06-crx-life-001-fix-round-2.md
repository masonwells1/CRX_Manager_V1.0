## 2026-10-06 - CRX-LIFE-001 fix round 2: accurate wording, a sharper write-off probe, two recorded gaps

Review round 2 on `2961c7dc9` (`rls-security-reviewer`, `migration-drift-reviewer` and two adversarial
reviewers, every finding checked by independent skeptics; plus Codex Luna round 2) found no BLOCKER
or HIGH. Fixed:

- **Migration wording only** (wrapper body unchanged, md5 `a1a91643bd8866823ae359f7e0ec290e`): the
  one-transaction guard no longer claims "nothing was changed". It stops a client that stops on the
  first error, which every sanctioned apply path does (`scripts/apply-migration-file.mjs` wraps the
  file in one transaction); plain autocommit psql without `ON_ERROR_STOP` would run on past it. The
  header now says what really happens on a split order without field allocations: every type is
  refused with `IDEMPOTENCY_KEY_REQUIRED` (22023), because that fallback passes a NULL key
  (pre-existing, unreachable since 2026-07-21). `rpc-functions.md` says the same.
- **Lifecycle chain:** after the switch to the Chicago business date, the reversed-write-off probe
  queried a date window that could miss the row's own UTC `created_at` date for part of each day,
  making it pass without testing. It now queries the row's own date. The chain header notes that a
  live run consumes invoice numbers (INV-, CS-) that the rollback does not return.
- **Type-gate chain:** uses the Chicago business date; its spec description no longer says it
  borrows a product.
- **Docs:** chain counts corrected (three chains cover `create_invoice_from_order`; the split-billing
  chain covers `create_split_invoices_from_order`); the `KNOWN_ISSUES.md` header no longer repeats
  ledger counts that go stale at apply; the archive entry and dates made consistent.
- **Recorded as open in `KNOWN_ISSUES.md`, not fixed here** (pre-existing; Mason's business rule
  decides the fix): the order-invoice RPCs check neither that the order's customer is assigned to the
  calling rep (`save_invoice` does, with `CUSTOMER_SCOPE_DENIED`) nor that the salesperson the caller
  names is themselves. `invoices.salesman_id` and `created_by` are read-access keys, so either gap
  can let the wrong person read an order invoice. Codex Luna round 2's one MED was the salesperson half; it is deferred
  here by name.

**PR #885 review (first automated review):** asked that CRX-LIFE-001 stay open until the live apply
is verified. Done: the entry is back in the OPEN part of `KNOWN_ISSUES.md` as "fix pending apply";
a follow-up after the merge verifies the live state and archives it.

**PR #885 Codex GitHub review (P2), deferred by name:** a refused `field_application` split on an
allocated order draws one invoice number before the CHECK rejects it (only a non-app caller sends
that type). The split wrapper's type allow-list goes into the rep-scoping change, which re-emits that
wrapper anyway; recorded in `KNOWN_ISSUES.md`.

**Owner decision (Mason, 2026-10-06, in chat): "Land it then lock down rep scoping next."** Codex
Luna round 3 rated both pre-existing gaps (customer scope and salesperson on the order-invoice RPCs)
HIGH; they are deferred by that decision and are the next change, recorded in `DECISION_LOG.md` and
`KNOWN_ISSUES.md`. Luna round 3's LOW (the one-transaction guard cannot stop a client that keeps
going after errors) is accepted as documented: every sanctioned apply path stops on the first error.

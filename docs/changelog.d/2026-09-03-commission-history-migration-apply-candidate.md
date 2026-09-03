## 2026-09-03 - Prepare commission history migration apply candidate

- Isolated the exact ledger-backed commission migration, rollback smoke, proof harness, and
  documentation. The Reports page already calls the existing aggregate balance RPC, so a live
  apply changes that report's supported date range without a separate frontend release. The new
  payment-detail RPC is backend-only in this candidate and has no frontend caller yet.
- The candidate records dated void/cancellation evidence, stable reporting labels, admin-only
  aggregate/detail RPCs, a writer-locked cheap-window precondition, and create-time rejection of
  negative or pre-order-date payout items. Canonical zero-dollar commissions remain settleable and
  are counted paid only when a signed settlement event exists, including after the source commission
  is later deleted or otherwise becomes unearned.

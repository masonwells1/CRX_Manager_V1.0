## 2026-09-03 - Close commission history replay catalog gaps

- Pin the cancellation trigger's exact timing, events, row mode, function, predicate, arguments, and
  column-list shape so a same-named trigger cannot conceal already-missed cancellation history.
- Execute the candidate's own three-table lock statement in the concurrency proof and reject a
  mutation that removes the payment-item table from its lock coverage.

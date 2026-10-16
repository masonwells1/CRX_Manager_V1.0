## 2026-10-16 — replay-binding batch 2: `create_planned_holds` requires a retry key on every call

CodeRabbit's pre-merge check on PR #951 ("Mutating RPC without idempotency key") was right:
migration `20261016140000` still let a caller run `create_planned_holds` with no key, because
`revert_quote_status` calls it that way. A first fix gated the keyless call behind a
transaction-local marker; the check still (correctly) flagged a keyless path in a public entry
point, so the final fix removes it:

- `create_planned_holds` refuses every keyless call with `IDEMPOTENCY_KEY_REQUIRED`. The app's own
  call already sends a key.
- `revert_quote_status` is recreated from its pinned live body with two changes: its rebuild of a
  reopened planned quote's holds calls the private `_create_planned_holds_replay_impl_20261015`
  instead of the public name, and a keyless call is refused first (`IDEMPOTENCY_KEY_REQUIRED`;
  CodeRabbit, since this migration now recreates it; every caller already sends a key). Every other
  line, its checks, its receipts, its grants and its COMMENT are unchanged (body md5 `fb0cc5def3766270b13c401810b61f3e` before, `e038d6568f6f0294045bf662eceb02bd` after).
- Proof: the rollback-only chain reopens a declined planned quote through `revert_quote_status`
  (its rebuild runs and writes no `create_planned_holds` receipt) and shows a keyless
  `create_planned_holds` is refused; the container prover gives the wrapper a keyless path back,
  and points `revert_quote_status` at the public name again, and each turns the chain red. Two older
  chains (`smoke-draw-ledger-reversal.sql`, `smoke-planned-holds-drawn-sync.sql`) now pass a key.
- The order screens also stop showing "Order created successfully" on top of the warning when
  they open an order an earlier attempt already created (Codex P2 on PR #951).

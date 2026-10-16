## 2026-10-16 — replay-binding batch 2: review round 1 fixes

Review round 1 on migration `20261016140000` (security, schema-drift, compliance and Luna reviews):

- The preflight now pins the live body of `auth.uid()` (the actor every wrapper binds receipts to),
  not just its existence (Luna, HIGH).
- The cycle-count reversal screen and the planned-holds save now show the plain-English refusal
  messages instead of raw error codes, and the planned-holds failure reaches Sentry (compliance).
- The call-site test refuses an `undefined` or `null` retry key.
- Refuted with evidence: a role check after the replay check (every renamed body checks the role
  before its own replay), and a server-role call failing (every renamed body already required a
  signed-in user). Deferred: the older bare key-reset form at `draw_down_quote` and on the
  purchase-order, vendor-bill and receiving screens; opening the already-created order after an
  intent refusal on the create screens.

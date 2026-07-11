# CRX Manager — TODO (as of 2026-07-10)

What's still **open**, what's **deferred on purpose**, and what's **out of scope**.
Everything that's been shipped lives in `docs/CHANGELOG.md`, the `CLAUDE.md`
**Snapshot** section, and the `memory/` files — this file only tracks what's left.

---

## 🔴 Outstanding — needs Mason (owner action)

These are blocked on something only you can provide or do. Nothing here is a
coding task — they're the base data, keys, and dashboard toggles the already-built
features are waiting on.

### Bigger items waiting on your input
- **Label data load** — the biggest unblocker. 0 of ~604 products have EPA #/REI/PHI/
  signal-word data, so compliance, WPS, spray-safety, and field-profitability
  features stay blank until it's loaded. The new admin **/label-data-quality** tool
  (shipped 2026-07-10) makes this a data-entry job, not a coding job. Caveat: of the
  ~204 EPA reg numbers already stored, roughly **105 are wrong** — the bulk backfill
  to correct them is parked (EPA lookup Waves 4–5, below).
- **A1 — ACH / card pay-now links** (let customers pay online; the #1 competitive gap).
  To start: create a Stripe account and hand over the API keys. This also unlocks
  the grower-portal payment features.
- **D1 — vendor-bill AI extraction pilot.** To start: send ~10 real vendor bills
  (PDF/photo) for the accuracy gate; production also needs an Anthropic API key in
  the Edge Function secrets.
- **H1 — inventory re-base.** 17 products are currently in a negative on-hand state
  and can't be delivered until corrected. Needs physical counts from you to set the
  true starting numbers.

### Quick verifications / toggles
- **L4 — leaked-password protection.** Confirmed this is **gated behind the Supabase
  Pro plan**, not a free toggle. Effectively parked unless you upgrade; the free
  security wins are GitHub-side and already done.
- **Backup restore drill** — Supabase dashboard → Settings → Database → Backups:
  confirm PITR is on and daily snapshots run, then do a one-time restore drill
  (throwaway project, replay migrations, restore latest, smoke-test, delete). Not
  exposed via tooling — dashboard only.
- **Sell-side in-app smoke** — click through the live flows once with real eyes:
  ship-now/price-later, draft-invoice consolidation, open-booking rollover.
- **Dispatch backfill (optional owner call)** — materialize dispatch rows for legacy
  assigned jobs. It's a business-data write (not additive-only), so it's your call
  to run it.
- **Money/AR deep audit re-run** — the foundation audits came back "vacuously clean"
  because there are ~0 real posted invoices/payments live. Re-run
  `/foundation-ultra-review` after your first real billing cycle.

---

## 🟡 Deferred / parked (intentional — revisit later)

Code either exists-but-parked or is planned-and-shelved on purpose.

- **EPA label-lookup Waves 4–5** — bulk backfill to fix the ~105 wrong stored EPA reg
  numbers. Stage 2 (auto-reading REI/PHI off the label) is deferred deliberately —
  per-crop values are a safety trap.
- **Grower portal (§7–§10)** — the customer-facing side of the beyond-parity roadmap.
  All the internal field-app features shipped; the portal is deferred.
- **Billing "Feature B"** — parked at a design blocker (residual-ledger question);
  needs a decision before it can proceed.
- **Sprint D + workflow Wave 2/3 remainder** — from the workflow-waves loop; parked
  with written plans.
- **~6 small workflow-review leftovers** — from the 121-finding review (e.g. #40 dead
  RPC retirement, #107 owner-decision item). Low-risk cleanups.
- **13 parked migrations across worktrees** — database changes written and awaiting an
  apply session. Run `/parked` to see the full list before applying any.
- **F3 WebP edge-function deploy** — blocked on a transient Supabase platform 500;
  just needs a retry (`supabase functions deploy process-document`).
- **#6b prepay "earmark" write-engine** — shelved to
  `docs/roadmap/shelved-earmark-engine/` pending a reserved-pool redesign. The 3
  shelved migrations must **not** be applied as-is.
- **Field Mode follow-ups** — on-device pass on a real phone + an offline-replay pass
  for the `/my-route` driver workspace (shipped & live, additive/zero-migration).
- **H2 squashed migration baseline** — collapse the migration history into a baseline.
  Deferred deliberately; schedule for a quiet window.
- **apply_prepay hand-decrement cleanup** — `apply_prepay_to_invoice` still
  hand-decrements the prepay balance while a trigger also recomputes it (same end
  state). Safe to drop the hand-decrement after more time watching the trigger in prod.
- **Customer RLS upper bound** — drivers/applicators can see customers for jobs
  scheduled arbitrarily far ahead. Left as-is on purpose (route/job planning needs
  future visibility); the lower bound already prevents the historical leak.

---

## 🚫 Out of scope (separate project)

- **E2E staging Supabase project** — blocked on creating a `crx-manager-staging`
  project + adding `STAGING_SUPABASE_URL` / `STAGING_SUPABASE_ANON_KEY` GitHub
  secrets. A standalone PR when unblocked.

---

## 📋 Status snapshot

| Metric | Value |
|---|---|
| Pages | 82 |
| Migrations (on disk) | 584 (live `schema_migrations` carries more — pre-existing drift, not a bug) |
| Tables | 113 (+2 views) |
| RPCs | 282 callable + 56 trigger functions |
| Edge Functions | 6 |
| Unit tests | ~2,222 passing / 115 skipped |
| E2E spec files | 94 |
| Production | Live at croprxsolutions.app (`main` = live) |

> Full shipped history → `docs/CHANGELOG.md`, the `CLAUDE.md` **Snapshot** section, and `memory/`.
</content>
</invoke>

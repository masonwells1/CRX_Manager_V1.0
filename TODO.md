# CRX Manager — TODO (as of 2026-06-15)

What's still **open**, what's **deferred on purpose**, and what's **out of scope**.
Everything that's been shipped lives in `docs/CHANGELOG.md` and the `CLAUDE.md`
**Current State** section — this file only tracks what's left.

---

## 🔴 Outstanding — needs Mason (owner action)

These are blocked on something only you can provide or do.

### Quick verifications
- **G5 sell-side in-app smoke** — click through the new flows on the live site:
  ship-now/price-later (create a rush order → price it later), draft-invoice
  consolidation, and the open-booking rollover view. Confirm they behave as
  expected with real data. (Shipped & live 2026-06-14; just needs your eyes.)
- **Phase 4 backup verification** — Supabase dashboard → Settings → Database →
  Backups: confirm PITR is on and daily snapshots run. Then schedule a one-time
  restore drill (spin up a throwaway project, replay migrations, restore latest
  backup, smoke-test, delete). Not exposed via tooling — dashboard only.
- ~~**M4** — confirm the `seed-admin` Edge Function has `ENVIRONMENT=production` set.~~ ✅ RESOLVED 2026-06-16: `seed-admin` was DELETED from the live project (nightly-debug PARKED-07), so its `ENVIRONMENT` kill-switch is moot. The one-time seed is done (3 active admins).
- **L4** — enable Supabase **leaked-password protection** (dashboard → Auth).

### Bigger items waiting on your input
- **A1 — ACH pay-now links** (let customers pay online; the #1 competitive gap).
  To start: create a Stripe account and hand over the API keys. This also unlocks
  the grower-portal payment features (A2/A4).
- **D1 — vendor-bill AI extraction pilot.** To start: send ~10 real vendor bills
  (PDF/photo) for the accuracy gate; production also needs an Anthropic API key in
  the Edge Function secrets.
- **H1 — inventory re-base.** 17 products are currently in a negative on-hand state
  and can't be delivered until corrected. Needs physical counts from you to set the
  true starting numbers.
- **Data enablement** — the system is feature-rich but operationally empty: 0 of
  ~604 products have label data (EPA #, REI/PHI, signal word) and 0 of ~112 have
  reorder points. Compliance, WPS, reorder, and field-profitability features stay
  blank until this base data is loaded. (Label-data research draft is in progress —
  see the grower-portal memory.)

---

## 🟡 Deferred (intentional — revisit later)

- **#6b prepay "earmark" write-engine** — shelved to
  `docs/roadmap/shelved-earmark-engine/` pending a reserved-pool redesign (the new
  mechanism collided with the legacy aggregate one). The 3 shelved migrations must
  **not** be applied as-is. Only the read-only #6 booking views shipped at G5.
- **Field Mode follow-ups** — on-device pass on a real phone + an offline-replay
  pass for the `/my-route` driver workspace (shipped & live, additive/zero-migration).
- **schema-registry live refresh** — re-run the registry refresh so the PreToolUse
  hooks see the post-G5 schema. Housekeeping, low urgency.
- **H2 squashed migration baseline** — collapse the 455-file history into a baseline.
  Deferred deliberately; schedule when there's a quiet window.
- **Customer RLS upper bound** — drivers/applicators can see customers for jobs
  scheduled arbitrarily far ahead. Left as-is on purpose (route/job planning needs
  future visibility); the lower bound already prevents the historical leak.
- **apply_prepay hand-decrement cleanup** — `apply_prepay_to_invoice` still
  hand-decrements the prepay balance while a trigger also recomputes it (same end
  state). Safe to drop the hand-decrement after a few more weeks of watching the
  trigger in prod.

---

## 🚫 Out of scope (separate project)

- **E2E staging Supabase project** — blocked on creating a `crx-manager-staging`
  project + adding `STAGING_SUPABASE_URL` / `STAGING_SUPABASE_ANON_KEY` GitHub
  secrets. A standalone PR when unblocked.

---

## 📋 Status snapshot

| Metric | Value |
|---|---|
| Pages | 68 |
| Migrations | 455 (all applied live) |
| Tables | 96 (+2 views) |
| RPCs | 226 callable + 47 trigger functions |
| Edge Functions | 7 (all current; `process-blend-ticket` at v20) |
| Unit tests | 2,005 passing / 70 skipped (139 files) |
| E2E spec files | 94 |
| ESLint / TypeScript errors | 0 / 0 |
| Supabase perf advisor WARN | 0 |
| Production | Live at croprxsolutions.app (`main` = live) |

> Full shipped history → `docs/CHANGELOG.md` and the `CLAUDE.md` **Current State** section.

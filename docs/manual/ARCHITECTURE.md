# CRX Manager — Architecture Overview

**Last verified:** 2026-07-13

**Update triggers:** update this file when a new subsystem or major data
flow is added (e.g. a new pipeline stage), a Supabase edge function is added
or removed under `supabase/functions/`, or an architectural decision changes
system topology (new automated job, new deploy target, new data store, a
shift in how frontend vs. database divide responsibility). Routine feature
work inside an existing subsystem does NOT require an update here — that
goes in `docs/workflows/*.md` or `docs/CHANGELOG.md`.

This file stays light on volatile detail (page counts, migration counts,
line counts) — those drift constantly and are covered by
`.claude/schema-registry.json` and `docs/reference/` (kept current by
`npm run check:docs`). This file answers "how does the system fit
together," not "how many of X exist right now."

---

## 1. What CRX Manager is (plain English)

CRX Manager is the day-to-day operations app for **Crop RX Solutions**, a
company that sells and applies agricultural chemicals (herbicides,
pesticides, fertilizer blends) to farms. Staff use it to quote jobs, take
orders, schedule deliveries and field applications, track warehouse
inventory, invoice customers, and take payments. It is a **production
system used by real people to run a real business** — mistakes here can
cost real money or send a driver to the wrong field.

"The owner" throughout this repo means **Mason Wells**, who has no coding
background. Every agent working in this repo (Claude, Codex, or any future
model) should write plans and explanations in plain English for him, the
way you'd explain something to a smart non-technical business partner.

---

## 2. System topology

```
 ┌─────────────────────────────────────────────────────────────┐
 │  Browser / phone (PWA — installable, works offline-ish)     │
 │  React 18 + TypeScript + Vite + Tailwind CSS                │
 └───────────────────────────┬───────────────────────────────────┘
                              │  git push to `main`
                              ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Vercel — hosts the built static app + auto-deploys on push  │
 │  Push to `main` = a production deploy. There is no staging   │
 │  environment; a merged PR to main goes live.                  │
 └───────────────────────────┬───────────────────────────────────┘
                              │  HTTPS (Supabase JS client)
                              ▼
 ┌─────────────────────────────────────────────────────────────┐
 │  Supabase (project rhyzpcqhnizqbxphqdkr)                     │
 │  ┌───────────────┐  ┌────────────────┐  ┌──────────────────┐ │
 │  │ Postgres       │  │ Edge Functions │  │ pg_cron          │ │
 │  │ + RLS policies │  │ (Deno, 7 fns)  │  │ (scheduled jobs) │ │
 │  │ + RPCs/triggers│  └────────────────┘  └──────────────────┘ │
 │  └───────────────┘                                            │
 └─────────────────────────────────────────────────────────────┘
```

- **Frontend**: React 18 + TypeScript, built by Vite, styled with Tailwind
  CSS. Packaged as a PWA (Progressive Web App — an installable, app-like
  website) via `vite-plugin-pwa` (see `vite.config.ts`). Error/performance
  monitoring via Sentry.
- **Hosting/deploy**: Vercel. **Pushing to `main` deploys to production** —
  there is no separate staging step. See `docs/workflows/SAFE_DEVELOPMENT_RULES.md`
  and `AGENTS.md` for the approval gate this requires.
- **Backend**: Supabase, which bundles a Postgres database, authentication,
  file storage, "Edge Functions" (small serverless Deno programs — see §6),
  and `pg_cron` (a Postgres extension that runs SQL on a schedule — see §7).
- **Repo**: `https://github.com/masonwells1/CRX_Manager_V1.0`. **Production**:
  `https://croprxsolutions.app`.

---

## 3. The core principle — logic lives in the database

**State it loudly because it is the single most important fact about this
codebase:** business, financial, and inventory rules — the things that MUST
be correct (can this invoice be voided, does this order have enough stock,
did this payment already happen) — are enforced in **PostgreSQL**, via
**RPCs** (stored functions the frontend calls, short for "Remote Procedure
Call"), **triggers**, and **CHECK constraints**. The **React frontend is a
thin caller**: it collects input, calls an RPC, and renders whatever the
database returns. It does not compute money, does not decide whether a
status transition is legal, and does not do inventory math.

Why this matters: a bug in a database RPC is systematically defended (every
caller gets the same guard); a bug that only lives in React can be bypassed
by a different button, page, or a race between two browser tabs. See
`docs/audits/2026-06-08-architecture-weakness-audit.md` (verdict: robust —
idempotency, row-locking, and status-guards are near-universal on the
busiest database functions).

**Money must resolve to exact whole cents.** New storage uses `bigint` cents,
where `100` means `$1.00`. Established PostgreSQL `numeric` dollar storage may
remain temporarily to avoid a risky unit rewrite, but it is not an approved
compatibility exception until database math is verified as exact `numeric`, all
existing values are finite whole cents, and an active finite whole-cent CHECK is
present. Dirty or unconstrained columns remain tracked findings. TypeScript must parse decimal
operands into integer cents before money math; binary-float conversion,
arithmetic, and rounding are not allowed. The pre-write `money-safety.mjs` hook
(see `docs/reference/agent-guardrails.md`) blocks `parseFloat()` on variables
whose names end in `_cents`.

Concrete rules that follow from this principle (full detail in
`docs/workflows/SAFE_DEVELOPMENT_RULES.md`):
- Inventory and financial invariants belong in RPCs/triggers, not React.
- Mutating RPCs require and enforce an idempotency key (`p_idempotency_key`)
  so a duplicate button-click or network retry can't double-charge or
  double-ship. See `src/lib/db.ts`'s idempotency helpers and
  `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`.
- Generated columns (Postgres computes them automatically, e.g.
  `invoices.balance_cents`) must never be written to directly by the app.

---

## 4. Data layer map

Everything the frontend does against the database goes through **one
file**: `src/lib/db.ts`. Key exports and why they exist:

- **`supabase`** — the single, typed Supabase client. Its custom `fetch`
  attaches an `X-Request-ID` header and a Sentry breadcrumb to every
  request (for tracing a failed call through logs). **Never instantiate a
  second Supabase client elsewhere.**
- **`assertRpcResult(data, rpcName)`** — call after every `.rpc()` call.
  Supabase silently returns `{ data: null, error: null }` when Row Level
  Security (RLS — Postgres's per-row permission system) denies access to a
  function the caller isn't allowed to run; without this check, a denied
  write looks like a successful no-op.
- **`checkMutationResult(result, operation)`** — call after every
  `.update()` / `.delete()`. Same silent-denial problem: an RLS-blocked
  update returns `{ data: null, count: 0 }` with no thrown error.
- **`RpcErrorCodes` + `hasRpcCode(err, code)`** — RPCs raise machine-readable
  string tokens (e.g. `INSUFFICIENT_HOLD_INVENTORY`) instead of raw text, so
  the frontend can branch on *why* a call failed without fragile substring
  matching.
- **`supabaseUntyped`** — an escape hatch for brand-new tables/RPCs not yet
  in generated `src/types/supabase.ts`. Prefer the typed client elsewhere.

**SECURITY DEFINER conventions** (a Postgres function that runs with the
privileges of whoever created it — needed for RPCs that must see across RLS
boundaries): every such function sets `SET search_path = public, pg_temp`
(prevents privilege-escalation via schema hijacking) and uses deliberate
`GRANT`/`REVOKE` — `anon` must be explicitly revoked. See
`docs/workflows/RLS_SECURITY_GUIDE.md` for the full pattern and
`.claude/schema-registry.json` for the live snapshot of tables, status
enums, and generated columns that hooks and reviewer agents check against.

---

## 5. Frontend map

- **Routing**: `src/App.tsx`. Every page is lazy-loaded (`React.lazy()`) so
  the initial bundle stays small; routes are wrapped in `ProtectedRoute`
  with an explicit `allowedRoles` list per route (roles: `admin`,
  `sales_rep`, `driver`, `applicator`). A route with no role restriction is
  open to any authenticated user.
- **Pages**: `src/pages/*.tsx` — one file per screen, matched to routes in
  `App.tsx`.
- **Shared types**: `src/types/index.ts` is the canonical place for
  TypeScript types shared across pages (statuses, entity shapes). Generated
  Supabase types live separately in `src/types/supabase.ts`.
- **Errors/monitoring**: import Sentry only via `src/lib/sentry` — never
  `@sentry/react` directly — so breadcrumbs/context stay consistent.
- **User-facing confirmations and messages**: use `ConfirmModal` (never the
  browser's native `confirm()`) and the toast system (never native
  `alert()`) — see `docs/workflows/UI_PATTERNS.md`.
- **Icons/styling**: Lucide icon set, Tailwind CSS utility classes.
- A dev-only `/design-preview` route (component gallery) is excluded from
  the production build by hostname check in `App.tsx`.
- **Product pricing (Phase 1a staged rollout):** the additive database bootstrap,
  forward hardening, and production frontend are live. Admin Product-page
  edits, Products-list inline edits, and the pricing-only `.xlsx` workflow call the same
  preview/apply RPC engine. The preview shows server-authoritative Product
  identity and old → new cost, margin, tier-price, and per-acre effects. The
  bootstrap records governed history through one trigger. The live zero-cost
  guard rejects a margin-driven zero cost, and the live strict cutover
  (`20260718190000`) denies direct pricing/history writes from app roles. Product-page,
  Products-list, and worksheet edits remain available because they use the
  governed preview/apply RPC path. Bulk Product Import remains a pricing-free CSV
  Product-details creator. Production `process-document` v19 rejects supplier
  price sheets and price-bearing Product lists before OCR; JWT verification is
  enabled, so the permanent supplier-pricing OCR retirement is live.

---

## 6. Edge functions (`supabase/functions/`)

Edge Functions are small serverless programs (Deno runtime) that run
outside the browser — used for anything that needs a secret the browser
must never see (e.g. the service-role key), or that calls an external API.
Current functions, one line each:

| Function | Purpose |
|---|---|
| `create-user` | Admin-only: provisions a new staff login (auth user + profile row) using the service-role key. |
| `epa-lookup` | Looks up an EPA pesticide registration number against the public EPA registry and normalizes/caches the result (added 2026-07 for label data quality). |
| `process-blend-ticket` | OCR/text parsing of a photographed blend ticket into structured fields (date, customer, driver, acres, rate, etc.). |
| `process-document` | Parses supported invoices, POs, customer lists, and quote lists into structured import data. Production v19 fails closed on supplier price-list/product-list requests before OCR, with JWT verification enabled. |
| `reset-user-password` | Admin-triggered password reset for another user (service-role privileged action, not self-service). |
| `send-email` | Sends transactional email; hardened to an allowlist of email types per role and validates the recipient server-side rather than trusting the caller's `to` address. |
| `setup-blend-tickets-storage` | One-time/idempotent setup of the storage bucket blend-ticket photos are uploaded into. |

All seven share `supabase/functions/_shared/` helpers: `cors.ts` (shared
CORS — Cross-Origin Resource Sharing — header config), `sentry.ts`
(`captureEdgeException`), and `auth.ts`'s `requireActiveProfile` for
consistent caller authentication.

**CORS is coupled to `src/lib/db.ts`.** On 2026-07-12, every edge function
went unreachable in production because the shared CORS config didn't allow
the `x-supabase-api-version` / `x-request-id` headers that `src/lib/db.ts`'s
custom `fetch` attaches to every Supabase request — a frontend-side change
broke the backend side with no shared code between them. If you touch
`_shared/cors.ts` or the headers in `src/lib/db.ts`'s `global.fetch`, check
the other side too.

---

## 7. Scheduled / automated jobs

- **Weekly in-database backup** (`pg_cron`, migration
  `20260713050000_weekly_db_backup.sql`): snapshots every public table's
  rows into `backup_snapshots` once a week, keeps 8 weeks. This is a
  same-database safety net against an accidental bad edit/delete — **not**
  an off-site copy.
- **Off-site encrypted backup** (GitHub Action, weekly): `pg_dump`s the live
  database, encrypts it (AES-256), and pushes it to the private repo
  `masonwells1/CRX_Backups` — the actual disaster-recovery copy for a
  total-Supabase-loss scenario.
- **Morning cron reports**: scheduled jobs that summarize overnight
  activity for staff.

**Time zone gotcha:** the live database and `pg_cron` run in **UTC**. The
business (and Mason) operate on **America/Chicago** time. Any code that
reasons about "today," "this week," or a cron schedule time must convert
explicitly — there is no implicit local-time behavior anywhere in the
database layer. This has caused bugs twice; see the entry in
`docs/manual/DECISION_LOG.md` ("Business time is America/Chicago; the live
DB and pg_cron run UTC").

---

## 8. Domain flow: quote → cash

The main business pipeline, in order, with the file that documents each
stage's detailed rules:

```
Quote --> Order --> Delivery / Blend Ticket / Job --> Invoice --> Payment / Credit Memo
```

- **Quote** (`quotes`, `quote_items`) — a priced proposal for a customer.
  Full rules: `docs/workflows/QUOTE_TO_DELIVERY.md`.
- **Order** (`orders`, `order_items`) — created from an accepted quote, or
  directly (`create_direct_order`) bypassing the quote step.
- **Fulfillment** happens one of three ways depending on the kind of sale:
  - **Delivery** (`deliveries`) — physical product shipped to a customer;
    two-step lifecycle (`confirm_delivery` then `complete_delivery`) that
    deducts inventory and updates the order.
  - **Blend ticket** (`blend_tickets`) — a driver/applicator's field mixing
    ticket, OCR'd via the `process-blend-ticket` edge function, reviewed,
    and turned into an invoice.
  - **Job** (`jobs`) — a scheduled field application (spraying, etc.)
    tracked through to an **applied record** and, for job-based billing, an
    invoice.
- **Invoice** (`invoices`, `invoice_items`) — draft → posted (locked, starts
  AR aging) → paid/voided. Field-application invoices support
  **multi-customer field/acre splits**: when a field's applied acres are
  shared across owners, one invoice per customer is generated from a shared
  job, linked by `invoice_group_id`, each with its own balance and AR
  trail. See the "Field Application Workflow" section of
  `docs/workflows/QUOTE_TO_DELIVERY.md` for the split-billing pricing modes.
- **Payment / Credit memo** (`payments`, `allocation_sets`,
  `prepay_credits`) — allocated to specific invoices via `allocate_payment`;
  invoices remain the single source of truth for AR balance.

**Two-acre model & field mapping**: fields are captured as GPS polygons
(draw-on-map or shapefile import). The app distinguishes a field's
**full/legal acres** from its **applied/edited acres** for a specific job —
because what a customer is billed for is what was actually sprayed, not the
field's nominal size — and that feeds directly into the per-acre invoice
split above. There is no dedicated `docs/workflows/` file for field mapping
yet; the relevant tables (`fields`, `field_billing_defaults`, `save_field`
RPC) and `.claude/schema-registry.json` are the closest thing to a spec.

**Inventory** underlies all fulfillment paths — every stock change writes
an immutable `inventory_transactions` row, and the one authoritative
"where do we stand" number is the `get_inventory_position()` RPC. Full
rules and all 12 transaction types: `docs/workflows/INVENTORY_RULES.md`.

---

## 9. Agent / guardrail layer

This repo runs multiple coding agents (Claude Code, Codex) against the same
codebase, with a layer of hooks and review subagents that catch the bug
classes that have actually bitten this project before (money math errors,
missing RLS, silent RLS denials, status-string typos, editing a generated
column, etc.). That layer is documented separately and should not be
duplicated here:

- **`docs/reference/agent-guardrails.md`** — full reference for every
  PreToolUse/UserPromptSubmit/SessionStart/Stop hook and what bug each one
  prevents.
- **`docs/manual/AGENT_ONBOARDING.md`** — (companion document, written
  alongside this one) onboarding guide for a new agent session: how to get
  oriented, what to read first, how the approval gates work day-to-day.
- **`AGENTS.md`** (repo root) — the concise shared contract: owner communication,
  authority, routing, true non-negotiables, and completion standards.
- **The rest of `docs/manual/`** — `DECISION_LOG.md` (settled decisions —
  check before re-opening one), `KNOWN_ISSUES.md` (everything known-open),
  `CURRENT_STATE.md` (dated live snapshot), `OWNER_PLAYBOOK.md` (Mason's
  plain-English manual).

---

## 10. "Where does X live?" quick reference

| Concern | Path |
|---|---|
| The one Supabase client | `src/lib/db.ts` |
| Shared frontend types | `src/types/index.ts` |
| Generated DB types | `src/types/supabase.ts` |
| Route table | `src/App.tsx` |
| Pages | `src/pages/*.tsx` |
| Reusable UI components | `src/components/` |
| Sentry setup | `src/lib/sentry.ts` |
| Database migrations (source of truth for schema) | `supabase/migrations/*.sql` |
| Edge functions | `supabase/functions/*/index.ts` |
| Shared edge-function helpers (CORS, auth, Sentry) | `supabase/functions/_shared/` |
| Current schema snapshot (tables, enums, generated columns) | `.claude/schema-registry.json` |
| Quote→order→delivery→invoice rules | `docs/workflows/QUOTE_TO_DELIVERY.md` |
| Inventory math & transaction types | `docs/workflows/INVENTORY_RULES.md` |
| RLS / SECURITY DEFINER pattern | `docs/workflows/RLS_SECURITY_GUIDE.md` |
| Migration checklist | `docs/workflows/DATABASE_CHANGE_CHECKLIST.md` |
| UI conventions (modals, toasts, tables) | `docs/workflows/UI_PATTERNS.md` |
| Multi-file/risky-change process | `docs/workflows/SAFE_DEVELOPMENT_RULES.md` |
| Agent/Codex collaboration mechanics | `docs/workflows/AGENT_COLLABORATION.md` |
| Hook + reviewer-agent reference | `docs/reference/agent-guardrails.md` |
| Project-specific known gotchas | `docs/reference/gotchas.md` |
| Shared agent contract and routing | `AGENTS.md` |
| Change history | `docs/CHANGELOG.md` |
| Past architecture audits | `docs/audits/` |

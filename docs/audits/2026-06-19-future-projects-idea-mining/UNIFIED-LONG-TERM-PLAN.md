# CRX Manager — Unified Long-Term Implementation Plan (Future Projects)

**Date:** 2026-06-19
**Reconciles three inputs:**
1. **Claude idea-mining sweep** — 6-repo multi-agent sweep, near-term picks *adversarially verified against the live CRX code*. (`docs/audits/2026-06-19-future-projects-idea-mining/`)
2. **ChatGPT / Codex analysis** — `2026-06-19-future-projects-open-source-comparison.md` (12 ranked opportunities + 3 "first projects"). Strong on *sequencing & architectural framing*; **not grounded against the live code.**
3. **Live-code grounding (this session)** — grep of `src/`, routes, and reference docs to confirm what CRX already has.

> Read this as the single source of truth. The two source analyses are the appendix.

---

## 0. The headline: most of ChatGPT's "build first" is already built

ChatGPT only read the project docs, never the running code, so its top recommendations over-state how much is greenfield. Grounded against the live app:

| ChatGPT "build first" | Live-code reality | Verdict |
|---|---|---|
| #1 Operations Command Center → global search / command launcher | `src/components/ui/CommandPalette.tsx` (global search RPC + recent items + entity search) | **Already built** |
| #1 → unified activity timelines + related-record panels | `CustomerDetail.tsx` (timeline over `activity_feed`, 89 logActivity sites), `FieldDashboard`, Customer 360 tab | **Already built** |
| #3 Inventory Proof Layer → ledger-vs-snapshot invariant checks | `/integrity-report` → `runReconciliationChecks()` (order totals, inventory ledger, invoice payments, balance formula, commission splits, hold parity, delivery-invoice parity…) | **Already built** |
| #6 Operational Work Queues → "delivered not billed", "negative inventory" | `/integrity-cleanup` (negative-inventory reset, over-received POs, *completed-deliveries-without-invoices* → `create_invoice_for_unbilled_delivery`); `/ar-aging`; `/financial-dashboard`; `/accounts-payable` | **Already built** |
| (Claude sweep also pre-killed) reps' tasks/notes; Customer-360 timeline; season planned-vs-actual crop plan | `/team-board` + `team_notes`; CustomerDetail; `/program-tracker` + `/crop-programs` + `field_crop_history` | **Already built** |

**Net effect:** the genuinely-missing pieces are *not* a new navigation/dashboard layer — those exist. The real gaps are **depth in the agricultural/compliance domain and a few targeted money/CRM features.** That is closer to the Claude sweep than to the ChatGPT top-3.

---

## 1. Where the two analyses agree (high-confidence signal)

- **License:** ideas / data-model shapes / formulas only for the 5 copyleft repos (ERPNext GPL-3.0, Twenty AGPL-3.0, Ekylibre AGPL-3.0, LiteFarm GPL-3.0, farmOS GPL-2.0). **FarmVibes.AI is MIT** (root) — the only code-borrowable one, and even there: verify per-file before copying, default to ideas-first. *(Jargon: **copyleft** = if you build on their code, you can be forced to publish yours; **AGPL** triggers that even for a website people merely use.)*
- **The keystone domain build is the Application & Evidence Record** — both rank it #2/top, both say *design-first, compliance-sensitive*, both cite **Ekylibre's intervention model** as the strongest reference (target field + inputs/products + outputs + tools + doers + working periods), plus LiteFarm/farmOS for tasks/docs/offline and FarmVibes for weather/geometry.
- **Stay dealer-scoped.** Don't build a full farm-owner ERP. Useful scope = sell · blend · apply · compliance evidence · customer operations.
- **Stay on the CRX stack** (React/TS/Vite/Tailwind/Supabase/Vercel). Don't adopt anyone else's platform.
- **Offline = non-money evidence capture only.** Never offline invoices/payments/commissions/inventory mutations.
- **Don't make money/inventory/delivery/invoice/status logic user-customizable.** (Metadata-driven custom fields are fine for soft CRM/notes data only — never the money core.)

## 2. Where they differ — and how this plan reconciles each

| Topic | Claude sweep | ChatGPT | Reconciled decision |
|---|---|---|---|
| Operations Command Center (search/views/timelines/queues) | Mostly not surfaced (kills removed timeline/360 as already-built) | Ranked #1 "build first" | **Mostly already built.** Net-new = **saved views** only. Demote to a small polish item. |
| Double-entry general ledger | High-value *big bet* | "Do **not** pursue a full double-entry engine" | **Defer / likely skip.** Build the *proof + reconciliation* layer instead (and that largely exists). Revisit a true ledger only if financial statements become a hard requirement after real billing. |
| Inventory valuation (FIFO/avg) | High-value big bet | Folded into "Inventory Proof Layer" | **Defer** until after the first real billing cycle; cost columns exist but no true engine. De-risk by building the negative-stock guard as a tested pure function first. |
| CRM sales pipeline (opportunity board) | High-value big bet (loudest CRM gap) | Under-weighted (Twenty section = search/views, not pipeline) | **Keep as a distinct strategic build.** It's a named gap and genuinely missing. |
| Lab/soil-test capture | Ranked #1 near-term (low risk, no external dep) | Embedded in "Field Foundation" | **Deferred ~a few months** (Mason, 2026-06-19) — revisit then. |
| Prompt-pay discount; duplicate-customer detection | Near-term #3/#6 | Not mentioned | **Dropped** (Mason, 2026-06-19). |
| Weather context | Field-intel idea | #10 weather-aware planning | **Partly present** — FieldDashboard already shows weather on application history. Net-new = *forward-looking* planning advisories. |

---

## 3. THE UNIFIED LONG-TERM PLAN

Four waves. Each item: **what · why · risk · depends-on · source.** "Already-have" notes prevent rebuilding shipped features. Anything touching money, inventory, compliance, or live schema is **design-first** (plain-English model + Mason's OK before any migration).

> **Revised 2026-06-19 (Mason):** dropped prompt-pay discount + duplicate-customer detection; deferred lab/soil-test capture ~a few months; removed lot/batch/expiry traceability + application-time compliance gate from Wave C. Wave D remains deferred as-is.

### Wave A — Now (small, isolated, low-risk; ship one at a time)
| Item | What | Risk | Source |
|---|---|---|---|
| **A1. Saved views / saved filters** | The one genuinely-missing piece of ChatGPT's "Command Center" — let users save filtered list views. Everything else in #1 (global search, timelines, related panels) already exists. | Low | ChatGPT #1 residual |
| **A2. Compliance document vault** | Typed store (Supabase Storage) for SDS, applicator licenses, dealer permits, insurance certs, with 30/60/90-day expiry alerts. Reuse the existing applicator-license expiry alerting. | Low | Both |

### Wave B — Next (the keystone; design-first, then build)
| Item | What | Risk | Depends-on | Source |
|---|---|---|---|---|
| **B1. Application & Evidence Record (deepen)** | Turn the thin `application_records` into the audit-grade canonical record: lot #, application method, rate + unit, area treated, % field treated, explicit **planned → done** status, normalized rate (= qty ÷ area), immutable completion + audit trail. Weather snapshot + field geometry are *partly present* via FieldDashboard. **DESIGN THE PLAIN-ENGLISH MODEL FIRST, reconciled with the in-flight `feat/as-applied-invoices` branch and `docs/plans/2026-06-14-spray-compliance-data-model.md` — do not fork them.** | **High** | coordinate w/ as-applied-invoices | **Both (strongest agreement)** |
| **B2. Product label + lot model** | Per-product REI/PHI/signal_word + restricted-use flags; physical lots/expiry separate from the catalog. The *schema* is buildable now; **populating label data (0/604 products today) is an owner task.** Feeds B1, compliance, and valuation. | Med (schema) / owner (data) | — | Both |

> **B1 design inputs + start gate (Mason, 2026-06-22):** **WAIT** to start B1 until `feat/as-applied-invoices` lands (still in progress) — don't design or build against a moving target. Confirmed **essential** fields: *field + acres actually treated · product + rate + lot · applicator + equipment + time window.* Weather snapshot / photos / signature = optional, not essential for v1. **Lot is tracked on paper today (not in CRX)** → B1/B2 must bring lot capture into the system (net-new behavior). Keep B1 on its own branch, clear of the invoice files the other session is editing.

> **Deferred ~a few months (Mason, 2026-06-19):** **Lab/soil-test capture** — soil/tissue/water test results per field (test header + analyte rows), no paid service. Low-risk and feeds blend recommendations + the future portal. Revisit in a few months.

### Wave C — Later (money/inventory discipline; gate on the first real billing cycle)
> The *invariant dashboard* half of ChatGPT's "Inventory Proof Layer" already exists (`/integrity-report`). These are the missing halves.
| Item | What | Risk | Source |
|---|---|---|---|
| **C1. Perpetual inventory valuation (FIFO/avg)** | True cost-per-movement engine feeding honest margin. **Defer** until real billing data exists; build the negative-stock guard as a tested pure function first (17 negative-inventory products are an open owner count). | High | Claude / ChatGPT |
| **C2. Payment-reconciliation workbench** | Polish on the existing `/payments` + integrity check: faster matching of checks/payments to invoices, cleanup of unallocated AR. | Med-High | ChatGPT #7 |
| ~~Full double-entry ledger~~ | Both lean **defer/skip.** Revisit only if formal financial statements become required after real billing. | — | reconciled |

> **Removed from Wave C (Mason, 2026-06-19):** lot/batch/expiry traceability; application-time compliance gate.

### Wave D — Someday (each its own strategic project)
| Item | What | Depends-on | Source |
|---|---|---|---|
| **D1. CRM sales pipeline** | Opportunity board (stages, probability, expected close, weighted forecast) feeding the existing quote flow. Stages = admin-editable config, not a CHECK enum. | — | Claude big-bet |
| **D2. Compliance packet generator** | Assemble label/SDS/WPS + delivery proof + photos + weather + usage into a single PDF. | B1 + B3 | Both |
| **D3. Grower self-service portal** | Greenfield customer-facing layer (fields, lab results, what-was-applied, documents). Build once B1/B2/B3/A4 content exists. | B1/B2/B3/A4 | Both (umbrella) |
| **D4. Weather-aware forward planning** | Advisory wind/rain/forecast badges on delivery & application planning (not approval logic). Weather already shown on history. | — | ChatGPT #10 |
| **D5. Satellite field-health (NDVI)** | Per-date NDVI summaries per field via a hosted imagery API. Heaviest; needs a paid API + a season of pulls. Do last. NDVI formulas are MIT (FarmVibes). | — | Claude big-bet |
| **D6. Limited offline field capture** | Non-money evidence (notes/photos/signatures/completion) with a sync queue. Completes the known offline-replay gap. **Never** money/inventory offline. | — | Both |

---

## 4. Cross-cutting guardrails (both analyses agree — apply to every item)
- Money stays **bigint cents**; inventory math stays in **Postgres RPCs/triggers**; every mutating RPC is **idempotent**.
- **RLS + strict-actor + role-gated pages** stay mandatory; delivery/invoice lifecycles cannot be bypassed.
- **Design-first** (plain-English model + owner OK) for anything touching money, inventory, compliance, or live schema.
- **Don't rebuild what exists** (global search, activity timelines, Customer 360, integrity dashboards, work queues, crop program, team notes).
- **Ideas/patterns only** from copyleft repos; FarmVibes (MIT) is the lone code-borrowable source, verified per-file.

## 5. Recommended first step
**Write the plain-English domain model for B1 (Application & Evidence Record), explicitly reconciled with the `feat/as-applied-invoices` work already in flight and the existing spray-compliance spec.** It's design-only (zero code risk), it's the keystone both analyses independently put at the top, and reconciling it *now* prevents the in-flight invoice work from forking. If you want a shippable win in parallel, **A1 (saved views)** or **A2 (compliance document vault)** are the smallest self-contained ones.

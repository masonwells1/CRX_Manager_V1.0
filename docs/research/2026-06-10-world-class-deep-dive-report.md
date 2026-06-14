# World-Class Deep Dive — CRX Manager
**Date:** 2026-06-10 · **Scope:** Full product + design + architecture strategic review (read-only — no code/DB changes)
**Method:** 5 parallel investigations — codebase reality scan, architecture readiness, competitor research, precision-ag/compliance research, payments/AI research — followed by an adversarial filter. Every claim about the current app cites file/doc; every market claim carries a URL (accessed 2026-06-10). Vendor-published statistics are labeled as such.
**Companion:** the commissioning prompt is `docs/research/2026-06-10-world-class-product-deep-dive-prompt.md`.

---

## 1. Executive Summary (plain English)

CRX Manager is, today, an unusually well-built **internal operations system** — the financial plumbing (money in cents, append-only audit log, idempotent operations, row-level security on all 96 tables) is genuinely better engineering than what the big incumbents run on. That discipline is the moat's foundation. But the app is **invisible to the customer**: farmers get PDFs by email, mail paper checks, and have no way to see their balance, approve a quote, or pay online. Meanwhile, a grower portal with online payment has quietly become **table stakes** — Agvance's Grower360, FieldAlytics Engage, and AgVend all ship one, and the adoption data says growers use them.

**The five moves that matter most:**

1. **Let customers pay you online (ACH pay-now links → grower portal).** ACH on a $50,000 invoice costs **$5** (Stripe caps ACH at $5/transaction). Industry claims of 13–30+ day DSO reduction from digital payments are vendor marketing, but directionally credible. Start with a pay-now link on the emailed invoice/statement — no portal needed — then grow into a portal with statements, quote approval, and autopay. This is the single biggest gap versus every competitor.
2. **Turn compliance from a register into an autopilot.** Compliance is the app's weakest area (2.5/5) but the data to fix it is already captured: auto-draft dicamba 72-hour records, WPS pre-application sheets, RUP buyer-certification checks at the point of sale, REI/PHI countdowns per field, license-expiry warnings that block dispatch. No incumbent does this well for small retailers; for an ag-chem retailer it converts regulatory risk into a sales pitch.
3. **Bill from the machine, not from paper.** Today billing starts with OCR'd paper blend tickets and manually typed weather. The open-source ADAPT/ISOXML toolkit parses as-applied monitor files for free, and the Leaf API wraps John Deere/FieldView/CNH behind one integration. "Auto-invoice from as-applied data" exists only at enterprise scale (FieldAlytics→Merchant Ag) — **nobody serves small retailers**. This is the category-defining bet.
4. **Expand the AI you already have.** The blend-ticket OCR pipeline is the proven pattern; pointing LLM extraction at **vendor bills and price sheets** costs under a penny per document and is the best-evidenced AI ROI in vertical SaaS right now. Skip demand forecasting and autonomous agents — that's demo-ware at this scale.
5. **Show field-level profitability.** CRX already stores both halves — input costs and application revenue per field — and no one assembles them. "Margin per acre, per field, per customer" is a report incumbents can't easily match and a reason for a retailer to choose CRX.

**And one deliberate non-move:** do **not** chase multi-tenancy (selling CRX to other retailers) yet. It's a 3–4 week schema retrofit that competes with everything above. Design the portal's data model so it doesn't *preclude* tenancy later, and revisit after the portal + compliance bets prove out.

---

## 2. Honest Scorecard — the app as it actually is

Ratings 1–5 from the code-level scan (citations in §9 of the scan notes; key ones inline).

| Area | Completeness | Verdict |
|---|---|---|
| **Sell** (quotes→orders, programs, rebates) | **4 / 5** | Polished: multi-line quotes with tier pricing, PDF + auto-email, holds, conversions. Friction: 3 hard-coded price tiers (`src/types/index.ts:49-57`), no per-customer contract pricing, season hard-coded Oct 1–Sep 30. |
| **Fulfill** (deliveries, jobs, dispatch, blend tickets) | **3 / 5** | Lifecycle enforcement is excellent (two-step delivery, item locks via DB trigger). Friction: driver flow runs through a 2,430-line `DeliveryDetail.tsx` with no mobile-first layout; weather typed by hand (`JobDetail.tsx:55-68`); no machine data. |
| **Bill** (invoices, AR, prepay, month-end, commissions) | **3.5 / 5** | Deep and financially rigorous (period close, finance charges, prepay workspace, credit memos). Friction: check-entry only — zero electronic payment capability (0 grep hits for stripe/ACH/card); crop-share splits are per-invoice arithmetic from `field_billing_defaults`, grouped only by `invoice_group_id`. |
| **Operate** (inventory, POs, receiving, cycle counts) | **3 / 5** | Immutable inventory ledger, net-free calc, reorder alerts all solid. Friction: no vendor price-sheet ingestion, no demand planning, AP bills typed by hand. |
| **Comply** (licenses, RUP register) | **2.5 / 5** | License expiry tracking + RUP sales register CSV exist (`src/pages/Compliance.tsx`). Missing: REI/PHI, label-rate validation, SDS storage, buyer-cert validation at sale, state report generation. **Weakest area; highest strategic upside.** |
| **Analyze** (dashboards, 14+ reports) | **3.5 / 5** | Strong internal reporting (AR aging, sales by rep/product/customer, financial dashboard). Missing: field-level profitability, cash-flow forecast, owner's daily brief; reports are full-scan RPCs with no pre-aggregation. |

**Already world-class — protect, don't bulldoze:** bigint-cents money everywhere; append-only `financial_audit_log` with old/new row snapshots; idempotency on every mutating RPC; RLS on all 96 tables with strict-actor auth (hardened through the June 2026 audit cycle); the OCR intake pipeline; the integrity report/cleanup dashboards; the machine-readable RPC error-token system (`src/lib/db.ts`) — which is, incidentally, a perfect substrate for an AI layer.

**Corrections to the team's own mental model found during the scan:** the app **is** a PWA — VitePWA + Workbox service worker with precaching and an IndexedDB offline action queue with conflict detection (`vite.config.ts:23-85`, `src/lib/offlineQueue.ts`, `src/lib/offlineSync.ts`). CLAUDE.md's "offline support is minimal" undersells it. What's missing is offline *reads* (pages still spinner-and-fail without a connection), not offline *writes*.

---

## 3. Market Map — who we're up against and where the opening is

*(Full citations in the research appendix, §8. All accessed 2026-06-10.)*

- **SSI Agvance** — the volume leader; full suite + Grower360 portal (statements, ACH/card pay, budget billing, surcharging). Decades-old desktop core with a cloud layer bolted on; quote-only pricing; review sentiment includes "the energy and accounting modules are klunking and they don't care" (softwareconnect.com). **Opening: legacy UX + indifference to small accounts.**
- **EFC / Ever.Ag (Merchant Ag + FieldAlytics)** — the agronomy-depth benchmark; 2,000+ retail locations; work orders + as-applied layers flow into the ERP for invoicing. Two products stitched together; enterprise-oriented. **Opening: integration seams; nothing for small independents.**
- **AgWorks AgOS** — operations/blending specialist (mix-plant integration, SmartGun in-field capture) but **not an accounting system** — pairs with someone else's ERP. **Opening: CRX's integrated blending-to-AR is exactly what AgOS users still lack.**
- **Levridge** — modern cloud ERP on Microsoft Dynamics; built and priced for co-ops/large retailers. **Opening: overkill below enterprise scale.**
- **Greenstone AGRIS / AgVantage / AgTrax** — grain-heritage legacy systems with aging customer bases and slow integrations per reviews. **Opening: weak fit for a chemical/application-first retailer.**
- **Modern challengers** — Traction Ag (farm accounting, published pricing from ~$950/yr, 4.9★ Capterra) and FarmQA (scouting/Rx, $800/yr base) prove transparent pricing + fast support beats legacy in small-ag. **Bushel** powers 3,500+ facilities with ag-native payments and reports ~13-day DSO reduction (vendor-claimed). **AgVend** (portal-as-a-service) reports 60–72% grower activation at some retailers (vendor-claimed).
- **Niche applicator tools** (Chem-Man, AgTerra SprayLogger, SprayMapper) — spray records + billing, but no real AR/GL/inventory depth.

**Synthesis:** the market is a barbell — legacy module-stacks for co-ops on one end, thin field-record tools on the other. CRX sits in an underserved middle: a **single-codebase, custom-application-first system that owns blend ticket → field job → invoice → commission end-to-end**. The incumbents' table stakes CRX lacks: a grower portal with online payment. The differentiators CRX already has that nobody markets: OCR intake, financial-integrity engineering, integrity dashboards.

---

## 4. Opportunity Backlog

Scoring: **Impact** 1–5 (revenue/cash-flow + daily-pain weighted) · **Effort** S/M/L/XL grounded in this codebase · **Class** = table-stakes / parity / differentiator / category-defining. Riskiest assumption + cheap test per item. Grouped by theme; IDs are stable for roadmap reference.

### A. Get paid online (portal + payments)

| ID | Opportunity | Impact | Effort | Class |
|---|---|---|---|---|
| **A1** | **ACH pay-now links on emailed invoices/statements.** Stripe ACH = 0.8% capped at $5 ([stripe support](https://support.stripe.com/questions/ach-direct-debit-pricing)); link in the existing `send-email` flow; webhook Edge Function records payment via a new RPC into the existing `allocation_sets` machinery. No portal required. | 5 | M | table-stakes |
| **A2** | **Grower portal v1** — login, balance, statements, invoice PDFs, payment history. Requires prework P1 (customer-org model) + P3 (server-side PDFs). | 5 | L | table-stakes |
| **A3** | **Online quote approval / e-sign** in the portal — quote status flows already exist (`sent → accepted`); none of the incumbent portals surfaced this in research [UNVERIFIED absence]. | 4 | M | differentiator |
| **A4** | **Autopay + scheduled payments** (statement-balance ACH on a chosen day). | 3 | M | parity |
| **A5** | **Card tender with Level 3 data + 3% surcharge** (legal in IL; debit may not be surcharged; Visa 3% cap). Secondary to ACH. | 2 | M | parity |
| **A6** | **Financing as a tender/terms type** — enroll as John Deere Financial Multi-Use merchant (9,000+ locations accept it) and/or a Rabo retailer program; surface terms on quotes. Record-keeping integration, not an API build. | 3 | S | parity |

- A1 riskiest assumption: farmers will click a payment link. Cheap test: add the link for 10 friendly customers for one statement cycle; count clicks before building anything else.
- A2 riskiest assumption: portal adoption at single-retailer scale. Cheap test: A1's click-through data IS the test.

### B. Compliance autopilot (weakest area → differentiator)

| ID | Opportunity | Impact | Effort | Class |
|---|---|---|---|---|
| **B1** | **RUP point-of-sale certification check** — IL requires per-sale records incl. purchaser cert number (8 Ill. Adm. Code 250.150); validate cert number + expiry on customer record when an invoice contains `is_rup` products; warn/block. Data model barely changes. | 4 | S | differentiator |
| **B2** | **Dicamba 72-hour record auto-draft** — EPA re-approved OTT dicamba for 2026–27 with label-mandated records within 72 hours; CRX already has applicator, product, rate, date, field polygon. Generate the record from the application record; applicator confirms buffer/survey items. | 4 | M | differentiator |
| **B3** | **WPS pre-application info sheet** — 40 CFR 170 requires giving the farm operator location, product, EPA reg no., REI before/at application; auto-generate from the job and email it via the existing pipeline. | 3 | S | differentiator |
| **B4** | **REI/PHI tracking per field** — add REI/PHI to products; show countdown on FieldDashboard; warn at dispatch when a field is inside an REI window. | 4 | M | differentiator |
| **B5** | **License-expiry gates** — applicator license data already exists (`Compliance.tsx:95-102`); block/warn job assignment when the applicator's license is expired; renewal reminders (IL: 3-yr term, Dec 31 expiry). | 3 | S | parity |
| **B6** | **State dealer report pack** — Wisconsin requires an annual dealer report (Oct 30, Excel format); Illinois requires records on demand; generate both from existing invoice + RUP data. | 3 | S | differentiator |
| **B7** | **Label-rate validation at blend/order time** — requires licensed structured label data (CDMS/Greenbook — commercial negotiation; EPA PPLS API is free but unstructured PDFs). The flagship compliance feature, but data-licensing-gated. | 4 | L | category-defining |
| **B8** | **SDS library** — attach SDS PDFs to products (storage bucket exists as a pattern); auto-include in delivery/job packets. | 2 | S | parity |

- B-track riskiest assumption: Mason's actual exposure/audit pain justifies the work. Cheap test: one conversation with the IDOA inspector relationship + count of RUP invoices last season (query exists today).
- B7 riskiest assumption: label-data licensing is affordable for one retailer. Cheap test: pricing inquiry to CDMS/Greenbook before any design.

### C. Bill from the machine (precision-ag ingestion)

| ID | Opportunity | Impact | Effort | Class |
|---|---|---|---|---|
| **C1** | **ISOXML/ADAPT as-applied file upload** — open-source ADAPT ISOv4Plugin parses monitor files with zero OEM gatekeeping; upload → match to job/field by boundary + date → propose application record with *actual* acres/rates. Reuses the OCR pipeline's review-queue pattern (`needs_review` lane). | 5 | L | category-defining |
| **C2** | **Leaf API integration** — one paid API wraps John Deere, FieldView, CNH, AgLeader, Slingshot ([withleaf.io](https://withleaf.io/)); automatic pull replaces the file upload. Sequenced after C1 proves the reconciliation logic. | 4 | L | category-defining |
| **C3** | **As-applied vs. billed reconciliation report** — "you applied 212 ac, you billed 200 ac" — revenue recovery, the easiest ROI story in the whole backlog once C1 exists. | 4 | S (after C1) | differentiator |
| **C4** | **Weather auto-capture** — replace hand-typed wind/temp/humidity with an hourly-weather API lookup at the field centroid + application time; applicator confirms instead of types. | 3 | S | parity |

- C1 riskiest assumption: Mason's applicators/growers run monitors that export ISOXML, and files can be obtained. Cheap test: collect 3 real monitor files from this season and hand-parse them before writing any code.

### D. AI layer (build on the proven pattern, skip the hype)

| ID | Opportunity | Impact | Effort | Class |
|---|---|---|---|---|
| **D1** | **Vendor-bill LLM extraction** — point the `process-document` pipeline at AP: extract vendor, lines, totals into a draft vendor bill for review. Best-evidenced AI ROI in vertical SaaS (Ramp: 15–20 min → <3 min per invoice, vendor-published); cost <$0.01/doc on Haiku-class models with batch + prompt caching. | 4 | M | differentiator |
| **D2** | **Vendor price-sheet ingestion** — extract season price sheets into proposed product-cost updates (review-queue, never auto-apply). Kills the most error-prone manual data entry in Operate. | 3 | M | differentiator |
| **D3** | **NL read-only analytics** — "ask your numbers" over the existing report RPC layer; the machine-readable error tokens + consistent jsonb returns make the RPC layer unusually agent-ready. Read-only RPCs only, by construction. | 3 | M | parity |
| **D4** | **AR follow-up drafting + ledger anomaly watch** — draft (never send) reminder emails ranked by aging; flag unusual `financial_audit_log` patterns. | 2 | S | parity |

- D1 riskiest assumption: extraction accuracy on Mason's actual vendor bills. Cheap test: run 10 real bills through a Claude extraction prompt by hand and count corrections.

### E. Field operations & UX

| ID | Opportunity | Impact | Effort | Class |
|---|---|---|---|---|
| **E1** | **Driver/applicator mobile workspace** — refactor the 2,430-line `DeliveryDetail.tsx` into a task-first mobile flow (today's stops → arrive → items → sign → photo → done); the PWA + offline queue already exist, the UI is what's office-shaped. | 4 | L | parity |
| **E2** | **Role-centric information architecture** — 66 flat pages is itself a finding; consolidate into role workspaces (Sell / Field / Money / Stock) with the Dashboard as a true command center. Sequenced behind features — IA churn without new capability is cost without revenue. | 3 | L | parity |
| **E3** | **Owner's daily brief** — one auto-generated morning summary (cash position, AR movement, today's jobs/deliveries, exceptions from integrity checks, license/REI warnings). All queries exist; this is assembly. | 4 | S | differentiator |
| **E4** | **Field-level profitability** — input cost per acre (job_chemicals cost) vs. application + product revenue per acre (invoices) per field/season. Both halves already in the schema; nobody assembles them. | 4 | M | differentiator |
| **E5** | **Pricing flexibility** — per-customer contract price overrides beyond the 3 hard-coded tiers (`tier1/2/3_price`); prerequisite for competing on bigger accounts. | 3 | M | parity |
| **E6** | **Offline reads for field pages** — cache today's deliveries/jobs locally so pages render offline (writes already queue). | 2 | M | parity |

### F. Platform (mostly: not yet)

| ID | Opportunity | Impact | Effort | Class |
|---|---|---|---|---|
| **F1** | **Customer-organization model** (prework P1) — `customer_organizations` + member junction so a farm can have multiple logins; gates RLS on membership. Unlocks A2 and keeps the multi-tenant door open without paying for it now. | enabler | M | — |
| **F2** | **Integration/webhook framework** (prework P4) — one `integrations` + `integration_events` pattern with HMAC verification before the *second* external integration exists, so Stripe/Leaf/weather don't become three bespoke patterns. | enabler | M | — |
| **F3** | **Multi-tenant SaaS** — deferred. No `tenant_id` anywhere, global invoice sequences, single-row settings; a 3–4 week retrofit minimum. Revisit only after the portal + compliance bets demonstrate a sellable product. | — | XL | deferred |
| **F4** | **GL/accountant export** — not a QuickBooks two-way sync; a clean period-close journal export (CSV/IIF) the accountant can import. CRX stays the ledger of record. | 2 | S | parity |

---

## 5. Three-Horizon Roadmap

### H1 — This season (≤3 months): cash + compliance quick wins
Compounds on what exists; nothing here requires new architecture beyond one webhook Edge Function.
1. **A1** ACH pay-now links (+ Stripe webhook receiver, built per the F2 pattern from day one)
2. **B1 + B5** RUP cert check at sale + license-expiry gates
3. **B3 + B6** WPS info sheets + state report pack
4. **E3** Owner's daily brief
5. **D1** Vendor-bill extraction pilot (10-bill manual test → ship if accuracy holds)
6. **C4** Weather auto-capture
7. Cheap tests that gate H2: collect 3 ISOXML files (C1), CDMS/Greenbook pricing inquiry (B7), A1 click-through data (A2)

### H2 — This year: the two strategic bets
1. **The Grower Portal** (A2 → A3 → A4): prework P1 (customer-org model) + P3 (server-side PDFs) first, then statements/balance/pay, then quote approval — the likely industry-first — then autopay. Marketing claim: "your customers can see and pay everything online."
2. **Machine-data billing v1** (C1 → C3): ISOXML upload + reconciliation report. Marketing claim: "bill every acre you actually applied."
3. Supporting: **B2 + B4** (dicamba records, REI/PHI) to complete the compliance story; **E4** field profitability; **D2** price-sheet ingestion; **E1** driver mobile workspace.

### H3 — Multi-year: the end-state that's hard to copy
- **C2** Leaf integration: applications flow from the machine into draft invoices automatically — paper and OCR become the fallback, not the path.
- **B7** Label-rate validation at blend time: the compliance engine becomes preventive, not archival.
- **E2** Role-workspace IA redesign, informed by portal + mobile usage data.
- **F3** Multi-tenancy decision point: by now CRX either is or isn't demonstrably better than Agvance for small retailers; if yes, the tenancy retrofit is a funded business decision, not a speculative one.
- **The defensible end-state:** the only system where *machine as-applied data, compliance records, and the customer's invoice are the same record* — incumbents would need to merge two products to copy it; niche tools would need to build an AR/GL.

---

## 6. Keep / Change / Kill — verdicts on today's assumptions

| Assumption | Verdict | Reasoning |
|---|---|---|
| Single-tenant, single-company | **KEEP (for now)** | Multi-tenancy is a 3–4 week retrofit with zero revenue until there's a second customer; but adopt the customer-org model (F1) so the door stays open. |
| Web-only PWA, no native app | **KEEP** | The PWA + offline-write queue already exist and work; the gap is UI shape (E1) and offline reads (E6), not a native app. |
| Checks-only payments | **KILL** | Capped-fee ACH makes electronic payment nearly free at CRX ticket sizes; this is the highest-leverage single change in the backlog. |
| No customer-facing surface | **KILL** | Portals are table stakes across every credible competitor; CRX's RLS discipline makes it *safer* to build than for most. |
| CRX **is** the ledger (no accounting integration) | **KEEP** | Its financial engineering is the moat. Provide an accountant export (F4); do not chase two-way QuickBooks sync. |
| OCR-centric intake | **CHANGE** | Keep OCR as the universal fallback; add machine-data ingestion (C1/C2) above it and manual-entry below it. |
| Hard-coded 3 price tiers / Oct–Sep season | **CHANGE (when touched)** | Not urgent, but E5 (contract pricing) should land before chasing larger accounts; make season config a table when a non-Oct fiscal need actually appears. |
| Compliance as a passive register | **KILL** | The B-track converts the weakest area into a differentiator using data already captured. |

---

## 7. Architecture Prework (before the H2 features, to avoid rewrites)

From the readiness assessment — each cited to current code:

1. **P1 — Customer-organization model.** Customers are pure data rows (`customers` table, no auth link); roles are internal-only (`AuthContext.tsx`); customer RLS is deliberately lower-bound-only (CLAUDE.md P2 #3). Add `customer_organizations` + `customer_organization_members`, gate portal RLS on membership — one farm, many logins. ~1 migration cluster + org-switcher UI. **Blocks A2.**
2. **P2 — Payment webhook receiver + recording RPC.** Zero gateway infrastructure exists today; one Stripe-webhook Edge Function (HMAC-verified, idempotent — the patterns already exist in `send-email`) + one `record_external_payment` RPC into `allocation_sets`. **Blocks A1.** Build it as the first instance of the F2 integration pattern.
3. **P3 — Server-side PDF generation.** All 10 PDF modules are client-side jsPDF (`src/lib/*Pdf.ts`); a portal can't depend on the office bundle. One `generate-pdf` Edge Function + a `customer-documents` bucket with signed URLs. **Blocks A2.**
4. **P4 — Integration framework** (`integrations`, `integration_events`, HMAC + retry conventions) — adopt at the *second* external integration (Leaf or weather), so patterns don't fragment.
5. **P5 — Materialized views for portal-facing reports.** Statements/AR currently full-scan per call (fine for 5 staff; not for N customers refreshing dashboards). Pre-aggregate `mv_customer_statement_lines` / `mv_ar_by_customer`, refresh nightly. Needed at portal launch, not before.

Explicitly **not** prework: multi-tenancy (F3), offline-first reads (E6), realtime expansion — none of the H1/H2 bets require them.

---

## 8. What NOT to Build (and why)

1. **Native iOS/Android apps** — the PWA covers field use; a native build doubles maintenance for a 5-person company with zero distribution upside.
2. **Multi-tenant SaaS now** — see F3; a speculative 3–4 week schema retrofit before the product story is proven is the classic premature-platform mistake.
3. **ML demand forecasting** — one season = one data point per SKU-season; classical reorder points + an agronomist's judgment beat a model at this scale. (Research verdict: hype-leaning at small scale.)
4. **Autonomous AI agents touching financial records** — the evidence supports AI that *drafts* for human review (D1/D2/D4); auto-acting agents on a ledger contradict the strict-actor/audit discipline that is the app's core asset.
5. **Two-way QuickBooks/GL sync** — CRX is the ledger; a sync invites the reconciliation hell the integrity dashboards were built to prevent. Export only (F4).
6. **Grain, energy, feed, or seed-treatment modules** — that's competing with Agvance on its home turf; CRX wins by being application-first, not module-complete.
7. **Custom telematics hardware / direct OEM agreements as a first step** — ADAPT files and Leaf exist precisely so a small ISV doesn't negotiate with Deere first.
8. **A big-bang UI redesign** — E2 ships *after* portal + mobile usage data exists; redesigning 66 pages on intuition is cost without information.

---

## 9. Source Appendix (key citations)

**Codebase (all verified in-repo 2026-06-10):** roles/routes `src/App.tsx:167-236`; no payment processors (zero grep hits for stripe/plaid/ach/card in `src/`); PWA `vite.config.ts:23-85`; offline queue `src/lib/offlineQueue.ts`, `src/lib/offlineSync.ts`; compliance depth `src/pages/Compliance.tsx`; weather manual entry `src/pages/JobDetail.tsx:55-68`; splits `field_billing_defaults` (migration `20260213000000`), `derive_customer_shares_from_fields` (`FieldApplicationInvoice.tsx:176`); tiers `src/types/index.ts:49-57`; client-side PDFs `src/lib/*Pdf.ts`; customer-RLS lower bound CLAUDE.md (P2 #3); email pipeline `supabase/functions/send-email/index.ts`.

**Market (all accessed 2026-06-10; vendor-published stats labeled):**
Grower360 payments — helpcenter.agvance.net/home/grower360-payments · Agvance reviews — softwareconnect.com/reviews/agvance-accounting · FieldAlytics — ever.ag/agribusiness/fieldalytics; help.fieldalytics.com/article/764 · AgWorks — agworks.net/agos · Levridge — levridge.com/industries/ag-retailers · AgVend adoption (vendor) — agvend.com/blog/driving-real-adoption-results · Bushel scale + DSO (vendor) — bushelpowered.com · Traction pricing — tractionag.com/pricing-and-plans · FarmQA pricing — farmqa.com/pricing.

**Precision-ag & compliance:** Deere Field Ops API — developer.deere.com/dev-docs/field-operations · Slingshot ISV — developer.ravenslingshot.com · FieldView partner — dev.fieldview.com/faq · ADAPT — aggateway.org; github.com/adapt · Leaf — withleaf.io · IL RUP dealer records — law.cornell.edu (8 Ill. Adm. Code 250.150); agr.illinois.gov · WI annual dealer report — datcp.wi.gov · IN — oisc.purdue.edu · MO — agriculture.mo.gov · USDA rescission (2025-05) — extension.illinois.edu pesticide-news · WPS — ecfr.gov 40 CFR 170 · Dicamba 2026–27 OTT — epa.gov dicamba page; oisc.purdue.edu 72-hr quick guide · IL commercial license — extension.illinois.edu/psep · EPA PPLS API — epa.gov/pesticide-labels · Label data — cdms.net; npic.orst.edu.

**Payments & AI:** Stripe ACH 0.8% / $5 cap — support.stripe.com · Melio — meliopayments.com/pricing · Level 3 — finix.com; ebizcharge.com · IL surcharge legality / Visa 3% cap — allaypay.com; staxpayments.com · IL IFPA enjoined/delayed to 2027-07-01 — occ.gov Bulletin 2026-17; consumerfinancemonitor.com (2026-06-04) · JDF Multi-Use — deere.com/en/finance · Rabo — raboag.com · DSO claims (vendor) — versapay.com · Ramp LLM extraction — ramp.com/blog; zenml.io/llmops-database · Invoice-LLM benchmark — research.aimultiple.com/invoice-ocr · Intuit NL analytics — quickbooks.intuit.com/intuit-intelligence · Claude API pricing — platform.claude.com/docs/en/about-claude/pricing.

**Adversarial-filter notes:** (1) One inter-agent conflict resolved: the architecture scan reported "no service worker," but the code scan cited the VitePWA/Workbox config at `vite.config.ts:23-85` with configuration detail — the PWA exists; the architecture scan's offline-*reads* gap stands. (2) All DSO/adoption figures (Bushel 13-day, AgVend 60–72%, Versapay 30%) are vendor marketing — treated as directional only and gated behind the A1 cheap test. (3) "No incumbent portal offers quote approval" and "no product auto-invoices from as-applied for small retailers" are absence-of-evidence claims, labeled [UNVERIFIED] where they appear. (4) Generic-SaaS ideas (chatbots, generic CRM features, social/community features) were generated and killed in filtering — they don't survive the "grounded in this codebase or this market" test.

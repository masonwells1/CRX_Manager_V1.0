# Future Projects Open-Source Comparison

Date: 2026-06-19  
Branch: `codex/future-projects-research`  
Scope: read-only research for CRX Manager improvement ideas

## Bottom Line

The best value from ERPNext, Twenty, FarmVibes.AI, Ekylibre, LiteFarm, and farmOS is not code reuse. It is a set of proven product patterns CRX can rebuild in its own React, TypeScript, Supabase/Postgres, Tailwind, and Vercel stack.

Recommended first build: a CRX-native **Operations Command Center** made of global search, saved operational views, unified activity timelines, and related-record panels. It gives Mason and the team faster daily navigation without touching money, inventory math, or live schema-heavy workflows first.

Recommended second build: a CRX **Application and Evidence Record** model. This should connect fields, jobs, delivered products, people, weather snapshots, photos, documents, labels/SDS, WPS notices, and PDFs. It is higher risk because it touches compliance, field geometry, inventory, and customer-facing records, so it should start as a plain-English domain model before any migration.

## Important License Rule

Several target projects use GPL or AGPL-family licenses. For this report, treat them as idea sources only unless a separate legal/license review approves direct reuse.

| Project | License Signal | Code Reuse Posture |
| --- | --- | --- |
| ERPNext | GPL-3.0 | Pattern only; do not copy code |
| Twenty | AGPL-3.0 plus enterprise carve-out | Pattern only; do not copy code |
| FarmVibes.AI | Root MIT, but package metadata and model resources need caution | Ideas only until legal review |
| Ekylibre | AGPL-3.0 | Pattern only; do not copy code |
| LiteFarm | GPL-3.0 | Pattern only; do not copy code |
| farmOS | GPL-2.0-or-later core; separate farmOS-map is MIT | Core pattern only; farmOS-map could be reviewed separately |

## CRX Baseline

CRX Manager is a React 18, TypeScript, Vite, Tailwind CSS, Supabase/Postgres, and Vercel app for an agricultural chemical distributor. It has mature modules for customers, quotes, orders, deliveries, jobs, invoices, payments, inventory, purchase orders, commissions, blend tickets, maps, PDFs, role permissions, and live production workflows.

The comparison should respect these CRX constraints:

- Money stays in bigint cents.
- Inventory math stays in Postgres RPCs/triggers.
- Mutating RPCs need idempotency.
- Supabase Row Level Security, strict actor checks, and role-gated pages remain mandatory.
- Delivery and invoice lifecycles cannot be bypassed.
- CRX uses one Supabase client, shared TypeScript types, Tailwind, and Lucide icons.
- Offline work should start with non-money evidence capture, not invoices, payments, commissions, or inventory mutations.

CRX source anchors inspected by the baseline agent included `CLAUDE.md`, `docs/reference/pages-routes.md`, `docs/reference/database-schema.md`, `docs/reference/rpc-functions.md`, `src/App.tsx`, `src/lib/db.ts`, `src/components/auth/ProtectedRoute.tsx`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md`, `docs/workflows/INVENTORY_RULES.md`, `docs/workflows/QUOTE_TO_DELIVERY.md`, `src/lib/offlineQueue.ts`, and `src/pages/FieldStop.tsx`.

## Ranked CRX Opportunity Backlog

| Rank | Opportunity | Best Sources | Why It Matters | Difficulty | Risk | Recommended Posture |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | Operations Command Center: global search, saved views, activity timelines, related-record widgets | Twenty, ERPNext | Faster navigation across customers, orders, deliveries, invoices, products, jobs, maps, PDFs, and AR queues | Medium | Medium | Build first; mostly frontend plus permission-safe read APIs |
| 2 | Application and Evidence Record | Ekylibre, LiteFarm, farmOS, FarmVibes.AI | Turns jobs/deliveries into complete field records with products, people, fields, photos, weather, docs, and PDFs | High | High | Design first; no migration until domain model is approved |
| 3 | Inventory Proof Layer | ERPNext, farmOS, Ekylibre | Adds ledger-vs-snapshot checks, lot/batch/expiry traceability, and safer inventory adjustment workflows | High | High | Plan as audited DB work; run live read-only checks first |
| 4 | Field and Location Foundation | LiteFarm, Ekylibre, farmOS, FarmVibes.AI | Makes field boundaries, delivery sites, and application geometry first-class data instead of loose map decoration | Medium-high | Medium-high | Start with optional field/location records and imports |
| 5 | Compliance Packet Generator | LiteFarm, Ekylibre, FarmVibes.AI | Assembles labels/SDS, WPS notices, delivery proof, photos, product usage, weather, and application PDFs | High | High | Pattern only; regulatory wording needs careful review |
| 6 | Operational Work Queues | ERPNext, Twenty | "To bill", "to receive", "jobs this week", "overdue AR", "negative inventory", and stale-document queues prevent missed work | Medium | Medium | Good early win after saved views/search |
| 7 | Payment Reconciliation Workbench | ERPNext | Helps match checks/payments to invoices and clean up unallocated AR | Medium-high | High | Valuable after first real billing cycle |
| 8 | Limited Offline Field Capture | LiteFarm, farmOS | Lets drivers/applicators capture notes, photos, signatures, and completion evidence in weak rural signal | High | Medium-high | Start with non-money queued events only |
| 9 | Product Catalog, Lot, and Label Model | ERPNext, Ekylibre, LiteFarm | Separates product catalog data, vendor SKUs, physical lots, restricted-use flags, labels, and expiration | Medium-high | High | Good design candidate before chemical compliance work |
| 10 | Weather-Aware Job Planning | FarmVibes.AI, farmOS | Adds forecast/wind/rain context to delivery and application planning without claiming agronomic advice | Medium | Medium | Use as advisory badges, not hard approval logic |
| 11 | Async Processing Status | FarmVibes.AI | Shows queued/running/done/failed for OCR, PDFs, imports, reports, and map jobs | Medium | Medium | Add only around real long-running CRX workflows |
| 12 | Safer Import/Export Staging | farmOS, Ekylibre, LiteFarm | CSV/KML/GeoJSON staging and review would improve onboarding fields, products, and historical records | Medium | Medium-high | Use staged imports; never direct live bulk writes |

## Recommended First Three Projects

### 1. CRX Operations Command Center

Build a search-and-views layer across existing CRX data. This borrows from Twenty's command menu, saved views, record-index patterns, timelines, and related-record widgets, plus ERPNext's related-document dashboards.

Core pieces:

- Global search that respects role permissions.
- Saved views for operational queues.
- Unified activity timeline on customers, orders, deliveries, invoices, and products.
- Related-record panels such as customer -> quotes/orders/deliveries/invoices/payments/jobs and product -> inventory/PO/delivery history.

Why first: high daily usability, moderate difficulty, and much lower data risk than migrations that change money/inventory workflows.

### 2. CRX Application and Evidence Record

Design a CRX concept that captures application-style work without becoming a full farm management system. Ekylibre's intervention model is the strongest reference: target field, inputs/products, outputs, tools, people, working periods, maps, and compliance checks. LiteFarm and farmOS add task/document/offline/observation patterns. FarmVibes.AI adds weather and geometry context.

Core pieces:

- Target field/location and treated acres.
- Products, lots, rates, and quantities used.
- Driver/applicator/doer, equipment, and time window.
- Weather snapshot and optional field geometry.
- Photos, signatures, SDS/label/WPS documents, and generated PDF evidence.
- Audit trail and immutable completion record.

Why second: it fits CRX's real agricultural workflow, but it is compliance-sensitive and should be designed carefully before schema or UI work.

### 3. Inventory and Billing Control Pack

ERPNext's strongest lesson is operational accounting discipline: ledger comparisons, separate delivery/billing/payment status, "to bill" and "to receive" work queues, payment reconciliation, and batch/lot traceability.

Core pieces:

- Inventory ledger invariant dashboard.
- Delivery/billing/payment status clarity.
- "Delivered but not billed", "received but not vendor-billed", and "requested but not ordered" queues.
- Lot/batch/expiry traceability for chemicals.
- Payment allocation/reconciliation review.

Why third: this targets money and inventory accuracy, but it needs the strictest CRX verification because those are high-risk domains.

## Project Findings

### ERPNext

Repo: `frappe/erpnext`  
Stack: Python/Frappe Framework plus JavaScript/TypeScript frontend assets  
License: GPL-3.0  
Usefulness to CRX: very high for ERP, inventory, accounting, sales, purchasing, work queues, and document relationships.

Best ideas:

- Inventory ledger invariant checks.
- Financial close and ledger comparison reports.
- Separate delivery, billing, and payment status fields.
- "To bill", "to receive", and "to order" work queues.
- Payment reconciliation workbench.
- Batch/lot/expiry traceability.
- Procurement pipeline before PO.
- Pricing rules beyond simple customer tiers.
- Related-document panels on detail pages.
- Commission analytics by sales allocation.

Source anchors:

- [ERPNext README](https://github.com/frappe/erpnext)
- [ERPNext license](https://github.com/frappe/erpnext/blob/develop/license.txt)
- [Stock ledger code](https://github.com/frappe/erpnext/tree/develop/erpnext/stock)
- [Accounts code](https://github.com/frappe/erpnext/tree/develop/erpnext/accounts)
- [Selling code](https://github.com/frappe/erpnext/tree/develop/erpnext/selling)
- [Buying code](https://github.com/frappe/erpnext/tree/develop/erpnext/buying)

Do not pursue:

- Full Frappe/DocType migration.
- Full double-entry accounting engine.
- Manufacturing/MRP, HR/payroll, healthcare, education, nonprofit, or regional tax packs.
- Any permissive negative-stock behavior.

### Twenty

Repo: `twentyhq/twenty`  
Stack: TypeScript monorepo, Nx, NestJS, PostgreSQL, Redis, BullMQ, React, Jotai, Linaria, Lingui  
License: AGPL-3.0 signal plus enterprise carve-out  
Usefulness to CRX: very high for CRM UX and operational navigation.

Best ideas:

- Global search and command launcher.
- Saved operational views across table/board/calendar-style layouts.
- Unified per-record activity timeline.
- Related-record widgets.
- Searchable-object metadata.
- Views/config "as code" for repeatable defaults.
- Permission-scoped AI assistant actions as a future read-only assistant pattern.

Source anchors:

- [Twenty README](https://github.com/twentyhq/twenty)
- [Twenty license](https://github.com/twentyhq/twenty/blob/main/LICENSE)
- [Object metadata entity](https://github.com/twentyhq/twenty/blob/main/packages/twenty-server/src/engine/metadata-modules/object-metadata/object-metadata.entity.ts)
- [View entity](https://github.com/twentyhq/twenty/blob/main/packages/twenty-server/src/engine/metadata-modules/view/entities/view.entity.ts)
- [Record index container](https://github.com/twentyhq/twenty/blob/main/packages/twenty-front/src/modules/object-record/record-index/components/RecordIndexContainer.tsx)
- [Search service](https://github.com/twentyhq/twenty/blob/main/packages/twenty-server/src/engine/core-modules/search/services/search.service.ts)
- [Timeline card](https://github.com/twentyhq/twenty/blob/main/packages/twenty-front/src/modules/activities/timeline-activities/components/TimelineCard.tsx)

Do not pursue:

- Migrating CRX to NestJS, GraphQL, Redis, BullMQ, or Nx just to mimic Twenty.
- Making CRX money, inventory, delivery, invoice, payment, or status logic custom-object driven.
- Adopting Twenty's UI stack.
- AI mutation tools before hard approval gates, audit logs, and role checks.

### FarmVibes.AI

Repo: `microsoft/farmvibes-ai`  
Stack: Python, notebooks, FastAPI, Kubernetes/Docker local cluster, Dapr/gRPC, Terraform/Azure, geospatial and ML libraries  
License: root MIT, but package metadata/model-resource concerns mean legal review before reuse  
Usefulness to CRX: medium-high for agriculture maps, weather, field geometry, async runs, and cache patterns; low for direct platform adoption.

Best ideas:

- Weather-aware delivery/job planning.
- Field boundaries as GeoJSON with time-window filters.
- Async analysis-run table for OCR, PDFs, reports, imports, and map jobs.
- Cache expensive field/time/weather calculations.
- Job completion evidence packet with weather, field boundary, photos, products, signer, and PDF export.
- Prescription/sample/shape import as attachments.

Source anchors:

- [FarmVibes.AI README](https://github.com/microsoft/farmvibes-ai)
- [FarmVibes.AI license](https://github.com/microsoft/farmvibes-ai/blob/main/LICENSE)
- [Workflow docs](https://github.com/microsoft/farmvibes-ai/blob/main/docs/source/docfiles/markdown/WORKFLOWS.md)
- [Workflow list](https://github.com/microsoft/farmvibes-ai/blob/main/docs/source/docfiles/markdown/WORKFLOW_LIST.md)
- [Cache docs](https://github.com/microsoft/farmvibes-ai/blob/main/docs/source/docfiles/markdown/CACHE.md)
- [Weather forecast workflow](https://github.com/microsoft/farmvibes-ai/blob/main/workflows/data_ingestion/weather/get_forecast.yaml)
- [Geometry ingest workflow](https://github.com/microsoft/farmvibes-ai/blob/main/workflows/data_ingestion/user_data/ingest_geometry.yaml)

Do not pursue:

- Installing FarmVibes.AI inside CRX/Vercel/Supabase.
- Porting Dapr, Redis/RabbitMQ, Terraform, or worker-pod architecture.
- Training or serving satellite/segmentation/irrigation/weed models from CRX.
- Customer-facing agronomic recommendations without agronomist/legal review.

### Ekylibre

Repo: `ekylibre/ekylibre`  
Stack: Ruby on Rails, PostgreSQL/PostGIS, Haml/CoffeeScript, Leaflet, Sidekiq  
License: AGPL-3.0  
Usefulness to CRX: very high for agricultural application/intervention modeling.

Best ideas:

- Model application work as an intervention with targets, inputs, outputs, tools, doers, and working periods.
- Field-level geometry as first-class data.
- Separate product catalog/variant from physical tracked product/lot.
- Treat input consumption as traceable inventory movement.
- Compliance checks around target field, product usage, and application history.
- Map views combining field shapes, application paths, popups, and layer controls.
- Field detail pages as operational hubs.
- Campaign/season concepts for crop-year reporting.
- Intervention cost breakdowns by inputs, labor, tools, and services.
- Import/export exchangers for agricultural interoperability.

Source anchors:

- [Ekylibre README](https://github.com/ekylibre/ekylibre)
- [Ekylibre license](https://github.com/ekylibre/ekylibre/blob/main/LICENSE)
- [Intervention model](https://github.com/ekylibre/ekylibre/blob/main/app/models/intervention.rb)
- [Interventions API controller](https://github.com/ekylibre/ekylibre/blob/main/app/controllers/api/v2/interventions_controller.rb)
- [Cultivable zone model](https://github.com/ekylibre/ekylibre/blob/main/app/models/cultivable_zone.rb)
- [Product nature variant model](https://github.com/ekylibre/ekylibre/blob/main/app/models/product_nature_variant.rb)
- [Intervention input model](https://github.com/ekylibre/ekylibre/blob/main/app/models/intervention_input.rb)

Do not pursue:

- Rails/Haml/CoffeeScript platform adoption.
- French accounting/FEC, CAP/cadastral, French phyto integrations.
- Livestock/vineyard production scope.
- Jasper/ODF report stack.
- Becoming a full farm-owner ERP.

### LiteFarm

Repo: `LiteFarmOrg/LiteFarm`  
Stack: React 18 + Vite + TypeScript/JavaScript webapp, Redux/Saga/RTK Query, MUI, Google Maps, TerraDraw, SurveyJS, Workbox PWA; Node/Express + Knex/Objection + Postgres API  
License: GPL-3.0  
Usefulness to CRX: high for field/task/document/compliance UX.

Best ideas:

- Map-first job/location records with typed geometry.
- Location detail tabs for details, tasks, crops/activity, and related work.
- Task lifecycle with assign, due date, complete, abandon, and read-only audit view.
- Compliance export packets assembled from tasks, products, documents, and dates.
- Product inventory tied to task usage and compliance flags.
- Attach documents directly to tasks/jobs.
- Mobile-friendly completion forms with a "changes needed" step.
- Offline readiness plus limited retry queue.
- Survey-driven data capture with saved progress and prefill.
- Granular permission seed tables.

Source anchors:

- [LiteFarm README](https://github.com/LiteFarmOrg/LiteFarm)
- [LiteFarm license](https://github.com/LiteFarmOrg/LiteFarm/blob/integration/LICENSE)
- [Webapp package](https://github.com/LiteFarmOrg/LiteFarm/blob/integration/packages/webapp/package.json)
- [API package](https://github.com/LiteFarmOrg/LiteFarm/blob/integration/packages/api/package.json)
- [Map container](https://github.com/LiteFarmOrg/LiteFarm/blob/integration/packages/webapp/src/containers/Map/index.jsx)
- [Task page](https://github.com/LiteFarmOrg/LiteFarm/blob/integration/packages/webapp/src/containers/Task/index.jsx)
- [Documents page](https://github.com/LiteFarmOrg/LiteFarm/blob/integration/packages/webapp/src/containers/Documents/index.jsx)
- [Product inventory](https://github.com/LiteFarmOrg/LiteFarm/blob/integration/packages/webapp/src/containers/ProductInventory/index.tsx)

Do not pursue:

- Express/Knex/Objection backend migration.
- Redux-Saga architecture.
- Organic-certification-specific forms as-is.
- Livestock or market-directory modules.
- Broad offline mutation queue, especially for money/inventory.

### farmOS

Repo: `farmos/farmos`  
Stack: Drupal/PHP, Composer modules, JSON:API, OAuth2, GIS libraries, OpenLayers via farmOS-map  
License: GPL-2.0-or-later core; separate farmOS-map is MIT  
Usefulness to CRX: high for asset/log thinking, maps, inventory quantities, quick forms, import/export, and offline companion ideas.

Best ideas:

- Separate "managed thing" from "event record": assets vs logs.
- Operational observations with photos, files, and flags.
- Field polygons and job geometry import/draw/edit.
- Inventory adjustment ledger with reset/increment/decrement events.
- Quick forms for field staff.
- Offline companion pattern with local IDs and explicit sync.
- Feature/capability toggles.
- Managed permission bundles.
- API discoverability/schema docs.
- Safer import/export batches.

Source anchors:

- [farmOS README](https://github.com/farmOS/farmOS)
- [farmOS license](https://github.com/farmOS/farmOS/blob/4.x/LICENSE.txt)
- [farmOS composer.json](https://github.com/farmOS/farmOS/blob/4.x/composer.json)
- [Asset model docs](https://github.com/farmOS/farmOS/blob/4.x/docs/model/type/asset.md)
- [Log model docs](https://github.com/farmOS/farmOS/blob/4.x/docs/model/type/log.md)
- [Inventory logic docs](https://github.com/farmOS/farmOS/blob/4.x/docs/model/logic/inventory.md)
- [Mapping guide](https://github.com/farmOS/farmOS/blob/4.x/docs/guide/mapping.md)
- [Quick forms guide](https://github.com/farmOS/farmOS/blob/4.x/docs/guide/quick.md)
- [farmOS Field Kit](https://github.com/farmOS/field-kit)
- [farmOS-map](https://github.com/farmOS/farmOS-map)

Do not pursue:

- Rebuilding CRX as Drupal.
- Copying farmOS's whole crop/livestock model.
- Offline invoices, payments, commissions, or AR.
- Sensor/data streams unless there is a real paid workflow.
- Full plugin marketplace.

## Ideas To Avoid Across All Repos

- Do not copy GPL/AGPL code into CRX without legal review.
- Do not migrate CRX away from React, TypeScript, Vite, Tailwind, Supabase/Postgres, and Vercel because another project uses a different platform.
- Do not make money, inventory, delivery, invoice, payment, or status logic user-customizable.
- Do not start with broad offline mutation support. Start with evidence capture and idempotent non-money updates.
- Do not introduce AI actions that mutate data until role checks, audit logs, human approval, and rollback behavior are proven.
- Do not build a full farm-owner ERP. CRX serves an agricultural chemical distributor, so the useful scope is sales, inventory, delivery, field application evidence, compliance, and customer operations.

## Recommended Next Step

Write a short design spec for the **CRX Operations Command Center**:

1. Global search and command launcher.
2. Saved operational views.
3. Unified activity timeline.
4. Related-record panels on key detail pages.

This is the best first project because it improves daily usability while staying mostly read-oriented. It also creates the navigation and activity foundation that later application records, inventory queues, compliance packets, and offline field evidence can plug into.

After that spec, create a separate plain-English domain model for **Application and Evidence Records** before touching schema.

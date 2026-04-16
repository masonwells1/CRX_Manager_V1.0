# CRX Manager V1.0 - Project Details

## What It Is
A business management system for **Crop RX Solutions**, an agricultural product distributor selling crop protection chemicals, fertilizers, etc. to farmers. It handles the full business cycle: quoting, ordering, delivering, invoicing, paying, and reporting.

## Additional Libraries (not listed in CLAUDE.md)
- **Maps:** Mapbox GL JS + react-map-gl (satellite imagery, field polygon drawing)
- **PDF:** jsPDF + jspdf-autotable (client-side generation)
- **OCR:** Google Vision AI via Supabase Edge Function + Tesseract.js fallback
- **Other:** signature_pad v5, proj4 (coordinate reprojection)

## User Roles
| Role | What They Do |
|------|-------------|
| **Admin** | Everything — products, costs, inventory, POs, commissions, month-end close, settings, user management |
| **Sales Rep** | Quotes, orders, deliveries, jobs, invoices, blend tickets, own customers/fields |
| **Driver** | Assigned deliveries, confirm/complete with signature/photos, quick deliveries, issue reporting |
| **Applicator** | Assigned jobs, record applied info (weather, gallons), view customers/products/fields/recipes |

## Feature Map (63 pages as of 2026-04-09)

### Core Business
- **Customers** — Farm accounts, tiered pricing (1-4), addresses, credit limits, finance charges, season summary, bulk import
- **Products** — Product catalog, 3-tier pricing, EPA registration, RUP status, signal words, unit conversions, cost history, bulk import
- **Quotes** — Multi-section builder, tiered pricing, commission splits, margin calcs, PDF generation, versioning, convert to order
- **Orders** — From quote or direct, line-item management, fulfillment tracking, credit limit alerts

### Fulfillment
- **Deliveries** — Driver assignment, two-step confirm->complete flow, signatures, photos, GPS, partial delivery remainders, quick delivery, batch cancel
- **Receiving** — PO receiving with per-item condition/lot/notes, receiving dashboard, quick receive, photo attachments
- **Inventory** — Real-time stock levels, low stock alerts, holds, adjustments, warehouse tracking, cycle counts with variance
- **Purchase Orders** — Vendor PO creation, two-step receive modal, receiving history, auto-cost update
- **DispatchBoard** — Driver/delivery dispatch management and scheduling view

### Financial
- **Invoices** — Auto-generate from deliveries, 3 PDF layouts, batch print/void, write-offs, post/unpost
- **Payments** — Unified allocation across invoices, prepay credits, auto-apply oldest-first
- **AR & Finance** — Aging buckets (current/30/60/90+), finance charges, statements, period close, commission posting
- **Month-End Close** — Period locking, batch statements, checklist
- **FieldApplicationInvoice** — Invoice generation directly from field application service records

### Field & Application
- **Fields** — Mapbox satellite maps, polygon draw tools, bulk import (shapefile/KML/GeoJSON)
- **FieldDashboard** — Field-centric view of customers, crops, application history
- **FieldSetup** — Multi-polygon field grouping, boundary drawing, crop assignment
- **ApplicationServices** — Application service records linked to jobs/blend tickets
- **ApplicationServiceDetail** — Detail view for individual application service records
- **ProgramTracker** — Seasonal crop program completion tracking per customer/field

### Operations
- **Jobs** — Application scheduling, applicator/vehicle assignment, recipe loading, complete->application record, transfer to invoice
- **Blend Tickets** — OCR upload (Google Vision AI), manual creation, product extraction, approve/reject/batch operations
- **Recipes** — Reusable blend recipe templates, product ratios, create job from recipe
- **Vehicles** — Ground/air equipment, capacity, registration, FAA/DOT numbers

### Reporting & Compliance
- **Reports** — 14 reports: 4 logbook variants, P&L, gross sales, customer balance, commission, chemical history, inventory cost, year-end summary
- **Compliance** — Applicator license tracking, RUP product flags, expiry alerts
- **Application Records** — Chemical application history from jobs + blend tickets

### Team & Admin
- **Team Board** — Kanban: notes/todos/announcements, comments, real-time updates
- **Notifications** — In-app notification center
- **GettingStarted** — Onboarding checklist page for new users
- **Settings** — OCR thresholds, app-wide config, user management

### Other
- **Returns** — RMA workflow (request->approve->receive->credit), restocking
- **Brand vs Generic** — Ingredient mapping
- **Crop Programs** — Seasonal crop program management
- **Rebates** — Manufacturer rebate claims

## Scripts
```bash
npm run dev          # Dev server (localhost:5173)
npm run build        # Production build
npx vitest run       # Unit tests
npm run typecheck    # TypeScript check
npm run lint         # ESLint
npm run test:e2e     # Playwright E2E tests
npm run test:e2e:ui  # Interactive Playwright UI
```

## Test User
- Email: mason@croprxsolutions.com
- See tests/e2e/utils/auth.ts for credentials

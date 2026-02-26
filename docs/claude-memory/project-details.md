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

## Feature Map (49 pages)

### Core Business
- **Customers** — Farm accounts, tiered pricing (1-4), addresses, credit limits, finance charges, season summary, bulk import
- **Products** — 598+ product catalog, 3-tier pricing, EPA registration, RUP status, signal words, unit conversions, cost history, bulk import
- **Quotes** — Multi-section builder, tiered pricing, commission splits, margin calcs, PDF generation, versioning, convert to order
- **Orders** — From quote or direct, line-item management, fulfillment tracking, credit limit alerts

### Fulfillment
- **Deliveries** — Driver assignment, two-step confirm->complete flow, signatures, photos (10 max), GPS, partial delivery remainders, quick delivery (atomic order+delivery+invoice), batch cancel, driver dashboard
- **Receiving** — PO receiving with per-item condition/lot/notes, receiving dashboard with summary cards, quick receive (auto-match to oldest POs), photo attachments
- **Inventory** — Real-time stock levels, low stock alerts, holds, adjustments, warehouse tracking, cycle counts with variance
- **Purchase Orders** — Vendor PO creation, two-step receive modal, receiving history, auto-cost update

### Financial
- **Invoices** — Auto-generate from deliveries, 3 PDF layouts, batch print/void, write-offs, post/unpost
- **Payments** — Check recording, unified allocation across invoices, prepay credits, auto-apply
- **AR & Finance** — Aging buckets (current/30/60/90+), finance charges, statements, period close, commission posting, transaction review
- **Month-End Close** — Period locking, batch statements, checklist

### Operations
- **Jobs** — Application scheduling, applicator/vehicle assignment, recipe loading, complete->application record, transfer to invoice
- **Blend Tickets** — OCR upload (Google Vision AI), manual creation, product extraction, approve/reject
- **Recipes** — Reusable blend recipe templates, product ratios, create job from recipe
- **Vehicles** — Ground/air equipment, capacity, registration, FAA/DOT numbers
- **Fields** — Mapbox satellite maps, polygon draw tools, bulk import (shapefile/KML/GeoJSON)

### Reporting & Compliance
- **Reports** — 14 reports: 4 logbook variants, P&L, gross sales, customer balance, commission, chemical history, inventory cost, year-end summary
- **Compliance** — Applicator license tracking, RUP product flags, expiry alerts
- **Application Records** — Chemical application history from jobs + blend tickets

### Other
- **Returns** — RMA workflow (request->approve->receive->credit), restocking
- **Team Board** — Kanban: notes/todos/announcements, comments, real-time updates
- **Notifications** — In-app notification center
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

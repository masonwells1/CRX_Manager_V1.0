# CRX Manager V1.0

Business management system for **Crop RX Solutions**, an agricultural chemical distributor. Manages the full order-to-cash workflow: customer management, 3-tier product pricing, quote building, order fulfillment, delivery scheduling with GPS & digital signatures, inventory tracking, purchase orders, blend ticket OCR, invoicing, payments, AR aging, commission tracking, field mapping, compliance, and reporting.

## Tech Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS
- **Backend:** Supabase (PostgreSQL, Auth, Storage, Realtime, Edge Functions)
- **Maps:** Mapbox GL JS + react-map-gl (satellite field mapping with draw tools)
- **Testing:** Vitest (unit) + Playwright (E2E)
- **Deployment:** Vercel → [croprxsolutions.app](https://croprxsolutions.app)
- **Other:** jsPDF (PDF generation), Google Vision AI (OCR), proj4/shpjs/@tmcw/togeojson (GIS import), Sentry (error tracking), Lucide React (icons)

## Quick Start

### Prerequisites
- Node.js 18+
- Supabase project with migrations applied
- Mapbox account (free tier) for satellite field maps
- Git

### Setup

```bash
git clone https://github.com/masonwells1/CRX_Manager_V1.0.git
cd CRX_Manager_V1.0
npm install
cp .env.example .env
# Edit .env with your Supabase URL, anon key, and Mapbox token
npm run dev
```

Open http://localhost:5173 in your browser.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anonymous/public key |
| `VITE_MAPBOX_TOKEN` | Mapbox public access token (for field maps) |
| `VITE_SENTRY_DSN` | Sentry DSN for error tracking (optional) |

All variables must start with `VITE_` to be accessible in the app. See `.env.example`.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server (port 5173) |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build locally |
| `npm test` | Run the full unit-test suite |
| `npm run test:watch` | Run unit tests in watch mode |
| `npm run typecheck` | Check TypeScript errors |
| `npm run lint` | Run ESLint |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run test:e2e:ui` | Interactive Playwright test UI |

> **Note:** Pre-commit runs fast checks for the files staged in the commit, plus the repository's safety and workflow-parity guards. Pre-push runs private-artifact containment, TypeScript, and the production build. CI is the full-product-proof gate: it runs lint, type checking, unit coverage, the production build, and the applicable safety checks before merge.

## User Roles

| Role | Access |
|------|--------|
| **admin** | Full access to everything |
| **sales_rep** | Own assigned customers, quotes, orders, products (read-only) |
| **driver** | Own assigned deliveries, customer addresses (read-only) |
| **applicator** | Own assigned jobs, application records, products/fields (read-only) |

## Features

### Core Business
- **Customers** — Master list, tiered pricing, addresses, farm fields, purchase history
- **Products** — Catalog with 3-tier pricing, EPA registration, unit conversions, cost history
- **Quotes** — Multi-section quote builder, margin calculations, PDF generation, convert to order
- **Orders** — Line-item management, fulfillment tracking, credit limit alerts, bulk import
- **Deliveries** — Driver assignment, signature capture, photo upload, GPS tracking, partial delivery support, offline capable
- **Receiving** — PO receipt with condition tracking (good/damaged/short), quick receive workflow

### Inventory & Purchasing
- **Inventory** — Real-time stock levels, low stock alerts, holds, adjustments, cycle counts
- **Purchase Orders** — Vendor PO creation, receiving workflow, condition recording
- **Returns** — RMA processing, restocking, credit memos

### Financial
- **Invoicing** — Auto-generate from deliveries, 3 layout modes, batch print, void/write-off
- **Payments** — Check recording, auto-allocation across invoices, prepay credits
- **AR Aging** — Aging buckets (current/30/60/90+), customer statements, finance charges
- **Commissions** — Split percentages, payment lifecycle, posting workflow
- **Month-End** — Period close checklist, batch statement generation, year-end summaries

### Field Operations
- **Field Mapping** — Mapbox satellite maps, polygon draw tools, bulk import (shapefile/KML/GeoJSON)
- **Jobs** — Application scheduling, applicator/vehicle assignment, recipe loading
- **Blend Tickets** — OCR upload via Google Vision AI, manual creation, order linkage
- **Recipes** — Tank mix templates with product ratios
- **Compliance** — Applicator license tracking, RUP product flags, expiry alerts

### Collaboration & Reporting
- **Team Board** — Notes, todos, announcements with tags and comments
- **Notifications** — Real-time via Supabase (low stock, expiring quotes, order status, etc.)
- **Reports** — Profitability, logbook, P&L, gross sales, commission balance, chemical history, price list, year-end
- **Bulk Import** — CSV import for customers, products, quotes, orders, POs, blend tickets
- **Offline Support** — IndexedDB queue for critical operations when disconnected

## Database

Production currently has 156 public base tables (+2 views), 440 callable function overloads across 432 names, and 129 trigger-function overloads. The repository contains 869 migration files, including local candidates that may not yet be live. Seven JWT-protected Edge Functions are active in production.

See the [database schema reference](./docs/reference/database-schema.md) for the table and RLS policy inventory, and the [RPC reference](./docs/reference/rpc-functions.md) for database functions.

## Deployment

Deployed to **Vercel** at [croprxsolutions.app](https://croprxsolutions.app). Configuration in `vercel.json` with security headers.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full deployment instructions, environment setup, and rollback procedures.

## Documentation

| File | Contents |
|------|----------|
| [AGENTS.md](./AGENTS.md) | Short shared contract and task-routing entry point for coding agents |
| [Agent onboarding](./docs/manual/AGENT_ONBOARDING.md) | First-session reading order, recurring failure modes, and verification expectations |
| [Architecture](./docs/manual/ARCHITECTURE.md) | System architecture, data flow, business logic, and code-location map |
| [Reference docs](./docs/reference/) | Current schema, RPC, route, pattern, and guardrail references |
| [TESTING.md](./TESTING.md) | Testing guide (beginner-friendly) — setup, running tests, troubleshooting |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Deployment instructions — Vercel setup, env vars, rollback |

## Current State

- **80 pages**, fully lazy-loaded across **88 routes**
- **323 unit-test files** + **94 E2E spec files** (pass totals come from the current test run)
- **156 live database tables** (+2 views), 440 callable function overloads, 869 migration files on disk
- **0 ESLint errors**, 0 TypeScript errors
- **Pre-commit hook** blocks commits if build or tests fail
- **Deployed to Vercel** at [croprxsolutions.app](https://croprxsolutions.app) (live)
- Security audit, codebase audit, all hardening sprints: **Complete**

## License

Private - All rights reserved

---

**Version:** 1.0
**Last Updated:** 2026-08-11

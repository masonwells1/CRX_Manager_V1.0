# CRX Manager V1.0

Business management system for **Crop RX Solutions**, an agricultural product distributor. Manages the full workflow from quoting to delivery: customer management, product catalog with 3-tier pricing, quote builder, order fulfillment, delivery scheduling with digital signatures, inventory tracking, purchase orders, blend tickets, team collaboration, and reporting.

## Tech Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS
- **Backend:** Supabase (PostgreSQL, Auth, Storage, Realtime, Edge Functions)
- **Testing:** Playwright (E2E)
- **Deployment:** Vercel
- **Other:** jsPDF, Tesseract.js, signature_pad, Lucide React

## Quick Start

### Prerequisites
- Node.js 18+
- Supabase project with migrations applied
- Git

### Setup

```bash
git clone https://github.com/masonwells1/CRX_Manager_V1.0.git
cd CRX_Manager_V1.0
npm install
cp .env.example .env
# Edit .env with your Supabase URL and anon key
npm run dev
```

Open http://localhost:5173 in your browser.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anonymous/public key |

All variables must start with `VITE_` to be accessible in the app. See `.env.example`.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server (port 5173) |
| `npm run build` | Build for production |
| `npm run preview` | Preview production build locally |
| `npm run typecheck` | Check TypeScript errors |
| `npm run lint` | Run ESLint |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run test:e2e:ui` | Interactive Playwright test UI |
| `npm run test:e2e:headed` | Watch tests run in browser |
| `npm run test:e2e:report` | View HTML test report |

## User Roles

| Role | Access |
|------|--------|
| **admin** | Full access to everything |
| **sales_rep** | Own assigned customers, quotes, orders, products (read-only) |
| **driver** | Own assigned deliveries, customer addresses (read-only) |

## Features

- Customer management with tiered pricing
- Product catalog (598+ products, 3-tier pricing, EPA registration)
- Quote builder with sections, margin calculations, PDF generation
- Order management with fulfillment tracking
- Delivery scheduling with driver assignment and digital signatures
- Inventory tracking with transaction audit trail
- Purchase orders to vendors
- Blend ticket system with OCR processing
- Team collaboration board (notes, todos, announcements)
- Real-time notifications via Supabase Realtime
- Bulk CSV import for customers, products, quotes, orders, blend tickets
- Brand vs generic product comparison
- Commission tracking with split percentages
- Reports and analytics with PDF export
- Offline support for critical operations
- Idempotency keys for critical writes

## Database

25 tables in Supabase PostgreSQL with Row Level Security (RLS) on all tables. See:
- `SCHEMA_QUICK_REFERENCE.sql` -- complete schema
- `DATABASE_RELATIONSHIPS.md` -- entity relationships
- `supabase/migrations/` -- all migration files

## Deployment

Deployed to **Vercel** (private staging). Configuration in `vercel.json`.

Build settings:
- **Framework:** Vite
- **Build command:** `npm run build`
- **Output directory:** `dist`

See [DEPLOYMENT.md](./DEPLOYMENT.md) for full instructions.

## Documentation

| File | Contents |
|------|----------|
| [CONTEXT.md](./CONTEXT.md) | Full business context, features, data model, assumptions |
| [CLAUDE.md](./CLAUDE.md) | Claude Code project instructions |
| [DATABASE_RELATIONSHIPS.md](./DATABASE_RELATIONSHIPS.md) | Entity relationship diagrams |
| [SCHEMA_QUICK_REFERENCE.sql](./SCHEMA_QUICK_REFERENCE.sql) | Complete SQL schema |
| [TESTING.md](./TESTING.md) | Testing guide (beginner-friendly) |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Deployment instructions |
| [VERIFICATION.md](./VERIFICATION.md) | Setup verification and known issues |
| [TEST_CHECKLIST.md](./TEST_CHECKLIST.md) | Pre-deployment checklist |

## Current State

- Security hardening (Tier 1-3): **Complete**
- Deployed to Vercel: **Yes** (private staging)
- Test coverage: **Minimal** (3 E2E test files)
- Next milestone: Comprehensive test coverage (T3-002)

## License

Private - All rights reserved

---

**Version:** 1.0
**Last Updated:** 2026-02-11

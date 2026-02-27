# CLAUDE.md - CRX Manager V1.0

## Project
- **Repo:** https://github.com/masonwells1/CRX_Manager_V1.0
- **Live:** https://croprxsolutions.app
- **Stack:** React 18, TypeScript, Vite, Tailwind CSS, Supabase, Vercel
- **Supabase ID:** rhyzpcqhnizqbxphqdkr
- **Owner:** masonwells1 (beginner — explain things simply)

## Session Start Checklist
At the start of each session, silently check if `docs/claude-memory/MEMORY.md` has a matching file at the Claude Code memory directory. If memory files appear to be missing (i.e., no MEMORY.md context was loaded), proactively tell the user:
> "It looks like your memory files aren't set up on this computer yet. Want me to copy them over? (Just say yes)"

To copy them: read each `.md` file (except README.md) from `docs/claude-memory/` and write it to the memory directory.

## Current State (2026-02-27)
- 49 pages, 72+ tables, ~110 RPCs, 80+ migrations
- 1,121 unit tests (80 files) + 424 E2E tests (370 passing, 42 pre-existing failures)
- 0 ESLint errors, 0 TypeScript errors, CI green
- Pre-commit hook: lint + build + vitest

---

## Architecture Rules
1. **Database changes MUST use migrations** — create files in `supabase/migrations/`, never modify tables directly
2. **All tables MUST have RLS policies** — no exceptions
3. **Use `checkMutationResult()`** after every `.update()` or `.delete()` call
4. **Lazy-load all pages** — follow the pattern in `App.tsx` with `lazy()` and `Suspense`
5. **Use Lucide React icons** — do not install other icon packages
6. **Tailwind CSS only** — brand color is `crx-green` (#28A26A)
7. **Keep types in `src/types/index.ts`** — all shared interfaces go there
8. **Use the Supabase client from `src/lib/db.ts`** — never create additional clients
9. **Activity logging:** Call `logActivity()` from `src/lib/activityLogger.ts` for important user actions
10. **Idempotency:** Use `generateIdempotencyKey()` for critical write operations

---

## Hard Red Lines — NEVER Break These

### Data Safety
- **NEVER delete or modify existing migration files** — only add new ones
- **NEVER remove RLS policies from any table** — every table must have RLS
- **NEVER expose `service_role` key in frontend code** — only use `anon` key in the browser
- **NEVER modify `financial_audit_log` records** — append-only by design
- **NEVER store money as floating point** — all money uses `bigint` cents. Display divides by 100.

### Business Logic
- **NEVER skip the delivery confirm->complete flow** — must go `scheduled -> in_progress -> completed`
- **NEVER allow editing delivery item quantities** — items locked to original order
- **NEVER create invoices without an order** — invoices always link to an order
- **NEVER bypass `check_period_open()`** — closed periods prevent backdated transactions
- **NEVER allow non-admin users to access month-end close, commissions, or settings**
- **Season runs July 1 to June 30** — all YTD calculations use this

### Code Quality
- **NEVER remove the pre-commit hook** — it runs lint + build + test
- **NEVER commit with `--no-verify`**
- **NEVER add `@ts-ignore` or `any` types** — only exception: `reportPdf.ts` columnStyles (has eslint-disable)
- **NEVER install additional CSS frameworks** (Tailwind only) or **icon libraries** (Lucide only)
- **NEVER create a second Supabase client**

### Deployment
- **NEVER commit `.env` files**
- **NEVER deploy without setting `ALLOWED_ORIGIN`** — Edge Functions will fail with CORS errors

---

## Business Logic Lifecycles

### Quote: `draft -> sent -> revised -> accepted -> declined -> expired`
- `is_planned` flag reserves inventory through holds (linked via `source_id`)
- Accepted quotes convert to orders via `convert_quote_to_order()` — holds released on accept
- Declined/expired quotes auto-release holds AND restore `quantity_available` via trigger

### Order: `confirmed -> partially_fulfilled -> fulfilled -> cancelled`
- AR derived from linked invoices (orders.total_paid / balance_due are deprecated)
- Commission records created per order per recipient

### Delivery: `scheduled -> in_progress -> completed -> cancelled`
- **Two-step flow:** `confirm_delivery()` then `complete_delivery()`
- Items locked to order quantities — only logistics editable
- Quick Delivery: `create_quick_delivery()` = atomic order + delivery + draft invoice; includes inventory pre-check with `FOR UPDATE` locks

### Invoice: `draft -> posted -> void`
- `post_invoice()` calls `check_period_open()` — rejects if accounting period is closed
- Posted invoices lock amounts and start AR aging
- `balance_cents` tracks remaining after payments/credits
- All changes logged to `financial_audit_log`

### Job: `scheduled -> in_progress -> completed -> cancelled -> invoiced`
- Completion creates application_record + deducts inventory
- Transfer to invoice via `transfer_job_to_invoice()`

### Purchase Order: `draft -> submitted -> partially_received -> fully_received -> cancelled`
- Receiving creates `receiving_records` with per-item condition/lot/notes
- Auto-updates product cost if PO unit_cost differs

### Return/RMA: `requested -> approved -> received -> credited -> rejected`

### Month-End Close
- `check_period_open()` prevents backdated transactions
- Closing runs checklist + batch statement generation

### Tier Pricing
- Customers assigned tier 1, 2, or 3
- Products have tier1_price, tier2_price, tier3_price
- Quotes inherit customer tier but can be overridden

### Inventory Calculations
- **Net Free** = quantity_available - planned holds - quantity_prebooked
- **On Order** = sum of (ordered - received) from open POs
- **Low Stock** = quantity_available <= reorder_point

### Commission Logic
- `commission_split` stored as JSONB: `{ splits: [{ recipient, percentage }] }`
- `save_customer()` validates splits sum to exactly 100% (server-side enforcement)
- Status: `pending -> paid` (with paid_date)

---

## Common Patterns

### Adding a new page
1. Create component in `src/pages/`
2. Add lazy import in `src/App.tsx`
3. Add Route inside the protected route block
4. Add nav link in `src/components/layout/AppLayout.tsx`

### Adding a database column
1. Create migration in `supabase/migrations/` with timestamp prefix
2. Update TypeScript interface in `src/types/index.ts`
3. Update affected components

### Supabase queries
```typescript
import { supabase, checkMutationResult } from '../lib/db';

// Read
const { data, error } = await supabase.from('customers').select('*');

// Write (always check result)
const result = await supabase.from('customers').update({ farm_name: 'New' }).eq('id', id).select();
checkMutationResult(result, 'Update customer');
```

### Migration best practices
- Name with timestamp prefix: `YYYYMMDDHHMMSS_description.sql`
- `DROP POLICY IF EXISTS` before `CREATE POLICY` for idempotency
- Check for existing triggers with `IF NOT EXISTS`

---

## Edge Functions (5 in `supabase/functions/`)
- **create-user** — Admin-only: creates auth user with role metadata
- **process-blend-ticket** — OCR via Google Vision AI (requires GOOGLE_VISION_API_KEY)
- **process-document** — Document processing
- **seed-admin** — One-time initial admin user creation
- **setup-blend-tickets-storage** — Returns storage bucket config

All require `ALLOWED_ORIGIN` env var for production CORS.

## Realtime Subscriptions
Hook: `useRealtimeSubscription({ table, event, filter, onInsert, onUpdate, onDelete, disabled })`
- `disabled?: boolean` — when true, skips channel creation (no-op). Convenience hooks pass `disabled: !noteId` to prevent null-filter subscriptions.
- Used for: `team_notes`, `team_note_comments`, `notifications`, `note_activity_log`

## Storage Buckets
- **blend-ticket-images** — Private, RLS-protected
- **delivery-photos** — Private, RLS-protected
- **receiving-photos** — Private, RLS-protected

---

## Key Entry Points
- `src/App.tsx` — Routes (lazy-loaded), auth provider
- `src/contexts/AuthContext.tsx` — Auth state (login, logout, role)
- `src/lib/db.ts` — Supabase client + `checkMutationResult()`
- `src/types/index.ts` — All TypeScript interfaces
- `src/lib/activityLogger.ts` — Activity feed + notifications
- `src/hooks/useRowSelection.tsx` — Bulk row selection (used on 15 pages)
- `supabase/migrations/` — Database migrations
- `supabase/functions/` — Edge Functions

---

## Known Limitations
- OCR requires GOOGLE_VISION_API_KEY secret in Edge Function
- PDF generation is client-side only
- No email sending (notifications are in-app only)
- Bulk imports process sequentially
- Offline support: built for driver delivery completion only, not full offline-first

---

## Documentation Maintenance (Fully Automatic)

### How It Works
A `PreToolUse` hook in `.claude/settings.json` fires automatically before every `git commit`.
If the commit includes structural changes (new pages, migrations, RPCs, etc.), Claude is **blocked from committing** until it:
1. Counts actual pages, migrations, and Edge Functions
2. Compares to what CLAUDE.md and reference docs say
3. Fixes any stale counts or missing entries
4. Includes the doc updates in the commit

**The user does not need to do anything.** This is fully hands-off.

### Optional: Manual Audit
Run `/update-docs` for a full audit anytime (not required — the commit hook handles it).

---

## Reference Docs (read when needed)

| Doc | Contents |
|-----|----------|
| `docs/reference/database-schema.md` | 72 tables + RLS policy matrix |
| `docs/reference/rpc-functions.md` | ~110 RPCs + helpers + triggers |
| `docs/reference/migration-history.md` | 80+ migration entries |
| `docs/reference/pages-routes.md` | 49 pages with routes |
| `docs/reference/code-patterns.md` | Number formats, UI patterns, build notes |
| `docs/reference/qa-testing.md` | Role matrix, workflow tests, edge cases |
| `docs/CHANGELOG.md` | Sprint-by-sprint history |
| `docs/E2E_FAILURES_TO_FIX.md` | 42 pre-existing E2E failures |
| `docs/plans/2026-02-23-price-list-versioning-design.md` | Future: price list versioning (NOT built) |

## Other Repo Docs
- `README.md` — Project overview, quick start
- `TESTING.md` — Testing guide (beginner-friendly)
- `DEPLOYMENT.md` — Vercel setup, env vars, Edge Function secrets

---

## Workflow Documentation

Detailed workflow guides and safety checklists are in `docs/workflows/`:

- `QUOTE_TO_DELIVERY.md` — Full business pipeline reference
- `INVENTORY_RULES.md` — Inventory calculations and transaction rules
- `DATABASE_CHANGE_CHECKLIST.md` — Step-by-step for any schema changes
- `RLS_SECURITY_GUIDE.md` — Row Level Security patterns and debugging
- `SAFE_DEVELOPMENT_RULES.md` — READ THIS EVERY SESSION — mandatory safety rules
- `UI_PATTERNS.md` — Frontend patterns and conventions

Copy-paste prompt templates for common tasks: `docs/PROMPT_TEMPLATES.md`

**At the start of every session, read `docs/workflows/SAFE_DEVELOPMENT_RULES.md` before making any changes.**

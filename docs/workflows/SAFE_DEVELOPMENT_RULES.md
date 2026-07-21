# Safe Development Rules

**READ THIS AT THE START OF EVERY SESSION.**

These are mandatory safety rules for anyone (human or AI) making changes to CRX Manager. Breaking these rules causes bugs, data loss, or security vulnerabilities.

---

## Before Making ANY Change

### 1. Read the context first
- Read `AGENTS.md` — the canonical contract (hard rules, approval gates, project facts). The hard red lines live there, not in `CLAUDE.md` (which is Claude-only routing).
- Read the relevant workflow doc in `docs/workflows/` for the area you're working on
- Read the source files you plan to change

### 2. Research before coding
- Search the codebase for existing patterns before writing new code
- Check if similar functionality already exists (there are many pages — see `docs/reference/pages-routes.md` for the current list — don't recreate one)
- Look at how the existing code handles the same type of operation

### 3. Plan before building
- Write a clear plan listing every file you'll create or modify
- For multi-file or risky work (data, money, security, production, migrations), show the plan to Mason and wait for approval before starting. **Tiny, obvious, reversible fixes may proceed directly** (per `AGENTS.md`) — don't make a ceremony of a typo fix.
- Break large changes into small, testable steps

---

## ALWAYS Do These Things

| Rule | Why |
|------|-----|
| Use `checkMutationResult()` after every `.update()` or `.delete()` | Catches silent RLS failures that return empty data with no error |
| Use `assertRpcResult()` after RPC calls | Catches RPCs that return null due to permission denial |
| Use `logActivity()` for important user actions | Feeds the activity timeline and keeps audit history |
| Use `generateIdempotencyKey()` for critical writes | Prevents double-submissions on order creation, delivery completion, payments |
| Create migration files for ALL database changes | Keeps the schema version-controlled and reproducible |
| Run `npm run typecheck` after changes | Catches type mismatches before they become runtime bugs |
| Run `npm run build` after changes | Catches import errors and compile failures |
| Update `src/types/index.ts` when database schema changes | Keeps TypeScript in sync with the database |
| Use `(select auth.uid())` in RLS policies (not bare `auth.uid()`) | Performance: evaluates once per query instead of once per row |
| Test as all roles (admin, sales_rep, driver) | Each role sees different data — bugs often hide in role-specific paths |

---

## NEVER Do These Things

### Data Safety
| Rule | Consequence of breaking |
|------|------------------------|
| NEVER delete or modify existing migration files | Migration won't re-apply; schema becomes inconsistent |
| NEVER remove RLS policies from any table | Data exposed to unauthorized users |
| NEVER expose `service_role` key in frontend code | Full database access to anyone with browser dev tools |
| NEVER modify `financial_audit_log` records | Destroys the immutable audit trail required for financial compliance |
| NEVER store money as floating point | Rounding errors in financial calculations. Use bigint cents. |

### Business Logic
| Rule | Consequence of breaking |
|------|------------------------|
| NEVER skip delivery confirm->complete flow | Must go scheduled -> in_progress -> completed. Skipping breaks inventory. |
| NEVER allow editing delivery items once in_progress or beyond | Items are only editable while status = 'scheduled'. Once started, items are locked. |
| NEVER create invoices without an order | Invoices always link to an order via order_id. |
| NEVER bypass `check_period_open()` | Closed periods prevent backdated transactions. Bypassing corrupts financials. |
| NEVER allow non-admin access to month-end, commissions, or settings | These are admin-only features. |
| NEVER skip a status transition step | Every lifecycle has defined transitions (see QUOTE_TO_DELIVERY.md). |

### Code Quality
| Rule | Consequence of breaking |
|------|------------------------|
| NEVER remove the pre-commit hook | Removes the safety net that catches errors before commits |
| NEVER commit with `--no-verify` | Bypasses lint + build + test checks and the ledger guard |
| NEVER commit agent-surface changes without a ledger update in the same commit | The pre-commit ledger guard (`scripts/check-ledger-update.mjs`, 2026-07-13) blocks commits that stage `.claude/{commands,skills,hooks,workflows,agents}/`, `.claude/settings.json`, `AGENTS.md`, `CLAUDE.md`, `.husky/`, or guard scripts with no `docs/CHANGELOG.md` / `docs/manual/*.md` / `docs/reference/agent-guardrails.md` / `docs/loops/` update — policy changes must leave a written record Mason can find |
| NEVER add `@ts-ignore` or `any` types | Hides bugs that TypeScript would catch |
| NEVER install additional CSS frameworks | Tailwind CSS only — other frameworks cause conflicts |
| NEVER install additional icon libraries | Lucide React only — keeps bundle size consistent |
| NEVER create a second Supabase client | Use `src/lib/db.ts` — multiple clients cause auth state issues |

### Deployment
| Rule | Consequence of breaking |
|------|------------------------|
| NEVER commit `.env` files | Exposes API keys and secrets publicly |
| NEVER deploy without `ALLOWED_ORIGIN` set | Edge Functions fail with CORS errors |

---


## Migration Safety (CRITICAL - Prevents Code Drift)

> **Context:** In March 2026, a single migration used pg_get_functiondef() + regex to dynamically clone 37 functions with an extra parameter. This created shadow overloads that froze old logic while newer migrations fixed the originals. Result: **40+ bugs** where bug fixes never reached production because PostgreSQL was calling the frozen copies. These rules prevent that from ever happening again.

### Before Writing ANY Migration

| Check | How | Why |
|-------|-----|-----|
| **Existing CHECK constraints** | Query pg_constraint for the table | If you rewrite a CHECK, you MUST include ALL existing values plus new ones |
| **Function overloads** | Query pg_proc for the function name | Must return exactly 1 row. If >1, consolidate before adding more |
| **Trigger function versions** | Search supabase/migrations/ for all versions | Read the LATEST version before rewriting - do not lose logic from earlier fixes |
| **Status column values** | Check CHECK constraint AND grep migrations for status strings | A function may write status values that are not in the CHECK yet |

### Migration Anti-Patterns (NEVER Do These)

| Anti-Pattern | What Goes Wrong | Do This Instead |
|-------------|-----------------|-----------------|
| pg_get_functiondef() + regex injection | Creates frozen shadow overloads | Write each function explicitly |
| Rewrite CHECK with only YOUR values | Removes values other functions rely on | Query existing values first, add yours to the list |
| CREATE OR REPLACE without checking overloads | Updates wrong overload; callers still hit old one | Check for overloads first, DROP all if >1, then CREATE |
| DROP FUNCTION without replacement | Deletes the only working version | Verify replacement exists BEFORE dropping |
| SECURITY DEFINER without SET search_path | Triggers fail when called from other SECURITY DEFINER functions | Always add SET search_path = public, pg_temp |
| Dynamic DO block modifying function source | Regex misses edge cases, creates untested code | Write functions explicitly |

### After Writing ANY Migration

Verify no overloads exist. Then: npm run build + npm run test

---

## Pipeline Change Safety

If you're changing anything in the quote -> order -> delivery -> invoice -> payment pipeline:

1. Read `docs/workflows/QUOTE_TO_DELIVERY.md` first
2. Identify all downstream stages that could be affected
3. Test the full pipeline end-to-end after your change
4. Verify inventory levels after delivery completion
5. Verify order status updates correctly
6. Verify invoice amounts match order totals

### Downstream impact reference:
| If you change... | Also check... |
|-----------------|--------------|
| Quote pricing | Order totals, invoice amounts, commission calculations |
| Order items | Delivery items (locked), invoice items, quantity_remaining |
| Delivery completion logic | Inventory levels, order fulfillment status, delivery remainders |
| Invoice posting | AR aging, payment allocation, finance charges |
| Payment recording | Order balance_due, invoice balance_cents, prepay credits |

---

## Database Change Safety

Before any schema change, follow `docs/workflows/DATABASE_CHANGE_CHECKLIST.md`:

1. Create a new migration file (never modify existing ones)
2. Include RLS policies for new tables
3. Make migrations idempotent (`IF NOT EXISTS`, `DROP ... IF EXISTS`)
4. **Read existing CHECK constraints and function overloads** (see Migration Safety above)
5. Update TypeScript types in `src/types/index.ts`
6. Update affected components
7. Run `npm run typecheck` and `npm run build`

### Fresh database rebuilds

- Keep every applied file in `supabase/migrations/` immutable; it remains the audit trail.
- Initialize a brand-new Supabase project from `supabase/baselines/manifest.json` in the exact listed order, then apply only migrations strictly newer than its high-water.
- Never clear or overwrite a non-empty migration ledger to force the baseline history restore; it is deliberately fail-closed.
- Run `npm run test:schema-baseline`, rebuild the schema registry from the target database, and run the DB invariant sweeps before treating the project as usable.
- The schema baseline contains no business data. Use the separately protected Supabase backup/restore path for disaster recovery.

---

## Money Handling

All money in CRX Manager is stored as **bigint cents** (whole numbers, no decimals).

| Operation | How |
|-----------|-----|
| Store $25.50 | Store as `2550` (bigint cents) |
| Display 2550 | Show as `$25.50` (divide by 100) |
| User enters $25.50 | Convert to `2550` before saving (multiply by 100) |
| Add $25.50 + $10.25 | Add `2550 + 1025 = 3575` (integer math) |

**NEVER use floating point for money.** No `parseFloat()`, no `0.1 + 0.2` problems.

---

## File Organization

| What | Where |
|------|-------|
| Pages | `src/pages/` |
| Shared components | `src/components/ui/` |
| Auth components | `src/components/auth/` |
| Layout components | `src/components/layout/` |
| Domain components | `src/components/{domain}/` (e.g., `deliveries/`, `blendtickets/`) |
| TypeScript types | `src/types/index.ts` |
| Supabase client | `src/lib/db.ts` |
| Activity logging | `src/lib/activityLogger.ts` |
| Idempotency | `src/lib/idempotency.ts` |
| Migrations | `supabase/migrations/` |
| Edge Functions | `supabase/functions/` |

---

## Session End Checklist

Before finishing a session:

- [ ] All changes compile: `npm run typecheck` passes
- [ ] App builds: `npm run build` passes
- [ ] Types are in sync with database changes
- [ ] Activity logging added for new user actions
- [ ] No `@ts-ignore`, `any`, or `console.log` left in code
- [ ] Migration safety verified (no function overloads, CHECK constraints complete)
- [ ] Land the work the standard way: commit on a branch → open a PR → wait for the required checks (Vercel) → merge. Direct pushes to `main` are impossible (the `protect-main` ruleset); agents land reviewed code themselves under the standing policy — Mason does not hand-commit code.

# Safe Development Rules

Read this before any multi-file, application-code, data, money, security, permission, production, migration, or customer-facing change. A tiny documentation-only correction does not require loading this entire file.

These are the detailed engineering rules behind the concise contract in `AGENTS.md`. Breaking them can cause bugs, data loss, security vulnerabilities, or incorrect business records.

---

## Before Changing Code or Behavior

### 1. Read the context first
- Read `AGENTS.md`, then only the workflow and reference documents its routing table names for this task.
- Read the source files you plan to change.
- Check `docs/manual/DECISION_LOG.md` before reopening a settled design question and `docs/manual/KNOWN_ISSUES.md` before claiming a problem is new.

### 2. Research before coding
- Search for the closest existing pattern before writing new code.
- Check whether the capability or helper already exists; use `docs/reference/pages-routes.md` when adding or changing a page.
- For architecture or multi-file tracing, use Graphify to narrow the source surface, then verify the relevant edges in current source.

### 3. Plan before building
- For substantial work, state the goal, observable completion conditions, files or systems likely to change, and one current step.
- Mason's request to build, fix, finish, handle, implement, or ship approves ordinary reversible in-scope work. Codex continues after the plan; Claude keeps its global pre-code approval checkpoint for multi-file work or work touching data, money, security, or a live system. After any required approval, continue without repeated permission pauses.
- Break large changes into small, observable steps. Ask Mason only for a material business choice or an action listed as hard-gated in `AGENTS.md`.

## Simplicity and Maintainability

Apply `docs/reference/coding-guidelines.md` to every code change. In particular, choose the simplest complete implementation, keep the diff tied to the requested outcome, reuse existing patterns, and preserve readable control flow. CRX safety and business invariants take priority over reducing line count.

---

## ALWAYS Do These Things

| Rule | Why |
|------|-----|
| Use `checkMutationResult()` after every `.update()` or `.delete()` | Catches silent RLS failures that return empty data with no error |
| Use `assertRpcResult()` after RPC calls | Catches RPCs that return null due to permission denial |
| Use `logActivity()` for important user actions | Feeds the activity timeline and keeps audit history |
| Require and enforce `p_idempotency_key text DEFAULT NULL` on mutating RPCs; use `generateIdempotencyKey()` at callers | Prevents retries or double-clicks from applying the same business action twice |
| Create migration files for ALL database changes | Keeps the schema version-controlled and reproducible |
| Run `npm run lint` after changes | Catches static-analysis and project-convention violations |
| Run `npm run typecheck` after changes | Catches type mismatches before they become runtime bugs |
| Run `npm run build` after changes | Catches import errors and compile failures |
| Update `src/types/index.ts` when database schema changes | Keeps TypeScript in sync with the database |
| Use `(select auth.uid())` in RLS policies (not bare `auth.uid()`) | Performance: evaluates once per query instead of once per row |
| Test as all roles (admin, sales_rep, driver) | Each role sees different data — bugs often hide in role-specific paths |
| Match status values to `.claude/schema-registry.json` | Prevents frontend/RPC strings from violating live database constraints |

---

## NEVER Do These Things

### Data Safety
| Rule | Consequence of breaking |
|------|------------------------|
| NEVER delete or modify existing migration files | Migration won't re-apply; schema becomes inconsistent |
| NEVER remove RLS policies from any table | Data exposed to unauthorized users |
| NEVER expose `service_role` key in frontend code | Full database access to anyone with browser dev tools |
| NEVER modify `financial_audit_log` records | Destroys the immutable audit trail required for financial compliance |
| NEVER store or calculate money with binary floating point | Rounding errors in financial calculations. New storage uses bigint cents; documented legacy PostgreSQL numeric-dollar columns use exact `numeric`. |

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
| NEVER commit agent-surface changes without a ledger update in the same commit | The pre-commit ledger guard (`scripts/check-ledger-update.mjs`, 2026-07-13) blocks commits that stage `.claude/{commands,skills,hooks,workflows,agents}/`, `.claude/settings.json`, `AGENTS.md`, `CLAUDE.md`, `.husky/`, or guard scripts with no ledger update. PREFERRED: add `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` — a NEW dated file of your own, since two sessions never write the same path and it cannot conflict. The guard requires it be ADDED (not modified, deleted or renamed) and to carry a `## <YYYY-MM-DD> - <what changed>` heading with detail beneath it. Also accepted: `docs/CHANGELOG.md` / `docs/manual/*.md` / `docs/reference/agent-guardrails.md` / `docs/loops/` — policy changes must leave a written record Mason can find |
| NEVER add `@ts-ignore` or `any` types | Hides bugs that TypeScript would catch |
| NEVER install additional CSS frameworks | Tailwind CSS only — other frameworks cause conflicts |
| NEVER install additional icon libraries | Lucide React only — keeps bundle size consistent |
| NEVER create a second Supabase client | Use `src/lib/db.ts` — multiple clients cause auth state issues |
| NEVER import Sentry outside `src/lib/sentry` | Keeps monitoring configuration, context, and breadcrumbs consistent |
| NEVER use `confirm()` / `window.confirm()` or `alert()` | Use `ConfirmModal` and toasts so behavior is accessible and consistent |

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
| SECURITY DEFINER without a safe search path | Enables schema-hijacking and cross-function failures | Normally add `SET search_path = public, pg_temp`; the fully schema-qualified empty-path exception requires the proof recorded in `docs/manual/DECISION_LOG.md` |
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

New money storage in CRX Manager uses **bigint cents** (whole numbers, no decimals). Established
PostgreSQL `numeric` dollar storage may remain temporarily to avoid a risky unit rewrite, but it is
not an approved or suppressible compatibility exception until database math is verified as exact
`numeric`, all existing values are finite whole cents, and an active finite whole-cent CHECK is
present. Dirty or unconstrained columns remain tracked findings and are not rewritten without approval.

**The "active finite whole-cent CHECK" above means exactly this predicate — write it in full:**

```
CHECK (col IS NULL OR (col = ROUND(col, 2) AND col > '-Infinity' AND col < 'Infinity'))
```

**Both halves are load-bearing; a `ROUND`-only check does NOT satisfy the rule.** PostgreSQL
`numeric` deliberately does not use IEEE-754 NaN semantics — so values stay sortable and indexable,
it treats `NaN` as equal to `NaN` and greater than every finite value. That makes
`'NaN' = ROUND('NaN', 2)` true, so a rounding-only constraint lets `NaN` straight through. The
`< 'Infinity'` bound is what rejects it. Name the constraint `<table>_<column>_whole_cents_chk`.

**One closed exception, already settled — do not re-raise it.** `purchase_orders.total_cost` and
`purchase_order_items.unit_cost` instead carry a "mirror" CHECK
(`col >= 0 AND col = (col_cents::numeric / 100.0)`) against a `GENERATED ALWAYS ... STORED` cents
column. Mason accepted those two on 2026-08-19 after the guarantee was proven read-only against
live. That exception covers those two columns only; the mirror form is **not** a second approved
shape, and anything new or changed uses the predicate above. See the 2026-08-19 entry.

**Never add one as `NOT VALID` over a column that still holds dirty rows.** `NOT VALID` only skips
the initial scan; a CHECK is re-evaluated against the whole new row on every later UPDATE, whatever
column changed, so each legacy dirty row becomes permanently un-editable. Repair the data first,
then add the constraint `VALID`.

Which columns are constrained today, which are deferred and why:
`docs/manual/DECISION_LOG.md` (2026-08-10 and 2026-08-19 entries).

| Operation | How |
|-----------|-----|
| Store $25.50 | Store as `2550` (bigint cents) |
| Display 2550 | Show as `$25.50` (divide by 100) |
| User enters $25.50 | Parse the decimal text exactly to `2550` before saving; do not multiply a binary float by 100 |
| Add $25.50 + $10.25 | Add `2550 + 1025 = 3575` (integer math) |

**NEVER introduce binary floating-point money arithmetic.** New or changed TypeScript money paths
parse decimal operands into integer cents before arithmetic. PostgreSQL legacy dollar paths use
exact `numeric`, not `real` or `double precision`.

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
- [ ] Land the work the standard way: commit on a branch → open a PR → finish the separate Codex review and required checks (Vercel) → bring the branch current → freeze and record the candidate head → apply `ready-for-coderabbit` → let the default-branch workflow post exactly `@coderabbitai review` once → read and resolve that review → recheck every reported check and auto-merge OFF → merge with `--match-head-commit <that-exact-sha>`. An approving review is NOT required (Mason removed it 2026-09-02) but a `CHANGES_REQUESTED` verdict still blocks; when CodeRabbit HAS approved, the marker SHA, that approval's SHA, and the live PR head must match. A fix or base update clears the gate labels, restarts checks, and needs one follow-up ready-label trigger. The generic Actions marker is dedupe evidence, not an independent trust identity. Direct pushes to `main` are impossible (the `protect-main` ruleset); agents land reviewed code themselves under the standing policy — Mason does not hand-commit code.

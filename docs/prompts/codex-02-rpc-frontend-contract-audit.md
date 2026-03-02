# Codex Audit #2: RPC ↔ Frontend Contract Audit

## CRITICAL INSTRUCTION — READ-ONLY AUDIT, NO CODE CHANGES

**DO NOT write, edit, or modify any files. DO NOT create branches, commits, or PRs. DO NOT run any commands that change state.**

Your job is REVIEW ONLY. Produce a detailed findings report. The developer will hand this to Claude for verification before any changes are made.

---

## Context

CRX Manager V1.0 has ~115 Supabase RPCs called from 50 React pages. Data flows like this:

```
SQL RPC (returns JSONB) → supabase.rpc() → TypeScript cast → setState → render
```

Common failure modes:
1. RPC field name doesn't match TypeScript interface (e.g., `total_count` vs `totalCount`)
2. RPC returns bigint (Supabase sends as string), frontend expects number
3. RPC returns null for a field, frontend doesn't handle null
4. RPC returns nested JSONB object, frontend treats it as a flat field
5. Frontend interface has fields the RPC doesn't return (stale interface after RPC change)
6. RPC returns fields the frontend never consumes (wasted bandwidth)

## Your Task

For every `supabase.rpc('...')` call in `src/`:

### Step 1: Find the RPC call
Search all `.ts` and `.tsx` files for `supabase.rpc(` and `\.rpc(` patterns.

### Step 2: Find the corresponding SQL
For each RPC name, find the migration in `supabase/migrations/` that defines it. Note: later migrations may `CREATE OR REPLACE` the same function — use the LATEST definition.

### Step 3: Compare the contract
Check that:
- Every field in the TypeScript interface exists in the SQL JSONB output
- Every field in the SQL JSONB output is represented in the TypeScript interface
- Field names match exactly (SQL uses snake_case, TypeScript may use camelCase — check the mapping)
- Numeric fields use `Number()` coercion (Supabase returns bigint as string)
- Nested JSONB objects have proper sub-interfaces
- NULL is handled (COALESCE in SQL, `|| defaultValue` in TypeScript)
- Array fields handle empty arrays (COALESCE to `'[]'::jsonb` in SQL, `|| []` in TypeScript)

### What to Report for Each RPC

```
### RPC: [function_name]
- **Called from:** [file]:[line]
- **Defined in:** [migration file] (latest version)
- **TypeScript interface:** [interface name or inline cast]
- **Fields in SQL output:** [list]
- **Fields in TS interface:** [list]
- **Mismatches found:**
  - [field]: [description of mismatch]
- **Null handling gaps:**
  - [field]: [what happens if null]
- **Number coercion gaps:**
  - [field]: [missing Number() call]
- **Unused fields:** [fields RPC returns but frontend ignores]
- **Severity:** Critical | High | Medium | Low
```

### Known High-Risk RPCs to Check First

These RPCs have complex return types most likely to have mismatches:
- `dashboard_summary()` — 16+ fields, nested arrays
- `financial_dashboard_summary()` — 14 fields, nested objects (quote_counts, ar_aging_buckets, current_period)
- `get_order_detail()` — complex order with items, deliveries, invoices
- `get_delivery_detail()` — delivery with items, signatures
- `get_invoice_detail()` — invoice with line items
- `get_quote_detail()` — quote with items, holds
- `month_end_summary()` — financial aggregations
- `ar_aging_report()` — customer-level aging buckets

## Expected Output

### Part 1: Complete RPC Inventory
Table of every RPC call found:

| RPC Name | Called From | Migration File | Interface Match | Issues |
|----------|-----------|----------------|-----------------|--------|

### Part 2: Detailed Findings
For each RPC with issues, the full report format above.

### Part 3: Severity Summary
- Critical (data corruption/wrong display): X
- High (potential runtime error): X
- Medium (unused fields, minor type gaps): X
- Low (cosmetic/naming): X

### Part 4: Proposed Fixes
For each finding, the exact TypeScript or SQL change needed — but DO NOT apply it.

---

## IMPORTANT

- **DO NOT WRITE CODE. DO NOT EDIT FILES. REPORT ONLY.**
- Focus on mismatches that cause wrong data or runtime errors, not style preferences
- When a migration has been CREATE OR REPLACE'd multiple times, use the LATEST version
- Your output will be reviewed by Claude before any changes are made

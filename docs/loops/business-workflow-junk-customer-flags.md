# Junk-Customer Flag List (read-only, no writes made)

Source: live `customers` table, project `rhyzpcqhnizqbxphqdkr`, queried 2026-07-05.
Total customers: **153** (150 `is_active=true`, 3 `is_active=false`).
This is a FLAG-ONLY list for owner decision #10 (`docs/audits/business-workflow-review-2026-07/report.md`). Nothing was deleted, updated, or touched — read-only `SELECT`s only.

## Method
- Pulled every customer (`id, farm_name, contact_name, email, is_active, created_at`) and scanned for test/demo/internal patterns (`[E2E]`, "TEST", "A1 TEST", company's own name, a "Purchase Orders for ..." catch-all bucket, and inactive+blank-email near-duplicates of active real farms).
- For each flagged row, counted linked `quotes`, `orders`, `jobs`, `invoices` (the 4 requested) plus `deliveries`/`fields`/`returns`/`commissions` as bonus context (all via `customer_id` FKs — confirmed those columns exist on each table first).
- Confirmed `purchase_orders` has **no** `customer_id` column at all, so the "PO bucket" customer row is a pure orphan with zero connective tissue anywhere in the schema.

## Flagged rows

| Farm name | Customer ID | Created | Quotes | Orders | Jobs | Invoices | Other links | Why flagged | Recommendation |
|---|---|---|---|---|---|---|---|---|---|
| `[E2E] Farm Alpha` | `903b9809-db7e-4b4e-bd58-80d69e674eec` | 2026-03-16 | 0 | 3 | 0 | 1 | 8 deliveries | Named `[E2E]` — this is the **shared automated-test fixture** defined in `tests/e2e/fixtures/e2e-constants.ts` (tier-1 customer used by the E2E suite); email is Mason's own | **KEEP** — it's intentional test infrastructure, not junk; deleting it breaks the E2E suite's `globalSetup`/`globalTeardown` |
| `[E2E] Farm Beta` | `db2f12b9-7451-49eb-9d9c-8eb7c8005ea0` | 2026-03-16 | 0 | 0 | 0 | 0 | 0 | Same E2E fixture pattern (tier-3 customer), Mason's own email, zero business records | **KEEP** — same reason as above (E2E test infra) |
| `A1 TEST FARM` | `da8dd51b-81c2-4006-b4ae-75bb6d41c3dc` | 2026-03-16 | 1 | 1 | 0 | 0 | 1 commission | Name literally says "TEST"; email is Mason's own personal Yahoo address (not a farm domain) | **DELETE-candidate** — has a quote/order/commission attached, so a real delete needs those 3 rows cleaned up first, but nothing suggests a live customer relationship |
| `Test Farm Alpha` | `0c703cb9-7bdf-4900-87f7-4952ef1df2d1` | 2026-02-22 | 0 | 1 | 0 | 0 | 1 commission | Name literally says "Test"; contact "John Smith"; email domain `testfarmalpha.com` is an obvious placeholder | **DELETE-candidate** — 1 order + 1 commission to clean up first, but clearly placeholder data, not a real grower |
| `Crop Rx Solutions` | `73672cfe-cf9a-41d6-b4cc-8a218f9eb901` | 2026-02-10 | 0 | 0 | 0 | 0 | 0 | This is **the company's own name** (CRX itself) sitting in the customer table, not a grower | **DELETE-candidate** — zero linked records anywhere; cleanest possible delete if it's not needed as an internal placeholder |
| `Purchase Orders for WELLS AG SUPPLY CHEMICAL` | `b4d71a33-9609-4338-8415-3e6e38511cbd` | 2026-02-10 | 0 | 0 | 0 | 0 | 0 | Classic **"PO bucket" catch-all** — not a real farm/customer; `purchase_orders` doesn't even have a `customer_id` column, so this row can't be linked to anything by design | **DELETE-candidate** — zero links anywhere in the schema; safest of all the flags to remove |
| `Mason Wells` (active) | `987c3722-5aa5-42e7-b079-c83ebc4dc615` | 2026-02-10 | 0 | 0 | 0 | 0 | 1 field | **Mason's own name/company** as a customer record | **REVIEW** — has 1 linked field, so it may be Mason's personal farming operation tracked through the app rather than pure junk; his call whether that's intentional |
| `Mason Wells` (inactive) | `e8508e65-6ee3-4723-92bc-655c87ec8893` | 2026-02-10 | 0 | 0 | 0 | 0 | 0 | Duplicate of the row above — already `is_active=false`, blank email, no links at all | **DELETE-candidate** — already soft-inactive, zero links anywhere; safe cleanup of a dead duplicate |
| `Wells Farm LLC` (inactive) | `d8bd091a-64ea-4550-a0c4-16ccb66ec1e9` | 2026-02-06 | 0 | 2 | 0 | 0 | 4 commissions | `is_active=false`, blank email — looks like an early duplicate/predecessor of the active `Wells Farms LLC.` (contact Chad Wells) | **KEEP / MERGE, not delete** — has 2 real orders + 4 commission records; deleting would orphan real financial history, needs a merge into the active "Wells Farms LLC." record instead |
| `Tuttle Family Farms` (inactive) | `b6a1d451-9762-4658-be9f-5dc0a36e6f5c` | 2026-02-10 | 0 | 0 | 0 | 0 | 0 | `is_active=false`, blank email — duplicate/predecessor of the active `Tuttle Family Farms Inc.` | **DELETE-candidate** — zero links anywhere; safe cleanup of a dead duplicate |

## Bottom line for Mason
- **Clean, zero-risk deletes (no linked records at all):** Crop Rx Solutions, the PO bucket, Mason Wells (inactive dup), Tuttle Family Farms (inactive dup) — 4 rows.
- **Deletes that need a couple of linked rows cleaned up first (1 quote/order + 1 commission each):** A1 TEST FARM, Test Farm Alpha — 2 rows.
- **Do NOT delete:** `[E2E] Farm Alpha` / `[E2E] Farm Beta` (live automated-test fixtures, needed by the E2E suite) and `Wells Farm LLC` (inactive) (has 2 real orders + 4 commissions — merge into `Wells Farms LLC.` instead of deleting).
- **Owner judgment call:** `Mason Wells` (active) — keep if it's his own tracked farming operation.

No database writes were made — this is a flag list only.

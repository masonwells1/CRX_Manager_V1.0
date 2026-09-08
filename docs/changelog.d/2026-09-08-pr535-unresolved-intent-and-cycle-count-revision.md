## 2026-09-08 — PR #535 review findings: unresolved-intent freeze, content-identity import scope, and a parked cycle-count revision refusal

Closes the open CodeRabbit and Codex findings on PR #535. Seven were frontend and are
fixed here; one SQL finding is parked as a migration pending Mason's approval; two SQL
findings were **withdrawn after checking live** rather than fixed.

### Frontend (shipped in this branch)

- **New `src/hooks/useUnresolvedIntent.ts`.** `adjust_inventory`, `create_inventory_hold`
  and `save_blend_recipe` replay on the idempotency key alone — verified read-only
  against the live catalog on 2026-09-08: none calls `check_idempotency_intent`, none
  stores a `request_fingerprint`, none raises `IDEMPOTENCY_PAYLOAD_CONFLICT`. Those call
  sites derive their intent scope from the payload, so when a request commits and its
  response is lost, editing a quantity mints a NEW key and the server applies the work a
  second time. The hook refuses an EDITED payload once while an attempt is unresolved,
  and never refuses a faithful retry. It refuses **once**, not forever: the state is
  component-level, so a permanent freeze would block every later unrelated hold or
  adjustment with a page reload as the only escape. One refusal matches the
  over-allocation pattern already on the page — click again to proceed anyway.
  Wired into `InventoryPage.tsx` (adjust and hold) and `BlendRecipes.tsx` (duplicate).
- **`BulkFieldImport.tsx` intent scope is now content-identity only.** Position came out:
  `fieldIndex` renumbers whenever an earlier row is dropped as invalid, and it does not
  survive re-importing one corrected row in a new file, so a position-bearing scope minted
  a fresh key for an unchanged row on exactly the retry the retained key exists to serve.
  The scope now hashes customer, name, payload, boundary and stated acres. Two identical
  rows in one file therefore share a key on purpose, and a new committed-id set stops that
  from being counted as two imported fields.
- **`digestIntentPayload` added to `src/lib/idempotency.ts`** — async SHA-256 with a
  synchronous fallback. The bulk import hashes a complete field boundary, and the existing
  64-bit synchronous hash is neither collision-resistant enough for a key-only RPC nor
  cheap enough to run on the UI thread for a large multi-part geometry.
- **`useIdempotencyKey.hasKeyFor`** — a read-only existence check that does not mint a key,
  so `CycleCounts.tsx` can attempt a cached replay of a completion whose response was lost
  before refusing on `status !== 'in_progress'`. Safe because
  `_complete_cycle_count_impl` never writes `cycle_count_items`, so `item_revision` is
  stable and the retained key's scope and receipt still match.
- **`CYCLE_COUNT_REVISION_REQUIRED` mapped** in `src/lib/db.ts` and `CycleCounts.tsx` to a
  "reload the page" instruction. Only a tab cached from before the parked migration can
  raise it, and refreshing the list would not help such a tab.

### Parked migration — NOT APPLIED

`supabase/migrations/20260908120000_close_pr535_live_gaps.sql` re-emits
`complete_cycle_count` so that omitting `p_expected_item_revision` is refused instead of
silently skipping both staleness checks. Its subject is already live (applied 2026-09-03),
so this is a live defect, not a branch defect. Body pinned by `md5(pg_proc.prosrc)`
(`6d1cab7c4298de34341d517265499896`, live and source-file identical); a precondition block
re-asserts that hash before the replace so the file refuses to run if anything has since
replaced the function. **Mason has not approved an apply and nothing has touched
production.** Recorded as row 918 in `docs/reference/migration-history.md`.

### Withdrawn after checking live

- Two findings claimed a nullable `purchase_orders.total_cost_cents` lets a positive
  vendor bill bypass cumulative-overage confirmation. Live, that column is
  `GENERATED ALWAYS AS (round(total_cost * 100))::bigint STORED` over
  `total_cost numeric NOT NULL DEFAULT 0`. It can never be NULL, the existing
  `v_po_total <= 0` arm already fires for a zero-cost PO, and the proposed `COALESCE` was
  a no-op. Re-emitting two live `SECURITY DEFINER` money functions for no behavioural
  change is exposure without benefit, so both sections were removed.
- One finding covers the browser-clock as-of date `Reports.tsx` sends to
  `get_commission_balance_report`. Deferred deliberately: the only correct fix is
  server-derived, and a frontend change that depends on unapplied SQL would break the
  report the moment this PR merged. Recorded as an open follow-up.

### A mistake caught before it shipped

An earlier revision of the parked migration also re-emitted `get_commission_balance_report`
from the body in `20260831162000`. That is no longer the live body:
`20260903150100_ledger_backed_commission_history` replaced that function on 2026-09-03.
Applying it would have reverted the commission balance report to its pre-ledger
calculation. It was caught by comparing against `pg_proc.prosrc` instead of against the
migration file, which is why the md5 pin above exists.

### Proof observed

`npx tsc --noEmit` clean; `npm run lint` clean (0 warnings); `npm test` — full vitest
suite green. Two guard tests were re-pinned rather than relaxed: the bulk-import scope pin
now asserts the content-identity form and denies the old `import:${fieldIndex}` form
outright, and the cycle-count baseline-pairing regex was narrowed to the exact
`item_revision` key so that an RPC argument named `p_expected_item_revision` is no longer
read as an unpaired baseline site. A new test pins the successor migration's refusal, the
absence of the `IS NOT NULL` bypass in its body, and its precondition hash check.

### Not verified

The parked migration has not been run — no container proof and no live apply. The
frontend fixes were verified by type-check, lint and the full test suite; the
lost-response paths they guard were not reproduced against a live database, because doing
so requires deliberately losing an RPC response on a production money path.

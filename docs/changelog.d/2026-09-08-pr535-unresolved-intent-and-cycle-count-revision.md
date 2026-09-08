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
  second time. The hook refuses an EDITED payload while an attempt is unresolved, and
  never refuses a faithful retry. It warns **once per distinct edit**, not once in
  total: the state is component-level, so a permanent freeze would block every later
  unrelated hold or adjustment with a page reload as the only escape, and one warning
  matches the over-allocation pattern already on the page — click again to proceed
  anyway. A first version cleared the freeze on the first refusal, which meant
  acknowledging one edit silently disarmed the guard, so a THIRD, different payload
  executed with no warning at all while the original attempt was still unresolved. The
  freeze now lifts only on a confirmed success, a definitive refusal, or a reload.
  Wired into `InventoryPage.tsx` (adjust and hold), `BlendRecipes.tsx` (duplicate) and
  `IntegrityCleanupPanel.tsx` (negative-inventory reconciliation). The last of those is
  the sharpest case: `reconcile_negative_inventory` writes an ABSOLUTE
  `quantity_available` and replays on the key alone, so a lost response plus an edited
  quantity silently overwrote every stock movement since the first commit.
- **`digestIntentPayload` now latches its fallback.** The doc comment claimed the SHA-256
  and FNV branches were stable for the life of the page; nothing enforced it. A transient
  `subtle.digest` failure returned an `f…` identity and the next call an `s…` identity for
  the same payload — a changed scope, a fresh key, and the double-apply this digest exists
  to prevent. Once a page falls back it stays fallen back.
- **`BulkFieldImport.tsx` intent scope is now content-identity only.** Position came out:
  `fieldIndex` renumbers whenever an earlier row is dropped as invalid, and it does not
  survive re-importing one corrected row in a new file, so a position-bearing scope minted
  a fresh key for an unchanged row on exactly the retry the retained key exists to serve.
  **Each of the row's three RPCs is now scoped to what that RPC actually does**, which a
  first attempt got wrong: folding the field payload, the boundary and the stated acres
  into one shared scope meant a downstream correction rewrote the UPSTREAM key. Fixing only
  a rejected boundary changed the combined hash, so the re-import called `save_field` with a
  fresh key and `p_field_id: null` and created a SECOND field before retrying the boundary.
  `save_field` is now keyed by the field's identity and payload alone; the boundary and the
  acreage override are each keyed by the committed field id plus their own input.
  Two identical rows in one file share the `save_field` key on purpose, and a committed-id
  set reports the second as a duplicate instead of counting it twice — which required
  **dropping the three end-of-row key resets**: retiring the key on success meant the second
  identical row minted a fresh one, got a new field id back, and created exactly the
  duplicate that check exists to prevent. It never fired in a normal import.
- **The acreage-override step now distinguishes a lost response from a refusal.** It ignored
  the returned status and reported every failure as "billing on the measured acres instead",
  which is a false statement about billable acres when the override in fact committed and
  only its answer was lost.
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
production.** Recorded as row 923 in `docs/reference/migration-history.md`.

### Withdrawn after checking live

- Two findings claimed a nullable `purchase_orders.total_cost_cents` lets a positive
  vendor bill bypass cumulative-overage confirmation. Live, that column is
  `GENERATED ALWAYS AS (round(total_cost * 100))::bigint STORED` over
  `total_cost numeric NOT NULL DEFAULT 0`. It can never be NULL, the existing
  `v_po_total <= 0` arm already fires for a zero-cost PO, and the proposed `COALESCE` was
  a no-op. Re-emitting two live `SECURITY DEFINER` money functions for no behavioural
  change is exposure without benefit, so both sections were removed.
- One finding covered the browser-clock as-of date `Reports.tsx` sent to
  `get_commission_balance_report`. **Now moot, not deferred.** Merging `main` brought in
  #592's ledger-backed commission history, which derives the Chicago business date, clamps
  the requested as-of value and calls `get_commission_history_report`. The whole stopgap
  this branch carried was superseded, so `Reports.tsx` was taken from `main` unchanged
  during conflict resolution and no follow-up remains on this PR.

### A mistake caught before it shipped

An earlier revision of the parked migration also re-emitted `get_commission_balance_report`
from the body in `20260831162000`. That is no longer the live body:
`20260903150100_ledger_backed_commission_history` replaced that function on 2026-09-03.
Applying it would have reverted the commission balance report to its pre-ledger
calculation. It was caught by comparing against `pg_proc.prosrc` instead of against the
migration file, which is why the md5 pin above exists.

### Second review round — `gpt-5.6-sol` high effort on the merged head

A high-effort exact-SHA review of the merged branch returned CHANGES REQUIRED with 16
findings. All 16 are addressed above or below; the three that mattered most:

- **The parked migration could not have been applied at all.** It carried a top-level
  `BEGIN;`/`COMMIT;`, and `scripts/apply-migration-file.mjs` REFUSES transaction control
  because it wraps the migration and its ledger row in one transaction so the two commit
  together. Running the repository's own wrappability guard against the committed file
  returned `NOT WRAPPABLE`. The transaction control is gone, the guard now returns OK, and
  the successor test pins its absence so the suite can no longer stay green while the
  artifact is unshippable.
- **The grant proof had a role-membership hole.** `aclexplode` lists DIRECT grants only, so
  `anon` inheriting EXECUTE through a role it belongs to would not have appeared. The proof
  now also runs `has_function_privilege('anon', …)`, guarded on `pg_roles` so it cannot be
  the vacuous form that passes where the role does not exist. Both checks are kept: each is
  blind to the other's case.
- **The bulk-import duplicate check was dead code**, and the shared intent scope could
  create duplicate fields after a downstream correction. Both are described above.

Also fixed from that round: `src/types/supabase.ts` carried `item_revision` TWICE in the
`cycle_counts` Row, Insert and Update shapes (a malformed generated artifact that can hide
future type drift); `KNOWN_ISSUES.md` still declared the wrong-purchase-order receiving race
OPEN and live when `main` had fixed it and dropped the entry; the receiving screen could
show a green "Receiving reconciled" immediately after warning that the workflow was still
locked, because `cleanupFailed` was invisible to `onSuccess`; and the nightly crawl summary
omitted its intentional-redirect count, so the totals no longer reconciled to the number of
routes crawled.

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

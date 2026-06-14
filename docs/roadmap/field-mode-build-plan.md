# Field Mode (driver mobile workspace) — overnight build plan

> **Status:** ✅ BUILT 2026-06-14 on branch `claude/recursing-cerf-6ae05f` — committed, **NOT pushed**. See "Build complete — handoff" at the bottom. Source: 5-agent brainstorm swarm 2026-06-13 (reuse map + 2 competing designs + adversarial scope). Owner-approved decisions baked in below.

## What it is
A new phone-first, task-first **`/my-route`** surface for delivery drivers: a "my open stops" list → a guided per-stop flow (**Arrive → Verify/short items → Signature → Photo → Review/Complete → Next stop**), working offline. It REUSES the existing delivery RPCs/components and leaves the 2,430-line `src/pages/DeliveryDetail.tsx` (desktop view) byte-for-byte untouched.

## Why it's overnight-safe (GREEN)
- **Pure additive frontend. ZERO migrations / RPC / table / RLS / bucket changes** — `confirm_delivery`, `complete_delivery`, `reassign_delivery`, the `delivery-photos` + `delivery-signatures` buckets, the `del_select` RLS policy, and the `enforce_delivery_items_parent_lock` trigger are all already live.
- Operates on **real data** (100 deliveries: 7 scheduled / 4 in-progress / 64 completed; 386 items) — browser-verifiable, unlike the empty report/compliance candidates.
- No collision with the sell-side session (quote→order→invoice→prepay) or the recovery session.

## Recommended design — Hybrid (Guided Wizard spine + 2 hub ideas)
Anchor on the **one-thing-per-screen Guided Wizard** because the DB already enforces the order (`complete_delivery` requires `in_progress`; `confirm_delivery` is the only path there). Borrow from the Hub design: **(1) status-driven entry** (scheduled → opens at Arrive; in_progress → resumes at Verify) and **(2) a "Open full detail" deep-link** to `/deliveries/:id` as the universal escape hatch (cancel / reschedule / edit items / follow-up).

## Owner-approved decisions (LOCKED)
1. **Verify on a disposable `[E2E]`-prefixed delivery** — create it, run the full flow, confirm inventory deduction + draft invoice, then teardown. NEVER complete a real customer delivery unattended.
2. **List = all open stops the login can access** — no app-side date/assigned filter; rely on `del_select` RLS (admin/rep see all, driver sees own). Optional "Today only" chip, off by default.
3. **Allow Claim** — a "Claim this stop" action (calls `reassign_delivery`, sets `assigned_driver=self`) behind a ConfirmModal, so the 2 real driver accounts can populate their list.
4. **Email replicates desktop exactly** — `emailOnComplete` toggle present, default ON, shown only when the customer has an email. (Add a never-email guard only if owner names internal-transfer deliveries.)

## Reuse map (call existing surfaces — do NOT reinvent)
- `confirm_delivery(p_delivery_id, p_performed_by, p_idempotency_key)` — Arrive (scheduled→in_progress). ~`DeliveryDetail.tsx:711`.
- `complete_delivery(p_delivery_id, p_signed_by, p_performed_by, p_quantities jsonb, p_issue_type, p_issue_notes, p_idempotency_key)` — Complete. `p_signed_by` REQUIRED (non-empty); `p_quantities` = `{item_id: qty}` only when partial, else `null`. Deducts inventory + auto-creates a draft invoice + returns `auto_invoice.invoice_number`. ~`DeliveryDetail.tsx:752-808`.
- `reassign_delivery(p_delivery_id, p_new_driver, p_performed_by, p_idempotency_key)` — Claim. ~`DeliveryDetail.tsx:599-611`.
- `SignatureCanvas` (`src/components/ui/SignatureCanvas.tsx`) — touch-ready; PNG dataURL → upload to `delivery-signatures` `signatures/{id}.png` then set `deliveries.signature_url`.
- Photo: `compressImage` (`src/lib/imageCompression.ts:19`) → `delivery-photos` bucket → insert `delivery_photos` row, 10-photo cap. **COPY** the ~58-line block (`DeliveryDetail.tsx:620-678`) into FieldRoute — do NOT extract a shared lib (that would edit DeliveryDetail). Tag the copy `// tech-debt: duplicated from DeliveryDetail handlePhotoUpload`.
- Offline: `useOnlineStatus` (`src/hooks/useOnlineStatus.ts:8`) + `queueAction` (`src/lib/offlineQueue.ts:50`). `offlineSync.ts` already replays `complete_delivery` (:142) and `confirm_delivery` (:184) — no new offline op to register.
- Idempotency: `useIdempotencyKey` (`src/hooks/useIdempotencyKey.ts:25`) — FieldRoute instantiates its OWN confirm/complete instances; `resetKey()` only on confirmed success AND on Next-Stop nav.
- Partial/short: reimplement `deliveryQtys` (init to item qty), `isPartialDelivery`, `hasAnyQty`, clamp 0..ordered as pure component state (`DeliveryDetail.tsx:376-381`). **NEVER `.update()` delivery_items** (trigger locks them once in_progress).
- List query: `deliveries.select('id, delivery_number, customer_id, status, scheduled_date, scheduled_time, priority, assigned_driver, customers(name)').is('deleted_at',null).in('status',['scheduled','in_progress']).order('scheduled_date').order('scheduled_time',{nullsFirst:false})` — RLS auto-scopes. Order in_progress-first in the UI.

## Build scope (ordered slices)
1. Wire-up (append-only): `App.tsx` lazy import + `Route { path:'my-route', element:<ProtectedRoute allowedRoles={['admin','sales_rep','driver']}><FieldRoute/></ProtectedRoute> }` (mirror ~`App.tsx:213`); `AppLayout.tsx` one nav link (Lucide `Truck`/`Navigation`).
2. `FieldRoute.tsx` "My Stops" list: query above; online/offline pill + pending-sync count; tappable cards; empty-state with link to `/deliveries`; **Claim** action on unassigned rows (ConfirmModal → `reassign_delivery`).
3. Status-driven per-stop runner: scheduled → Arrive; in_progress → Verify.
4. Arrive: `confirm_delivery` (own idem key, reset on success). **Online-only for scheduled stops** — if offline, disable with "Connect to start this stop."
5. Verify Items: all-full = single Continue; per-item "Short?" → stepper; optional `p_issue_type`/`p_issue_notes` only when short. No direct item writes.
6. Signature: `SignatureCanvas` + required "Signed by" input; Continue gated on `signedBy.trim()`.
7. Photo (optional/skippable): copied upload block; disabled + labeled "online only" when offline.
8. Review & Complete: `emailOnComplete` toggle (default ON, only if customer email); summary; ConfirmModal; build rpcParams exactly as `DeliveryDetail.tsx:752-760`. Online → `complete_delivery` + signature upload + photos + surface invoice number. Offline (in_progress stops only) → `queueAction('complete_delivery', …)`; reset key; "Saved offline" toast.
9. Stop Complete → Next Stop (reset key fired; load next open card's runner).
10. One vitest test: two sequential completes in the mounted component produce two DISTINCT idempotency keys (reset on nav).

## Adversarial-review checklist (the loop re-checks every cycle)
- **Idempotency key per stop** (HIGH) — reset on Next-Stop; never reuse across stops (else cached wrong-stop completion).
- **Offline ordering** (HIGH) — offline path allowed ONLY for already-in_progress stops; NEVER enqueue `confirm_delivery`; block offline Arrive.
- **Non-empty list** (HIGH) — no strict today/mine filter; RLS-scoped all-open.
- **Email/invoice parity** (MED) — toggle present + surface returned invoice number.
- **Item-lock** (MED) — zero direct `delivery_items` writes; quantities only via `p_quantities`.
- **Insufficient-inventory at completion** — catch the RPC error and show it cleanly.
- **Inherited, DO NOT fix tonight** — offline image-blob queue + offline stale-write conflict guard (touch the shared offline path / DeliveryDetail). Server `FOR UPDATE` status gate is the backstop; flag as tech-debt.

## Definition of done
- `npm run lint` 0 / `npm run build` clean / `npm run test` green incl. the new key-reset test; no local-rule violations.
- Zero migrations; `DeliveryDetail.tsx`, `db.ts`, clean-zone files unchanged; `types/index.ts` unchanged or additive-only.
- Browser-verified in preview against real deliveries: list shows the 11 open stops under an admin login; a full happy-path completion of a disposable `[E2E]` delivery deducts inventory + creates a draft invoice (number shown); a scheduled `[E2E]` stop confirms then completes online; offline Arrive on a scheduled stop is blocked; offline Complete on an in_progress `[E2E]` stop queues and replays on reconnect; Claim sets `assigned_driver`; partial/short produces a remainder + reduced invoice; desktop `/deliveries/:id` confirmed unchanged.
- Committed on `claude/recursing-cerf-6ae05f`. **NOT pushed / NOT deployed.**

## Hard safety rails (unattended)
NEVER edit `DeliveryDetail.tsx` or clean-zone files (QuoteBuilder/Order*/Prepay*/MonthEndClose/Quotes/notificationTriggers/db.ts/types heavy edits) · apply no migrations (none exist) · NEVER `git push` or deploy · verify ONLY against disposable `[E2E]` data, never a real customer's delivery · stop at definition-of-done and leave a handoff; escalate (don't guess) if a genuinely new owner decision appears.

---

## Build complete — handoff (2026-06-14)

Built end-to-end by the overnight `/loop` session. **6 commits on `claude/recursing-cerf-6ae05f`, NOT pushed:**

| Commit | What |
|---|---|
| `c133bfd` | docs: staged build plan |
| `e39e742` | slice 1 — `FieldRoute.tsx` "My Stops" list (RLS-scoped open stops, online/offline pill + pending-sync count) + wire-up (App route, Sidebar nav, pagePermissions) |
| `3a98eed` | slice 2 — `FieldStop.tsx` per-stop runner: status-driven entry, Arrive (`confirm_delivery`, online-only), Verify (clamped full/short stepper) |
| `d285736` | slice 3 — Sign → Photo → Review → Complete (`complete_delivery` mirroring desktop exactly; offline queue for in_progress stops; signature upload; invoice surfacing; notifications) + new `src/lib/deliveryCompletionEmail.ts` (faithful copy of the desktop receipt) |
| `25ec53b` | slice 4 — Claim unassigned stops (`reassign_delivery` behind ConfirmModal) |
| `36fc16e` | slice 5 — per-stop idempotency test (route-per-stop ⇒ fresh key per stop) |

**New surface:** `/my-route` (list) + `/my-route/:id` (runner), roles admin/sales_rep/driver. **Zero migrations.** `DeliveryDetail.tsx` and all clean-zone files byte-unchanged (additive wire-up only).

**Verified:**
- Per-commit gate green every time: `lint` 0 · `build` clean (vite 7) · **2,000 tests** pass · workflow-map regen.
- **Adversarial-review swarm CLEAN** — 4 reviewers (correctness/idempotency, offline-semantics, regression/clean-zone, compliance), **0 blocker/high/med**. Confirmed: rpcParams identical to desktop, fresh idempotency key per stop, offline path only for in_progress (confirm never queued), no direct `delivery_items` writes, all CRX red lines clean, email lib a faithful copy.
- Completion correctness rests on the green gate + clean review + line-by-line mirroring of the production-tested `DeliveryDetail.handleComplete`.

**Verification NOT done (needs Mason):** an authenticated end-to-end browser run. The worktree dev server boots the app cleanly (React mounts, bundle + new lazy routes load, **0 console errors**) but lacks Supabase env config + login credentials, so `/my-route` couldn't be driven autonomously. **→ Do a final on-device click-through** (Arrive→Verify→Sign→Complete on a real or `[E2E]` stop) before merge.

**Deferred (documented, intentional):**
- Optional short-reason capture (`p_issue_type`/`p_issue_notes`) on partial deliveries — RPC defaults to NULL, completes fine without it.
- Offline image-blob queue — signature/photo images still upload online-only (inherited from desktop); offline-complete saves the RPC but warns images save on reconnect.
- True "Next Stop" auto-advance — currently returns to the list (completed stop drops off).
- Switching `DeliveryDetail` to the shared `deliveryCompletionEmail.ts` (would touch the frozen file) — left as a future cleanup; the two copies are intentionally duplicated for now.

**Next:** Mason reviews → final on-device pass → merge to `main` (= deploy to croprxsolutions.app) when satisfied.

---

## Red-team review + remediation (2026-06-14)

A second, aggressive red-team review (4 hunters, grounded against the **live** RPC/RLS catalog) ran after the first clean swarm. It found what the first missed:

**Fixed (commits `a8c883a`, `2b97739`):**
- **HIGH (real bug):** `FieldStop` read `customer_addresses.street` — a column that doesn't exist (it's `address_line`); the street line silently dropped from the stop address. Fixed + switched to explicit-column select so the type checker catches field drift.
- **MED:** signature-image upload failure was swallowed (Sentry only) → added a non-blocking toast (delivery still completes; failed capture is now visible).
- **LOW:** `handleArrive` race-recovery now syncs local status to `in_progress`.
- **LOW (offline data-loss):** offline `complete_delivery` now carries `entityTable/entityId/snapshotAt` so `offlineSync`'s stale-write guard surfaces a `Conflict:` instead of silently dropping a queued completion if the stop is completed/cancelled elsewhere while offline.

**Owner decision (2026-06-14): dispatcher-assign model.** The red-team proved (live) that `del_select` RLS hides unassigned stops from drivers, so the driver self-claim flow was non-functional for the target role. Mason chose: drivers run **pre-assigned** routes; dispatchers assign via the existing desktop flow. The driver-facing **Claim button was removed** (commit `2b97739`), which also moots the `reassign_delivery` self-claim tightening. Field Mode works for admin/sales-rep now, and for drivers once a stop is assigned to them.

**Verified faithful (no change needed):** completion `rpcParams`, inventory deduction, draft-invoice creation, `auto_invoice.invoice_number` return shape, and the receipt email are all identical to the production `DeliveryDetail` handler / live RPC.

**Known limitation (documented, NOT fixed — would need a migration the owner declined for now):**
- `customers_select` driver branch date-gates on `scheduled_date >= CURRENT_DATE - 1`, so a driver completing an assigned stop with a null/old `scheduled_date` gets a NULL customer embed → the receipt email silently skips and the name shows "Unknown customer". **Latent** (0 such stops today). Revisit with the customers_select widening (or a SECDEF receipt-fetch RPC) if it ever bites.
- `customer_addresses` RLS is `USING (true)` (world-readable to authenticated) — pre-existing, not introduced here; FieldStop now selects only `address_line, city, state, zip`.

Note: the Codex packet (`docs/audits/2026-06-14-codex-field-mode-prompt.md`) predates this round — it still describes the Claim flow and the address bug. Re-running real Codex is still worthwhile for independent-model coverage; the code it reviews now has Claim removed and the address bug fixed.

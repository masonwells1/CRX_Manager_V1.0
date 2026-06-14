# Field Mode (driver mobile workspace) — overnight build plan

> **Status:** STAGED — not started. Built by an unattended `/loop` session on branch `claude/recursing-cerf-6ae05f` (worktree `recursing-cerf-6ae05f`). Source: 5-agent brainstorm swarm 2026-06-13 (reuse map + 2 competing designs + adversarial scope). Owner-approved decisions baked in below.

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

# Delivery Signature Canvas for All Roles + PDF Embedding

**Date:** 2026-03-19
**Status:** Approved
**Branch:** main (direct push)

## Problem

The `SignatureCanvas` component exists and works in the **driver view** (dark mobile UI) of `DeliveryDetail.tsx`, but the **admin/sales rep view** (light desktop UI) has only a text "Signed By" input with no signature pad. This means admins and sales reps completing deliveries can never capture a customer signature.

Additionally, the delivery receipt PDF (`deliveryPdf.ts`) renders a blank signature line instead of embedding the actual captured signature image.

## Scope (3 changes)

### 1. Add SignatureCanvas to admin/sales rep completion view

**File:** `src/pages/DeliveryDetail.tsx` (~line 1798)

- Add `SignatureCanvas` component after the "Signed By" text input
- Light theme styling consistent with admin view (white background)
- Optional — does not block completion
- No logic changes needed — `handleComplete()` already uploads signature regardless of role

### 2. Embed signature image in delivery receipt PDF

**File:** `src/lib/deliveryPdf.ts`

- Fetch signature PNG from Supabase storage via signed URL
- Embed as image above the typed "Signed By" name at bottom of receipt
- If no signature captured, keep blank line (current behavior)
- Pass signature data URL or signed URL to PDF generator

### 3. Show signature image in driver view after completion

**File:** `src/pages/DeliveryDetail.tsx`

- Driver view currently missing signature display for completed deliveries
- Add same signature image display that admin view already has (line 1645)

## What's NOT changing

- No new database columns or migrations
- No new npm dependencies
- No changes to `complete_delivery()` RPC
- No changes to driver view completion form (already works)
- Photo upload stays driver-only for now

## Code Safety Checklist

- [ ] Follow all patterns in CLAUDE.md (checkMutationResult, Sentry imports, etc.)
- [ ] No `@ts-ignore` or `any`
- [ ] No `window.confirm()` or `window.alert()`
- [ ] Import Sentry from `lib/sentry` only
- [ ] Run `npm run lint && npm run build && npm run test` before commit

# Delivery Signature for All Roles + PDF Embedding — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the SignatureCanvas component to the admin/sales rep delivery completion view, embed captured signatures into the delivery receipt PDF, and show the signature in the driver view after completion.

**Architecture:** Three surgical edits — no new files, no migrations, no new dependencies. The `SignatureCanvas` component and all upload/storage logic already exist.

**Tech Stack:** React, TypeScript, jsPDF, signature_pad (all already installed)

---

## Code Safety Reminders

Before writing ANY code, follow these CLAUDE.md rules:
- Import Sentry from `../lib/sentry` (NEVER `@sentry/react`)
- Use `checkMutationResult()` after every `.update()` / `.delete()`
- No `@ts-ignore` or `any`
- No `window.confirm()` — use `ConfirmModal`
- Run `npm run lint && npm run build && npm run test` before committing

---

### Task 1: Add SignatureCanvas to Admin/Sales Rep Completion View

**Files:**
- Modify: `src/pages/DeliveryDetail.tsx:1790-1811`

**Step 1: Add SignatureCanvas below the Signed By input in the admin completion section**

In the admin/sales rep "Complete Delivery" card (line ~1744, condition: `delivery.status === 'in_progress' && isAdminOrRep`), the "Signed By" `<Input>` is at line ~1792. Add the `SignatureCanvas` component directly after it, inside the same grid but as a full-width element below.

Find this block (around line 1790-1798):
```tsx
          {/* Signed by */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <Input
              label="Signed By"
              value={signedBy}
              onChange={(e) => setSignedBy(e.target.value)}
              placeholder="Customer name"
              required
            />
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Issue (Optional)</label>
```

Insert the SignatureCanvas after the closing `</div>` of the grid (after the issue select/textarea), before the email checkbox. Add it as a new block:

```tsx
              <div className="mb-4 border border-gray-200 rounded-lg p-3 bg-white">
                <SignatureCanvas
                  onSignatureChange={setSignatureDataUrl}
                  label="Customer Signature (Optional)"
                  height={120}
                />
              </div>
```

This goes right after the issue notes conditional block closes (after line ~1821) and before the email checkbox (line ~1824).

**Step 2: Verify the import already exists**

Line 14 already has: `import SignatureCanvas from '../components/ui/SignatureCanvas';`
Line 98 already has: `const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);`
Line 674 already handles upload in `handleComplete()`.

No new imports needed — the state and upload logic are shared between both views.

**Step 3: Run lint and build**

Run: `npm run lint && npm run build`
Expected: 0 errors, clean build

**Step 4: Manual test**

1. Log in as admin
2. Navigate to an in_progress delivery
3. Verify the signature canvas appears below the signed-by / issue fields
4. Draw a signature, type a name, complete the delivery
5. Verify signature uploads to storage and `signature_url` is set on the delivery record

---

### Task 2: Show Signature in Driver View After Completion

**Files:**
- Modify: `src/pages/DeliveryDetail.tsx` (driver view section, around line 1040-1070)

**Step 1: Add signature display to driver view for completed deliveries**

In the driver view (line 949-1276), after the products card and before the photo upload section, add a signature display block for completed deliveries. Find the products section closing `</div>` (around line 1119) and add:

```tsx
          {/* Signature display (completed deliveries) */}
          {delivery.status === 'completed' && delivery.signature_url && signedSignatureUrl && (
            <div className="bg-gray-800 rounded-xl p-5 border border-gray-700">
              <h3 className="text-white font-semibold mb-3">Signature</h3>
              <div className="flex items-start gap-4">
                <img
                  src={signedSignatureUrl}
                  alt="Customer signature"
                  className="border border-gray-600 rounded-lg max-w-xs bg-white"
                />
                <div className="text-sm text-gray-400">
                  <p>Signed by: <span className="font-medium text-white">{delivery.signed_by || '-'}</span></p>
                  {delivery.completed_at && <p>Completed: {new Date(delivery.completed_at).toLocaleString()}</p>}
                </div>
              </div>
            </div>
          )}
```

Note: Uses dark theme classes (`bg-gray-800`, `text-white`, `border-gray-600`) consistent with the driver view. The `signedSignatureUrl` state is already loaded in the `useEffect` fetch (line 274-282).

**Step 2: Run lint and build**

Run: `npm run lint && npm run build`
Expected: 0 errors, clean build

---

### Task 3: Embed Signature Image in Delivery Receipt PDF

**Files:**
- Modify: `src/lib/deliveryPdf.ts:29-46` (interface) and `src/lib/deliveryPdf.ts:202-211` (signature line)
- Modify: `src/pages/DeliveryDetail.tsx:1358-1380` (pass signature URL to PDF)

**Step 1: Add `signature_image_data_url` to the `PdfDeliveryData` interface**

In `deliveryPdf.ts`, add an optional field to `PdfDeliveryData` (line 29-46):

```typescript
export interface PdfDeliveryData {
  // ... existing fields ...
  signature_image_data_url?: string;  // Base64 PNG data URL of captured signature
}
```

**Step 2: Update `renderDeliveryPage` to embed the signature image**

Replace the signature line section (lines 202-211) with logic that embeds the image if available, or falls back to the blank line:

```typescript
  // Signature section
  y += 20;
  if (data.signature_image_data_url) {
    // Embed captured signature image
    try {
      const sigWidth = 200;
      const sigHeight = 60;
      doc.addImage(data.signature_image_data_url, 'PNG', margin, y - sigHeight + 5, sigWidth, sigHeight);
      y += 10;
    } catch {
      // Fallback to blank line if image fails
      doc.setDrawColor(180, 180, 180);
      doc.line(margin, y, margin + 250, y);
      y += 0;
    }
  } else {
    // No signature captured — blank line
    doc.setDrawColor(180, 180, 180);
    doc.line(margin, y, margin + 250, y);
  }

  // Signed-by name below signature
  doc.setFontSize(8);
  doc.setTextColor(160, 160, 160);
  if (data.signed_by) {
    doc.text(`Signed by: ${data.signed_by}`, margin, y + 14);
  } else {
    doc.text('Customer Signature', margin, y + 14);
  }

  // Date line on the right
  doc.setDrawColor(180, 180, 180);
  doc.line(pageW - margin - 150, y, pageW - margin, y);
  doc.text('Date', pageW - margin - 150, y + 14);
```

**Step 3: Pass signature URL when generating PDF from DeliveryDetail.tsx**

In the admin view's PDF download button (line ~1358), add `signature_image_data_url`:

Find:
```tsx
                downloadDeliveryPdf({
```

The `signedSignatureUrl` state variable already holds the signed URL. However, `jsPDF.addImage()` needs a data URL or base64 string, not a fetch URL. Two options:

**Option chosen:** Pass the `signedSignatureUrl` (HTTPS URL) — jsPDF's `addImage` supports URLs directly for same-origin or CORS-enabled resources. Supabase signed URLs have CORS enabled.

Add to the PDF data object (after `signed_by`):
```tsx
                  signed_by: delivery.signed_by || undefined,
                  signature_image_data_url: signedSignatureUrl || undefined,
```

**Step 4: Run lint, build, and tests**

Run: `npm run lint && npm run build && npm run test`
Expected: 0 errors, clean build, all tests pass

**Step 5: Manual test**

1. Complete a delivery with a signature drawn
2. Click "Receipt PDF" button
3. Verify the PDF shows the signature image above the typed name
4. Test without a signature — verify blank line still appears

---

### Task 4: Run Full Validation and Commit

**Step 1: Run full test suite**

Run: `npm run lint && npm run build && npm run test`
Expected: 0 errors, 0 warnings, clean build, all 1,633+ tests pass

**Step 2: Commit**

```bash
git add src/pages/DeliveryDetail.tsx src/lib/deliveryPdf.ts
git commit -m "feat: add signature canvas to admin/sales rep delivery view + embed in PDF

- Add SignatureCanvas to admin/sales rep completion form (was driver-only)
- Embed captured signature image in delivery receipt PDF above typed name
- Show signature image in driver view after delivery completion
- All changes use existing components, state, and upload logic — no new deps

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

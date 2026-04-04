# Blend Ticket Enhancement Suite (E1–E10) — Design

> Created: 2026-04-04 | Owner: Mason Wells | Status: **Approved**

## Overview

8 improvements to the blend ticket OCR review workflow. 7 are purely frontend (data already exists in DB), 1 needs a small RPC migration.

---

## E1: Per-Product Confidence Display
- Show `confidence_score` pill next to each product row on BlendTicketDetail
- Color: green (>=80), yellow (50-79), red (<50)
- Data already exists in `blend_ticket_products.confidence_score`

## E2: Raw OCR Text Viewer
- Collapsible panel at bottom of BlendTicketDetail
- Toggle: "Show Raw OCR Text" / "Hide"
- Monospace `<pre>` block, only shown when `raw_ocr_text` is not null

## E4: Order Suggestion Enhancement
- Enhance existing suggestion banner on BlendTicketDetail
- One-click "Link to this order" button directly on the banner
- Show top 3 matching orders if multiple match

## E6: Duplicate Detection on List Page
- Add "Dup" warning badge on BlendTickets list for tickets sharing a ticket_number
- Enhance detail page warning with clickable link to the duplicate

## E7: Reprocess OCR Button
- Button on BlendTicketDetail header, available on any completed ticket
- New RPC: `reprocess_blend_ticket_ocr(p_ticket_id, p_performed_by)`
- Resets status='pending', clears confidence, inserts into ocr_processing_queue
- Existing useOCRProcessor auto-picks it up

## E8: Blend Math Validation
- Validation banners on BlendTicketDetail:
  - Total volume vs sum of product quantities (warn if >10% mismatch)
  - Total acres x rate vs total volume (warn if inconsistent)
  - Products with quantity = 0

## E9: Confidence Filter Preset
- Quick-filter chip "Needs Review (N)" above BlendTickets table
- Uses existing useOCRThresholds hook for threshold values

## E10: Low-Confidence Product Highlight
- Yellow background on products with confidence < 70
- "Low confidence — verify" label
- Green "Verified" label on manually_corrected products

---

## Implementation Order
1. E1 + E10 (per-product confidence — detail page products section)
2. E2 (raw OCR text — detail page panel)
3. E8 (blend math validation — detail page banners)
4. E6 (duplicate detection — list + detail)
5. E4 (order suggestion — detail page)
6. E7 (reprocess OCR — migration + button)
7. E9 (confidence filter — list page)

## Migration: 1 total
- `reprocess_blend_ticket_ocr(p_ticket_id uuid, p_performed_by uuid)` RPC

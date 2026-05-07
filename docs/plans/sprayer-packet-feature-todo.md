# Sprayer Packet Feature — TODO (deferred)

**Status:** Awaiting design pass before build. Do NOT start without explicit Mason approval.

## Scope (per Mason's audit Q1, 2026-05-06)

A printable packet for sprayer applicators with:

- Customer + address
- Fields with map preview AND acres
- Chemicals + rates + mixed rate per acre
- Applicator signature line
- Wind / temperature / date lines

**Excluded:** EPA registration numbers, service fee.

**Letterhead:** West York, IL (per Mason's audit Q2).

## Estimated effort

Significant — likely:

- New page/component (likely under `/jobs/:id/sprayer-packet` or similar)
- New PDF generation flow (extend `src/lib/reportPdf.ts` patterns)
- Possibly a new RPC `get_sprayer_packet_data(p_job_id)` to aggregate customer + fields + chemicals + rates
- Map preview integration (Mapbox already in the bundle)
- Applicator signature input (could leverage existing signature capture if present)

## Why deferred

Wave 4 closes the Phase 4 audit. Sprayer packet is a NEW feature, not a fix. It needs a design pass on:

- Single-customer vs multi-customer packet
- One packet per job vs one packet per delivery
- Whether to include re-printing (signed copy archival)
- Print format (PDF only? printable HTML too?)
- Whether the "mixed rate per acre" calc needs new data not currently captured on quotes/orders

Open these questions with Mason before starting build.

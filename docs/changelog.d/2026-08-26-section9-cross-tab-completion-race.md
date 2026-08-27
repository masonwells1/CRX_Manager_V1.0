## 2026-08-26 - Preserve cross-tab completion proof for AP and receiving retries

- Fixed a same-request race where one tab could complete a vendor-bill, payment, or receiving mutation while another tab lost its response, then erase the shared retry record and later mint a duplicate-capable key.
- The durable browser record now uses per-tab claims, request versions, and atomic compare-and-resolve tombstones. A stale failure cannot delete or unlock a newer request version.
- All six affected AP and receiving callers distinguish a peer-tab completion from a definitive rejection or an uncertain response, refresh authoritative state, and avoid repeating non-critical post-receipt side effects.
- Regression coverage proves both race orders: a lost response observes the peer completion as resolved, while a still-later response cannot clear a newer request.

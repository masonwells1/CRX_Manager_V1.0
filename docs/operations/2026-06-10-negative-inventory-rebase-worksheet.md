# Negative-Inventory Re-Base Worksheet — H1 (2026-06-10 ultra review)

**Why this matters:** these 17 products show NEGATIVE available stock in the system.
The negatives came from a window (Mar 19 → Apr 30, 2026) when deliveries were
deliberately allowed to record even without system stock. The stock check is back
on now — which means **every delivery attempt against these products FAILS until
the numbers are fixed.** No code change is needed; this is a count-and-adjust job.

**What Mason needs to do:**
1. Physically count each product below (Main Warehouse).
2. Write the real count in the "Physical count" column.
3. Tell Claude "here are the counts" — Claude will prepare the adjustment
   migration (each correction becomes an `adjusted` ledger row, fully audited),
   run it through the review gate, and apply it.

| # | Product | System says | Physical count | Notes |
|---|---------|-------------|----------------|-------|
| 1 | Water W/ D-Chlorinator | −2,345.00 | ______ | Largest discrepancy |
| 2 | HumiK Bio WSP - 55LB | −1,870 | ______ | |
| 3 | Black Strap Molasses Sugar - Bulk | −1,325 | ______ | **Known mispost pair** — see below |
| 4 | Gen Liberty (Interline, Inflame) - Bulk | −530 | ______ | |
| 5 | PeKacid 0-60-20 | −275 | ______ | |
| 6 | COC XL - Bulk | −265 | ______ | |
| 7 | Gen Dual S Moc (Visor S Moc II, …) | −265.00 | ______ | also has 235 prebooked |
| 8 | Ultramate LQ - Tote | −202.5 | ______ | also has 260 prebooked |
| 9 | Pinzola EC | −175 | ______ | |
| 10 | Boron 10% - Tote | −150 | ______ | also has 87.5 prebooked |
| 11 | Gen Capture LFR (Batallion LFC, Seguro) - 2.5 Gal | −100 | ______ | |
| 12 | Warrant - Bulk | −57 | ______ | |
| 13 | MagnifySi - 2.5 Gal | −32.5 | ______ | also has 85 prebooked |
| 14 | Copper 7.5% - 2.5G | −22.96 | ______ | also has 31.9 prebooked |
| 15 | Gen Sencor (Metribuzin, …) - 5 | −15 | ______ | |
| 16 | Gen Callisto (Explorer, Incinerate) - 1 Gal | −15 | ______ | also has 133.5 prebooked |
| 17 | MSO 84 - Bulk | −11 | ______ | |

## Also count these (positive but suspect — surplus with no ledger backing)

| Product | System says | Physical count | Why suspect |
|---------|-------------|----------------|-------------|
| Black Strap Molasses Sugar - **Tote** | (current) | ______ | The Bulk −1,325 above is a proven Tote↔Bulk mispost; count BOTH variants together |
| Start Right 2.0 **Tote** | (current) | ______ | +530 above its own ledger (≈ 2 totes); receiving evidence was destroyed by an old delete |
| 2,4D Amine 4# - 2.5 Gal | (current) | ______ | Stock was seeded without ledger rows (March) |
| 2,4D Amine 4# - Bulk | (current) | ______ | Same |
| Start Right 2.0 - 2.5G | (current) | ______ | Small unledgered seed (+10) |

**Source:** `docs/audits/2026-06-10-foundation-ultra-review.md` (finding H1) +
the Codex-round disposition. The `reverse_receiving_record` clamp bug that
contributed to the Black Strap pair was fixed live 2026-06-10
(`20260610131048`), so corrections made after today stay consistent.

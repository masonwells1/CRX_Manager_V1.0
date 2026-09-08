## 2026-09-06 — Quote version history lists legacy snapshots instead of hiding them

**Why.** PR #592 added `src/lib/quoteVersionAdapter.ts` to stop untrusted `quote_versions.snapshot_data`
shapes reaching the history and compare views, which read `quote.total_price` and `sections[].items`
as trusted values. The validator was correct, but `adaptQuoteVersionRows` DROPPED every row it could
not parse. A quote whose saved versions are all in the pre-`20260316` flat shape (quote fields at the
top level, no `quote` key) therefore lost its version history entirely: `quoteVersions.length` was 0,
so the `Versions (n)` button never rendered, and each load fired a warning toast plus a
`Sentry.captureMessage`.

Confirmed against live before fixing, read-only: `public.quote_versions` holds 3 rows, and 2 of them
have no `quote` key — both versions of quote `7373e9ac-6897-4bab-b70e-14411935054f`, saved
2026-03-16. That quote would have shown no version history at all, and would have reported to Sentry
on every open. Found by an adversarial review of the merge candidate (finding H1).

**What changed (frontend only).**
- `src/lib/quoteVersionAdapter.ts`: added `adaptQuoteVersionList()`, which splits rows into
  `versions` (snapshot parsed and trusted) and `unreadable` (`id`, `version_number`, `sent_at` —
  columns the row itself guarantees, never a value read out of the snapshot). `adaptQuoteVersionRow`
  and `adaptQuoteVersionRows` are unchanged; the validator was not loosened.
- `src/pages/QuoteBuilder.tsx`: both load sites use the new split. Unreadable versions are listed at
  the bottom of the history card, reading "Saved in an older format · details unavailable" with no
  item count and no total, and are not selectable — so they reach neither the compare view nor
  restore, which the server already refuses for them
  (`QUOTE_VERSION_LEGACY_UNTRUSTED`, `20260826220000`). The version-count button and the history card
  both count them. The per-load warning toast and `Sentry.captureMessage` are removed: a legacy
  snapshot is expected historical data, not an incident.

**Proof observed.** A new rendering test mounts the real `QuoteBuilder` with the two production
legacy shapes and asserts `Versions (2)`, both rows listed with the explanatory text, and no warning
toast. That test was confirmed to FAIL against the pre-fix count (`findByRole` timed out — no
Versions button rendered), so it falsifies rather than passing vacuously. Adapter unit tests cover
the split, the all-legacy case, and that only row columns are carried. Full suite, typecheck, lint,
build, and docs checks pass.

**Not verified.** Not exercised in a browser against live data; the auth-gated page was proven
through a rendered component test using the exact snapshot shapes read from production, not through
a signed-in session.

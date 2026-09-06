## 2026-09-06 — An unreadable saved quote version the server trusts stays reported

**Why.**

The previous change in this branch (`7175335b6`) stopped hiding saved quote versions whose
snapshot this build cannot parse, and listed them as "Saved in an older format · details
unavailable" instead. It also removed the per-load warning toast and `Sentry.captureMessage`,
on the grounds that a legacy snapshot is expected historical data rather than an incident.

That was right for the rows it was written for and wrong for every other row it caught.
`adaptQuoteVersionList` had no way to tell an expected legacy row from a *current* row whose
snapshot failed validation, so both landed in the same bucket, wore the same "older format"
label, and — after the removal — raised nothing at all. If the version writer and this app's
snapshot validator ever drifted apart, every newly saved version would quietly read as
unavailable, Restore and Compare would disappear for versions the server would happily restore,
and no signal would reach anyone.

Found by an adversarial review of `114dee368` and verified against the migration that owns the
column.

**What changed.**

Frontend only. No migration, no schema change, no server behaviour change.

- `src/lib/quoteVersionAdapter.ts` — `UnreadableQuoteVersion` gains `server_trusted`, read from
  the row's own `restore_trusted_at` column. That column is stamped by the current version
  writer and was deliberately never backfilled onto older rows (`20260826220000`), so an empty
  value is the server's own statement that it treats the row as legacy. It is a row column, not
  a value read out of the untrusted snapshot, so it is safe to trust here.
- `src/pages/QuoteBuilder.tsx` — a row the server never stamped still reads "Saved in an older
  format · details unavailable" and stays silent. A row the server *did* stamp reads only
  "Details unavailable" — calling it old would be a guess — and raises one
  `Sentry.captureMessage` per load (not per row) at `error` level, carrying the quote id and the
  affected version numbers. Both load paths report.

**Proof observed.**

- `src/lib/quoteVersionAdapter.test.ts` and `src/pages/QuoteBuilder.test.tsx`: 70 tests pass.
- **Falsification, run before keeping the tests:** forcing `server_trusted` to a constant `false`
  makes exactly the two new tests fail — the adapter test on the flag, and the page test on both
  the label and the missing Sentry report. They fail against the wrong code, so they are not
  passing vacuously.
- The quiet half is pinned too: the legacy-row test now asserts `captureMessage` is *not* called,
  so restoring the old blanket report would fail the suite.
- The same test also pins that an unreadable row is not selectable — it asserts the row carries
  no `role` and no `tabindex`, and that clicking it opens no Restore control. Without this,
  adding a click handler to a legacy row would have passed the suite.
- Full suite, typecheck, lint and build: see the commit.

**Not verified.**

- No live row currently has `restore_trusted_at` set *and* an unparseable snapshot — this path
  is a guard against future drift, not a fix for observed data. Confirmed read-only that the
  live writer's columns and this validator's expectations agree today.
- Not exercised in a real browser: the anomaly branch needs a row that cannot exist without
  writing one, and this change does not alter the rendering path the previous change already
  proved in a browser.

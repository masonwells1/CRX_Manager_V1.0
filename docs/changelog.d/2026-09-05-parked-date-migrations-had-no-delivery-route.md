## 2026-09-05 - Two parked date migrations had NO delivery route, and the harness proving them was hiding it

**Not applied to production.** `20260905020400` and `20260905020500` remain parked with the rest
of the `20260905020*` set. This entry records a fix to the files themselves, not an apply.

## What was wrong

Both files opened their own transaction — a top-level `BEGIN;` … `COMMIT;`
(`20260905020500` lines 94 / 2913; `20260905020400` lines 112 / 486).

`scripts/apply-migration-file.mjs` is the only surviving apply route, and it wraps the migration
**and its `schema_migrations` ledger row in ONE transaction** so the two commit together. A file
that manages its own transaction breaks that pairing — the schema can change with no ledger row,
or the row can land with no migration. So `assertWrappable()`
(`.claude/hooks/migration-wrappability-lib.mjs`) hard-refuses such a file at
`apply-migration-file.mjs:295`, before the apply gate is even evaluated.

The other route is gone: `mcp__supabase__apply_migration` accepts exactly `{name, query}` with
`additionalProperties: false`, while `migration-apply-lib.mjs:325` refuses unless `project_id`
equals the production ref. The guard requires a field the tool cannot carry. Re-verified against
the live tool schema on 2026-09-05, not carried from memory.

Net effect: **both migrations were unappliable by any sanctioned path.** Neither could ever have
reached production in the shape they were parked in.

Found by a Codex review thread on `20260905020500` line 94, opened at `dd1d60200`.

## The harness was accommodating the defect, not testing it

`scripts/smoke/prove-document-dates-chicago.mjs` and `prove-commission-dates-chicago.mjs` both
called `assertWrappable` through a swallowing wrapper:

```js
function isWrappable(text) { try { assertWrappable(text, 'replay'); return true; } catch { return false; } }
```

and then used the boolean to decide whether to pass `psql -1`. A non-wrappable candidate was
therefore applied **without** the single transaction — by the one route the real system will not
use — and the run passed. Four consecutive `ALL PHASES PASSED` runs were honest about what they
executed and silent about the blocker.

The general rule, worth more than this instance: **a harness that branches on a property must not
treat that property as an input when the property is itself under test.**

## What changed

- `20260905020500` and `20260905020400`: the top-level `BEGIN;`/`COMMIT;` are removed. Each file
  now carries a header block naming `assertWrappable`, the ledger-pairing guarantee, and an
  instruction not to re-add the transaction. Every `RAISE EXCEPTION` in the preflight/postflight
  still aborts the whole apply — the wrapper's transaction rolls it back and writes no ledger row.
- `prove-document-dates-chicago.mjs` and `prove-commission-dates-chicago.mjs`: `assertWrappable`
  now runs **unconditionally** on the candidate before any phase reports, and `copyText` — every
  mutant, all of which derive from the candidate — asserts instead of branching. The tolerant
  `isWrappable` path survives only for the replayed historical migrations, where a genuinely
  non-wrappable file is legitimate.

## What this fix does NOT change

Only self-managed atomicity is removed; the apply wrapper's `-1` restores it. Across both files
there is exactly one `SET LOCAL` (`20260905020500` line 335) and no `LOCK TABLE`, and that
`SET LOCAL` sits inside the re-emitted PL/pgSQL body of `_convert_quote_to_order_owner_impl` — it
runs at RPC call time inside the caller's transaction and is unaffected by how the migration file
is applied. The residual hazard is only an operator applying the raw file by hand without `-1`,
which the new header comment names explicitly.

## Still open

`scripts/smoke/prove-invoice-date-fallbacks-chicago.mjs:100` carries the identical
`isWrappable`-then-branch shape. Its subject migration is already applied to production, so it
masks nothing live today, but the pattern will hide the next one. Not fixed here — flagged rather
than folded into this change.

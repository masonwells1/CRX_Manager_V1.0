## 2026-09-04 - Bulk field import: a retry after a failed boundary no longer creates a duplicate field

Closes the HIGH finding parked from PR #535's round-2 `gpt-5.6-sol` review
(`docs/changelog.d/2026-09-04-pr535-sol-round2-own-fix-holes.md`). Mason deferred it on
2026-09-04 with an explicit decision to merge #535 without it and fix it separately.

**This change is stacked on PR #535** (`codex/gauntlet-s9-safety-20260831`, base `37b488b16`).

> **CORRECTION (2026-09-04, Codex `gpt-5.6-sol` finding 11).** The paragraph that stood here said
> the defect "does not exist on `main`" and that this change "is moot and should be dropped" if
> #535 is abandoned. **Both statements are wrong and the advice was unsafe.** On `main` every
> `save_field` call gets a fresh `crypto.randomUUID()`, so a retry can never replay the committed
> save — it calls `save_field(p_field_id: null)` with a new key and duplicates **unconditionally**.
> `main` is worse than #535, not clean. If #535 is abandoned this work must be re-based onto
> whatever carries `useIdempotencyKey`/`fingerprintIntentPayload`, or reimplemented — not dropped.
> See `2026-09-04-bulk-import-retry-codex-round1-fixes.md`.

### The defect

`handleUpload` runs three RPCs per imported row — `save_field`, then `set_field_boundary`, then
`set_field_override_acres` — and #535 gave all three ONE shared intent scope built from the row's
file position plus the boundary geometry plus the stated acreage:

```
`import:${fieldIndex}:${pf.customer_id}:${pf.field_name}:${fingerprintIntentPayload([...])}`
```

`save_field` COMMITS before the other two run and consumes none of that. So when the boundary call
failed and the operator corrected the geometry and re-imported just that row, the row's position AND
its geometry both changed, a fresh idempotency key was minted, `save_field` ran again with
`p_field_id: null`, and the retry created a SECOND field while the first, boundary-less one stayed
orphaned. `fields_delete` RLS is admin-only, so a sales_rep could not clean that up.

### Why not the fix the review recommended

The review recommended generating a stable client-side field id and passing it so the retry updates
instead of inserts. Verified against the live `save_field` definition, that is unsafe:

- with `p_field_id IS NULL` it `INSERT`s and lets Postgres pick the id — there is no client-id path;
- with a non-null `p_field_id` it runs `UPDATE fields ... WHERE id = p_field_id` with **no
  `IF NOT FOUND` check**, then `RETURN`s that id regardless. A client-generated id would update zero
  rows and still report success, after which `set_field_boundary` raises `FIELD_NOT_FOUND`.

That trades a duplicate field for a missing one. Doing it properly needs a new RPC or migration,
which is more than was deferred. Also verified: `check_idempotency` is key-only (no actor or payload
binding), so the client-side scope is the only thing separating two intents here.

### The fix

Per-stage intent scopes, each bound to its own stage's exact payload:

- **`save_field`** is scoped to `fieldIdentity` — the columns `save_field` itself writes — with the
  row's file position replaced by a per-identity occurrence counter. The counter keeps two genuinely
  identical rows on separate keys (so they still become two fields). `fieldPayload` is now derived
  from `fieldIdentity`, so a column added later joins the scope automatically.

  > **CORRECTION (finding 1, BLOCKER).** This bullet claimed the counter "stays stable when only
  > the failed row is re-imported." **That is false.** `saveIdentityOccurrences` is rebuilt on every
  > `handleUpload`, so re-importing only the second of two identical rows makes it `#0` — replaying
  > the first row's key, or minting a new one and duplicating. Not fixed; a stable cross-invocation
  > ordinal cannot be derived from file content alone.
- **`total_acres` is deliberately excluded** from that identity, which is what lets a corrected-
  geometry retry replay instead of inserting.

  > **CORRECTION (finding 3, HIGH).** The justification that stood here — that `set_field_boundary`
  > overwrites it so the seeded value "never survives" — is **false on the failure path**. It is
  > overwritten only when the boundary call SUCCEEDS. When it fails, the seeded value persists on
  > the orphaned field indefinitely, and a corrected retry replays the save receipt so the corrected
  > acreage never lands. The exclusion is still correct; the stated reason was not.
- **`set_field_boundary`** and **`set_field_override_acres`** each bind to the field id `save_field`
  actually returned plus their own payload. A corrected boundary is genuinely new work and correctly
  mints a fresh key; an unchanged retry still replays.

**Retirement stays at ROW completion, not per stage** — deliberately contrary to the review's third
recommendation. Retiring `save_field`'s key at its own success would RE-CREATE the bug: `save_field`
has already committed by the time the boundary call fails, so a retry would find the key gone, mint a
fresh one, and insert a second field. Its key is the only thing preventing the duplicate, so it must
survive until the row as a whole is done.

### Verification

- **The retry sequence was executed**, not just asserted. `BulkFieldImport.retry.test.tsx` drives the
  real component through the real `handleUpload` and the real `useIdempotencyKey` hook (only the
  network boundary and the file parser are mocked): import a row, fail `set_field_boundary`, correct
  the geometry, re-import. It asserts `save_field`'s second call carries the SAME key and that the
  corrected boundary lands on the original field id.
- **That test was proven to detect the defect.** Against PR #535's component at `37b488b16` it goes
  RED with `expected 'save_field:user-1:67505275…' to be 'save_field:user-1:be251e98…'` — the two
  different keys that are the bug — and GREEN against the fixed component. Source restored
  byte-identical afterwards.
- **The guard test was made mutation-resistant and proven so.** It previously asserted the three
  `getKeyFor` calls but none of the three `resetKeyFor` calls, so deleting stage retirement left it
  green. Five mutations now each turn it RED: deleting all three resets; deleting only the
  `save_field` reset; retiring `save_field` with the wrong scope; moving `total_acres` back into the
  intent identity; and putting the row's file position back into the scope.
- `npm run lint` clean, `npm run test` 356 files / 5017 passed / 0 failed, `npm run build` succeeded,
  `tsc --noEmit` clean.

### Reported, not fixed

- **LOW — `fingerprintIntentPayload` main-thread cost.** Measured rather than assumed: 18.3 MB of
  GeoJSON hashes in **362 ms**, so a 25 MB import costs roughly half a second of blocking, once,
  spread across rows and dwarfed by the 1–3 network round trips each row already makes. Real but
  modest; not worth a shared-hash redesign on #535's own new code. This change also removes the
  boundary from `save_field`'s scope, so the geometry is no longer hashed on the create path.

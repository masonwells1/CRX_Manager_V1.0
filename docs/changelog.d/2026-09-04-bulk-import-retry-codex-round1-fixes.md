## 2026-09-04 - Bulk field import retry: close the Codex round-1 findings and correct three false claims

Adversarial review of `d6f9fc9c` by `gpt-5.6-sol` at high reasoning effort, prompted for EVERY
finding at every severity with the author's own comments treated as claims to falsify. Run
confirmed complete (`tokens used` marker present, no 404/quota). Result: **34 findings** —
2 BLOCKER, 9 HIGH, 14 MEDIUM, 5 LOW, 4 QUESTION.

The diff was inlined into the prompt rather than reviewed via `scripts/write-codex-push-proof.mjs`,
because that wrapper's base is pinned to `origin/main...HEAD` and this branch is stacked on PR #535
— the wrapper would have reviewed ~30 commits of #535's work with these 4 files buried inside.
**This run therefore did NOT mint the exact-SHA proof JSON and is not the push gate.** That artifact
gets minted after the rebase, when `origin/main...HEAD` honestly means this commit alone.

### Fixed — both blockers, verified by mutation

- **An override failure retired the `save_field` key while the row was unfinished** (finding 2,
  which Sol rated 75% because the hunk elided the relevant lines — **confirmed from source at
  100%**). Retirement was gated on `boundaryOk` alone. A rejected `set_field_override_acres` was
  caught into `warnings`, execution fell through to `success++`, and all three keys were retired.
  Retrying the acreage then minted a fresh save key and **inserted a second field** — the exact
  defect this branch exists to close, on a different path. Retirement is now additionally gated on
  a new `overrideOk` flag. An out-of-band stated acreage remains a deliberate skip (the row is
  complete, billing on measured); only a rejected RPC blocks retirement.

- **The guard was vacuous about the occurrence counter** (finding 24). It asserted that
  `saveOccurrence` appeared in the scope string but never that it was read from
  `saveIdentityOccurrences` or incremented. **Verified by running the mutation:** replacing the
  whole counter with `const saveOccurrence = 0;` left the guard AND the behavioral suite green
  while every identical row collapsed onto one key. The guard now pins the map declaration, the
  read and the increment.

### Fixed — the missing behavioral coverage (findings 19 and 20)

Two tests added, and **one of them was vacuous on first writing** — caught by mutation, not by
review:

- **Override failure → retry must not duplicate.** No test previously called
  `set_field_override_acres` at all. This required mapping an acre-denominated column through the
  stubbed `AttributeMappingStep`; without it `pf.stated_acres` is null and the override RPC is
  never invoked, so the test would have passed while proving nothing.
- **A second identical row must get its own key.** The first version of this test had both rows
  succeed — and it stayed GREEN with the counter neutered. Reason, confirmed by dumping both
  payloads (byte-identical) and both keys (different): **row 1 retires its scope at row completion
  before row 2 starts**, so row 2 mints a fresh key regardless. The counter only does work while an
  earlier identical row's key is still RETAINED, i.e. after that row failed. The test now fails
  row 1's boundary first. It also required mapping `field_name`, without which each row falls back
  to `Imported Field ${i + 1}` and the rows are never actually identical.

### Corrected — three claims in `2026-09-04-bulk-field-import-retry-duplicate-field.md` were false

- **"the counter stays stable when only the failed row is re-imported"** — FALSE (finding 1,
  BLOCKER). `saveIdentityOccurrences` is rebuilt per `handleUpload`. Given two identical rows, if
  only the second one is re-imported it becomes `#0` and either replays the first row's key or, if
  that key was retired, mints a new one and duplicates. **Not fixed**: a stable ordinal across
  invocations cannot be derived from file content alone. See the accepted limits below.
- **"the value `save_field` stores never survives"** (about `total_acres`) — FALSE on the failure
  path (finding 3, HIGH). It is overwritten only when `set_field_boundary` SUCCEEDS. On the
  boundary-failure path — precisely the path this fix addresses — the seeded value persists on the
  orphaned field indefinitely, and a corrected retry replays the save receipt so the corrected
  acreage never lands. Excluding it from the identity is still right (it is what makes the retry
  replay at all), but the stated justification was wrong.
- **"the defect does not exist on `main`… if #535 is abandoned this change is moot and should be
  dropped"** — WRONG AND UNSAFE (finding 11, HIGH). On `main` every `save_field` call gets a fresh
  `crypto.randomUUID()`, so a retry can never replay the committed save; it calls
  `save_field(p_field_id: null)` with a new key and duplicates **unconditionally**. `main` is worse
  than #535, not clean. This work must not be dropped if #535 is abandoned — it must be re-based
  onto whatever carries `useIdempotencyKey`/`fingerprintIntentPayload`, or reimplemented.

### Accepted limits — NOT fixed, and not fixable in the client

These are real and remain open. Stated here so nobody reads a stronger guarantee into this change
than it gives:

- **A remount, refresh, logout, route change or browser restart loses the key map** (finding 8) and
  a retry after that duplicates. The map is in-memory for the component's lifetime.
- **Server receipt expiry defeats it** (finding 7). `check_idempotency` deletes expired rows; after
  that window a retained client key replays nothing and `save_field` inserts again. The retry
  window is bounded by a lifetime neither the UI nor this note states.
- **Correcting any `save_field`-owned attribute duplicates** (finding 9) — a typo fix in
  `field_name`, county, FSA numbers or notes changes the digest, so the retry inserts rather than
  repairing the committed field.
- **Re-importing a whole mixed-result file duplicates every previously successful row** (finding
  10), because those rows retired their keys. This is a common operator workflow.
- **Cross-invocation ordinals for duplicate-identity rows** (finding 1) and **reordering identical
  identities** (finding 5) can still misattribute a boundary.

Every one of these needs a durable field identity the client can hand to the server — a new RPC or
a migration, which is more than was deferred here. Findings 12-13 (FNV-1a collision surface),
16-18 (JSON.stringify representation vs semantic stability), 14-15 (key leaks) and 26-30 (further
guard weaknesses) are also open. **Net position: strictly better than `d6f9fc9c`, and far better
than `main`, but not a general guarantee.**

### Verification

`npm run lint` clean · `npm run test` 356 files / **5019 passed** / 0 failed · `npm run build`
succeeded · `tsc --noEmit` clean.

Mutation-proved, source restored byte-identical after every run:

- `B2` revert the `overrideOk` gate → guard RED, behavioral RED
- `B2b` keep the gate but never set `overrideOk = false` (present but cannot fire) → guard RED,
  behavioral RED
- `S24` neuter the occurrence counter → guard RED, behavioral RED
- plus the original five (delete all three resets; delete only the `save_field` reset; retire with
  the wrong scope; move `total_acres` back into the identity; put the file position back into the
  scope) → all still RED

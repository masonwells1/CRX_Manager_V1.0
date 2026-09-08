## 2026-09-08 — runtime proof for the per-call idempotency key, and three comments that still argued the other way

A Codex session independently verified PR #535 against a snapshot taken at `335275f7e`,
about forty minutes before `63e468b59` withdrew the bulk-import retained idempotency key.
It reproduced a real corruption path in that snapshot: two rows with identical mapped
metadata but different ground, where the first row's response is lost, made the second row
reuse the first row's creation key, receive the first field's id, and write its own
boundary onto that field. The candidate's collision map was populated only after a
successful response, so it could not see the committed-but-unacknowledged first field.

**That finding is aimed at a superseded artifact.** The current candidate has no collision
map, no retained key and no content-derived scope — all three RPCs mint a fresh
`crypto.randomUUID()`. Verified against the source, not inferred: `BulkFieldImport.tsx`
contains exactly three `p_idempotency_key: crypto.randomUUID(),` lines and no
`getKeyFor(`, `useIdempotencyKey(`, `createdFieldIds` or `fingerprintIntentPayload(`.

### What was worth keeping

Codex's regression test, adapted. `gauntletFrontendSafetyGuards.test.ts` pins the settled
decision by **source text**, which proves the file is spelled correctly and says nothing
about what the screen does when a response is lost. There was no runtime coverage of that
path anywhere: `p_idempotency_key` appeared in no test under `src/components/fields/`.

`src/components/fields/BulkFieldImport.perCallKey.test.tsx` now drives the real component
through the real upload handler against a `save_field` fixture that replays a repeated key,
which is what the live RPC actually does — `20260729222311_bind_save_field_actor.sql` calls
the two-argument `check_idempotency`, matching on key and operation with no payload
fingerprint. Three cases: two same-metadata rows with different ground stay on separate
fields, the same with the first reply lost, and a re-import after a lost reply creating a
SECOND field rather than replaying.

Adapted rather than copied. Codex's version asserted `queryByText(/identical to an earlier
row/i)` is absent — a string that belonged to the withdrawn collision map and no longer
exists in `src/`, so the assertion could never fail. It is replaced with the property under
test asserted directly: the two `save_field` calls must carry different keys. Codex's other
new test is deliberately NOT carried over; it asserts key reuse across a re-import, which
pins the retained key `63e468b59` removed.

Mutation-proven twice, independently: reintroducing a retained content-derived key on
`save_field` alone fails all three tests.

**Limits, stated plainly.** The network boundary, auth, parser and child steps are mocked.
`set_field_boundary` and `set_field_override_acres` are stubbed in a way that ignores
`p_idempotency_key` and `p_performed_by`, so this file proves nothing about those two keys.
It is not browser proof and not database proof.

### Three comments removed

The revert left prose that still argued for the scheme it removed, directly above code that
does the opposite:

- a truncated dangling sentence, `// A field id already seen in this run means this row is
  byte-identical to an`, spliced onto the next comment;
- a five-line note claiming the boundary key is "keyed by the field this boundary lands on
  and the geometry itself — NOT by the save_field scope", sitting above a fresh UUID;
- a fourteen-line block headed `// The keys are deliberately NOT reset here.` arguing that
  "retaining the key is also the right rule on its own terms".

Given that this screen has now had four schemes attempted and withdrawn, a comment telling
the next reader that a retained key is intended is the most likely way the decision gets
re-litigated a fifth time. The accurate note explaining the decision remains in the file.

### Proof

`tsc` clean, lint clean (0 warnings), `npm run test:correction-guards` exit 0,
`check-doc-drift` clean, full vitest suite 372 files / 5222 passed / 123 skipped / 0 failed.

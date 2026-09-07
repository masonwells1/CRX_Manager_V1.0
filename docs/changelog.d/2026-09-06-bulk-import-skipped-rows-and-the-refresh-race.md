## 2026-09-06 - Warn about rows the field import SKIPPED, and stop presenting one refresh as settled

Sixth Codex round on the same PR. Two P1s, both real, both reachable from the results screen.

### Finding 1 - a file with invalid rows warns about nothing

`handleUpload` imports `parsedFields.filter((f) => f.isValid)`, so rows the parser rejected are
never attempted and never reach `results.failed`. The "do not re-import this whole file" warning
was gated on `(created > 0 || unknownOutcome > 0) && failed > 0`.

So for a file of, say, eight good rows and two bad ones, all eight import cleanly, `failed` stays
zero, and the screen says nothing at all. But the operator now has a reason to come back: the two
bad rows. They fix those in the spreadsheet, re-upload the same file, and duplicate all eight
fields that already landed. The silence was worst in the case most likely to bring them back.

The condition now also fires on `invalidCount > 0`, and a new line names the skipped rows and says
to put them in a NEW file containing only them, rather than re-sending the whole one.

### Finding 2 - a refreshed list can be honestly current and still not show the write

The previous round made the import await the parent refresh and report failure. But the refresh is
a single immediate snapshot. When a `save_field` response is lost while PostgreSQL is still
processing the request, that refresh can complete before the transaction commits: `fetchFields`
truthfully returns `true`, and the screen then sent the operator to that list to decide whether the
field exists. Not finding it, they re-import - just as the original write becomes visible.

The unknown-outcome copy no longer treats the refreshed list as settling the question. It says the
list was reloaded, that a write still going through may not be in it yet, and to wait, reload the
page, and confirm the row is really absent before importing it again.

### Verification

- `npm run typecheck` clean, `npm run lint` clean, `npm run build` succeeded.
- Full suite - 353 files, 5028 passed, 0 failed, 123 skipped.
- Two new tests in `src/components/fields/BulkFieldImport.duplicateWarning.test.tsx`. The first
  drives a two-row file whose second row fails parser validation and whose first row imports
  perfectly, and asserts the warning appears anyway. The second drives a lost `save_field`
  response with a refresh that reports success, and asserts the screen still says the row may not
  be in the list yet.
- **Thirty mutations (six new), each verified to be a real edit and not a silent no-op, source
  restored byte-identical after every run - all caught.** Three gate the warning back on `failed`
  alone, suppress the skipped-row line, and restore the copy that treated the refreshed list as
  authoritative; three more cover the rendering defects below. Two older mutations were re-anchored
  onto the rewritten condition, preserving exactly what each destroyed.
- **Rendered and looked at** - and that is the only reason three further defects were found, none
  of which any passing test noticed:
  - The closing line, "Re-import only the rows below...", rendered on a file where nothing failed,
    so there was no list below. It pointed at an empty box and away from the skipped rows, which
    were the only thing to act on. It is now shown only when there is an error list.
  - "That includes every row below saying a field was created" made the same claim in the same
    case, and is now conditional too.
  - JSX drops the whitespace between an expression that ends a line and the text on the next, so
    the new copy read "confirm that row **isreally** absent before importing **itagain**." Fixed
    with an explicit space, and asserted on the joined words - the shape of the bug is invisible to
    an assertion that only checks the surrounding phrases.
- Not verified: no live-database round trip. The Supabase boundary is mocked throughout.

### Still open - unchanged

Re-importing still duplicates. This is operator guidance, not a fix. Durable protection needs a
stable per-row idempotency key and server-side reconciliation - ideally one atomic RPC creating
field, boundary and override in a single transaction - which is a migration awaiting Mason's
decision.

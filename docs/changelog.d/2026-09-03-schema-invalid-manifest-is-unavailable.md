## 2026-09-03 - a schema-invalid manifest reads as UNAVAILABLE, not as empty

**Class:** fail-open provenance. Ninth instance of the shape on PR #565, in a helper that was kept.

`scripts/sync-agent-workflows.mjs` — `previousManifest()`.

## What was wrong

The helper answered "is `generated-manifest.json` usable?" with `known: true` for any
valid JSON, whatever its shape. It read `parsed.managed` off the parsed value and fell
back to `[]` when that was not an array, so `[]`, `"text"`, `7`, `{"version":1}` and
`{"managed":"invalid"}` all reported a confident **"nothing was ever managed"**.

`checkExpected()` ands `prior.known` into `trackingKnown`, which is the switch that
grants the importer-directory exemption. A corrupt manifest therefore bought the
exemption for every `skills/source-command-*/` directory at exactly the moment the
record of what the last sync generated had become unusable — the same fail-open shape
already fixed in `gitKnownTargetPaths()` (unknown read as "nothing is tracked").

Found by CodeRabbit on PR #565, round 9.

## What changed

`previousManifest()` now validates the shape it actually writes: a plain object whose
`managed` is an array of strings. Anything else returns `known: false` and fails closed,
identical to the existing unparseable branch. The operator note was reworded to cover
both causes ("unreadable **or** is not the `{ version, managed: string[] }` shape").

The helper is now exported so the regression can test it directly.

## Scope

Nine lines of logic plus a comment. This is the ninth instance of the fail-open shape on
this PR, but it sits inside a helper that was **kept** — it is not the durable
`ownedImporterDirs` layer coming back. That layer was cut on Mason's call and stays cut;
the accepted gap is still pinned by test case (d).

## Proof

- New test case (i) in `scripts/sync-agent-workflows.test.mjs`: nine invalid shapes each
  assert `{ managed: [], known: false }`; a well-formed manifest (populated and empty)
  still answers `known: true`, so the provenance source was not simply disabled.
- Mutation 1 — restore the old permissive return: RED on `a top-level array must report
  the record as UNAVAILABLE, not as an empty managed list`.
- Mutation 2 — drop only the element-type check: RED on `managed holding non-strings`.
- Real path: with the live `.agents/generated-manifest.json` replaced by `[]`,
  `npm run check:agent-workflows` fails and prints the new note stating the exemption is
  withheld. Manifest restored; tree clean.
- `npm run test:agent-workflows` green (whole suite), `npm run lint` clean.

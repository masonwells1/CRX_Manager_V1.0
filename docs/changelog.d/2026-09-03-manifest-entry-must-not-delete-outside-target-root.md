## 2026-09-03 - a manifest entry must not delete outside the target root

**Class:** unvalidated input reaching a delete. Round 10 on PR #565, from an independent
Codex review of the round-9 fix recorded in
`2026-09-03-schema-invalid-manifest-is-unavailable.md`.

`scripts/sync-agent-workflows.mjs` — `writeExpected()` and `previousManifest()`.

## How it was found

`gpt-5.6-sol` at high reasoning effort, run through the Codex CLI in an isolated temp
workspace holding only the diff and the two touched files — no repo agent-instruction files
for the reviewer to self-recurse on. It was asked for every finding at any severity and
returned three. All three were confirmed against the real code before anything was changed.

## 1. HIGH — a manifest entry could delete a file OUTSIDE `.agents/`

`writeExpected()` prunes by `rmSync(path.join(targetRoot, entry), { force: true })` for every
`managed` entry that is no longer generated, and entries were only checked to be strings. So
a manifest holding

```json
{"version":1,"managed":["../package.json"]}
```

resolved out of the target root on `--write` and deleted a repository file. On Windows
`"..\\.git\\index"` reaches the git index the same way. Empty, NUL-bearing, absolute and
drive-rooted entries were equally unchecked.

**Pre-existing, not introduced by the round-9 commit** — the old
`Array.isArray(parsed.managed) ? parsed.managed : []` passed arbitrary strings through too.
It is fixed here because this is where `managed` is now validated.

Closed in two independent layers:

- `isSafeManagedEntry()` rejects an entry that is empty, absolute, drive- or UNC-rooted,
  backslash- or NUL-bearing, or holds a `.`, `..` or empty path segment. Entries are written
  as relative unix paths, so anything else means the record is not one this generator wrote.
- the prune loop re-checks containment itself before deleting. A delete does not get to
  assume its caller validated, and this line is reachable from any caller of `writeExpected()`,
  not only from `previousManifest()`.

## 2. MEDIUM — the declared `version` was never checked

`{"managed":[]}`, `{"version":null,"managed":[]}` and `{"version":2,"managed":[]}` all read as
authoritative, while the operator note claimed the `{ version, managed }` shape had been
validated — a comment out-claiming the code. `previousManifest()` now requires an **own**
`version` exactly equal to `MANIFEST_VERSION`, so a manifest written by a different generator
reads as unavailable instead of being parsed on a guess.

## 3. LOW — an inherited `managed` satisfied the check

With `Object.prototype.managed` set anywhere in the process, `{"version":1}` read the
inherited array and returned `known: true` — a schema-invalid manifest promoted to an
authoritative empty record. Both keys now go through `Object.hasOwn`.

## Proof

- Case (i) pins **21** invalid shapes at `{ managed: [], known: false }`: unparseable, wrong
  top-level type, bad `managed` type, missing/null/wrong/string `version`, and nine path
  shapes that could escape the target root. A well-formed manifest — populated and empty —
  still answers `known: true`, so the provenance source was not simply disabled.
- Case (j) runs `writeExpected()` end to end against a real file outside the target root, with
  a manifest holding `["../package.json","skills/../../package.json"]`, and asserts the file is
  still there afterwards.
- The prototype-pollution regression sets `Object.prototype.managed`, tears it down in a
  `finally`, and asserts the fixture is gone.
- **Six mutations, each RED on the case it targets:** the old permissive return
  (`a top-level array`); the element-type check (`managed holding non-strings`); the
  path-segment check (`a parent-escaping entry`); the `version` + `hasOwn` checks
  (`version missing`); the `managed` `hasOwn` alone (`an inherited managed must not make a
  schema-invalid manifest authoritative`); and **both deletion layers off**, which deletes the
  outside file and fails case (j) with `ENOENT` — the negative control proving that test can
  detect the deletion at all.
- **Layer isolation:** with `isSafeManagedEntry()` disabled but the containment check left in,
  case (j) still passes. Each layer is independently effective, so neither is decoration.
- `npm run test:agent-workflows` green (whole suite), `npm run lint` clean, pre-push typecheck
  and build passed.

## Not reopened

The durable `ownedImporterDirs` layer stays cut (Mason's call, after eight rounds). The Codex
charter named that gap as deliberate and out of scope, and the reviewer confirmed it did not
report it. Test case (d) still pins the accepted gap.

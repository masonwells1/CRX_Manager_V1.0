## 2026-09-03 - importer-directory ownership now survives a `--write`

**Class:** guard hole (fourth in the importer-exemption series). **Outcome:** a file left behind in a
directory the generator used to own is still reported as drift after the manifest is rewritten.

Follows `docs/changelog.d/2026-09-02-overnight-removed-and-importer-exemption-narrowed.md`, which
added the "previously generated" condition. That condition was correct but its memory was too
short-lived.

## The hole

Raised by Codex as P2 on PR #565, against `scripts/sync-agent-workflows.mjs`. The sequence:

1. `skills/source-command-demo/` is genuinely generated, and also holds an extra `manual.md`.
2. The canonical `.claude` command is deleted.
3. `--write` prunes `SKILL.md` — `writeExpected()` removes only the *files* the old manifest named,
   so the directory survives with `manual.md` still in it — and rewrites `managed` wholesale from
   the current expected set, which no longer mentions the directory at all.
4. The next `--check` reads `previousManagedFiles()`, finds no trace of the directory, and so the
   "previously generated" condition cannot fire. `manual.md` is classified as importer litter:
   warning, then `PASS`.

Net effect: instructions that were never generated from `.claude/` live on under `.agents/` and the
parity check reports success. That is the exact invariant the exemption was written not to break.

## The fix

`generated-manifest.json` now carries a second, **durable and monotonic** field alongside `managed`:

```json
{ "version": 1, "managed": [ ... ], "ownedImporterDirs": [] }
```

`managed` still describes only the last sync. `ownedImporterDirs` accumulates every
`source-command-*` directory the generator has ever owned and is carried forward across every
`--write`, so step 4 above still knows the directory is ours. `classifyExtras()` takes it as
`previouslyOwnedDirs` and seeds the owned set with it.

The list grows only when a canonical command is itself named `source-command-*`, which is normally
never — the field is `[]` today. A stale entry only ever makes the check **stricter**: a genuine
importer directory that reused that exact name would fail loudly instead of being exempted, which is
the safe direction.

The alternative Codex offered — delete the whole formerly managed directory on `--write` — was not
taken. It would recursively remove files the generator never wrote, against Mason's 2026-09-02
decision to keep importer output visible rather than delete it.

## Verification

Ran, not inferred.

**Mutation test.** The new case (d) in `scripts/sync-agent-workflows.test.mjs` was proven to depend
on the fix: with `previouslyOwnedDirs` dropped from the owned set, it fails with
`durable ownership outlives the manifest rewrite`, actual `['source-command-demo']` vs expected
`[]`. Restored, the suite prints `OK`.

**Live parity.** After the schema change `--check` correctly reported
`FAIL generated-manifest.json is stale`; `--write` regenerated it (`Synced 37`), and `--check`
returned `PASS - 37 Codex workflow file(s) match .claude sources.` The manifest diff is two lines.

No other file in the repo parses `generated-manifest.json`, so the added key has no other consumer.

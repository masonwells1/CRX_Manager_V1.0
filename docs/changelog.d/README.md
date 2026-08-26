# `docs/changelog.d/` — one file per change

Write your changelog entry as a **new file in this folder** instead of appending to
`docs/CHANGELOG.md`.

## Why

`docs/CHANGELOG.md` is a single file over 15,000 lines long. Every parallel session
appends to the top of it, so any two sessions working at once collide there. On
2026-08-25, **12 of 13 open PRs** touched one of the shared ledger documents, and a
merge conflict in this file blocked a finished PR at the last step.

Two sessions never write the same path here, so there is nothing to conflict on.

## How

Create `docs/changelog.d/<YYYY-MM-DD>-<short-slug>.md`:

```text
docs/changelog.d/2026-08-25-fail-closed-save-job-smoke.md
```

Write the same content you would have put in `CHANGELOG.md` — start with a `##`
heading naming the date and the change, then the detail. Say what changed, what
proof you observed, and what you did **not** verify.

This satisfies the pre-commit ledger guard (`scripts/check-ledger-update.mjs`), so an
agent-surface or migration commit is recorded without touching the shared file.

## What is enforced, not just asked

Both of these are checked by `scripts/check-ledger-update.mjs`, so a commit that gets
them wrong is blocked rather than merely discouraged:

- **The filename must be `<YYYY-MM-DD>-<slug>.md`**, flat in this folder. A bare
  `notes.md` satisfies nothing. The slug is lower-case; the date must be zero-padded.
  The pattern lives in one exported `ENTRY_RE`, so any future consolidation tool can
  import it rather than re-expressing it and drifting.
- **The entry must be ADDED by this commit.** Modifying or deleting an existing entry
  does not satisfy the requirement, because it records nothing about the change you
  are making. This is what stops one session's commit riding on another session's
  entry.

## Rules

- **One file per change.** Do not append to someone else's entry.
- **Never edit an existing entry to satisfy the guard.** Record what actually
  changed. A throwaway line to get past a red hook is the failure this guard exists
  to prevent.
- **`README.md` does not count.** The guard explicitly refuses it, so editing these
  instructions cannot stand in for recording a change.
- `docs/CHANGELOG.md` is unchanged and remains the history for everything written
  before this convention. It is still a valid ledger file — this folder is the
  preferred path, not the only one.

## Consolidating

Entries accumulate here. Nothing consumes them automatically, and nothing needs to —
`docs/CHANGELOG.md` remains the history for everything written before this convention,
and these files are readable as they are.

A consolidation tool that merges entries into `docs/CHANGELOG.md` is deliberately NOT
part of this change. It deletes the files it consumes, so it needs a higher bar than the
convention itself; it ships separately once it has one.

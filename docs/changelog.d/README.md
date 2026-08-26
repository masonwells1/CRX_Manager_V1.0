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
  `scripts/assemble-changelog.mjs` imports the same predicate, so the guard and the
  assembler can never disagree about what counts as an entry.
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

`node scripts/assemble-changelog.mjs` previews merging these entries into
`docs/CHANGELOG.md`; add `--write` to actually do it. It is deliberately manual and
wired into no hook — consolidation is a moment to read what shipped, not a step to
automate away.

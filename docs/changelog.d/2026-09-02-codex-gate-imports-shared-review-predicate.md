## 2026-09-02 - Codex merge gate imports the shared review predicate instead of mirroring it

CodeRabbit finding on PR #560 (`CHANGES_REQUESTED`, one actionable comment). Fixed.

## What it caught

`.codex/hooks/production-action-guard.mjs` defined its own `pullRequestReviewBlocked` rather than
importing the one in `.claude/hooks/codex-push-lib.mjs` — a module it already imports nine other
symbols from.

## Why it mattered more than a style nit

**Mirroring a predicate is exactly how the two merge gates drifted apart in the first place.** The
Codex `Medium` finding on PR #559 was that the Codex-side gate still required `APPROVED` while the
documentation claimed both sides had moved to blocking only `CHANGES_REQUESTED`. Repairing that
drift by introducing a *second* copy of the predicate would have rebuilt the very mechanism that
caused it.

Importing it makes drift **structurally impossible** rather than a matter of discipline, and keeps
`.claude/hooks` the single source of truth for what a review verdict means. Behaviour is unchanged:
same predicate, same `CHANGES_REQUESTED` denial, still not exempt for auto-merge.

## Deliberately left alone

The Codex guard still carries an unused local `pullRequestApproved` mirror. It is unreferenced
anywhere outside its own file and therefore inert. Removing it is dead-code cleanup beyond what the
review asked for — worth a separate tidy-up, not a drive-by edit on a fix for a live hole.

## For the record

PR #559 merged at `306d1e263` **before** its review findings were fixed, so the `--auto` objection
bypass and the un-migrated Codex gate were briefly live on `main`. PR #560 closes both.

## Verification

`codexGuard` protected-source blobs re-pinned — a non-identity transform, so the output blob came
from the producer test's printed candidate and was never hand-computed.

| Check | Result |
|---|---|
| Codex `production-action-guard` | OK |
| `pr-merge-guard` | 97 assertions |
| producer protected-source pins | 87 + 308 assertions |
| `check-agent-guidance` | PASS |

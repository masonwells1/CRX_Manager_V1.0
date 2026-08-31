## 2026-08-31 — A scan narrower than the rule it enforces, and a PR column that ages

Round 7 of Codex review on PR #529. Three findings, all correct; two of them defects in the audit
that had, one commit earlier, claimed to be thorough.

### The re-audit enforced a rule it did not fully implement

The previous round wrote a standard — *a record whose text says work is open may be archived only by
citing the later evidence that closed it* — and then applied it with a marker list that omitted
`NOT DONE`, `## Remaining`, `## Activation follow-ups`, and `## Also outstanding`. Four archived
records went unexamined, one of them
`handoffs/2026-08-12-field-mode-reliability-gauntlet.md`, which carries `## NOT DONE` as a literal
heading.

This is the same failure as every prior round in this PR, one level up: not a wrong rule, but a
check narrower than the rule it was written to enforce. The rule read as complete; the thing
verifying it was not. The corrected marker list is now written into the archive README so the next
cleanup inherits it instead of reinventing a narrower one.

### The summary did not add up

Five incidental records, one archived-on-evidence, four moved back is ten — and the entry claimed
six incidental against a flagged total of ten. Plain arithmetic, reported and fixed.

### Corrected classification

**Six records moved back** to the live folders because their open section still binds — the four
from the previous round plus:

- `docs/audits/2026-07-14-offline-receipt-concurrency-interruption-proof.md` — the queued server
  contract must not be wired to driver phones until its stated conditions hold. A live activation
  gate, not a historical note.
- `docs/handoffs/2026-07-30-push-guard-round23-codex-closeout.md` — `## Also outstanding`, carrying
  a standing `--verify-remote` obligation after any `CRX_Backups` push.

**Three archived with their later disposition cited**, per the standard: the live-SQL-guard handoff
via `2026-08-28-escape-string-scanner-maintenance-complete.md`; the field-mode gauntlet via
`609968d6` ("fix: harden field mode async recovery (#391)", 2026-08-13 — the same commit that added
the record, so its `NOT DONE` list scopes one overnight cycle rather than the work); and the offline
stage1b receipts review via the 2026-07-14 `docs/CHANGELOG.md` entry recording all three
offline-receipt migrations applied live.

That third citation took a second attempt. It first pointed at the record's own
`## Implementation follow-up — 2026-07-14` section — which ends "The migration remains queued and
unapplied live. A fresh exact-HEAD Claude review is required", and therefore closes nothing. Citing
a follow-up that leaves the gates open is not evidence of closure; it only looks like it because the
heading says "follow-up". The real disposition is the changelog entry and the applied migration
chain (`20260714171331`, `20260714171800`, `20260714172135`, plus corrective `20260714203709`).

Final counts: **16 archived, 14 kept live.** The README carries the per-record accounting so the
classification is reproducible rather than asserted.

### A matching tip OID does not freeze the PR column

The branch report told a reader to confirm the tip OID before deleting. That is necessary and not
sufficient: **a branch can acquire an open pull request without a single commit being pushed to it**,
so the content check and the PR check can disagree, and only one of them was required.

The demonstration is in the report itself — its PR scan stops at #528, and #529, the pull request
carrying the report, is already past it. The deletion procedure now requires a fresh PR lookup
alongside the `ls-remote` check, and says to leave any branch that has since gained an open PR alone.

### Proof observed

- `git diff --name-status origin/main -- docs/archive/2026-summer-closeout/` reports 16 added paths.
- Re-scanning the 16 with the corrected marker list flags exactly the three archived-with-citation
  records and nothing else.
- `609968d6` verified by date, title, and a diff touching `src/lib/offlineSync.ts`,
  `src/pages/FieldRoute.test.tsx`, and the gauntlet record itself.
- `npm run check:docs` passes.

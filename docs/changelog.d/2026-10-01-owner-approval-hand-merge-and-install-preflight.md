## 2026-10-01 — owner-approval route hand-merged by Mason; field-season install preflight refreshed

- `docs/manual/DECISION_LOG.md`: new 2026-10-01 entry. Sol's first exact-SHA finding on PR #857
  (the pinned key and Windows Hello helper were read from the checkout unchecked) was fixed in #857
  itself. Its second finding (the verifier is code in the same checkout) is the residual already
  recorded on 2026-09-29. Mason accepted it ("I'll merge 857") and merged #857 himself as
  `653addd6b`; no agent merged over a Sol HIGH. The entry names the way to close it: a GitHub
  Actions apply on protected `main`, which is a separate project needing Mason's go.
- `docs/reference/migration-history.md`: the 2026-10-01 live-ledger capture now also records the
  22:23 UTC read-only read taken right after the merge. It is identical to the morning read: 1013
  rows, `max(version)` `20260928025520`, effective high-water `20260914100900`, and the four
  field-season files `20260914101000`..`20260914101300` not applied.

This PR is the checkout those four install from.

Review chronology, moved here from the decision-log entry (CodeRabbit Minor on PR #862: decision
entries stay about 8 lines):
1. Sol's first exact-SHA review of #857 found that the pinned key and the Windows Hello helper were
   read from the checkout, unchecked against the reviewed commit. Fixed in #857:
   `assertOwnerTrustFilesReviewed` compares the on-disk bytes of every approval-chain file with the
   reviewed head before an approval is requested or honoured. A real tamper (key swapped, mtime
   restored, hidden with `--assume-unchanged`) was refused while `git status` reported clean.
2. Sol's second review found that the verifier is itself code in that checkout. Sol asked for
   enforcement "by trusted code outside the mutable checkout". Mason was shown both positions,
   accepted it as the 2026-09-29 residual, and merged #857 himself. Field-season installs
   `20260914101000`..`20260914101300` run from this follow-up PR. It must pass CodeRabbit and Sol on
   its own diff, and the installs need Mason's chat yes plus his Windows Hello approval for
   `101000`.

Proof: the read-only `select version, name from supabase_migrations.schema_migrations` at 22:23 UTC,
with the high-water computed by `migrationTimestamp` (`.claude/hooks/migration-ordering-lib.mjs`).
Not verified: documentation only; nothing was applied by this change.

## 2026-10-01 — owner approval: the key, helper and gate code must be the reviewed bytes (Sol HIGH, PR #857)

Sol's exact-SHA review of PR #857 returned one HIGH: the apply gate read Mason's pinned public key
and ran the Windows Hello helper from the working checkout, and the landing gate compared only the
migration file with the reviewed commit. An uncommitted local edit, such as a software key pinned
in place of Mason's plus a helper that signs with it, could therefore make a parked migration pass
without his Windows Hello approval while the migration and PR head stayed reviewed. CodeRabbit raised
the same point as a Major.

- New `assertOwnerTrustFilesReviewed` (`.claude/hooks/owner-approval-lib.mjs`) compares the bytes
  on disk (CRLF→LF) of every file an approval is created or checked with against that file in the
  reviewed commit, and throws naming each one that differs, is missing, or is not in that commit.
  The files (`OWNER_TRUST_FILES`): the pinned key, the Windows Hello helper, the approval library,
  the two safety classifiers it uses, the apply rule book, the landing gate, the shared merge-gate
  predicates, `scripts/apply-migration-file.mjs` and `scripts/owner-approve-migration.mjs`.
- It compares file bytes directly, never `git status`, which trusts the index's cached file times
  and the assume-unchanged and skip-worktree flags.
- The apply gate runs it last, against the head the landing gate just confirmed, before the key is
  even read. `scripts/owner-approve-migration.mjs` runs it at HEAD before asking Mason, so he never
  signs through a locally edited helper or summary.

What remains (unchanged residual, `docs/manual/DECISION_LOG.md` 2026-09-29): a check that runs on
the same PC as the same Windows user is only as strong as the rule that agents cannot edit the
guard files. This closes the uncommitted-edit route; a committed edit is reviewed by CodeRabbit and
Sol at the exact head the approval is bound to.

Deferred (Sol MED, same review): the approval window names the migration and the kind of change
("Deletes data", with the classifier's reason) but not which tables or how many rows. That matters
for a destructive migration; none of the four field-season migrations deletes data. Follow-up:
show the affected tables in the window.

Proof: `owner-approval-lib` 64 assertions (13 new: identical, CRLF, swapped key, edited helper,
missing file, file absent from the commit, symbolic head, the file list, the root);
`migration-apply-lib` 294 (3 new: a failing check refuses a valid approval, it gets the landing
head, and the key is never read). Real repository: with the change uncommitted, the check against
HEAD refused and named exactly the three edited files. Not verified here: no live apply.

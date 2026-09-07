## 2026-09-06 — PR #614 brought current with `main`; the `KNOWN_ISSUES.md` conflict resolved by keeping all three entries

PR #614 (the parked `next_invoice_number` Chicago-year migration) had gone `DIRTY` /
`CONFLICTING` against `origin/main`. This entry records the branch-update commit only. The
migration itself is unchanged and still **PARKED — NOT APPLIED**.

**What conflicted, and how it was resolved.** Exactly one file: `docs/manual/KNOWN_ISSUES.md`.
Three sessions had each appended a new `##` entry immediately after the same `---` separator, so
git could not tell three independent additions from three competing rewrites of one entry. They
were independent. All three are kept:

- `## PARKED 2026-09-05 … invoice numbers take their year from UTC` (this PR's own entry)
- `## CLOSED 2026-09-05 … maintenance producer retired unapplied` (from `main`)
- `## FIXED 2026-09-05 … the CodeRabbit gate reported "requested" …` (from `main`; auto-merged
  elsewhere in the file, not part of the conflicted region)

Resolution was **by content, not by side**. Before resolving, each side was diffed against the
merge base to confirm what it actually added: `main` contributed two new entries and did not touch
the file's `Last verified` header, so the PR's newer header text carries forward without
overwriting anything. The resolution was applied with a line-terminator-preserving script rather
than `sed`, because this file is CRLF and the repo pins line endings in `.gitattributes`.

**Proof observed.**

- `git diff adcec57b6 HEAD` over the seven PR files reports **+78 insertions, 0 deletions**, all in
  `docs/manual/KNOWN_ISSUES.md` — arithmetic confirmation that the resolution only added `main`'s
  entry and dropped nothing from either side.
- `supabase/migrations/20260905090000_next_invoice_number_year_chicago.sql`,
  `scripts/smoke/prove-next-invoice-number-year-chicago.mjs` and
  `docs/changelog.d/2026-09-05-next-invoice-number-year-chicago.md` are **byte-identical** to the
  previously reviewed head `adcec57b6` (empty `git diff`).
- `node scripts/smoke/prove-next-invoice-number-year-chicago.mjs` re-run at the new head: terminal
  `NEXT_INVOICE_NUMBER_YEAR_CHICAGO_PROOF_PASS`, including the mutation steps (drifted body, direct
  `anon` EXECUTE, EXECUTE via role membership, NULL `proacl`, third-party grantee) that prove each
  assertion fails when the thing it guards is broken.
- `docs/reference/migration-history.md` re-checked after the merge: exactly one row 917, no row 918,
  and its detail still reads `LOCAL CANDIDATE — … NOT APPLIED LIVE, NOT MERGED` — the wording the
  registration guard keys on.
- GitHub now reports `mergeable: MERGEABLE` (was `CONFLICTING`). Pre-push containment, type check
  and build passed.

**What was NOT verified, and why.**

- **No exact-SHA Codex review exists for this head.** `node scripts/write-codex-push-proof.mjs` was
  run and minted nothing. The reviewer never read the diff: `gpt-5.6-sol` returned
  `ERROR: You've hit your usage limit … try again at Sep 11th, 2026 3:53 PM`. The capture carries no
  `tokens used` marker and is 52 lines — the signature of a reviewer that did not run, which is
  indistinguishable from a refusal by exit code alone. The script failed closed, correctly. No proof
  was hand-written and no gate was bypassed. **This PR is not mergeable until that review runs
  against the frozen head.**
- **No CodeRabbit review has ever run on #614.** The standing `CodeRabbit` status is the stale
  "Review skipped: automatic reviews are disabled". A review is requested only by applying the
  `ready-for-coderabbit` label, never by an agent posting the command itself.
- **Nothing was applied to the live database**, and no live write of any kind was performed. Applying
  `20260905090000` remains a separate approval Mason has not given. The two staleness items recorded
  in the 2026-09-05 changelog (the 2026-08-27 `applied-migrations.json` capture, and the
  `20260905090000` stamp needing re-derivation) still stand and were not refreshed here.
- Issue #617 (six sibling generators with the identical UTC-year defect, same 31 December 2026
  deadline) is untouched and must not be closed when this migration applies.

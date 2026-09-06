## 2026-09-05 - record Mason's decision to retire the never-applied 2026-08-12 maintenance producer; the deletion follows in the next commit

**Decision (Mason, 2026-09-05).** `scripts/apply-live-testdata-maintenance-20260812.mjs` is the
reviewed, blob-pinned one-use tool built on 2026-08-12 to regenerate the live SQL classifier in
`.claude/hooks/live-testdata-lib.mjs` from three reviewed snippets. Its apply lane never ran, and
the 2026-09-02 classifier false positives catalogued in `docs/reference/agent-guardrails.md` are
not covered by those snippets, so applying it would not fix the live defect. Mason chose to retire
it unapplied rather than spend a review cycle on a repair aimed at the wrong target.

**What this commit does.** Records the decision only, in this entry, `docs/manual/KNOWN_ISSUES.md`
and `docs/manual/DECISION_LOG.md`. No executable, test, snippet, CI step or pin changes here: the
producer, its regression harness and its inputs are byte-for-byte as on `main`.

**Why the split.** The producer's own `--retire-producer` lane is the only command the shell guards
allow for removing it, and that lane refuses to run unless the commit it runs against still contains
the producer AND carries a fresh exact-head `gpt-5.6-sol` proof. A candidate that removed the
producer's tests while the producer itself remained was correctly blocked by that review
(2026-09-05, 20:00Z: "security-sensitive producer remains while its defenses are removed"). So this
docs-only commit is what the retire lane's proof is minted against; the next commit in the same PR
carries the deletion itself plus everything that only exists to serve the producer.

**Read before running.** The retire lane performs a single `rmSync` on the producer file and
nothing else; the script has no Supabase client, no network call and no SQL in any lane, so
retirement cannot touch the live database.

**Not verified.** Nothing to verify yet beyond the doc-drift check; the deletion and its proofs are
recorded in the follow-up entry.

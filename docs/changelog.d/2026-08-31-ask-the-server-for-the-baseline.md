## 2026-08-31 — Ask the server for the baseline, in every file that says how

CodeRabbit's review of the frozen candidate found the fix-in-one-file failure again — the seventh
time on this PR, and this time in the entry that was written *about* that failure.

The branch inventory tells the reader to confirm the pinned baseline with
`git ls-remote origin refs/heads/main`, and says explicitly not to use a bare
`git rev-parse origin/main`, which reads the local remote-tracking ref and returns a stale OID in
a checkout that has not fetched. That correction was made in the report and recorded in
`2026-08-31-modified-migrations-cannot-be-restamped.md`.

**Four changelog entries still carried the old command.** Two of them told the reader to re-check
the baseline the stale way. A reader following those would confirm a baseline that had already
moved — and a stale read here is the worst failure mode available, because it reports the baseline
as current in exactly the condition that makes every classification in the report wrong.

### This is not hypothetical; it happened during this PR

While preparing the previous commit, `git rev-parse origin/main` returned `67e6da9d` in this
checkout. The server's `main` was `3ff8dbb1` — it had moved twice more. The command reported a
current baseline that was two moves out of date, and only an explicit `git fetch` revealed it.
That instance is now recorded in the proof of `2026-08-31-state-the-drift-as-a-floor.md`.

### What changed

- **Reader instructions** in `2026-08-31-state-the-drift-as-a-floor.md` and
  `2026-08-31-pin-the-main-baseline.md` now say `git ls-remote origin refs/heads/main`, with the
  reason.
- **Proof records** in `2026-08-31-state-the-drift-as-a-floor.md`,
  `2026-08-31-baseline-moved-a-third-time.md` and `2026-08-31-baseline-moved-again-mid-review.md`
  are relabelled as *the local scan ref after fetching* — which is what was actually run. They are
  historical records of a measurement, so rewriting them to claim a command that was not run would
  trade one inaccuracy for a worse one. Each now points the reader at the server-side command for
  their own re-check.
- The grep proof in `2026-08-31-the-same-defect-in-the-other-file.md` claimed the only remaining
  `became` hits were grammatical. That file quotes the historical typo itself, so the search
  necessarily matches it. The proof now says so.

### The rule, restated because restating it did not work

Naming the rule was not enough — the previous entry named it and then broke it. The operative
version is mechanical: **when a reviewer reports a claim, grep the repository for the claim before
fixing the line.** One command. `grep -rn "rev-parse origin/main" docs/` would have caught all four
of these at the moment the report was first corrected.

### Proof observed

- `grep -rn "rev-parse origin/main" docs/changelog.d/` returns only labelled local-scan-ref proof
  records and the entry that documents the change away from it; no reader instruction uses it.
- `docs/audits/2026-08-31-branch-inventory-for-codex-review.md` continues to specify
  `git ls-remote origin refs/heads/main` and to name the bare `rev-parse` as the wrong tool.
- `npm run check:docs` passes.

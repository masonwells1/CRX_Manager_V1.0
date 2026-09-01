## 2026-08-31 — The same defect, in the file nobody looked at

CodeRabbit reported three wording errors on this PR. All three were fixed. One of them —
"has became" to "has become", and "a file main lacks" to "a file that main lacks" — appears in
**two** files: the changelog entry it was reported against, and the branch inventory itself, which
carries the same sentence. Only the reported copy was corrected.

This is the sixth time in this PR that a fix landed in the file a reviewer named and not in the
other file saying the same thing. The cause is always the same: a reviewer cites one location, and
the fix is scoped to the citation rather than to the claim. **A review finding is a report about a
statement, not about a line number.** The right move on every finding is to grep the statement
across the repository and fix every copy, which costs one command.

Also corrected in the same pass: the inventory's header said the measure had been *revised twice*
while the body and the changelog both describe **three** measurement corrections — the third being
the round that never counted deletions. Round 3 is now written out alongside rounds 1 and 2, so
the header no longer undercounts the corrections in the document it heads.

### Proof observed

- `grep -rn "became" docs/` — the remaining hits are unrelated and grammatical, plus this entry's
  own quotation of the historical typo, which is expected. No uncorrected claim remains.
- The inventory header reads "Revised three times" and lists Round 1, Round 2 and Round 3.
- `npm run check:docs` passes.

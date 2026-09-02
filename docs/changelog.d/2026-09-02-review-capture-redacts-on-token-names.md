## 2026-09-02 — documenting a token's NAME blinds the Codex review capture entirely

Recorded from PR #563. Not fixed here; the workaround is in place and the defect
is filed, because fixing it means editing a protected harness file and that
deserves its own reviewed change.

### What happened

`node scripts/write-codex-push-proof.mjs` returned:

```
## STDOUT
[STDOUT omitted because it contained secret-shaped text; SHA-256 38df63d0…]
```

No verdict, no findings, no proof — the entire review output was replaced by a
hash. The run had cost a full `gpt-5.6-sol` high-effort review and produced
nothing readable.

### Why

`REVIEW_CAPTURE_SECRET_RE` in `scripts/write-codex-push-proof.mjs:746` matches
the **bare identifier** of the Actions token environment variable, with no
requirement that an actual value follow it. The changelog entry for the
final-review-gate fix legitimately told readers to check that token's permissions
group in the job log — mentioning the variable by name, never a credential.

Codex's review output quotes the diff it reviewed. The quoted documentation
contained the identifier, so the redactor fired on the review's own STDOUT and
destroyed the verdict along with it.

### Why it matters beyond one entry

The trigger is a **name**, not a secret. Any change that documents Actions token
permissions, names that variable in a comment, or reviews a workflow file that
sets it can never produce a readable proof — and the failure looks like an
unparseable verdict rather than a redaction, so the natural response is to re-run
the review and burn the cost again.

The same clause also matches `password|secret|api_key|access_token` followed by
`:` or `=`, which ordinary prose and YAML keys hit easily (`permissions:` blocks,
a sentence like "secret: never commit one").

### Workaround in place

The entry now describes the group without spelling the identifier. That is a
workaround, not a fix — the next change to document Actions permissions will hit
this again.

### Suggested fix, when someone takes it

Require an assigned value before redacting: match the identifier only when
followed by a separator and a plausible secret, as the pattern already does for
`password`/`api_key`. A bare mention of a variable name is documentation, not a
leak. Any change here needs its own exact-SHA review — the file is in
`PROTECTED_HARNESS_SOURCE`, and loosening a secret filter is exactly the kind of
edit that warrants one.

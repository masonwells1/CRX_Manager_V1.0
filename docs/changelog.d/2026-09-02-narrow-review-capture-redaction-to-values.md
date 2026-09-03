## 2026-09-02 — the review capture redacted on variable NAMES, destroying whole verdicts

Supersedes the "workaround in place" note in
`2026-09-02-review-capture-redacts-on-token-names.md`. Mason approved the fix on
2026-09-02 after it blocked PR #563 outright.

**Files:** `scripts/write-codex-push-proof.mjs`, `scripts/write-codex-push-proof.test.mjs`

### The defect

`REVIEW_CAPTURE_SECRET_RE` matched three environment-variable **names** as bare
identifiers — the Actions token, the Supabase service-role key, and the OpenAI
key — with no requirement that a value follow.

A match does not censor a line. It replaces the **entire capture** with a
SHA-256. So a false positive destroys the verdict, the findings, and the
high-effort review run that produced them:

```
## STDOUT
[STDOUT omitted because it contained secret-shaped text; SHA-256 9f5889b6…]
```

PR #563 changes workflow token permissions. Codex's own findings therefore
necessarily spelled the Actions token's name, and **three consecutive reviews of
that branch returned no readable verdict**. The branch's own files were verified
clean of triggers by running the exact regex over every changed file — the
trigger was in the reviewer's output, so no amount of editing the branch could
fix it.

The failure also presents as an *unparseable verdict* rather than as a
redaction, so the natural response is to re-run and pay for another full review.

### The fix

Those three names now redact only when an assignment follows (`=` or `:` plus a
value) — exactly how the same pattern already treated `password` and `api_key`.

Everything that identifies an actual **credential** rather than a name is
untouched and still matches on sight: private-key headers, `github_pat_…`,
`ghp_/gho_/ghu_/ghs_/ghr_…`, `sk-…`, JWTs, `AKIA…`, `AIza…`, Slack `xox…`, and
live Stripe keys. A leaked value carries one of those shapes; it does not arrive
as a bare variable name.

### Coverage

Ten credential **values** must still redact with no assignment present; seven
assignment forms must still redact across both separators; five prose sentences
naming those variables must now survive. One assertion pins the property that
makes precision matter here — a single match destroys the whole capture,
`VERDICT:` line included — so nobody relaxes this into line-censoring without
seeing what else goes with it.

### Note on scope

This is a protected harness file, and loosening a secret filter deserves its own
scrutiny. It rides along here because it is the reason no proof could be minted
for this PR at all; the change is narrow, and the tests above are the argument.

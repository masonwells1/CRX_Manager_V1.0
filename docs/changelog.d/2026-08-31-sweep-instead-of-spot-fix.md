## 2026-08-31 — Sweep for the claim instead of fixing the line that was reported

Codex's review of `3032d276` returned two P2 findings, both in
`docs/changelog.d/2026-08-31-docs-cleanup-and-branch-inventory.md`, and both instances of the same
failure this PR has now committed three times: correcting a claim in the file where it was reported
while an identical claim survives elsewhere in the same change.

### The two findings

**"Four workflows exist."** `ec90015d` deleted two of them. The previous round updated
`DEPLOYMENT.md` and left the count standing in the durable changelog record, where it contradicted
both the repository tree and the entry written in the same commit to document the deletion.

**`fuzzyMatchProduct()` "lives in `BulkPOImport.tsx`."** That function name does not exist
anywhere. An earlier round corrected the *file* but kept the *name*, then a later round corrected
the name in `code-patterns.md` and in a companion changelog entry — and left the original wrong
name in this one. A reader of the durable record was still being sent to an API they could not
find.

Both are fixed, and both now point at the entry carrying the full correction.

### The actual fix: stop spot-fixing

Three rounds of this is a pattern, not bad luck. The response was not to fix the two reported lines
but to grep the whole repository for every form of both claims — workflow counts, references to the
two deleted workflow files, the bare `fuzzyMatchProduct()` identifier, and `ocrParser` — and check
each hit. Every other occurrence turned out to be correct: they quote the wrong claim in order to
describe what was fixed, which is what a correction record is supposed to do.

### What the sweep caught that no reviewer had reported

`docs/audits/2026-08-04-test-coverage-analysis.md` — a *live* audit, untouched by this PR — states
"CI runs `npm run test:e2e:smoke`". It does not. The `e2e-smoke` job has been pinned `if: false`
since `0474fa47` on 2026-05-18, two and a half months **before** that audit was written, so the
claim was false when made rather than overtaken by events.

It matters because the error runs the wrong way: the finding is headed "99.4% of the E2E suite
never runs in CI" and treats 6 `@smoke` tests as covered. The true figure is **100%**. An audit
written to raise the alarm about test coverage was itself understating the gap.

Handled consistently with this PR's policy on records: the original finding text is left intact and
a dated correction note is appended beneath it. The record of what was believed on 2026-08-04
survives; a reader is no longer misled about what CI actually does.

### Proof observed

- `.github/workflows/` contains exactly `ci.yml` and `phase3-private-artifact-containment.yml`.
- `git show 0474fa47:.github/workflows/ci.yml` contains `if: false` at line 107; the commit is
  dated 2026-05-18 and titled "ci: disable E2E smoke job until staging Supabase exists".
- Repository-wide greps for `four workflows`, `production-approval-canary`,
  `production-migration.yml`, `fuzzyMatchProduct()`, `ocrParser`, and browser-coverage claims; every
  surviving hit read and confirmed correct.
- `npm run check:docs` passes.

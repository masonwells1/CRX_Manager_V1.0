## 2026-09-05 — The CodeRabbit gate now proves a review was actually requested, and refuses candidates that cannot merge

Two defects in `.github/scripts/coderabbit-final-review.cjs`, recorded as the fourth and fifth in
`docs/manual/KNOWN_ISSUES.md`. The second is the load-bearing one: **every "requested" this gate has
ever reported was unverified**, and for bot-authored commands it was measurably false.

### Defect 5 — posting is not requesting

The gate reported success the moment GitHub accepted its comment. That is evidence a comment exists,
not that CodeRabbit heard it. Measured on this repository — same PR, same head, same command text,
minutes apart, with the comment **author** as the only variable:

| author | when | acknowledgement |
|---|---|---|
| `github-actions[bot]` | #535 16:09:16Z | none, 62 min |
| `github-actions[bot]` | #449 16:48:40Z | none, 24 min+ |
| `masonwells1` (User) | #535 02:19:49Z | 11 s |
| `masonwells1` (User) | #535 17:11:38Z | 6 s |

So `coderabbit-review-requested` was never evidence of a request, and the gate's success reports for
bot-authored commands were false positives.

**The gate now posts, then waits for CodeRabbit's own reply**, and only credits the request when one
arrives. The acknowledgement must be authored by `coderabbitai[bot]` **and** be strictly newer than
the command — CodeRabbit posts an auto-generated summary comment even with automatic reviews
disabled, and that comment quotes `@coderabbitai review` inside its own tips block, which has already
caused two sessions to miscount requests.

**Why this verifies instead of encoding a rule.** CodeRabbit's documentation does not say which
identities may issue commands — checked 2026-09-05 against the commands guide, the configuration
reference, and the "why reviews might not trigger" knowledge-base article. The closest setting,
`auto_review.ignore_usernames`, governs *PR authors* ("Skip reviews for PRs authored by these
usernames"), not comment authors. The bot-filtering is therefore an **observed behaviour with no
documented contract**, which is exactly what must not be hard-coded: it could change in either
direction without notice. So there is no allowlist of identities that "work" — the gate checks
whether CodeRabbit actually answered.

**Three outcomes, deliberately distinct** — collapsing the last two is the bug this guards against:

- **Acknowledged** → the request is credited.
- **Confirmed unheard** (a lookup succeeded and found nothing) → fail, delete the inert command and
  clear the requested marker, so the next attempt is a genuine one. Leaving the marker would strand
  the head forever: a relabel finds marker + command and returns `duplicate`, posting nothing.
- **Unverifiable** (every lookup errored) → fail, but keep **both** the command and the marker. The
  request may be live, and clearing the marker would invite a relabel that buys a *second* paid
  review. An unverifiable lookup is never a confirmed absence.

If deleting the command fails, the marker is preserved regardless — that pairing is the only thing
preventing a duplicate paid review.

### Defect 4 — a PR that provably cannot merge was still spending a review slot

Both merge gates hard-deny `reviewDecision == CHANGES_REQUESTED`. The final-review gate did not look
at it, so #449 — `BLOCKED` on a standing objection with every check green — passed every other
validation and consumed one of roughly 2–3 shared hourly CodeRabbit slots, directly ahead of a
candidate that needed one.

The gate now refuses that verdict, posts nothing, and clears the ready label. It reads the **same
field the merge gates read**, through GraphQL, rather than re-deriving it from `listReviews`: a local
re-derivation would have to model dismissed reviews, `COMMENTED` reviews, staleness and CODEOWNERS,
and any divergence would show up as this gate refusing what the merge gate allows — or worse,
allowing what it denies. The decision is re-read **after** the quiet period too, because a reviewer
can submit the verdict during it.

An unreadable decision fails **closed**, consistently with every other snapshot in this gate (an
unreadable pull request, check list or mergeability state all block). The known cost is stated in the
code rather than hidden: a refusal leaves a red `final-review-gate` check run, and a previous
completed-failure run still counts as a blocking check on later attempts at the same SHA, so a
transient GraphQL error can require a new commit. That is a separate open defect in this gate, not a
reason to fail open here.

### Proven by mutation, not by coverage

105/105 tests pass, and the new refusals were each verified to actually fire by removing them and
watching the suite go red — a guard nobody has watched refuse anything is not a proven guard:

| mutation | tests that went red |
|---|---|
| `reviewDecision` check removed | 2 (including the one that submits the verdict during the quiet period) |
| acknowledgement poll removed | 5 |
| unverifiable collapsed into confirmed-absent | 1 |

The harness gained a `coderabbitai[bot]` acknowledgement, a GraphQL `reviewDecision`, and an
`actionsComments` view. That last one matters: CodeRabbit's reply is a real comment that stays on the
PR even when the gate deletes its own command, so assertions about *what the gate did* must filter by
**author**. Asserting over the raw comment list would silently start asserting things about
CodeRabbit's behaviour instead.

### Not changed

**No workflow permission change.** `pull-requests: write` is already declared and covers the GraphQL
read. The permissions block is deliberately untouched: an invalid key there does not warn or degrade,
it makes the workflow file unloadable and produces a zero-job run that reads like an unrelated infra
blip — the failure mode that made #563's "fix" a no-gate.

The gate is also **not** wired to post anything on its own initiative beyond the one command it
already posted, and nothing here changes who may trigger a review.

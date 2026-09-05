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

### Three more holes found by the exact-SHA review, all in the new code

The first round of this change was rated BLOCKED, and all three findings were real. They are worth
recording because each is a way a verification step can look right and verify nothing.

**1. The gate laundered its own unverified request into a confirmed one.** Adding
`coderabbit-review-requested` is itself a `labeled` event, so the gate raises the very event that
then re-enters it. That path saw marker + command, called it "the confirmed CodeRabbit request", and
returned success — without ever checking for an acknowledgement. So the unverifiable state the new
code carefully preserved was converted into a reported success seconds later, defeating the entire
change. The duplicate path now re-derives the answer from the comments themselves: find the command
for this head, then look for a CodeRabbit reply newer than it. Marker + command is **dedupe state,
not proof**.

**2. "One lookup succeeded" was the wrong test for a confirmed absence.** The success flag was
latched once and never reset, so an early empty read followed by five failed polls reported a
*confirmed* absence — and the caller then deleted the command and cleared the marker. CodeRabbit may
well have answered during the interval nobody could observe, which would let a retry buy a second
paid review. Absence is now confirmed only when the **final** lookup, after the whole wait, succeeded.

**3. Any later CodeRabbit comment counted as an acknowledgement.** Author plus increasing id is not
causal linkage: a delayed auto-generated summary — the one CodeRabbit posts unprompted, quoting
`@coderabbitai review` in its own tips block — would have read as an answer to a command it knew
nothing about. Comments are now classified. The summary is excluded by its own HTML marker, and the
measured refusal tell (`Action not completed`) is treated as a **fourth outcome**: CodeRabbit heard
the command and declined it, which still costs the attempt. That state keeps the command and marker
rather than clearing them, because presenting a spent attempt as untried invites another one.

### Round two — five more, and the same lesson each time

The second review was also BLOCKED, and again every finding was real. Four of the five are the
*same* mistake in places the first pass did not reach:

- **Two more paths read "a command exists" as "a review was requested".** The ready-label route (the
  one an operator lands on when relabelling after a failure) and the crash-recovery handler both
  reported success on marker + command alone. Both now consult the acknowledgement. The crash path is
  precisely when the gate knows least, so it was the last place that should have been optimistic.
- **The classifier failed OPEN.** It recognised the summary and the refusal and treated *everything
  else* as an acknowledgement — so any unrelated or delayed bot comment could green the gate.
  Polarity inverted: acceptance is matched positively (`Action performed`, `Review triggered`, both
  measured here), and anything unrecognised is not an acknowledgement. If CodeRabbit changes its
  wording this gate goes quiet rather than certifying a review that never happened; fix it by
  updating the markers against observed replies, never by widening the default back.
- **`CHANGES_REQUESTED` was missing from the last snapshot before posting.** Checked at the first two
  and not the third, so an objection arriving during the mergeability poll or the marker write still
  cost a slot.
- **The window was 25 seconds, not the 30 the comment claimed.** Six attempts gave five gaps, and the
  first read happened instantly, before any reply could exist. The wait now precedes every lookup.

**One residual, stated rather than buried:** deleting the comment cannot revoke an event CodeRabbit
may already be processing. If it answers after the window and someone then relabels, two paid reviews
are possible. The window is sized so the gap is narrow — every acknowledgement measured here arrived
within 11 s against a 30 s wait — and it cannot be closed by waiting, only narrowed. The failure
message tells the operator to confirm no review exists for the head before relabelling, and the
ready-label path now refuses to post over an existing command rather than quietly adding a second.

### Round three — and the honest limit of what this gate can prove

Two more findings, both real. One is fixed outright; the other is a boundary, and saying so is more
useful than pretending otherwise.

**Fixed: the candidate was not revalidated after the acknowledgement wait.** That wait is up to 30
seconds of real time *after* the last snapshot, so a head change, a newly failing check, a removed
label, auto-merge being switched on, or a `CHANGES_REQUESTED` verdict inside it would have been
reported as a clean success on a candidate that had already stopped being one. The gate now re-reads
the pull request, the checks and the review decision before crediting. It deliberately does **not**
delete the command on that path: CodeRabbit has already accepted it, so the review is spent whether
or not the comment survives, and removing it would make the next relabel look untried.

**Narrowed, not solved: the acknowledgement is not causally bound to the command.** Only the *first*
CodeRabbit comment after the command now counts, so an unrelated later action ("Action performed" for
something else) can no longer answer a command that was ignored. But CodeRabbit's reply does not name
the head or the command it answers, and its documentation defines no acknowledgement contract, so the
binding is by author, order and time — not causation.

**That is the right scope for this gate, though.** What was broken, and silently false for months,
is whether the command was *heard at all*. Proving that a review of the exact head **exists** is a
different, head-bound question, and it already has an owner: the merge gate must match a CodeRabbit
review's `commit_id` to the final head. Widening this 30-second poll into a review-existence check
would take minutes and duplicate a gate that already exists. The success message now says this
explicitly, so nobody reads a green gate as proof of a review.

### Proven by mutation, not by coverage

115/115 tests pass, and every new refusal was verified to actually fire by removing it and watching
the suite go red — a guard nobody has watched refuse anything is not a proven guard:

| mutation | tests that went red |
|---|---|
| `reviewDecision` check removed | 2 (including the one that submits the verdict during the quiet period) |
| acknowledgement poll removed | 5 |
| unverifiable collapsed into confirmed-absent | 1 |
| terminal-lookup rule latched back to "any lookup succeeded" | 2 |
| duplicate path hard-coded back to "confirmed" | 3 |
| comment classification removed | 3 |
| classifier default widened back to "anything counts" | 1 |
| first-reply binding relaxed to "any matching reply" | 1 |

Seven existing tests had to change, and that is itself a finding: each had asserted a green
`duplicate` for a marker plus command with **no acknowledgement anywhere**. They were faithfully
encoding the defect. Their real intent — no second paid command — is preserved and now asserted
explicitly; only the reported status changed.

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

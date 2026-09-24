## 2026-09-22 — a peer's unfinished code fence no longer swallows Mason's halt (#504b)

`authoredByMason()` in `.claude/hooks/prompt-source-lib.mjs` removes text Mason did not
write before the hold-latch hook matches halt phrases. It stripped fenced code FIRST, so
an unterminated ``` fence inside a peer `<cross-session-message>` ran past that peer's own
closing tag and consumed everything after it — including a `stop` Mason typed underneath.
A real halt then matched nothing: fail-open on the halt path.

Fully closed envelopes are now removed first, each on its own, then fences, then inline
code, then any unclosed envelope, then blockquotes.

### Origin

Finding #504b from the 2026-09-03 PR-comment audit
(`docs/audits/2026-09-03-pr-comment-audit-reconciliation.md`, on the unmerged branch
`codex/pr-comment-remediation-20260903`). An earlier fix attempt on
`codex/peer-envelope-fence-20260908` (six commits, ~250 lines of candidate-boundary
"consensus" parsing) was cherry-picked, reviewed by `gpt-5.6-luna` at xhigh, and
**abandoned**: Luna returned 8 findings, and a measured side-by-side run confirmed its
first BLOCKER — that version lost a `stop` typed BETWEEN two peer envelopes, a case
`main` handles correctly today. That branch is not merged and should not be revived.

### Proof observed

- Measured against both versions of the file, same three inputs: on `main`, the peer-fence
  cases lost Mason's `stop`; with this change all three keep it, and the between-two-
  envelopes case that the abandoned branch broke still passes.
- Five new assertions in `.claude/hooks/prompt-hooks.test.mjs` (fence, fence-as-last-line,
  inline-code span, between two envelopes, and the fenced bare open tag the original
  fences-first order existed to protect). Mutation-proven non-vacuous: restoring the old
  order fails the first of them; restoring the fix returns the suite to 240/240 green.
- `npm run test:correction-guards` passes end to end; `npm run check-doc-drift` passes.

### Accepted residual, unchanged from before

A peer that writes a fake closing tag inside its own message ends its envelope early, so
peer words after the fake tag read as Mason's and can latch a hold he did not ask for.
That is the fail-safe direction — a spurious pause costs a round-trip, a missed `stop`
does not stop — and it is how this file already behaved before #504b.

### Follow-up in the same PR (2026-09-24): unclosed fences give their lines back

A pre-merge review of the first commit found two prompts that still lost Mason's `stop`,
both caused by a fence left dangling after closed envelopes are removed:

- Mason's fence quoting a bare open tag, then a real peer message, then `stop`: the quoted
  open tag paired with the peer's closing tag, leaving Mason's fence opener dangling. This
  one was a regression — the fences-first order on `main` handled it.
- A peer's fake closing tag inside a fence, then `stop`: the envelope ended early and the
  rest of the peer's fence dangled. `main` lost this one too, so the residual above was not
  purely fail-safe.

`stripFencedCode()` now removes only fences that close; an unterminated fence keeps its
lines. At worst code or peer text is read as Mason's (a spurious hold, fail-safe); a
dangling fence can no longer hide his `stop`. A second review round then found the
envelopes-first order itself loses a `stop` typed between a quoted envelope tag and a real
peer message, so `authoredByMason()` now runs both strip orders and keeps what either
keeps. Details, proof, and residuals: `2026-09-24-pr768-unclosed-fence-followup.md`.

### Not verified

No live end-to-end latch was exercised: running `hold-latch-prompt.mjs` for real would
write `hold.json` and freeze the session doing the verifying. The hook's use of
`authoredByMason(payload?.prompt)` is pinned by an existing assertion in the same suite.

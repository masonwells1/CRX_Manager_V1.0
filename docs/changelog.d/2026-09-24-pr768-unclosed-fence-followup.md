## 2026-09-24 — PR #768 follow-up: Mason's halt survives both strip orders

A pre-merge review of PR #768 (#504b) measured prompts where the new closed-envelopes-first
order in `authoredByMason()` (`.claude/hooks/prompt-source-lib.mjs`) still lost a `stop`
Mason typed — one of them a regression against `main`. Two changes, same PR:

1. **Unclosed fences give their lines back.** `stripFencedCode()` removes only fences that
   close; an unterminated fence keeps its lines (re-scanned, so a closed inner fence of the
   other marker is still removed). A fence left dangling after envelope stripping — e.g. a
   peer's fake closing tag inside a fence — can no longer hide the `stop` below it.
2. **Both strip orders run; anything either keeps counts as Mason's.** Envelopes-first
   loses a `stop` between an envelope tag Mason quotes in code and a real peer's closing
   tag (the quoted open tag pairs with the peer's close). Code-first — the order on `main`
   — loses a `stop` below a peer's unfinished fence. `authoredByMason()` now returns the
   union of both, so a halt either order preserves always latches.

3. **Clearing a hold needs both orders to agree Mason spoke.** A second review round found
   the union let a peer-only message that merely *quotes* its own closing tag (inline or in
   a fence) count as Mason's turn — and any non-hold prompt from Mason clears the hold, so
   that peer could release a hold he latched. `hasAuthoredText()` is now the intersection
   (both orders leave text), and `hold-latch-prompt.mjs` checks it *after* the latch and
   *before* the clear: a halt either order keeps still latches; only a prompt both orders
   agree is Mason's can clear.

### Proof observed

- `prompt-hooks.test.mjs`: 256/256 (every reviewer-measured prompt; unclosed-fence
  give-back; closed inner fence still stripped; end-to-end runs of the real hook proving a
  one-order stop still latches and both quoted-close-tag peer messages do NOT clear a
  held hold; a source check pinning the gate between latch and clear).
  `npm run test:correction-guards` and `npm run check-doc-drift` pass.
- Fuzz, 200,000 random prompts with `stop now` typed outside any code/quote/envelope: zero
  where this version loses the `stop` and either `main` or the PR's first commit keeps it.
- Fuzz, 200,000 peer-only messages with no fake closing tag: zero leave authored text, on
  this version, on `main`, and on the first commit.

### Residual, stated plainly

- A peer that FORGES a closing tag inside its own message can still have words after it
  read as Mason's, and so could still clear a hold. That was already true on `main`; the
  unclosed-fence give-back widens how often it happens for forged-tag shapes. Peers that
  only quote the tag no longer can (item 3).
- A peer quoting its close tag in a fence, then writing "stop", can latch a spurious hold
  on the receiver (fail-safe). So can Mason pasting a fence he never closes that contains
  "stop".
- Still open on `main` and here: a blockquoted open tag followed by a real peer message,
  and an open tag inside an unclosed fence, can hide a `stop` below them.

### Review status

Two independent Claude adversarial review rounds found the envelopes-first regression
(fixed by item 2) and the hold-clear hole (fixed by item 3). The Codex round could not run
before merge (usage limit until 2026-09-26). It ran after merge on 2026-09-26 through the
Codex GitHub App (not pinned to luna/xhigh: the session had no Codex CLI login) and found
one P1, fixed in `2026-09-26-codex-794-dangling-fence-clear.md`.

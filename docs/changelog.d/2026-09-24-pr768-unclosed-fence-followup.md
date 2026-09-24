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

### Proof observed

- `prompt-hooks.test.mjs`: 251/251 (eleven new assertions: every reviewer-measured prompt,
  unclosed-fence give-back, closed inner fence still stripped, peer-only prompts still
  leave no authored text). `npm run test:correction-guards` and `npm run check-doc-drift`
  pass.
- Fuzz, 200,000 random prompts with `stop now` typed outside any code/quote/envelope: zero
  where this version loses the `stop` and either `main` or the PR's first commit keeps it.
- Fuzz, 200,000 peer-only messages with no fake closing tag: zero leave authored text, on
  this version, on `main`, and on the first commit.

### Residual, stated plainly

- A peer that writes a fake closing tag inside its own message can still have words after
  it read as Mason's. That was already true on `main`; the union widens how often it
  happens. Mostly fail-safe (a spurious hold), but the same leaked text can also clear a
  hold Mason latched — pre-existing, and only for a peer forging the envelope's close tag.
- Pasting a code fence he never closes, containing "stop", now latches a hold (fail-safe).
- Still open on `main` and here: a blockquoted open tag followed by a real peer message,
  and an open tag inside an unclosed fence, can hide a `stop` below them.

### Review status

An independent Claude adversarial review of the first follow-up commit found the
envelopes-first regression fixed here. The required `gpt-5.6-luna` xhigh Codex round has
not run on this PR (usage limit until 2026-09-26) and must run clean on the final head
before merge.

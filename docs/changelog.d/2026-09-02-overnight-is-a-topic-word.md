## 2026-09-02 - Naming autopilot no longer freezes the session

**Class:** guard false positive. **Outcome:** `overnight` freezes only in its adverbial use; naming
the feature no longer latches. Real hands-free requests are unchanged.

## What was broken

`autopilot-intent-reminder.mjs` latches `.claude/session-state/OVERNIGHT-INTENT.flag` when a prompt
matches its `strong` list. `unattended-autopilot.mjs` then blocks Bash, Write, and Edit for 45
minutes until autopilot is armed.

`/overnight/` was in that list as a bare word — the one shape that can appear in a question *about*
the feature rather than a request *for* it. It froze this session twice in ten minutes:

1. `yes fix codex folder , and i think the overnight flag is gettign worked on you might investigate`
2. `yes drop the word overnight from the freeze list`

The second is the approval to make this change.

That is worse than an inconvenience. `review-proof-guard.mjs` refuses every command that would clear
the flag, which PR #548 established is deliberate — a sanctioned clear-script was built, drew
BLOCKERS from two `gpt-5.6-sol` reviews, and Mason removed it because the cure was a fresh way to
execute code during exactly the window when execution is meant to be paused. So a false latch leaves
**arming autopilot as the only unblocked path**, which is the failure the handshake exists to
prevent. #548 fixed the deny message; it never touched the word list that causes the false latch.

Not a new observation either: the Governed Autonomous Software Factory was removed on 2026-08-07
partly because "casual words like 'factory' or 'overnight' flipped governed state"
(`docs/manual/DECISION_LOG.md`).

## What changed

`.claude/hooks/autopilot-intent-reminder.mjs`

- The bare `/overnight/` is replaced, not deleted. Mason's instruction was to drop the word from the
  freeze list; deleting it outright would also have dropped `run this overnight` — a genuine
  hands-free request that `hook-router.test.mjs:53` already pinned as latching. That existing test
  is what caught the over-correction.
- The replacement splits the word **grammatically, not by a list of banned phrasings**: adverbial
  `overnight` says WHEN the work happens and is a request; attributive `overnight` modifies a noun
  and is naming a thing ("the overnight flag", "the overnight bug hunt", "the word overnight from
  the list").
- **Two independent signals, both required before the session freezes.** The first draft used a
  single lookahead and CodeRabbit found a real hole on each side of it (see below), so:
  - **NOT-NAMED** — no determiner or quoting word immediately before it. This is the closed half of
    the rule (English determiners are a fixed set; nouns are not), and it is what makes "the word
    overnight FROM the list" safe even though `from` is a perfectly good adverbial preposition.
  - **ADVERBIAL** — it ends the phrase, or the next word starts a new clause rather than continuing
    a noun phrase. This is what makes a sentence-leading "overnight flag is broken" safe, where
    nothing precedes the word at all.

  Each covers the other's gap, which is also why the follower set can afford to be generous:
  over-matching there is caught by the determiner rule. `this`/`that` are deliberately not treated
  as determiners — "run this overnight" is the canonical request.
- Where the two still disagree, prefer MISSING a real request over freezing on a mention. The
  failures are not symmetric: a miss degrades to the arm-autopilot reminder that `triggers` still
  injects, while a false freeze can only be escaped by arming autopilot.
- The list now carries its admission rule inline: a pattern belongs in `strong` only if it is a
  phrase Mason can be USING but not NAMING.

## What CodeRabbit caught (PR #565, `CHANGES_REQUESTED` @8ea551ebf)

Two findings on the same line, pulling in opposite directions. Both were verified against the code
and both were real:

- **Major — punctuation preceding a noun phrase.** The lookahead accepted any of `.,;:!?` as a
  phrase terminator, so `investigate the overnight: flag behavior` latched: the colon was read as
  ending the request when it was in fact introducing a noun.
- **P2 — dropped latches on extended requests.** The fixed follower whitelist silently stopped
  latching `run this overnight without asking me again`, `work overnight for me`, and `keep working
  overnight through the morning`. A dropped latch is not harmless: an unattended run then stalls for
  permission later, which is the complaint the whole subsystem exists to answer.

The single-lookahead design could not satisfy both — widening the follower set to fix the second
worsens the first. Adding the determiner signal resolves them together, and all six cases are now
pinned.

## Verification

**End to end, independent of this repo's test files.** The two real hook binaries chained as a live
session runs them (`autopilot-intent-reminder.mjs` -> `unattended-autopilot.mjs`), against a real
`npm run build` payload — the question asked is "would this Bash call actually have been frozen":

```
MUST NOT FREEZE — naming the feature:            MUST FREEZE — real hands-free requests:
  ok  "...i think the overnight flag is..."        ok  "run this overnight"
  ok  "yes drop the word overnight from..."        ok  "run this overnight without asking me again"
  ok  "investigate the overnight: flag behavior"   ok  "work overnight for me"
  ok  "overnight flag is broken again"             ok  "keep working overnight through the morning"
  ok  "why does the overnight flag keep firing"    ok  "keep going overnight, ill check in the morning"
  ok  "run the overnight bug hunt report past..."  ok  "im going to bed, keep working"
                                                   ok  "run this hands-free until morning"
ALL 13 CASES CORRECT against the real hook chain.
```

`node .claude/hooks/prompt-hooks.test.mjs` — 195 assertions pass (was 169), including new ones that
run the real hook process against a throwaway `CLAUDE_PROJECT_DIR` and check the actual flag file on
disk: the two verbatim freezing prompts, four real hands-free requests, seven adverbial `overnight`
requests, and six noun-modifier mentions.

Every added assertion was mutation-proved, and no single mutation can pass all of them:

| Mutation | Check that went red |
|---|---|
| Restore the bare `/overnight/` | `naming the feature must not FREEZE the session: "yes fix codex folder , and i think the overni..."` |
| Delete the replacement pattern (drop the word entirely) | `adverbial overnight is a real request: "run this overnight"` — and `hook-router.test.mjs` `Claude autopilot reminder preserves intent flag` |
| Empty the `strong` list entirely | `a real hands-free request must still latch: "im going to bed, keep working"` |
| Drop the NOT-NAMED lookbehind, keep the lookahead | `naming the feature must not FREEZE the session: "yes drop the word overnight from the freeze l..."` |
| Drop the ADVERBIAL lookahead, keep the lookbehind | `overnight as a noun modifier must not freeze: "overnight flag is broken again"` |

`node .claude/hooks/hook-router.test.mjs` — 47 assertions pass.
`node .claude/hooks/overnight-intent-clear.test.mjs` — all 10 checks pass, so #548's handshake
contract (fresh latch gates, expired latch releases, no advertised escape) is intact.

## Scope

The handshake itself is unchanged: a real hands-free request still latches, still blocks building
until autopilot is armed, and still has no shell escape. Only the trigger that fires it was
narrowed.

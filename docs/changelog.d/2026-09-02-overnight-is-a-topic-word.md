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
- The replacement splits the word **grammatically, not by a list of banned phrasings**: it freezes
  only when `overnight` ENDS its phrase, which is the adverbial use ("run this overnight"; "keep
  going overnight, I'll check in the morning"). When another word follows, it is modifying a noun —
  naming a thing rather than asking for one ("the overnight flag", "the overnight bug hunt", "the
  word overnight from the list").
- The lookahead's continuation set errs toward MISSING a real request, never toward freezing on a
  mention. The two failures are not symmetric: a miss degrades to the arm-autopilot reminder that
  `triggers` still injects, while a false freeze can only be escaped by arming autopilot.
- The list now carries its admission rule inline: a pattern belongs in `strong` only if it is a
  phrase Mason can be USING but not NAMING.

## Verification

`node .claude/hooks/prompt-hooks.test.mjs` — 183 assertions pass (was 169), including new ones that
run the real hook process against a throwaway `CLAUDE_PROJECT_DIR` and check the actual flag file on
disk: the two verbatim freezing prompts, four real hands-free requests, four adverbial `overnight`
requests, and three noun-modifier mentions.

Every added assertion was mutation-proved, and no single mutation can pass all of them:

| Mutation | Check that went red |
|---|---|
| Restore the bare `/overnight/` | `naming the feature must not FREEZE the session: "yes fix codex folder , and i think the overni..."` |
| Delete the replacement pattern (drop the word entirely) | `adverbial overnight is a real request: "run this overnight"` — and `hook-router.test.mjs` `Claude autopilot reminder preserves intent flag` |
| Empty the `strong` list entirely | `a real hands-free request must still latch: "im going to bed, keep working"` |

`node .claude/hooks/hook-router.test.mjs` — 47 assertions pass.
`node .claude/hooks/overnight-intent-clear.test.mjs` — all 10 checks pass, so #548's handshake
contract (fresh latch gates, expired latch releases, no advertised escape) is intact.

## Scope

The handshake itself is unchanged: a real hands-free request still latches, still blocks building
until autopilot is armed, and still has no shell escape. Only the trigger that fires it was
narrowed.

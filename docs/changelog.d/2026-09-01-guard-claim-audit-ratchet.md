## 2026-09-01 — Guard-claim audit: absolute safety claims must say what backs them

The lessons-to-checks ratchet owed from 2026-08-31, now executable.

**The finding it encodes.** In one night, five guards across four PRs were found asserting a safety
property they did not have — and every one overclaimed; not one understated:

| Guard | Claimed | Actually |
|---|---|---|
| `guarded-surface-lock` | "a boundary an agent cannot cross" | a five-line script writing through node `fs` walked through it |
| `guard-unlock` | "an agent shell cannot run it" | a PTY-capable agent satisfies `isTTY`; the phrase is a source literal |
| PR #502 | "fails closed" | Codex reproduced an `allow` on the live-migration path |
| PR #449 lexer | "fail-closed" | fails open on an ordinary trailing-backslash string |
| PR #500 `LIVE_CLAIM` | "fail-closed" | fail-*permanently*-closed: 23h+ operator lockout on every vendor payment |

Overclaiming is worse than having no control, because a control described as stronger than it is
stops anyone building the real one.

**The rule.** `scripts/guard-claim-audit.mjs` scans guard sources for absolute claims about their
own strength (`fail-closed`, `cannot be bypassed`, `no agent can`, `only a human`, `guarantee`, …).
A NEW claim must carry `@proven-by <test>`, `@speed-bump`, or `@unproven` within three lines.
Existing claims are grandfathered in `guard-claim-audit.baseline.json` (159 entries) so the check
lands green and ratchets from there; shrinking that list is the point.

It reports **user-facing** claims separately — the ones in refusal text an operator actually reads,
which is how Mason came to believe the guarded surface was protected when it was not. Thirteen of
the grandfathered claims are user-facing, including this repo's own
`guarded-surface-lib.mjs:429` — "so an agent shell cannot run it" — which the audit caught on its
first run and which is the exact sentence last night's reproduction disproved.

**What it is not.** A lint over text. It cannot tell whether a claim is TRUE, only whether anyone
said what backs it, and it is trivially satisfied by writing `@proven-by` next to a lie. It will not
catch a guard that is wrong while saying nothing. It raises the cost of drifting by accident, which
is how all five happened. That limitation is stated in the file's own header, which is the rule
applied to itself.

25 mutation assertions, each built from a real overclaim from that night, plus negative cases so
that writing an honest correction ("it is NOT a human-only gate") is never punished — a false
positive found on the first run against this repo's own correction text.

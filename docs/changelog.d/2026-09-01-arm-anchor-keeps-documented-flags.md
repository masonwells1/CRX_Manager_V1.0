## 2026-09-01 - Arm-command anchor must not block the CLI's documented flags

Follow-up to `2026-09-01-anchor-the-autopilot-arm-allowance.md`. Codex
(`gpt-5.6-sol`, exact-SHA review) returned CLEAN on that commit but flagged a
**regression it introduced**, and the flag was correct.

## What broke

`ARM_CMD_RE` was written to accept only a bare invocation, `--hours <integer>`, and
`--off`. Checked against the real CLI:

- `--status` is documented at `autopilot-arm.mjs:6` and handled at line 32. It is
  **read-only** — and it is exactly what a *paused* agent should be able to run to see
  whether autopilot is armed.
- `--hours` is clamped to `[0.25, 24]`, so fractional values such as `--hours 0.5` are
  legitimate.

The anchor silently removed both. Hardening that quietly deletes a working command is a
regression, not a win — the guarded path is only correct if the legitimate uses still work.

## The fix

The anchor now accepts exactly the argument set the CLI documents — bare, `--hours <n>`
including fractions, `--off`, `--status` — and still refuses any prefix, suffix, or chain.

## Verification — the shipped hook, against a real latch

Both properties had to hold *together*: a fix for the regression could easily have
re-opened the bypass. Spawning `unattended-autopilot.mjs` with a fresh latch:

```text
ALLOWED THROUGH   node .claude/hooks/autopilot-arm.mjs --status
ALLOWED THROUGH   node .claude/hooks/autopilot-arm.mjs --hours 0.5
ALLOWED THROUGH   node .claude/hooks/autopilot-arm.mjs --hours 8
ALLOWED THROUGH   node .claude/hooks/autopilot-arm.mjs --off
DENY              node .claude/hooks/autopilot-arm.mjs --status && npm run build
DENY              npm run build && node .claude/hooks/autopilot-arm.mjs --hours 8
DENY              npm run build
```

All four documented forms run; nothing rides them; the pause still holds. Regression cases
added for `--status`, `--hours 0.5`, `--hours 0.25` (the CLI minimum), and
`--status && npm run build` so the read-only flag cannot become a carrier.

## Note

This is the second consecutive round where a fix produced the next finding — the deferred
arm bypass, then over-tightening it. Both were caught by review rather than by the unit
tests, which is why each round is now verified by running the real hook rather than trusting
the assertions alone.

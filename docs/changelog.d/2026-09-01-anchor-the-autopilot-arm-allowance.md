## 2026-09-01 - Anchor the autopilot-arm allowance so a chained command cannot ride it

CodeRabbit finding on PR #548 (Security & Privacy, Major). Real, and fixed.

## The defect

`overnightGateDecision()` allowed any Bash command whose text merely *contained*
`autopilot-arm.mjs`:

```js
if (cmd && /autopilot-arm\.mjs/.test(cmd)) return "allow-through";
```

So `npm run build && node .claude/hooks/autopilot-arm.mjs --hours 8` returned
`allow-through` — **the build ran during the pause**, with the arm command along for the
ride. The overnight handshake exists precisely to stop building before autopilot is armed,
so this defeated the gate it belongs to. A suffix (`… --hours 8 && npm run build`), a
semicolon chain, or a pipe worked the same way.

This was listed as a known residual in `2026-09-01-overnight-intent-escape-hatch.md` and
deliberately left alone there, on the reasoning that it was the arming path rather than the
clearing path. CodeRabbit was right that the reasoning does not hold: whichever path it sits
on, it lets arbitrary commands through the pause.

## The fix

`ARM_CMD_RE` is anchored start-to-end and admits no shell metacharacters, so no prefix,
suffix, or chain can ride it. Only the documented forms are accepted — a bare invocation,
`--hours <n>`, or `--off` — with either path separator, since PowerShell spells the path
with a backslash. The check is also now gated on the tool actually being `Bash`/`PowerShell`,
as the finding asked.

## Verification — mutation-proved load-bearing

Restoring the old substring test turns the new regression cases red:

```text
AssertionError: PROVEN BYPASS: a build BEFORE the arm command must not ride it
```

Regression coverage added for a command before the arm invocation, after it, a semicolon
chain, a pipe, a planted same-basename script, an unknown extra flag, and merely naming the
script in an unrelated command — plus positive cases for all three documented forms and the
Windows path separator.

`overnight-intent-clear.test.mjs` caught a real interaction while this landed: the deny
message advertises `--hours N` as a placeholder inside a parenthetical, and the extractor
was pulling `--hours N)` and asserting the guard accepted it. The guard is correct to reject
a literal `N` and a stray `)`; the test now stops at the paren and substitutes a real value
before checking, so the contract stays "the advertised command runs once the operator fills
the obvious argument" rather than weakening the guard to match the documentation.

Also fixes MD040 on the previous entry's diagnostic fence (`text` language tag).

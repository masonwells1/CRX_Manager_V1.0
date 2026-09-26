## 2026-09-07 - Clustered `-n` walked past the autopilot no-verify rule

**Class:** the same option-spelling defect the rest of PR #631 fixes, caught one layer down.
**Source:** CodeRabbit review of PR #631 (head `0b0561efa`) — a real finding on code added in
that PR, not a pre-existing bug on `main`.

## What was wrong

The new `git commit -n` rule matched `-n` only as a **standalone token**:

```js
new RegExp(String.raw`git\s+commit\b` + OPT_SCAN + String.raw`-n(?=$|\s)`)
```

Git's parse-options **clusters** short flags, so `git commit -nv` and `git commit -vn` are
`--no-verify` plus `--verbose` and both returned `allow`. Measured against the real
`autopilotDecision`; `git commit -an`, `-na` and `-qn` bypassed the same way.

The reason the first draft was narrow was itself sound, and is preserved: a short option that
**takes a value** swallows the rest of its cluster, so `git commit -mn 'msg'` is the message
`"n"`, not a flag. A naive cluster match would have denied ordinary commits.

## The fix

`GIT_COMMIT_VALUE_OPTS = "mcCFtuS"` names the short options that consume the rest of their
cluster (`-m <msg>`, `-c`/`-C <commit>`, `-F <file>`, `-t <file>`, `-u[<mode>]`,
`-S[<keyid>]`). Only letters from the **complement** of that set may appear ahead of the `n`.

## Proof

- Now deny: `git commit -nv -m x`, `-vn -m x`, `-an -m x`, `-na`, `-qn -m x`.
- Still allow: `git commit -mn 'msg'`, `-amn 'msg'`, `-Fnotes.txt`, `-tnotes.txt`, `-cnew`,
  `-m x`, `--amend --no-edit`.
- Strictly additive: the 18,131-command sweep against `origin/main` still reports **0
  de-denials**.
- `autopilot-lib.test.mjs`: 165 → 174 assertions.

## Accepted residual

`git commit -Sn` is deliberately **not** denied. `-S` takes an *optional* key id, so the shell
text alone cannot say whether git reads `n` as a key id or as a flag, and guessing wrong in
the denying direction would break signed commits.

**Files:** `.claude/hooks/autopilot-lib.mjs`, `.claude/hooks/autopilot-lib.test.mjs`.

## 2026-09-02 - Bind the arm allowance to the trusted project root, not to command text

Codex (`gpt-5.6-sol`, exact-SHA review) **BLOCKED** on a HIGH: the overnight handshake's
arm allowance validated only the command *text*.

## The defect

`node .claude/hooks/autopilot-arm.mjs --hours 8` carries a **relative** path, which resolves
against the *shell's* working directory — not the repo. Matching the text therefore proves
nothing about which file actually runs. From a directory containing a planted
`.claude/hooks/autopilot-arm.mjs`, the byte-identical sanctioned command executes attacker
JavaScript **during the pause**, and everything that process does is past every later
tool-call guard.

This is the same cwd-unbinding class that ended the `clear-overnight-intent.mjs` escape.

## Two facts that frame it

- **Pre-existing, and worse on `main`.** `main` currently has
  `/autopilot-arm\.mjs/.test(cmd)` — a bare substring accepting any path from any cwd, plus
  arbitrary chaining. This change set narrowed it (anchored, no chaining) and now closes it.
  The hole was not introduced here.
- **The reviewer flipped on identical code.** Codex returned CLEAN with *zero* findings on
  `ac9e8b568`, then BLOCKED on `b134d8a66`. `git diff` over the three arm files between those
  commits is **empty** — only an unrelated `main` merge separated them. Documented
  non-determinism; the finding is real on its merits regardless.

## The fix — structural, not another text rule

`isSanctionedArmCommand` now resolves the command's script argument against the trusted
`projectDir` supplied by `unattended-autopilot.mjs`, and requires it to *be* that file.
Identity, not spelling — which converges, unlike enumerating command forms.

Fails closed when the trusted root is unknown, when the cwd is unknown, or when the resolved
path is anything else. Absolute paths are not an accepted form at all: the documented
spelling is repo-relative, and one accepted shape is one slot to reason about.

## Verification — end-to-end, real hooks, only the cwd differs

```text
allowed   node .claude/hooks/autopilot-arm.mjs --hours 8      (cwd = project root)
DENIED    node .claude/hooks/autopilot-arm.mjs --hours 8      (cwd = dir with a planted
                                                               .claude/hooks/autopilot-arm.mjs)
```

Byte-identical command text; only the working directory changes. Unit coverage adds the
planted cwd, a repo subdirectory, unknown cwd, unknown root, no context at all, absolute
paths both trusted and untrusted, and a cwd that normalizes back to the root.

79 unit assertions and 10 end-to-end checks pass.

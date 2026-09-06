## 2026-09-06 — PR #619 review round 3: a path-qualified runtime and a transparent launcher are still launches

**Why.** CodeRabbit's review of PR #619 at head `db355b11d` returned four findings. Three were real
bypasses of the computed-script rule in `.claude/hooks/bash-safety-lib.mjs` and one was a false
claim in this PR's own changelog. All four are fixed here.

One of them is a repeat. `/usr/bin/node "$F"` was raised by `gpt-5.6-sol` in review round 1 and
recorded in the PR body as one of "two evasions of the new computed-script matcher". It was never
actually closed — the round-1 commit fixed the other spellings and this one survived to round 3.
See [[feedback_partial-compliance-with-a-review-finding-is-the-same-bug]].

**What changed** (`.claude/hooks/bash-safety-lib.mjs`, tests in `bash-safety.test.mjs`).

- **Path-qualified runtime names.** `segmentHead()` already strips the directory, so the head check
  passed for `/usr/bin/node "$F"` — but `JS_RUNTIME_TOKEN_RE` required the name to sit at a
  delimiter, found nothing, and the segment was skipped. The regex now accepts an optional
  `…/` or `…\` prefix. Covers `/usr/bin/node`, `./node`, `$HOME/bin/node`, `/usr/local/bin/bun`.
- **The Windows spelling needs the RAW command.** `wordEscapeView()` strips a backslash between two
  letters so `n\o\d\e` cannot hide the name; that same strip turns `C:\tools\node.exe` into
  `C:toolsnode.exe`, leaving no separator for either scan to cut on.
  `computedJavaScriptScriptArgument()` now scans the escaped view AND the raw command, so each view
  catches what the other's normalisation destroys. Scanning an extra view can only ADD denials,
  never remove one.
- **Transparent launcher heads.** `SEGMENT_HEADS_THAT_EXECUTE` gained `start`, `wsl`, `winpty`,
  `runuser`, `su`, and `flock`. Each runs its trailing argv, so `start /b node "$F"`,
  `wsl --exec node "$F"`, `winpty node "$F"`, `runuser -u u -- node "$F"`, `su -c 'node "$F"' u`,
  and `flock lock node "$F"` were being skipped as non-executing heads.
- **Braced PowerShell environment assignment.** `${env:NODE_OPTIONS} = …` is valid PowerShell and
  the anchored assignment rule matched only the unbraced `$env:NODE_OPTIONS`. Both spellings now
  match; the item-cmdlet and .NET rules are unchanged.
- **A false claim removed from `2026-09-05-maintenance-producer-guard-by-name.md`.** That entry said
  the generated Codex production guard "keeps the full classifier, blob-pinned". It does not, and
  never did: `.codex/hooks/production-action-guard.mjs` gates the producer by name through
  `maintenanceProducerCommandMentioned()` behind an exact-HEAD proof gate, and contains no
  `opaqueJavaScriptLoaderInvocation`. The claim mattered because it was read as "the Codex side
  still holds the broad net". The file itself remains untouched by this PR, which was and is true.

**Mutation proof.** The 16 new pinned cases were run against the pre-fix library (`db355b11d`),
which got **12 of 16 wrong** — every path-qualified launch, every launcher-fronted launch, and the
braced assignment were allowed — and the 4 must-stay-allowed cases right. The fixed library gets
all 16 right.

**Over-block check.** Four cases pin that the fix does not over-reach: `/usr/bin/node
scripts/safe.mjs` and `start /b node scripts/safe.mjs` (literal scripts) stay allowed,
`sudo apt install nodejs` stays allowed, and `echo /usr/bin/node "$F"` stays allowed because `echo`
is not an executing head.

**Proof observed.** `node .claude/hooks/bash-safety.test.mjs`: 518 assertions pass.
`node .claude/hooks/mcp-tool-guard.test.mjs`: 30 assertions pass. The generated Codex production
guard is untouched.

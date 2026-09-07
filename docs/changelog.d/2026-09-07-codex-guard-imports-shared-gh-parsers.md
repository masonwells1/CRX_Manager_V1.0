## 2026-09-07 - The Codex production gate now imports the shared gh parsers instead of copying them

### What was broken

`.codex/hooks/production-action-guard.mjs` carried its own copies of the four gh/MCP
merge parsers, and each copy spelled the GitHub CLI binary as a **one-item extension
list**: `gh(?:\.exe)?`. Every other spelling the shell resolves to the same program
walked past the merge gate entirely.

Measured through the file's own exported `evaluateProductionAction` at `358bfdbfa`
(the base of this change) — not read off the pattern, because reading a regex tells
you what it says, not what it matches, and that mistake is the origin of this whole
bug family:

| command | before | after |
| --- | --- | --- |
| `gh pr merge 625 --squash` | `blocked: true` | true |
| `gh.exe pr merge 625 --squash` | `blocked: true` | true |
| `gh.cmd pr merge 625 --squash` | **`blocked: false`** | true |
| `gh.ps1 / gh.bat / gh.com pr merge 625 --squash` | **false** | true |
| `gh.cmd pr merge 625 --admin` | **false** | true |
| `C:\Tools\gh.cmd pr merge 625` | **false** | true |
| `./gh.cmd pr merge 625` | **false** | true |
| `"C:\Program Files\GitHub CLI\gh.cmd" pr merge 625` | **false** | true |
| `gh.cmd api -X POST repos/o/r/issues/1/comments` | **false** | true |
| `gh.ps1 api graphql -f query=mutation` | **false** | true |
| `gh -R o/r api -X POST repos/o/r/issues/1/comments` | **false** | true |
| `gh pr view 625` (control) | false | false |
| `npm run build` (control) | false | false |

The two controls returning `false` are what make the table conclusive: `false` means
"not blocked", not "the call errored".

`blocked: false` on a `pr merge` line means the merge gate — green pipeline,
`CHANGES_REQUESTED`, `--admin` refusal, risky-diff exact-SHA proof — never ran at all.
A merge to `main` auto-deploys production through Vercel, so this was the Codex-side
control that stops an agent landing work without Mason's approval, absent for three
ordinary Windows spellings of the same program. `.cmd` is what Windows resolves `gh`
to when the CLI ships a shim, and `PATHEXT` is user-configurable.

**Latent, not an incident.** Nothing was armed (9 `AUTOPILOT.on` flags on this
machine, all expired), no agent has ever typed those spellings, and GitHub's own
branch protection still requires a mergeable PR. The gap was one layer deep, and the
layer was real.

### The fix: import, do not paste a fourth copy

`codex-push-lib.mjs` recorded the follow-up in its own header — *"production-action-guard
should import these instead of carrying its own copies"* — and `AGENTS.md` names
`.claude/hooks/` as the single source of truth for shared guard logic. So the copies
are deleted rather than patched:

- `ghMergeRequest`, `ghApiMergeRequest` and `mcpMergeRequest` are now imported from
  `.claude/hooks/codex-push-lib.mjs`, where the binary is modelled by `BIN_TAIL` — an
  extension defined as a **rule** (a dot-segment with no separator, no further dot, no
  quote inside it) rather than as a roster of names.
- `ghApiMutates` had no shared twin, so it MOVED to `codex-push-lib.mjs` and is
  exported from there. Its `api` subcommand is now found by word scan rather than by
  the position-anchored `gh\s+api`, matching what `ghApiMergeRequest` already did — so
  `gh -R o/r api -X POST …` is gated too, which it was not before.
- The guard's private `shellWords` helper died with its last caller.

No gh binary pattern remains anywhere under `.codex/`. Adding `.cmd|.bat|.ps1` to the
list would have inherited the next list's omissions; this is the third repeat of that
one error (`autopilot-lib.mjs` enumerated option spellings, then option values, then
the binary name — PR #607 replaced all three with a grammar).

### Both directions are pinned

A guard that over-denies gets switched off, which is the worse failure. The benign
boundary is asserted, and is unchanged before and after: `gh-dash pr merge 1`,
`ghq push`, `ghost pr merge 1`, `npm run ghpr`, `echo highlight pr merge`,
`node scripts/ghost.mjs pr merge`, `gh pr view`, `gh.cmd pr view`, `gh pr list`,
`npm run build`, `git log --oneline`. `-` is not `.`, so the extension tail never
opens on a hyphenated neighbour, and `\b` never matches inside a longer word.

**One deliberate loosening, pinned by its own assertion:** the shared parser stands
the gate down for `gh pr merge <n> --disable-auto`, which cancels a pending
auto-merge and lands nothing. The deleted local copy gated it.

### Proof

- Every new assertion was run against the **pre-fix** guard through a module resolve
  hook and fails there: `AssertionError: any gh binary extension still reaches the
  merge gate: gh.cmd pr merge 123 --squash`. It passes after.
- Backtracking measured, not assumed — a hook that can be stalled is a hook that can
  be timed out, and a killed `PreToolUse` hook emits nothing, which means ALLOW.
  On 18k-35k character adversarial inputs (`gh.` x6000, `gh` x10000, `gh` + `.gh`
  x6000, a 20k quoted path, 5000 `-f k=v` fields, 20k leading spaces) the three gh
  parsers decide in **0.06-2.96 ms** and the whole `evaluateProductionAction` in
  **0.17-86 ms**. The test pins a 250 ms ceiling on the parser path.
- `node .codex/hooks/production-action-guard.test.mjs`, `npm run test:agent-workflows`,
  `node scripts/agent-manifest-parity.mjs` and `npm run agent-health` all pass. Parity
  is unaffected: no hook was added or removed on either side.

### Other name lists in the same file — reachability MEASURED, not read

Each was probed through `evaluateProductionAction`, because a list's omission only
matters if some *other* rule does not already catch the case. Two of the three are
compensated; one is not.

**`usesDynamicProcessEval` (lines ~763-765) — REACHABLE, a real gap.** Three
`node(?:\.exe)?` occurrences, and the helper is node-only while its sibling
`NODE_INTERPRETER_RE` already knows about `npx`/`tsx`/`ts-node`/`bun`/`deno`. This
rule exists to stop an interpreter running code the guard never gets to inspect.
Measured:

| command | verdict |
| --- | --- |
| `echo x \| node`, `echo x \| node.exe`, `node -` | BLOCKED |
| `echo x \| node.cmd` / `node.bat` / `node.ps1` / `nodejs` | **allowed** |
| `echo x \| C:\tools\node.cmd` | **allowed** |
| `node.cmd -` / `node.cmd --eval "x"` / `node.cmd -p "x"` | **allowed** |
| `echo x \| bun`, `echo x \| deno`, `bun -e "x"`, `deno eval "x"` | **allowed** |

Not fixed here: it is a different helper with a different blast radius, and this
change is deliberately confined to the gh binary. It wants the same treatment —
`BIN_TAIL` plus the interpreter set `NODE_INTERPRETER_RE` already carries.

**`NODE_INTERPRETER_RE` (line ~753) — same one-item list, not independently
reachable in the forms tested.** `npx.cmd $S`, `node.cmd $S`, `bun.cmd $S` and
`deno.cmd $S` were all BLOCKED — but by `computedSegmentWithUnrecognizedCommand`
(an unrecognised head plus computed text), not by this rule. Its omissions are
covered in those shapes; it should still lose the list when the file is next
touched, because a compensator is not a fix.

**`normalizeShellHead` (line ~433) — strips `\.(?:exe|cmd|bat|com)$`.** Also a
roster, but its omissions fail **closed**: an unstripped extension leaves the head
unrecognised, and an unrecognised head is treated as a writer and denied.
Over-block, not under-block.

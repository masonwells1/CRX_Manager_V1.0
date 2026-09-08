## 2026-09-08 - The push and merge gates now read the argv the SHELL produces, not the words as typed

### What was broken

PR #630 modelled the gh BINARY by shape instead of by a list of extensions. The words
*after* the binary kept being compared as typed — and a shell removes quote and escape
syntax from every word, not just the first. `gh pr merge 123` and `gh pr me""rge 123`
are the same command to the computer; only the first was recognised.

Two distinct defects in `.claude/hooks/codex-push-lib.mjs`, both reported by CodeRabbit
on this PR (Major / Security, on `ghApiMutates`):

1. **`splitShellArgs` treated a quote as a WORD BOUNDARY.** Its scan was
   `/"[^"]*"|'[^']*'|\S+/g`, so `"--method"=POST` — one word to every shell — arrived
   as the two tokens `--method` and `=POST`, and no `--method` comparison ever saw the
   option.
2. **The words it produced were never resolved to the argv the program receives.**
   `--met""hod=POST`, `--meth\od=POST` and `-"X" POST` matched no keyword, so
   `ghApiMutates` returned `false` while gh performed the POST.

Measured through `evaluateProductionAction` at `e7c68e24d`, not read off the pattern.
`blocked: false` means the gate did not run at all:

| command | before | after |
| --- | --- | --- |
| `gh pr merge 123 --squash` (control) | `blocked: true` | true |
| `gh pr me""rge 123 --squash` | **`false`** | true |
| `gh pr me''rge 123 --squash` | **false** | true |
| `gh p""r merge 123 --squash` | **false** | true |
| `gh pr me\rge 123 --squash` | **false** | true |
| `gh api -X POST repos/o/r/issues/1/comments` (control) | true | true |
| `gh api --met""hod=POST …` | **false** | true |
| `gh api --met''hod=POST …` | **false** | true |
| `gh api "--method"=POST …` | **false** | true |
| `gh api --meth\od=POST …` | **false** | true |
| `gh api -"X" POST …` | **false** | true |
| `gh api -X PO""ST …` | **false** | true |
| `gh a""pi -X POST …` | **false** | true |
| `gh api … -"f" body=x` / `--fi""eld body=x` | **false** | true |
| `git push origin HEAD:main` (control) | true | true |
| `git push origin HEAD:m""ain` | **false** | true |
| `git push origin HEAD:m''ain` | **false** | true |
| `git push origin HEAD:ma\in` | **false** | true |
| `git p""ush origin HEAD:main` | **false** | true |
| `gh api repos/o/r/issues/1 --jq .title` (control) | false | false |
| `npm run build` (control) | false | false |

The controls returning `false` are what make the table conclusive: `false` means "not
blocked", not "the call errored". Every `true` in the "after" column was also checked
for its REASON — merge-gate, `gh api` and composition denials, not incidental ones.

`blocked: false` on a `pr merge` line means the merge gate — green pipeline,
`CHANGES_REQUESTED`, the `--admin` refusal, the exact-SHA risky-diff proof — never ran.
A merge to `main` auto-deploys production through Vercel.

**Latent, not an incident.** No agent has typed these spellings, nothing is armed, and
GitHub's `protect-main` ruleset remains the external hard wall. The gap was one layer
deep, and the layer was real.

**The same fix, made once before, stopped one line short.** `ghMergeRequest` has
normalized flag NAMES since Codex's P1 on PR #541 (`--ad""min`, `--ad\min`). That fix
covered flag names and nothing else, so the identical splice in the `pr`/`merge`
subcommand words directly above it, and in every keyword of the two `gh api` parsers,
survived untouched. Partial compliance with a finding leaves the same bug.

### The fix

- **`splitShellArgs` now splits on UNQUOTED whitespace only** — a character walk that
  tracks quote context, in which `\` binds the next character into the word (so `\"`
  cannot open a quote and `\ ` cannot end a word). The token TEXT is still returned as
  typed apart from the long-standing wrapping-quote strip, because callers read values
  — remote URLs, Windows destination paths — where the raw form is the correct one.
- **`shellArgvWord` (new, exported) resolves one word to the argv a program receives**,
  and `splitShellArgv` maps it over a whole command. The three gh parsers compare every
  subcommand, option name and HTTP method against that reading.
- **`ghMergeRequest`'s inline `word.replace(/["'\\]/g, "")` is gone**, superseded by the
  correct reading.
- **`.codex/hooks/production-action-guard.mjs` now imports the shared
  `pushHiddenByShellComposition`.** `codex-push-guard.mjs` has refused composition-hidden
  pushes since Codex's nineteenth 2026-07-30 review; this guard never got the check, and
  it is checked on the WHOLE command and BEFORE `isGitPush`, because `git p""ush` is not
  a push to `isGitPush` at all. Shared helper, not a fourth copy.

### This is a shell-aware reading, NOT "delete every quote and backslash"

Blanket removal is a second bug in the opposite direction, and CodeRabbit named it:
`--method='P"OST'` really does pass `P"OST` to gh, so erasing the quote would read it
as POST and deny a call that is not one. Only syntax the shell CONSUMES is removed:

- outside quotes, `\` escapes the next character and `'`/`"` open a quote context;
- inside single quotes everything is literal, `\` included;
- inside double quotes `\` escapes only `"`, `\`, `` ` `` and `$` — which is what keeps
  a double-quoted Windows path (`"C:\tmp\x.json"`) intact;
- an unterminated quote runs to the end of the word rather than being dropped, the
  fail-closed reading.

The reading is applied to subcommands, option names and the HTTP method, never to
free-form values (`--repo`, body fields, destination paths), where a Windows separator
must survive verbatim. Backslash escapes are POSIX and PowerShell leaves `\` literal, so
reading them as escapes can only make a gate RUN on a word PowerShell would have left
alone — the fail-closed direction.

**A second-order bug caught during the fix, and pinned:** applying the argv reading on
top of `unquoteShellArg` re-interprets a surviving literal quote as syntax — `-X 'P"OST'`
unquotes to `P"OST`, which re-reads back to `POST`. The reading is therefore computed
once, from the RAW word, and `splitShellArgv` is a sibling of `splitShellArgs` rather
than a layer on it.

### Both directions are pinned

Asserted unchanged: `gh-dash pr merge 1`, `ghq push`, `ghost pr merge 1`,
`npm run ghpr`, `echo highlight pr merge`, `gh pr view 123`, `gh.cmd pr view 123`,
`gh pr list`, `npm run build`, `git log --oneline`, `gh api … --jq .title`,
`gh api -X GET …`, and an ordinarily quoted push (`git push origin "HEAD:main"`), which
must reach the normal gates rather than the composition refusal. A throwing `runGh`
makes an accidental trip into any gate fail loudly instead of passing quietly.

`gh pr merge <n> --disable-auto` cancels a pending auto-merge and lands nothing, so the
gate stands down for it — including the spliced spelling `--disable-a""uto`, in both
directions.

### Proof

- Every new assertion was run against the **pre-fix** snapshot `e7c68e24d` in a detached
  worktree and fails there — the table above is that run's output, not a re-reading of
  the patterns.
- Backtracking measured, not assumed: a hook that can be stalled is a hook that can be
  timed out, and a killed `PreToolUse` hook emits nothing, which means ALLOW. On 20k-40k
  character adversarial inputs (unterminated quote runs, `a""` x12000, `\"` x20000) the
  word walk and all three parsers stay linear; the tests pin a 250 ms ceiling.
- `node .claude/hooks/codex-push-lib.test.mjs`,
  `node .codex/hooks/production-action-guard.test.mjs`,
  `node .claude/hooks/pr-merge-guard.test.mjs` (129 assertions),
  `node .claude/hooks/guards.test.mjs` (168 assertions),
  `npm run test:agent-workflows` — all pass. Parity is unaffected: no hook added or
  removed on either side.

### Still open, measured not read

The sibling name lists reported in the 2026-09-07 entry are unchanged and still stand:
`usesDynamicProcessEval` remains a reachable gap (`echo x | node.cmd` is allowed),
`NODE_INTERPRETER_RE` is compensated rather than fixed, and `normalizeShellHead` fails
closed. This change is confined to shell word reading.

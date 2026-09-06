## 2026-09-05 - The Claude-side maintenance-producer shell guard denies by NAME; the opaque-invocation classifier is removed

**Why.** A timestamp-bounded read of the last 14 days of Claude transcripts (2026-08-21 to
2026-09-04) counted 1,503 tool-call refusals; 849 of them came from `bash-safety-lib.mjs`'s
maintenance-producer check, and only 59 of those named the producer. The other 790 were ordinary
commands refused for their SHAPE — `node -e`, `node -v`, `bash -c`, `python -c`, `| xargs`, a
heredoc, `[ -f x ] && …`, `$VAR` in executable position, a PowerShell `@(…)` — because a ~350-line
"opaque invocation" classifier treated any command whose executable or code could not be read from
its text as a possible producer launch. Each refusal costs a full-context model call plus a retry,
and the message it printed ("Blocked maintenance producer invocation") described none of them.

The 2026-08-31 decision in `docs/manual/DECISION_LOG.md` had already recorded the classifier as
"the larger remaining productivity cost", found it ineffective (`node runner.mjs` or `make x` run
the producer without tripping it), and named its removal "the next harness-focused task after this
one, not a backlog item". The classifier's original job — closing the pre-bootstrap window before
the generated Codex production guard existed (handoff of 2026-08-12) — ended when that guard was
installed and blob-pinned.

**What changed** (`.claude/hooks/bash-safety-lib.mjs`, tests in `bash-safety.test.mjs`).

The classifier is gone. The Claude-side shell guard now refuses exactly two shapes:

- any spelling of the producer's name or of its approval token that survives quote, slash,
  whitespace, backtick, and caret stripping — chained, wrapped, re-spelled, reordered, with an
  unknown argument, behind `cmd /c` or `env`, or assembled by cmd `set` — unless the whole command
  is one of the four reviewed invocations;
- a JavaScript runtime (`node`, `nodejs`, `bun`, `deno`) whose SCRIPT argument is computed (`node
  "$F"`, `node scripts/$(…)`, `node scripts/appl?-…`, `!F!`, a PowerShell sub-expression), in a
  segment whose head word executes what follows (the runtime, a shell, or a transparent launcher
  such as `exec`, `env`, `nohup`, `timeout`, `xargs`). That is the one shape that runs a file
  whose name the rule cannot check. Arguments after the script and inline code (`-e`, `-p`,
  stdin) are not scanned; a segment headed by `echo`, `rg`, `git commit -m`, or `Write-Output`
  is data.

The three NODE_OPTIONS mutation spellings that lived inside the classifier (`Set-Item
Env:NODE_OPTIONS`, `$env:NODE_OPTIONS =`, `[Environment]::SetEnvironmentVariable('NODE_OPTIONS'`)
are kept as their own ordered checks, anchored to a statement start so the same text quoted as
search data stays a read. The npm-script indirection check uses the same two rules.

**What is now allowed, on purpose.** The whole deny corpus the classifier was tested against is
still in the test file, re-sorted by what the by-name rule does with each entry: 18 stay denied by
name, 49 by a computed script, 1 by the NODE_OPTIONS rule, and 64 are now allowed. Two of the 64
are producer invocations with the name split or held in variables (`& ('no','de' -join '') …`,
`& $EXE $OPTION $MODULE $SCRIPT $APPROVAL`). They are allowed knowingly: the producer itself
refuses any argv but its exact reviewed one, a dirty worktree, `main` or a detached HEAD, a body
that differs from its committed HEAD blob, and any write mode without a fresh exact-head Sol proof;
its only outputs are three pinned blobs in a branch worktree that still have to pass the PR
pipeline; and the same run was always reachable through `node runner.mjs`, which the classifier
never saw. The generated Codex production guard (`.codex/hooks/production-action-guard.mjs`) keeps
the full classifier, blob-pinned, for the Codex session that holds production credentials; it is
not touched here.

**Recorded over-block.** A computed `node …` inside a quoted argument of `pwsh`/`bash` is refused
even when that argument is not a command string, because a shell head makes the whole segment a
command line to this rule. The old classifier parsed each shell's option grammar to tell the two
apart, and that grammar is what never converged under review. Pinned in the test file.

**Exact-SHA Codex review, round 1 (2026-09-05), and the prediction for round 2.** `gpt-5.6-sol`
returned BLOCKERS on one HIGH finding: the PowerShell launch with the runtime and option names
split (`& ('no','de' -join '') ('--requ','ire' -join '') ./preload.cjs …`) is allowed by the
candidate and denied by `main`, and a preload runs before the producer's own checks. That is a
nameless launch — the class this change removes on purpose, listed as allowed in the test file with
its reasoning — not a defect in the by-name rule. Closing that one spelling would reopen on the next
(`Invoke-Expression "$COMMAND"`, `cmd /c "%X%"`, `Start-Process (…)` are on the same list), which is
the recorded "a command-text guard never converges" pattern. Prediction, written before round 2 on
the rebased candidate: the reviewer re-raises a nameless-launch form as HIGH. If it does, the
disagreement is an owner decision (keep the 790-refusals-a-fortnight classifier, or accept that a
nameless launch is bounded by the producer's own gates and the PR pipeline) and goes to Mason with
both positions rather than to a fifth round. The second finding of round 1 — a `RelatedNotes`
regression — was the stale-base artefact (the candidate predated PR #609) and disappears with the
rebase.

**Round 2 happened as predicted, and the disagreement went to Mason.** The rebased candidate drew
the same BLOCKER on a nameless launch. Mason accepted the by-name design on 2026-09-05 and pushed
the branch himself as PR #619; the Claude-side push and merge guards refuse without a CLEAN Sol
proof, so the owner's terminal is the only path for this change.

The Codex App's three P2 findings on the PR's first commit are fixed in the same PR; see
`docs/changelog.d/2026-09-05-pr619-shell-guard-redirection-quote-option-fixes.md`.

**The producer was retired while this PR was open.** PR #622 (merged 2026-09-05 21:30Z) deleted
`scripts/apply-live-testdata-maintenance-20260812.mjs`, its harness and snippet inputs, and — on a
Codex P1 — removed the four-command allowlist from this same guard so every mention of the path
fails closed. `main` was merged into this branch by content: the by-name matcher and the
computed-script rule stay, no allowlist comes back (the four former exact spellings are now pinned
as denied, with the retirement named in the refusal), and the test for the deleted harness file is
gone. The "producer's own gates" reasoning above describes the state when the corpus was sorted;
since the retirement there is no file at that path to run, and a nameless launch is bounded by the
PR pipeline every guard-file change must pass.

**Proof.** `node .claude/hooks/bash-safety.test.mjs` (459 assertions, including the live hook on
the four shapes that used to be refused) and `node .claude/hooks/mcp-tool-guard.test.mjs` (30). The
Codex guard's suite is unchanged and untouched. Exact-SHA Codex proof via
`scripts/write-codex-push-proof.mjs` recorded in the PR.

# Guard-denial baseline — 2026-09-11 (start of the guard freeze)

**Status:** baseline captured 2026-09-11 by a read-only session. Re-measure on 2026-09-25 with the
same command and window length, per section 6 of `docs/plans/2026-09-11-open-pr-backlog-plan.md`.
**Rule from that plan:** no guard change is proposed from denial counts alone.

## How it was measured

Read-only. The script reads the Claude Code transcripts on this PC and sends nothing anywhere.

```
node scripts/claude-usage-report.mjs --start 2026-09-04 --end 2026-09-11 --denials <scratch>/denials-baseline-0904-0911.json
```

- Script at commit `a8656debb` (PR #613), unchanged on `main` at capture time.
- Window: seven full days, 2026-09-04 00:00 UTC to 2026-09-11 00:00 UTC, events filtered by their
  own timestamp. The 2026-09-25 re-measure uses 2026-09-18 to 2026-09-25.
- The `--denials` export quotes refused command text verbatim, so it stays in the session's scratch
  directory and is not committed. Nothing below quotes a denied command.
- Diagnostics from the run: 654 transcript files, 728,883 lines, 58 parse failures, 0 unpaired
  denials (every counted denial is attributed to a tool call inside the window).

## Baseline figures (2026-09-04 .. 2026-09-11)

| Field | Value |
|---|---|
| Main sessions | 433 |
| Subagent transcripts | 103 |
| Human prompts (Mason-authored, main transcripts only) | 995 |
| API calls | 33,139 |
| Unique tool calls (attempted operations) | 36,228 |
| Hook denials (attributed) | 1,199 = 3.31% of unique tool calls |
| Sessions with at least one denial | 96 |
| Cache-read tokens | 6,076,209,319 |
| Output tokens | 22,962,108 |
| Average context per call | 186,994 |
| API calls above 200K context | 12,436 (37.5%) |

### Denials per category (all categories)

| Category | Denials | Distinct sessions | By tool |
|---|---|---|---|
| review-proof | 631 | 73 | Bash 590, Read 20, Grep 15, Write 5, Monitor 1 |
| maintenance-producer | 374 | 69 | Bash 370, Grep 3, Read 1 |
| other-hook | 121 | 37 | Edit 114, Bash 7 |
| hold-latch | 73 | 28 | Bash 52, Read 9, Write 4, Edit 3, Grep 3, Glob 1, spawn_task 1 |

Reason text, by count, inside each category:

- review-proof: 430 "shell commands that WRITE to .husky, .github/workflows, .claude/hooks, .codex/hooks…";
  127 "destructive or overwriting shell commands touching the .claude review state directory";
  36 "review state directory … cannot be…"; 14 "direct shell access to review proof JSON";
  4 "review state directory … cannot become an interactive shell working directory".
- maintenance-producer: 329 "use one exact repository-relative node command only; chaining, wrappers…";
  41 "the 2026-08-12 maintenance producer was retired unapplied".
- other-hook: 114 of 121 are the MEMORY.md index-size guard refusing an Edit to
  `~/.claude/projects/C--CRX-Manager/memory/MEMORY.md`; 6 are AUTOPILOT never-auto-approve refusals.
- hold-latch: 25 are the latch itself ("Mason said stop / pause / scope-only"); the rest are reads of
  files whose text merely contains the latch's own wording (the classifier matches on the result
  text, so these are counted as denials but were not refusals — see "Missing data").

### Read-looking share

A command whose first word is a read (`cat`, `head`, `sed -n`, `grep`, `ls`, `git log/show/diff/status`,
`gh api`, `node -e`, …) was refused in:

| Category | Read-looking / total |
|---|---|
| review-proof | 356 / 631 (56%) |
| maintenance-producer | 188 / 374 (50%) |
| hold-latch | 31 / 73 |
| other-hook | 1 / 121 |

The heuristic is a first-word match; a `cat > file` redirection is counted as read-looking, so the
true read-only share is somewhat lower. It is the same heuristic used in the 2026-09-10 review, so the
2026-09-25 figure is comparable.

### Repeated identical failures

19 command strings were refused two or more times, covering 156 denials. One string accounts for 113
of them: the MEMORY.md index-size guard refusing successive Edits to the same file. The next largest
groups are four refusals each (an inline Python edit of a hook test, a `sed -n` read of a hook library,
a `node <scratch script>` invocation refused as a maintenance-producer wrapper).

### Concentration

96 sessions had at least one denial; the ten sessions with the most denials account for 34.8% of all
denials (36 to 51 denials each).

### Estimated time lost

Proxy: wall-clock from each denial result to the session's next tool call (the retry, workaround,
or next step), measured over 1,418 denial results in the window (this count includes a denial that
was answered more than once and is therefore higher than the 1,199 attributed denials above).

| Category | Median to next tool call | 90th percentile | Sum, capped at 10 min per denial |
|---|---|---|---|
| review-proof | 5 s | 19 s | 2.0 h |
| maintenance-producer | 5 s | 17 s | 0.9 h |
| other-hook | 9 s | 24 s | 0.5 h |
| hold-latch | 9 s | 24 s | 0.6 h (14.1 h uncapped: the latch is meant to stop the session, so long gaps are Mason's, not lost) |
| All | 5 s | | 4.0 h |

Direct agent time lost to denials over the week was about four hours. The larger cost identified in the
2026-09-10 review is indirect: 15 of 50 merged PRs and 8 of 16 open PRs in the week were guard, CI, or
harness work, much of it opened to fix a false positive. Neither figure is a reason to change a guard
on its own; the freeze holds to 2026-09-25.

### Successful supported alternatives

Not measurable from the export: the transcripts record what was refused and what was tried next, but
not whether the next call was the "supported form" of the same operation. The time-lost proxy above
(median five seconds to the next tool call) is the closest available signal that a refused call was
usually re-issued in another form immediately.

## Missing data

- The category classifier reads the tool RESULT text. A `Read` or `grep` whose output contains a guard's
  own wording is counted as a denial of that kind (visible in hold-latch and in single-digit rows of
  the others). The 2026-09-25 measurement should either keep the same classifier for comparability or
  report both raw and result-text-corrected counts.
- Denials are attributed per tool call; a refusal that made the agent stop the whole task is not
  distinguished from one it worked around in five seconds.
- The MEMORY.md size-guard refusals are a memory-hygiene signal, not a repository guard signal; they
  are reported because the plan asks for every category.
- No dollar figure: the report's weighted share uses price ratios only.

## Re-measure on 2026-09-25

```
node scripts/claude-usage-report.mjs --start 2026-09-18 --end 2026-09-25 --denials <scratch>/denials-0918-0925.json
```

Report the same table, plus outcomes A–E from the plan, with denominators (unique tool calls, sessions).

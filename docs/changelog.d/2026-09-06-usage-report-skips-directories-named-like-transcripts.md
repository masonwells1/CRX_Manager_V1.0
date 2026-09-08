## 2026-09-06 - The usage report skips a directory named like a transcript under subagents/

CodeRabbit's review of PR #613 at 336ad30f0 found that the subagent scan in
`scripts/claude-usage-report.mjs` filtered `*.jsonl` entries by modification time
only, while the main-transcript scan also checked that the entry is not a
directory. A directory named like a transcript under a session's `subagents/`
folder therefore reached `fs.createReadStream`, which raised `EISDIR` and crashed
the report.

The subagent scan now requires a regular file before the time pre-filter. The
regression fixture adds such a directory beside the real subagent transcript and
requires the report to exit 0 within a bounded timeout; on the previous code the
run exited non-zero with the `EISDIR` error.

The same review asked for two documentation corrections in this PR's own ledger:
the 2026-09-04 entry called the report "read-only" although `--denials <path>`
writes an export (it now names that one exception and its scratch-path rule), and
the 2026-09-05 Codex App round entry carried inline-code spans with interior
spaces that trip markdownlint's MD038 (rewritten as prose).

## 2026-09-05 - Exclude subagent instructions from the human-prompt count

Fable 5.1 reviewed PR #613 and found that subagent starting instructions were
counted as Mason's prompts. The human-message classifier now excludes subagent
transcripts while retaining their API usage, tool calls, and paired denials.

A synthetic transcript fixture reproduced four human prompts where only two
were written by the owner. The regression covers string and text-block records,
and checks that subagent token usage and a paired denial remain in the report.
Run it with `node scripts/claude-usage-report.test.mjs`.

Fable found no required changes to the report-folding or reminder-deduplication
hooks. Its optional observations about cross-file response deduplication, mixed
envelopes, argument parsing, and report formatting remain follow-up limitations;
this change addresses the actionable prompt-population finding.

## 2026-09-26 - autonomous landing: the daily summary counts only explicit apply records

**Sol MEDIUM, round 8 on PR #804 (verdict CLEAN).** `scripts/daily-landing-summary.mjs` counted any
changelog entry containing "applied live" as an apply, so a note saying a migration was "not applied
live" was reported to Mason as applied. Real change notes mix both phrasings, so prose is no longer
read at all: an apply counts only as an explicit record line, `Applied live: <migration_name>`, at the
start of a line and naming a real migration stem.

The record's location also changed. `/ship` told agents to write "applied live" into the change's
changelog entry, but the apply happens after CodeRabbit approved and Sol cleared the final head, so
that edit would have moved the approved head and voided both reviews. Agents now post the record as a
comment on the merged PR (`/ship` Step 8 item 7). The summary reads it only from Mason's account —
the one the agents' `gh` uses — so a stranger's comment on the public repo never counts. Changelog
entries with the same explicit line still count, for applies recorded later.

Also fixed: migration names in the summary lost their underscores (the markdown scrubber strips them).
Names that are plain letters, digits and underscores are now shown intact in code quotes.

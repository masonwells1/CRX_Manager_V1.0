## 2026-09-05 - restore the quote status transition edges, derived from the live enforcer

Answers the second CodeRabbit review of PR #600, on `51d7da16`. Three comments, one accepted and
two rejected with reasons.

### Accepted — `docs/workflows/QUOTE_TO_DELIVERY.md`

The streamlining replaced the quote lifecycle's transition graph with a bare list of allowed values.
`docs/workflows/SAFE_DEVELOPMENT_RULES.md` still promises the opposite — "Every lifecycle has defined
transitions (see QUOTE_TO_DELIVERY.md)" — so the routed reader was sent to a document that no longer
answered the question, and `cancelled` had no description at all.

The edges are restored, but **not** the ones that were deleted. `main` carried a single linear chain:

```
draft -> sent -> revised -> accepted -> declined -> expired -> cancelled
```

That is not the live state machine and never was. It reads as though `accepted -> declined` and
`expired -> cancelled` are legal; both are refused, and it omits `closed_by_application` and
`closed_short` entirely. Restoring it verbatim would have re-documented a fiction.

The table now published is read from the authority itself — the `_enforce_quote_status_transition`
trigger on `quotes`, queried live via `pg_proc.prosrc` — together with its three qualifications
(no-op updates always pass, `_is_admin_override()` bypasses the table, and `closed_short` is refused
with `BOOKING_HAS_ACTIVE_JOBS` while a scheduled or in-progress job still references the quote). The
note that `save_quote()` enforces a deliberate strict subset is recorded so the two are not mistaken
for a contradiction. The nine allowed values were confirmed against the live CHECK constraint.

### Rejected — `scripts/log-session.mjs`, "add the missing closing parenthesis"

False positive. The banner spans two `console.log` lines and the parenthesis opened on the first is
closed on the second (`...if drifted)`). Applying the suggestion would have emitted two closing
parentheses for one opening.

### Rejected — `.claude/agents/compliance-reviewer.md`, markdownlint MD022

Style nitpick, declined. `markdownlint` is not configured or run anywhere in this repository, so the
rule is the reviewer's own linter rather than a project gate. All eleven `### CHECK n` headings in
that file are followed directly by their content; CHECK 10 is the file's consistent style, not an
outlier. The comment's prose also misreads its own tool output — it asks for a blank line *before*
the heading, while the attached MD022 detail reports `Below`, and line 87 is already blank.

## Verification

- Transition table read from live `pg_proc.prosrc` for `_enforce_quote_status_transition`, and the
  nine status values from the live `quotes` CHECK constraint.
- `node scripts/check-agent-guidance.mjs` — passes, including "quote workflow documents every live
  terminal status" and "every lifecycle audit compares all nine entities with live CHECK constraints".
- `npm run test:agent-workflows` — passes.

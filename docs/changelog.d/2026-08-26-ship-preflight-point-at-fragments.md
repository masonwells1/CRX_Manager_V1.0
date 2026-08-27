## 2026-08-26 — the shipping workflows now point at fragments, and a date is not a record

Three findings, and the first is the one that decided whether any of this works.

**`/ship` and `/preflight` still told sessions to append to `docs/CHANGELOG.md`.** A
convention the canonical shipping workflow contradicts is a convention nobody follows —
ordinary parallel sessions would have kept landing in the shared file and kept colliding,
while this PR quietly claimed to have fixed it. Both commands now direct a shipped change
to a new `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` entry, and both state the conditions
that actually make one count: it must be ADDED by the commit, and it must describe the
change. Adoption was the open risk called out when this convention landed; this closes the
part of it that is mechanical rather than social.

**A bare `## 2026-08-26` satisfied the content check.** The heading regex required a date
and nothing else, so an entry consisting only of a date passed as a "written record". A
heading now needs a description after the date, and needs detail beneath it — a title with
an empty body records the fact that something happened and none of what it was.

**Fragments escaped validation on trigger-free commits.** The guard returned early when a
commit touched no agent-surface file, so a `src/`-only commit could drop an empty or
malformed entry into the folder unchecked. Validation now runs on any ADDED entry
regardless of triggers. A commit staging no entry is unaffected, and merely touching an
existing entry without claiming it as your record is still fine.

76 assertions (was 68). `npm run test:agent-workflows` passes after the command edits.

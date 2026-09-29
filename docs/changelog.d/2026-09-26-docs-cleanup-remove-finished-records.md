## 2026-09-26 — Docs cleanup: remove 277 finished records, carry their open items forward

Mason asked for a full docs cleanup. It landed in three PRs. The first (#830) corrected stale
facts in the living docs and copied every open item out of the records due for removal. The
second (#833, 138 files) and the third (this change, 139 files) removed those finished records.
Splitting the removal kept each PR under CodeRabbit's 150-file limit.

**What was removed (277 files across parts 2 and 3):**
- finished session handoffs (`docs/handoffs/`);
- completed build loops and their ledgers (`docs/build-loops/`, `docs/loops/`);
- most of `docs/archive/`;
- shipped or abandoned plans in `docs/plans/` and `docs/roadmap/`;
- one-off smoke SQL for migrations that were applied in June;
- resolved or superseded audit reports in `docs/audits/`, plus superseded gauntlet snapshots;
- one resolved monthly report;
- `tests/e2e/MEGA-TEST-REPORT.md`.

**The removed text is still in git history.** Any file can be recovered with
`git show <commit>:<path>`. Only a force-push can purge it from history, and that is Mason's
decision. This change does not do it.

**How each file was cleared:** a four-agent inventory proposed candidates and checked every
reference from code, hooks, commands, skills and applied migrations. Six more agents then read
every candidate **in full**. That step was added because the 2026-08-31 cleanup had to restore all
30 files it removed: about a third of them still held open items. Two files were kept:
`docs/OPEN_ITEMS.md`, which an applied migration cites, and `docs/ROADMAP.md`, which still tracks
backlog items. 26 of the removed files held something still open.

**Open items carried forward (in #830):** owner decisions, a smoke test, approved features never
built and one owed proof went to `TODO.md` §5. Open bugs and residual risks went to the top
section of `docs/manual/KNOWN_ISSUES.md`. An item that appeared in several sources was recorded
once. Junk-customer rows are recorded by id prefix only, because the repository is public.
Review of this change found one miss. #830 carried only the click-test from the June UI-overhaul
ledger (`ui-overhaul-v2/STATE.md`), not its other deferred follow-ups. Those are now in `TODO.md` §5:
one owner decision (the old A/R page routes), six features never built, and one item recorded as
dropped. Each was confirmed still open in code on 2026-09-28.

**Pointers:** the archive READMEs (`2026-summer`, `2026-summer-closeout`, `2026-spring`,
`2026-Q1-brainstorms`) now list only what remains. Mentions inside other historical records, the
changelog and applied-migration comments were left alone as history. Four code comments point at
paths that no longer existed even before this cleanup, and they were not touched:
`src/lib/money.ts`, `src/pages/FieldRoute.tsx`, `src/pages/FieldStop.tsx` and
`tests/e2e/holds-cleanup-paths.spec.ts`.

**Deliberately not touched:**
- `docs/CHANGELOG.md` and `docs/changelog.d/`;
- the ChemMan research and walkthrough transcripts;
- generated files;
- the bug-hunt state files the workflows read (each folder's `LEDGER.json`). Only finished
  reports inside those folders were removed; each hunt recreates its morning report on its next
  run;
- `docs/plans/sprayer-packet-feature-todo.md`, an open owner decision in `TODO.md` §4.

**Source citations:** twelve `(Source: …)` citations in `docs/manual/KNOWN_ISSUES.md` named files
that parts 2 and 3 remove. Each now says the file was removed in this cleanup and gives a
`git show 4b6ff6293:<path>` command that recovers it: 4 were edited in #833 and 8 in this change.
These edits touch only those lines. A trial merge against the open field-season delivery PR (#832
at the time), which also edits that file, showed no conflict.

**Proof observed for part 3:** `npm run check:docs` and `npm run test:agent-workflows` both exit 0,
and the pre-push containment, typecheck and build checks pass. **Not verified:** the session-start
hook reads `origin/main`, so it will count fewer loop ledgers only after this merges. That drop
was not observed.

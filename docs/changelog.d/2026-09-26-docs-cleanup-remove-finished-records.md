## 2026-09-26 — Docs cleanup, part 1: remove 275 finished records, carry their open items forward

Mason asked for a full docs cleanup. This part removes finished history only; correcting stale
facts in the living docs is a separate change.

**What was removed (275 files):** finished session handoffs (`docs/handoffs/`), completed build
loops and their ledgers (`docs/build-loops/`, `docs/loops/`), most of `docs/archive/`, shipped or
abandoned plans in `docs/plans/` and `docs/roadmap/`, one-off smoke SQL for migrations that
applied in June, 42 resolved or superseded audit reports in `docs/audits/`, one resolved monthly
report, and `tests/e2e/MEGA-TEST-REPORT.md`. Everything stays recoverable from git history.

**How each file was cleared:** a four-agent inventory proposed candidates and checked every
reference from code, hooks, commands, skills and applied migrations. Then six agents read every
candidate **in full** (the 2026-08-31 cleanup had to restore all 30 files it removed because about
a third still held open items). 249 were plain deletes, 2 were kept (`docs/OPEN_ITEMS.md` is cited
by an applied migration; `docs/ROADMAP.md` still tracks backlog items), and 26 held something
still open.

**Open items carried forward (the 26):** owner decisions, a smoke test, never-built approved
features and one owed proof went to the new `TODO.md` §5; open bugs and residual risks went to a
new top section of `docs/manual/KNOWN_ISSUES.md`. Duplicates across sources were recorded once.
Junk-customer rows are recorded by id prefix only, because the repository is public.

**Pointers:** archive READMEs were rewritten to list what remains; pointers in `TODO.md`,
`docs/manual/KNOWN_ISSUES.md` and `docs/loops/owner-decisions-2026-07.md` now say the target was
removed. Mentions inside other historical records, the changelog, and applied-migration comments
were left as history. Four code comments (`src/lib/money.ts`, `src/pages/FieldRoute.tsx`,
`src/pages/FieldStop.tsx`, `tests/e2e/holds-cleanup-paths.spec.ts`) already pointed at paths that
did not exist before this change; they were not touched.

**Deliberately not touched:** `docs/changelog.d/` and `docs/CHANGELOG.md` (the ledger), ChemMan
research and walkthrough transcripts, generated files, the bug-hunt state files the workflows read (each folder's `LEDGER.json`; only finished
reports inside those folders were removed — the hunts recreate their morning report on the next run), and
`docs/plans/sprayer-packet-feature-todo.md` (an open owner decision in `TODO.md` §4).

**Proof observed:** `npm run check:docs`, `check:agent-guidance`, `check:agent-workflows`,
`check:phase3-private-artifacts` and `test:correction-guards` all exit 0; `npm test` passes
380/380 files (5411 tests). **Not verified:** the session-start hook still counts 8 loop ledgers
because it reads `origin/main`; it should count 5 after merge, which was not observed.

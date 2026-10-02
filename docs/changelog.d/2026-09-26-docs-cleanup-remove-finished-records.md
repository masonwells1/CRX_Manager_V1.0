## 2026-09-26 — Docs cleanup: remove 277 finished records, carry their open items forward

Mason asked for a full docs cleanup. It landed in three parts.

- **Part 1 (#830)** corrected stale facts in the living docs and copied open items out of the records
  due for removal.
- **Part 2 (#839)** removed 138 finished records.
- **Part 3** removed the last 139 and landed as four PRs: this change (the carry-forward edits plus the
  Q1-brainstorms archive), the summer-closeout archive, and the spring archive in two halves.

Part 3 started as one PR (#835, later #854). It was split because a review of its size exceeded the
remaining CodeRabbit usage cap, and part 2 had to stay under CodeRabbit's 150-file limit.

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
one owner decision (the old A/R page routes), seven features never built (including the Customer 360
summary-bar numbers), and one item recorded as dropped. Each was confirmed still open in code on 2026-09-28.
After a second miss, three read-only agents swept all 277 removed files on 2026-09-30. They checked
187 unfinished-item markers (unticked boxes, "REMAINING", "DEFERRED") and the text around them against
current code and every tracker. Most markers were shipped work, items already tracked, or one-off process
steps. About fifteen open items that no tracker recorded are now in `TODO.md` §5 under "Found by a full
sweep of every removed doc":
- the approved 2026-05-04 UI follow-ups;
- two field-boundary import gaps;
- three low-severity inventory and loader checks;
- the field-app parity leftovers;
- a dead-animation cosmetic issue;
- a keep-or-drop list of unscheduled accounting features.

One owner smoke test (importing a real field boundary export) was added under "Owner smoke test".

Codex then found a third miss written as free text rather than as a checkbox: a statement PDF that prints
its footer twice. Six more read-only agents read all 616 free-text phrases that mark open work ("future
fix", "follow-up", "out of scope", "owner call" and similar) across 192 removed files, again checking each
against current code and every tracker. About twenty more open items are now in the same `TODO.md` §5
block:
- three low-severity access gaps;
- field-app owner actions and decisions, including the never-done `send-email` deploy that turns on
  application notices;
- four field-app bugs;
- field-app polish;
- two ordering items: a possible idempotency race in `create_direct_order`, and the dormant field-staff rush-order branch.

One agent claim was checked and rejected: the vendor-bill name check it cited exists only in an older
version of that function.

Review of part 3a then found open findings written as audit headings (for example "4.3 N+1 query in
batch invoice print"), a format that both sweeps above missed. Four more read-only agents went through
every finding in the roughly 100 audit and review reports still to be removed.

- **Result:** most findings were already fixed. About 90 open, untracked items were added to `TODO.md`
  §5 under "Found by a sweep of every removed audit's findings", and the financial audit log's
  references to deleted records went to `docs/manual/KNOWN_ISSUES.md` as a HIGH item.
- **Rejected:** two agent claims did not hold. `allocate_payment` was already revoked from anon, and the
  preset-date drift was already tracked.
- **Not fully re-checked:** three of the largest audits were not re-checked row by row. TODO.md names
  them so they are re-read from git history before anyone acts in those areas.

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
`git show 4b6ff6293:<path>` command that recovers it: 4 were edited in #839 and 8 in this change.
These edits touch only those lines. A trial merge against the open field-season delivery PR (#832
at the time), which also edits that file, showed no conflict.

**Proof observed for part 3:** `npm run check:docs` and `npm run test:agent-workflows` both exit 0,
and the pre-push containment, typecheck and build checks pass. **Not verified:** the session-start
hook reads `origin/main`, so it will count fewer loop ledgers only after this merges. That drop
was not observed.

## 2026-09-26 — Docs cleanup, part 1 of 3: correct stale and wrong facts in the living docs

Part 1 of 3 of Mason's full docs cleanup (parts 2 and 3 delete 277 files: 275 finished records plus the 2 docs this part folds into others). This part corrects the
docs agents and the owner rely on, so they match current code, config, git history and the live
migration ledger. No rule or policy was changed; where a doc disagreed with enforced behaviour it
was brought into line, and policy questions were reported instead of decided.

**Sources of truth used:** a read-only live `list_migrations` on 2026-09-26 (1011 rows, max version
`20260926163005`), the schema registry, `src/types`, the migrations on disk, `src/App.tsx`, the
hooks and CI files, and read-only `gh`. Nine editors each owned a disjoint set of files and
re-checked every audit finding against current text (PR #797 had already fixed some); findings
they could not verify were skipped and listed, not guessed.

**Most consequential corrections**
- `docs/reference/migration-history.md` (machine-read by the session-start hook and fleet status):
  `20260914100500`, `100600` and `100700` now read APPLIED LIVE with their ledger versions. The
  hook's reader (`localCandidateMigrationPathsFromHistory`) returned 5 parked migrations on
  `origin/main` and returns exactly `100800` and `100900` on this branch — the real parked set as of
  2026-09-26 (`100800` was applied live on 2026-09-27, ledger `20260927060531`). The
  boundary header is current and stale "not applied" sections applied since June are corrected.
- `docs/manual/KNOWN_ISSUES.md`: one current header; 45 resolved/closed entries moved, text intact,
  to a "Resolved and closed (archive)" part at the end; ~60 status corrections with evidence. Every
  old heading was checked to still exist (one verbatim duplicate pointer was removed).
- `docs/manual/CURRENT_STATE.md`: ~500 lines of stacked superseded headers removed; correct applied
  vs parked migration state and effective ordering high-water; the finished open-PR queue replaced.
- `docs/manual/DECISION_LOG.md`: 8 entries marked SUPERSEDED and 28 dated update notes; nothing
  deleted. The two 2026-07-13 entries are now unambiguous.
- `AGENTS.md`: not changed by this part. Its earlier edits here were superseded by the autonomous-landing
  text from #804, which this branch took verbatim when main was merged in.
- Reference docs: `database-schema.md` (~25 column/status/tier fixes), `rpc-functions.md` (54
  browser-called RPCs added, dropped functions removed), `pages-routes.md` (rebuilt from the router;
  95/95 routes match), `code-patterns.md`, `agent-guardrails.md` (~20 hook-behaviour corrections).
- Workflow docs: page-adding steps, the `useIdempotencyKey()` hook pattern, the current new-table
  RLS template, the gated migration-apply path, and business rules that contradicted the database.
- `README.md`, `TESTING.md`, `DEPLOYMENT.md`, `docs/CONTRIBUTING.md`, `docs/SETUP-NEW-MACHINE.md`:
  Node 24, what pre-commit / pre-push / CI actually run, protected-main landing, secret names only.
- Plans, roadmap, loops and `TODO.md`: current status banners; supplier-pricing Stage C recorded as
  shipped (PR #282), not parked; `docs/plans/2026-08-18-product-data-model-GAMEPLAN.md` folded into
  the MASTER-RECORD and `docs/PROMPT_TEMPLATES.md` folded into `OWNER_PLAYBOOK.md` (both source files are removed in part 2);
  the two earmark smoke proofs moved next to the shelved migrations they test.
- Public-repo hygiene: two real customer names and the raw commission-split JSON removed from
  `scripts/db-invariant-sweeps/FIN-README.md`, real payment figures removed from `CURRENT_STATE.md`,
  and one archive log redacted (identity keys kept; the old text remains in git history).
- From the Codex GitHub App and CodeRabbit reviews: the Chicago-year claim is narrowed to the
  generators that use it, with a new `KNOWN_ISSUES` entry for the three that still read the UTC
  clock (quote, order, rebate claim); the `TESTING.md` manual checklist is read-only while no staging
  project exists; the finished CodeRabbit bootstrap procedure is removed; smaller accuracy fixes in
  the QA, inventory, RLS, UI-pattern, roadmap and `TODO.md` docs.

**Proof observed:** `check:docs`, `check:agent-guidance`, `check:agent-workflows`,
`check:phase3-private-artifacts` and `test:correction-guards` exit 0; `npm test` 380/380 files
(5411 tests); the parked-migration reader output above, run on both `origin/main` and this branch.

**Not changed — reported for a decision or a code change:** whether intent-bound idempotency
(`check_idempotency_intent`) should be mandatory for new RPCs; a SAFE_DEVELOPMENT rule that says
non-admins never see commissions while live `comm_select` lets reps read their own rows;
`is_driver()` / `is_applicator()` search_path without `pg_temp`; hardcoded fallback test passwords in
role specs; stale comments in `.claude/hooks/stop-wrap.mjs` and `BatchAdjustModal.tsx`;
`.claude/commands/rollback.md` and `scripts/log-session.mjs` still writing to `docs/CHANGELOG.md`;
duplicate row numbers in `migration-history.md` (not renumbered). Open PRs #793 and #800 edit some of
the same files and will need a rebase after whichever lands first (#799 was closed). #804 and #820
merged on 2026-09-27 and were merged into this branch before review.

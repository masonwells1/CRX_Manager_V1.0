## 2026-09-26 — Docs cleanup, part 2: correct stale and wrong facts in the living docs

Part 2 of Mason's full docs cleanup (part 1 removed 275 finished records). This part corrects the
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
  `origin/main` and returns exactly `100800` and `100900` on this branch — the real parked set. The
  boundary header is current and stale "not applied" sections applied since June are corrected.
- `docs/manual/KNOWN_ISSUES.md`: one current header; 45 resolved/closed entries moved, text intact,
  to a "Resolved and closed (archive)" part at the end; ~60 status corrections with evidence. Every
  old heading was checked to still exist (one verbatim duplicate pointer was removed).
- `docs/manual/CURRENT_STATE.md`: ~500 lines of stacked superseded headers removed; correct applied
  vs parked migration state and effective ordering high-water; the finished open-PR queue replaced.
- `docs/manual/DECISION_LOG.md`: 8 entries marked SUPERSEDED and 28 dated update notes; nothing
  deleted. The two 2026-07-13 entries are now unambiguous, and `AGENTS.md` names the live-migration one.
- `AGENTS.md`: the landing-path summary now names the `ready-for-coderabbit` step, matching `ship.md`.
- Reference docs: `database-schema.md` (~25 column/status/tier fixes), `rpc-functions.md` (54
  browser-called RPCs added, dropped functions removed), `pages-routes.md` (rebuilt from the router;
  95/95 routes match), `code-patterns.md`, `agent-guardrails.md` (~20 hook-behaviour corrections).
- Workflow docs: page-adding steps, the `useIdempotencyKey()` hook pattern, the current new-table
  RLS template, the gated migration-apply path, and business rules that contradicted the database.
- `README.md`, `TESTING.md`, `DEPLOYMENT.md`, `docs/CONTRIBUTING.md`, `docs/SETUP-NEW-MACHINE.md`:
  Node 24, what pre-commit / pre-push / CI actually run, protected-main landing, secret names only.
- Plans, roadmap, loops and `TODO.md`: current status banners; supplier-pricing Stage C recorded as
  shipped (PR #282), not parked; `docs/plans/2026-08-18-product-data-model-GAMEPLAN.md` folded into
  the MASTER-RECORD and removed; `docs/PROMPT_TEMPLATES.md` folded into `OWNER_PLAYBOOK.md` and removed;
  the two earmark smoke proofs moved next to the shelved migrations they test.
- Public-repo hygiene: two real customer names removed from `scripts/db-invariant-sweeps/FIN-README.md`
  and one archive log (identity keys kept; names remain in git history).

**Proof observed:** `check:docs`, `check:agent-guidance`, `check:agent-workflows`,
`check:phase3-private-artifacts` and `test:correction-guards` exit 0; `npm test` 380/380 files
(5411 tests); the parked-migration reader output above, run on both `origin/main` and this branch.

**Not changed — reported for a decision or a code change:** whether intent-bound idempotency
(`check_idempotency_intent`) should be mandatory for new RPCs; a SAFE_DEVELOPMENT rule that says
non-admins never see commissions while live `comm_select` lets reps read their own rows;
`is_driver()` / `is_applicator()` search_path without `pg_temp`; hardcoded fallback test passwords in
role specs; stale comments in `.claude/hooks/stop-wrap.mjs` and `BatchAdjustModal.tsx`;
`.claude/commands/rollback.md` and `scripts/log-session.mjs` still writing to `docs/CHANGELOG.md`;
duplicate row numbers in `migration-history.md` (not renumbered). Open PRs #793, #799 and #800 edit
some of the same files and will need a rebase after whichever lands first.

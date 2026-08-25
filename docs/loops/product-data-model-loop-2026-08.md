# Mission — Product Data Model Rebuild (Phase 0 + Phase 1)

**Launch with:** `/run-loop docs/loops/product-data-model-loop-2026-08.md`
**Ledger:** `docs/loops/product-data-model-ledger.md`
**Scoresheet:** `docs/plans/2026-08-19-product-data-model-COVERAGE.md`

**Read before cycle 1:** `docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md` (what to
build, §3; the 22 decisions, §0; the 12 standing rules, §2) and
`docs/plans/2026-08-19-product-data-model-ORCHESTRATION.md` (how, incl. the 15-step gate chain).
The master record holds the reasoning; the PRD holds numbered requirements. **Where the PRD and
the build plan disagree, the build plan wins** — its §0 closed items the PRD still lists as open.

---

## Driver

**Claude orchestrates; Codex `sol` builds; Claude Opus 5 independently reviews; Mason gates
anything irreversible.**

Per cycle, the orchestrator: grounds against live schema (read-only) → writes a self-contained
spec → runs `node scripts/codex-build.mjs <spec> --model gpt-5.6-sol --effort high` → runs the
deterministic floor → fans out the four reviewers → proves the behavior in the running app →
commissions the Opus checkpoint → mints the exact-SHA Codex proof → commits, PRs, and lands.

**The orchestrator never hands Sol a task it has not first specified in writing.** Sol's wrapper
strips its Supabase, GitHub and Vercel tools, so it can edit the tree and nothing else; every
consequential action stays on the hook-guarded orchestrator side.

**What triggers the next cycle:** the current work package reaches `SHIPPED` or `PARKED` in the
ledger. No cycle starts while the previous package is mid-flight.

**Mason's words (2026-08-19), on continuing while he is unreachable — decision D-U:**
*prepare the next package, apply nothing.* The loop keeps writing and reviewing ahead so progress
does not stall on his availability. **This is not hands-free mode.** Autopilot is not armed by it,
the 2026-07-13 hands-free exception is not invoked, and every live database change still waits for
his in-chat yes.

## Granularity

**One work package per cycle. One package, one pull request** (build plan R-8).

The six packages, in mandatory order — a builder who starts on screens builds them against tables
that then change shape:

| | Package | Migration? |
|---|---|---|
| WP-0 | Data hygiene | no |
| WP-1 | Ingredient core + fast-entry editor | **yes** |
| WP-2 | Density, net weight, scale-weight surface | **yes** |
| WP-3 | Brand layer, receiving capture, split loads | **yes** |
| WP-4 | EPA auto-seed through propose-review-commit | no |
| WP-5 | Copy-from-sibling, searchable nickname | no |

No package bundles another's migration. A package is not finished until its COVERAGE.md rows
carry evidence and its ledger row carries a `PROOF` line.

## Worktree

This loop OWNS a dedicated tree, cut from `main` **after** PR #429 merges, on branch
`ship/product-data-<package>` — a fresh branch per package off current `origin/main`.

Suggested path: `C:\CRX_ProductData` (create it; it does not exist yet — the launcher's
path warning on cycle 1 is expected and non-blocking).

**Never run this loop in a shared tree.** Mason runs many concurrent worktrees; the collision
preflight in ORCHESTRATION §5 runs before the first write of every cycle:
`git worktree list` → `git fetch origin` + ancestry count → `node scripts/fleet-status.mjs` →
Supabase `list_migrations` for the live high-water mark. On any collision, stop before writing and
name the owning worktree.

## Definition of done

The loop ends when **all six packages are `SHIPPED` or `PARKED` with a reason**, and:

- every COVERAGE.md row for a shipped package has non-empty Evidence (set by Sol) **and** a
  Verdict (set by Opus — Sol never grades its own work);
- Opus checkpoint 2 has run: the full 43-issue audit at `xhigh`, plus the PRD-requirement
  cross-check, since the matrix is issue-keyed and PRD-only requirements are otherwise invisible;
- the ledger carries a `PROOF — Ran: … · Saw: …` line per package and a handoff note for Mason.

**Phase 1b and beyond are NOT in this loop's scope.** They continue in this same mission doc by
appending worklist sections later — do not create a new harness per phase, and do not start them
without Mason.

## Delivery gate

**Never without Mason's explicit OK in the current session:**

- applying **any** migration to the live database;
- **any** bulk write to live product rows — WP-0's hygiene edits and WP-4's proposal commit;
- pushing, opening a PR, merging, or deploying;
- deleting anything, ever. Build plan R-7: deactivate or re-identify instead.

**Approval never carries forward between sessions.** A successor re-asks.

`main` is protected: branch → PR → Vercel green → read and resolve CodeRabbit → merge. **A merge
to `main` deploys production.**

**Before the first live write of the whole loop (R-12):** a fresh verified backup. The last good
one is 2026-08-09 and the Supabase org is on the free plan — **there is no point-in-time
recovery**, so that file is the only restore path.

---

## Cycle protocol

Follow ORCHESTRATION §3 exactly. Condensed:

1. Collision preflight (§5). 2. Branch off fresh `origin/main`. 3. Ground read-only + write the
spec. 4. `codex-build.mjs` at `gpt-5.6-sol` / high — max 3 fix rounds. 5. `typecheck && lint &&
build && test && test:agent-workflows`. 6. Four reviewers in one message: `rls-security-reviewer`,
`migration-drift-reviewer`, `typescript-types-drift-reviewer`, `compliance-reviewer`.
7. **Behavioral proof in the running app** — positive *and* negative cases (R-11), on `[E2E]` rows
only (R-9), plus the `has_column_privilege` check per new column. 8. **Opus checkpoint 1** — a
`BLOCK` becomes the next fix-spec verbatim and never reaches Mason. 9. `node
scripts/write-apply-proofs.mjs <migration>`. 10. Docs + commit. 11. PR, Vercel, CodeRabbit.
12. **Mason's apply OK.** 13. Apply → smoke → B7 rename → `/regen-schema-registry` → `db-sweeps`.
14. Merge → re-prove against production. 15. Ledger 🚀, next cycle.

**Ordering, pinned:** the migration **applies before the PR merges**. Phase 1's migrations are
additive, so applying ahead of the code is harmless; merging first would deploy code referencing
tables that do not exist yet. A non-additive migration re-opens this explicitly.

## Standing prerequisites — verify before cycle 1

| Prerequisite | State as of 2026-08-19 |
|---|---|
| Codex credits | **Zero.** Nothing runs — not Sol, not the adversarial gate. Mason's action |
| Codex-app Supabase connector | OAuth grant recorded dead (`invalid_grant`, 2026-08-14). Mason's action |
| Fresh backup | Last good 2026-08-09. **No PITR on the free plan** |
| Parked-migration scan | `fleet-status.mjs` reports `PARKED STATE UNKNOWN` — fail-closed. Repair before trusting any parked count |
| Plan docs on `main` | PR #429. Until it merges, a tree cut from `main` cannot read this mission doc |

## Do not re-litigate

22 owner decisions (D-A … D-V) are settled in build plan §0, and the three consequential ones are
in `docs/manual/DECISION_LOG.md`. The traps most likely to be re-opened by a fresh session:

- **Search merges forms; math never does** (R-4). Never calculate through a canonical parent.
- **The lot/tote chain is fully built and holds zero rows** (R-5). Do not build brand tracking on
  it; do not extend it; never make brand behavior conditional on it.
- **`products` is permission-carved column by column.** A missing `GRANT` produces a field that
  looks perfect and silently fails to save, and **service-role testing cannot see it** (R-1/R-3).
- **The quality tiers are not clean substitutes** (D-O) — same actives, higher surfactant load,
  genuinely different inerts.
- **Warn on entry, refuse on use** (R-6). A missing density refuses a scale weight. Never water,
  never a default, never an estimate.

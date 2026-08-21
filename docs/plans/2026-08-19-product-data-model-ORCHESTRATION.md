# Product Data Model — Orchestration

**Date:** 2026-08-19 · **Status:** design, not yet started
**Companion to:** `2026-08-19-product-data-model-BUILD-PLAN.md` (what gets built) and
`…-COVERAGE.md` (the scoresheet). This file is *how the work is driven*.

Derived from an orchestration study against this repo's existing machinery. Every command,
script and hook named here was confirmed to exist on 2026-08-19; where a capability was found
**absent**, this file says so rather than assuming it.

---

## 1. The governing finding

**This project already owns the harness for this shape of work.** The 2026-07 Workflow-Waves
loop ran "Codex builds, Claude orchestrates and gates, one session owns database writes" across
a comparable multi-package build, launched through `/run-loop` with a validated mission doc and
a ledger. **This build should be that harness with a new mission doc, not a new system.**

What is missing is paperwork, not capability: the mission doc and the ledger. See §6.

---

## 2. Session topology

**One orchestrator session at a time, in one dedicated worktree, running packages serially.**

The build plan orders WP-1 → WP-2 → WP-3 → WP-4 → WP-5 strictly, so there is nothing to
parallelize inside Phase 1. With 17 other worktrees already live, concurrency here is a cost, not
a feature.

**All five packages carry migrations *(corrected reviewing PR #435)*.** An earlier sequence here
named only WP-1 → WP-3, written when WP-4 and WP-5 were still "no migration" packages. Both
became migration packages — **WP-4 adds only the `create_label_draft_proposal` RPC**, WP-5 adds
the atomic sibling-copy RPC — so **every** package in this phase runs the full gate chain below,
including its own apply gate. Nothing in Phase 1 skips it.

**WP-4 does not touch the `product_label_drafts` queue schema — WP-1 owns it *(finding 5, fourth
pass; this line said "WP-4 extends the queue and its RPC contract" and contradicted both the build
plan and the ledger)*.** WP-3's D-K escape hatch needs the queue's typed payload, `purpose`
discriminator and `proposed_brand_name`, and WP-3 applies **before** WP-4 — so the schema moved
forward into WP-1. Three documents disagreeing about who owns one DDL change is how it gets
written twice or not at all. **WP-1 owns the queue's shape; WP-4 adds only
`create_label_draft_proposal` over it; `create_label_draft` is never modified by any package.**

| Role | Who | How |
|---|---|---|
| **Orchestrator** | A Claude Code session | Fresh worktree cut from current `origin/main`, one feature branch per package (R-8). Started every sitting with `/run-loop docs/loops/product-data-model-loop-2026-08.md` |
| **Builder** | Codex `sol` | Headless and ephemeral per package: `node scripts/codex-build.mjs <spec> --model gpt-5.6-sol --effort high`. The wrapper pins model and effort and passes `--ignore-user-config`, which **strips Sol's Supabase, GitHub and Vercel tools** — the builder can edit the tree and nothing else |
| **Hard adversarial gate** | A *separate ephemeral* Sol run | Minted only by `scripts/write-apply-proofs.mjs`, which runs the Codex CLI itself and produces a content-bound proof pair only on a clean verdict. Hand-written proofs are blocked by `.claude/hooks/review-proof-guard.mjs`. Proofs expire in 30 minutes and die if the file changes |
| **Independent review** | Claude Opus 5 | Per-package `Agent` call at high effort; see §4 |
| **Specialist reviewers** | Existing subagents | `rls-security-reviewer`, `migration-drift-reviewer`, `typescript-types-drift-reviewer`, `compliance-reviewer` |

**Exactly one session owns database writes** — the orchestrator, and only inside the gate chain
in §3. Sol-as-builder physically cannot reach the live database.

**Why not drive Sol interactively in the Codex app?** It works — `.agents/` adapters and
`.codex/hooks.json` mirror the guards, and `scripts/run-claude-review.mjs --model claude-opus-5`
gives that side the Opus gate. But it maximizes owner babysitting and puts the live-database
connector in the builder's hands (`.codex/config.toml` is `read_only=false`). Keep it as the
fallback if the `codex-build` wrapper or the CLI breaks.

---

## 3. The gate chain — worked example: WP-1

A checklist a person could follow. Every step names what runs and what must be true to proceed.

| # | Step | Produces | Gate |
|---|---|---|---|
| 1 | **Session start.** SessionStart hooks fire (`worktree-awareness.mjs`, `session-staleness.mjs`). Run `/run-loop <mission doc>` → validator passes → collision check (§5) | 3-line launch summary | Mason: one word if present |
| 2 | **Branch** off fresh `origin/main` — never `main` itself | `ship/wp1-ingredient-core` | — |
| 3 | **Ground + spec.** Read live schema read-only; check `list_migrations` for the live high-water so the new timestamp sorts above it; write a self-contained WP-1 spec (tables, constraints, D-A/D-E/D-J, CRX canon: RLS in the same migration, `p_idempotency_key`, `SET search_path`, audit trail, column grants, seed data) | The spec file | — |
| 4 | **Sol builds** via `codex-build.mjs` | Working-tree diff | Up to 3 fix rounds, each a new self-contained spec |
| 5 | **Deterministic floor** — `typecheck && lint && build && test && test:agent-workflows` | Green output | Must be green (R-10) |
| 6 | **Reviewer fan-out**, all four in one message | Findings reports | BLOCKER/HIGH fixed; max 3 rounds |
| 7 | **Behavioral proof (R-2, R-9, R-11)** — orchestrator drives the running app **as a normal user** on `[E2E]` rows, positive *and* negative cases | Screenshots + console + read-back `SELECT`s | A passing test is **not** acceptable |
| 8 | **Opus checkpoint 1** (§4) | `docs/audits/<date>-opus-checkpoint-WP-1.md` + COVERAGE verdicts | `BLOCK` → back to step 4 |
| 9 | **Codex adversarial verdict** — a separate ephemeral `gpt-5.6-sol` high-effort review of the diff | Clean verdict | BLOCKER/HIGH → step 4 |
| 10 | **Docs + commit** — `migration-history.md`, `gotchas.md` if touched, `CHANGELOG.md`, `check-doc-drift.mjs` | Commit on the branch | Husky re-runs the pipeline. **Never `--no-verify`** |
| 10a | **Exact-HEAD push proof** on the final commit — the repository policy proof for a risky migration/RLS diff | Exact-SHA proof | Required *before* the first push, or the push guard blocks it |
| 11 | **PR** — push branch, `gh pr create`, wait for the required **Vercel** check, read and resolve **CodeRabbit** | Open PR, checks green | `main` is push-protected |
| 12 | **THE HUMAN GATE** — Mason's explicit in-chat OK to apply live | — | Shown: `/explain-migration` plain English, the Opus verdict, the Codex verdict, the proof, the rollback story |
| 12a | **Mint the apply proof** — `node scripts/write-apply-proofs.mjs <migration>` | Hash-bound proof pair | **Runs here, not at step 9** — proofs live 30 minutes *(finding 11)* |
| 13 | **Apply** via MCP (`migration-apply-guard.mjs` verifies the fresh proof pair or blocks) → smoke each new RPC → **B7 rename** the disk file to the assigned version stamp → `/regen-schema-registry` → `npm run db-sweeps` | Applied migration, refreshed registry | R-12: fresh backup first |
| 13a | **Commit the post-apply changes** — the B7 rename and the regenerated schema registry are tracked files produced *after* every review in step 9–11 ran. **Commit only; do not push yet** | Commit on the branch | These changes have never been reviewed by anything yet |
| 13b | **Mint the exact-HEAD proof on the new commit** — the step-10a proof is bound to the *old* SHA and is void here | Exact-SHA proof on the post-apply head | **Before the push, not after.** Pushing an unreviewed risky head violates the gate and the push guard may reject it |
| 13c | **Push**, then let CodeRabbit and the required checks run on the post-apply head | Green checks + CodeRabbit read and resolved | *(finding 9)* Merging without this either omits the rename/registry or ships an unreviewed head |
| 14 | **Merge** the PR → deploys production → **re-run the step-7 proof against production** | Ledger row 🚀 with the live stamp | — |
| 15 | **Next cycle** — the loop advances to WP-2 without asking | — | — |

### Ordering decision — apply before merge

**The migration applies (step 13) before the PR merges (step 14).** Phase 1's migrations are
purely additive, so applying ahead of the code is harmless — the new tables simply sit unused.
Merging first would deploy code referencing tables that do not exist yet, which is the
parked-RPC caller failure this project has already hit. Any package whose migration is *not*
additive re-opens this ordering explicitly rather than inheriting it.

**The additivity claim is a gate, not an assumption *(Sol finding 3).*** Revision 2 asserted it
and was wrong: WP-3 called for a `receive_po_items` signature change, which PostgreSQL cannot
perform in place, so the live database would have stopped offering the signature the deployed
app and queued offline actions still call — a failed receive with a truck at the dock. WP-3 has
been rewritten to keep its signature. **Before step 13, audit the migration statement by
statement** and confirm every one is additive: no changed CHECK constraint, no dropped default,
no new NOT NULL on an existing column, no replaced function signature. **One non-additive
statement reverses the order for that package** — compatible code merges first, migration
second, cleanup third.

### Three gate defects to fix before cycle 1

**Applying changes the branch after it was reviewed *(finding 9).*** Step 13 renames the
migration file to its assigned stamp and regenerates the schema registry — tracked changes
produced *after* CodeRabbit, Vercel and the commit review ran. Merging then either omits them or
pushes an unreviewed head. **Fix:** after apply, commit and push the rename and registry
changes, then re-run the exact-head review, CodeRabbit and the required checks before step 14.
**These are numbered steps 13a–13c in the table above, not just a note here** — an executor
following the numbered chain must not be able to walk from apply straight to merge. **Order
matters inside them:** commit → mint the exact-HEAD proof on that new commit → push → checks. The
step-10a proof is bound to the pre-apply SHA and does not carry over, so pushing before re-proving
sends an unreviewed risky head at the push guard.

**The "exact-SHA" proof is not exact-SHA *(finding 10).*** `scripts/write-apply-proofs.mjs`
hashes the **migration file**, not the commit; it never sees UI consumers, generated types, or
RPC call sites. SQL can stay byte-identical while a later TypeScript edit introduces exactly the
`?? 1` that R-4a forbids, and the proof still validates. **Fix:** keep the migration-content
proof for the apply gate, and separately require the repository's exact-HEAD push proof after
the final commit **and before the first push** — step 10a in the table above. They answer
different questions; neither substitutes for the other, and the branch must not reach its first
push carrying only the migration-content hash.

**The proof expires before it is used *(finding 11).*** Proofs live 30 minutes. Minting one
before commit, PR, Vercel, CodeRabbit and the human gate spans a sequence that routinely exceeds
that. The apply guard then rejects a stale proof, and whoever is mid-cycle feels pressure to
weaken the gate. **Fix:** run the adversarial review early if useful, but **mint the apply proof
immediately after Mason's approval and immediately before the live apply.** **The gate-chain
table above is the authoritative sequence and already encodes this** — the adversarial verdict is
step 9, the exact-HEAD push proof is step 10a, and `write-apply-proofs.mjs` runs at step 12a,
after the human gate. Do not mint the apply proof at step 9.

---

## 4. The independence problem

`AGENTS.md` normally makes Sol the adversarial gate. Here Sol is the **builder**, so a later Sol
session reviewing that diff is the same model checking its own work.

The 2026-07-30 decision accepted that tradeoff deliberately — independence comes from a separate
ephemeral read-only process plus exact-SHA/content binding. **Mason explicitly asked for Opus
review on this build**, so the Opus checkpoint is a plan-mandated *additional* layer. Both run;
neither replaces the other.

**Invocation:** the orchestrator issues an `Agent` call at `model: opus`, high effort, at step 8,
on the trigger *"package clean through reviewer fan-out and behavioral proof attached, before the
migration proof is minted."* The prompt is the build plan §5 charter and **must request every
finding** — never "high-severity only", which Opus 5 follows literally.

**Independence holds** because the builder is Sol: Opus reviewing Sol's diff is a genuinely
different model reviewing work it did not write.

**Durable artifact:** `docs/audits/<date>-opus-checkpoint-WP-n.md`, committed on the package
branch so it travels with the PR, plus the Verdict column in COVERAGE.md.

**A failed review routes back without Mason:** a `BLOCK` becomes the next `codex-build.mjs`
fix-spec verbatim, capped at 3 rounds. Only a finding surviving 3 rounds — a genuine model
disagreement — reaches Mason, with both positions stated.

**Enforcement honesty.** The Sol proof is **HARD** — `migration-apply-guard.mjs` physically
requires it. The Opus checkpoint is **SOFT** — process only. That is acceptable while every
apply is interactive and Mason sees the verdict first. It would need hardening before any
hands-free run. See §6.

---

## 5. Collision and state safety

Every session in this build runs this before its first write:

1. `git worktree list` — confirm this session is in the build's own worktree on the expected
   branch. A sibling on the same branch, or foreign work-in-progress in this tree → **stop and
   ask Mason who owns it.** Never launch two sessions into one tree.
2. `git fetch origin && git rev-list --left-right --count origin/main...HEAD` — never claim a
   finding or build on a stale base.
3. `node scripts/fleet-status.mjs` — sibling map plus the parked-migration list. **While it
   reports `PARKED STATE UNKNOWN`, treat the parked queue as unknown and assert no counts.**
4. Supabase MCP `list_migrations` — the live high-water mark. A new migration timestamp must
   sort above it, and no *other* pending migration may re-emit a function this package touches.
5. Act on the SessionStart hook output rather than reading past it.

**On collision:** stop before the first write, name the owning worktree, and either hand the
conflict to Mason as one question or re-scope. **Never edit or move a parked draft belonging to
another worktree.**

---

## 6. What must be built before starting

| # | Item | Path | Why nothing existing covers it |
|---|---|---|---|
| 1 | **Mission doc** | `docs/loops/product-data-model-loop-2026-08.md` | `scripts/validate-mission-doc.mjs` refuses to launch a loop without five slots — Driver, Granularity, Worktree, Definition of done, Delivery gate. It is also the only place this build's contract binds a future session with no memory of this conversation |
| 2 | **Ledger** | `docs/loops/product-data-model-ledger.md` | COVERAGE.md tracks *issues*; the ledger tracks *cycles* — per-package status, PR number, migration disk name and live version stamp, and the `PROOF — Ran: … · Saw: …` line. Model on `docs/loops/structure-wave-2-ledger.md`. Both are needed and they reference each other |
| 3 | **Repair the parked scan** | — | `fleet-status.mjs` is in its fail-closed `PARKED STATE UNKNOWN` state. This build adds **five** migrations — WP-1 through WP-5, each with its own apply gate — to a queue that cannot be counted *(count corrected 2026-08-20; WP-4 and WP-5 became migration packages after this line was written)* |
| 4 | **Fresh backup** | — | `/backup-db`. Last good: 2026-08-09. Free plan, **no PITR** |
| 5 | **Land the plan docs** | — | They are unpushed local commits; a session starting from `origin/main` cannot read the contract |

### The mission doc's five slots, pre-written

- **Driver.** Sol builds via `codex-build.mjs` at high effort; Claude orchestrates, reviews and
  lands; Opus checkpoints each package; the next cycle starts when the current package is
  SHIPPED or PARKED.
- **Granularity.** One work package per cycle (R-8: one package, one PR).
- **Worktree.** The dedicated build tree, cut from `main` after prerequisite 5.
- **Definition of done.** Every WP SHIPPED or PARKED, COVERAGE.md verdicts set by Opus, and
  checkpoint 2 run.
- **Delivery gate.** Live applies need Mason's in-chat OK; WP-0 and WP-4 bulk writes need his
  OK; no edge-function deploys; no deletion.

Later phases continue the **same** mission doc by appending worklist sections. Do not create a
new harness per phase.

---

## 7. Nice to have later

| Item | What it does | Why it can wait |
|---|---|---|
| **Hard Opus-checkpoint proof** | Extend `migration-apply-guard.mjs` to require a fresh `opus-checkpoint-<mig>.json` alongside the Codex proof | Mason sees the Opus verdict before every interactive apply anyway. Becomes important if any later phase runs armed/hands-free |
| **COVERAGE-drift check** | A script (pattern: `scripts/check-doc-drift.mjs`) asserting every COVERAGE row whose package shows 🚀 has non-empty Evidence and an Opus verdict; wire into `npm run check:docs` | Keeps the scoresheet honest across ~10 months without relying on a session remembering |
| **Scripted non-admin smoke** | An authenticated **non-service-role** smoke against a preview deploy | Makes R-2 proofs repeatable rather than manual browser work each package. The existing `scripts/smoke/` chains are SQL-level and role-blind to the C-25 grant class by design |

---

## 8. In one paragraph, for Mason

One Claude "foreman" session runs this whole build from its own folder, started each day with a
single command that reads the build's contract file. The foreman never writes the feature code
itself: for each package it writes precise instructions and hands them to Codex's strongest
model, which builds in that folder and nothing else — it has no access to your live database or
to GitHub. The foreman then checks that work four ways: automated specialist reviewers, actually
clicking through the app as a normal user, an independent review by a different AI that grades
the shared scoresheet so nothing gets marked "fixed" by the model that built it, and a separate
locked-down review that stamps a tamper-proof approval file the database gate physically
requires. Progress is written into a running logbook so any new session picks up exactly where
the last stopped, and a pre-flight check at every start makes sure none of your other work
folders is touching the same thing. You are needed at exactly the moments that cannot be undone:
approving the data-cleanup list class by class, one "yes" before each of the three database
changes goes live, approving the one bulk data-fill, and reading the end-of-phase scorecard.

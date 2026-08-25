# Decision Log

Last verified: 2026-08-24
Update triggers: append when an architectural/policy/business decision is made or reversed.

An ADR-style ("Architecture Decision Record") running log so future agents don't re-litigate
settled calls. Newest first. Each entry is a decision, why it was made, and the operative
rule it implies. This is a log of outcomes, not a design doc — see the cited source for detail.

---

## 2026-08-24 — AP aging measures DAYS PAST DUE; the bucket mapping is a separate, still-open decision

**Source:** Mason's in-chat decision, 2026-08-24, answering the open product question raised by the
Live Foundation Gauntlet Section 9 refresh (PR #457).

**The question.** `get_ap_aging(date)` ages every bucket from `vendor_bills.bill_date`; `due_date`
is never read. An audit initially scored that a HIGH defect. On review that scoring was wrong as
stated: invoice-date aging and due-date aging are both standard accounting views, and nothing in
this repository declared which one the `Current` / `31-60 Days` / `61-90 Days` / `90+ Days` buckets
were meant to express. Calling the existing basis a defect — and queueing a live SQL change on that
footing — would have committed Crop RX to an accounting policy by implication rather than by
decision.

**The decision.** **AP aging measures days past due.** Buckets are computed from each bill's
`due_date`, so a bill inside its terms is not reported as aged no matter when it was issued. With
that contract stated, the live implementation provably contradicts it, and the Section 9 finding is
a genuine HIGH.

**Explicitly NOT decided.** The report exposes only four buckets and has no `1-30`, so days-past-due
must be *mapped* onto them, and the obvious mapping (`Current` = not yet due **through 30 days past
due**) silently merges "not yet due" with "up to a month late". Whether those should be separated —
which needs a fifth bucket and a UI change — is a **second decision Mason has not made**. Do not
assume it, and do not write a test that locks either mapping in until he answers. The question to
put to him: *should `Current` mean "not yet due" only, with a new `1-30 Days` column?*

**Operative rules.**

- Age AP buckets from `due_date`, not `bill_date`. Do not re-open this half.
- Get Mason's answer on the bucket mapping **before** writing the migration or its smoke test.
- `public.vendor_bills.due_date` is `NOT NULL` (verified by live introspection 2026-08-24), as is
  `bill_date`. Do not add null-handling or a null test case; it would assert invented behavior for
  an unreachable input. If that constraint is ever relaxed, revisit this contract first.
- The AP Aging UI labels and CSV export state no basis today. They should state whichever is
  adopted — that holds under either mapping.

**Status.** Recorded only; **no code, SQL, or migration has been written.** Scope note for the
implementing session: `.claude/handoffs/SCOPE-ap-aging-days-past-due.md`. Full finding: HIGH 1 in
`docs/audits/gauntlet/2026-08-23-section-09-purchase-orders-receiving-vendor-bills-ap-refresh.md`.

---

## 2026-08-24 — CodeRabbit config: stop spending the review budget on half-finished commits

**Source:** Mason's in-chat decisions, 2026-08-20 through 2026-08-24. Supersedes nothing; refines
the mechanics of the 2026-07-17 / 2026-07-30 standing CodeRabbit review policy in `AGENTS.md`,
which is unchanged. This entry covers the **configuration** half of the work opened as PR #441.
The merge-gate enforcement half is parked — see "What is deliberately not here" below.

**The problem.** CodeRabbit was refusing reviews for two *different* reasons, and the distinction
matters because only one of them is fixable with money:

1. **Fair-usage throttle.** 61 included review attempts in 7 days dropped the org from Pro's 5
   reviews/hour to the floor — 1 review/hour, one at a time. Attempt *count* drives this, not spend.
2. **Usage spending cap.** Separately, large reviews were refused with "This review is too large to
   run within your organization's remaining usage spending cap."

**What was measured.** The org was on **Pro** (CodeRabbit's own run-configuration block on PR #434
reported `Plan: Pro`). After Mason raised the cap the same block reports **`Plan: Pro Plus`** on
FarmRx PR #26 — the billing change moved the tier, not just the cap.
`auto_pause_after_reviewed_commits` sat at its default of 5 and auto-review re-runs on every push,
so each PR could spend five attempts on mid-work commits. Recent PRs are commit-heavy — #429 had 21
commits, #433 had 11, #431 had 8 — across 12 PRs in roughly two days: 12 × 5 ≈ 60, the entire
weekly allowance. The failure mode ran the dangerous direction: the budget was consumed by
**half-finished intermediate commits**, and the runs that got refused were the ones on finished
code. **PR #429 (21 commits) and PR #434 both posted "Review limit reached."** #429 merged with its
later commits never auto-reviewed.

**Decisions.**

- **Mason raised the usage spending cap** (billing tab), then raised it again, stating he would
  rather spend more than lose review quality.
- **Report sections stay ON at their defaults** — sequence diagrams, related PRs/issues,
  linked-issue assessment, suggested labels/reviewers, changed-files summary. Turning them off was
  proposed as a cost saving and Mason declined: he will not trade any possible review context for a
  cheaper report. Do not re-propose disabling them to save spend.
- **`auto_pause_after_reviewed_commits: 2`.** Mason initially objected, on the belief that a higher
  number meant "it reviews my changes before merge." It does not. The setting pauses *automatic*
  review after N reviewed commits on a PR — ordinary non-draft PRs included, not only GitHub drafts
  — after which later pushes are not auto-reviewed until someone comments `@coderabbitai review`,
  which resumes it. So the number caps how many **intermediate** commits get reviewed for free; it
  guarantees nothing about the final one, and at 5 it was actively starving the runs that mattered.
  **Settled by Mason, 2026-08-22: keep 2.** (Wording in the config corrected after CodeRabbit
  flagged the original "mid-work drafts" phrasing as inaccurate on FarmRx PR #26.)
- **The actual pre-merge gate is a fresh review on the final commit, proven by SHA** — the standing
  policy in `AGENTS.md`, with the procedure in `.claude/skills/deploy-check/SKILL.md`. A review
  **with findings** creates a review object whose structured `commit_id` must equal the current
  `headRefOid`. A **clean** review creates no review object at all, so its only evidence is
  CodeRabbit's canonical walkthrough stamp naming that same head. Check both endpoints; if neither
  binds, comment `@coderabbitai review`, wait, and read it. **`submitted_at` is not proof** — any
  reviewer's timestamp satisfies a timestamp check, and a review of the previous commit can start
  before the final push and finish after it. Never merge on a review that predates the final commit.
- **A green `CodeRabbit` status check is not proof the head was reviewed.** On FarmRx PR #26 the
  check read **pass** while the three reviewed commits were `358e3a8`, `cc28976`, and `ae0e6b1` —
  not the head, `9abaf18`.
- **Refresh a stale branch before spending a review attempt, and stop on any non-`CLEAN` state.**
  `BEHIND` is the common case and `gh pr update-branch` fixes it, but `DIRTY`, `BLOCKED`,
  `UNSTABLE`, and `UNKNOWN` all mean the merge cannot proceed as-is, and requesting a review while
  in one of them can burn an attempt against a head that is about to move.
- **`path_instructions` extended** with rules settled since the July config: integer-cent parsing
  before money arithmetic, the `<table>_<column>_whole_cents_chk` naming, explicit UTC →
  America/Chicago conversion for business-day logic, and **two** blend patterns
  (`src/**/[Bb]lend*/**` and `src/**/*[Bb]lend*`) marking blend tickets as a money path. One
  pattern alone misses files *inside* a blend-named folder, because `src/**/*[Bb]lend*` matches
  only the filename component.
- **`knowledge_base.code_guidelines`** now points CodeRabbit at `AGENTS.md`, `CLAUDE.md`,
  `docs/reference/gotchas.md`, and `docs/workflows/`, so it reviews against the repo's own written
  contract rather than only the inline path instructions.

**A positive `path_filters` pattern switches off review for everything else.** Both CodeRabbit and
the Codex reviewer recommended adding a positive `**/package-lock.json` filter, to override
CodeRabbit's built-in ignore of lock files. Applied literally on FarmRx PR #26, the next review
answered **"No files to review"** — on a PR whose one changed file was `.coderabbit.yaml` itself.
Once *any* non-`!` pattern exists in `path_filters`, only files matching a positive pattern are
reviewed. Two well-meant lines silently disabled code review for the whole repo, and the result
reads as a clean pass rather than an error.

A leading `**` restores default-include breadth, but it is not free: it also opts **out of
CodeRabbit's curated default ignore list**, so dependencies, build output, generated code,
binaries, media, and source maps become reviewable and must be re-excluded by hand or every review
inflates. That is why the two repos differ. FarmRx carries the `**` + lockfile-include +
hand-maintained-ignores form, because a lockfile there has shipped as the sole functional change.
**CRX stays exclusion-only**, because its problem was review budget and hand-maintaining an ignore
list CodeRabbit already curates is the worse trade. The lockfile-only blind spot on CRX is a
documented, accepted gap, not something this change closed.

**An exclusion must name a mechanism, not a directory.** The config opened with `path_filters`
covering `docs/archive/`, `docs/audits/`, `docs/loops/`, `docs/build-loops/`, `docs/handoffs/`, and
the generated `.agents/` adapters — 340+ files. Four review rounds took all of it apart, each time
for the same reason:

- A blanket `!docs/audits/**` also hid real executable programs
  (`docs/audits/ordering-cycle-review-2026-08-09/workflow.mjs` and `build-report.mjs`).
- Scoping to `*.md`/`*.json` still hid **live agent control files**:
  `architecture-weakness-audit-prompt.md` and `foundation-ultra-review-prompt.md` are the canonical
  instructions their slash commands tell an agent to "read that file and execute it exactly", and
  `codex-driven-bug-hunt/LEDGER.json` is state automation reads and writes. On a **public** repo an
  excluded agent-control file is a prompt-injection path into privileged automation, not a
  cost-control question. The same defect then turned up untouched in `docs/loops/`,
  `docs/build-loops/`, and `docs/handoffs/`.
- A `[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*.md` carve-out inferred "inert report" from the
  *shape of a filename*: of the 57 matches, 23 are prompts, handoffs, ledgers, plans, or go-live
  execution docs.
- `docs/archive/` went too. "Archive" is a naming convention, not a property, and automation does
  read those files — `.claude/agents/rls-security-reviewer.md` sends a security-reviewing agent to
  an archived incident disposition for the patterns it hunts.

**`.codex/` was never excluded.** Only `.agents/` is generated (it is the sole `TARGET_ROOT` in
`scripts/sync-agent-workflows.mjs`); every tracked file under `.codex/` is hand-maintained,
including `production-action-guard.mjs`, which gates live mutations, pushes, and merges. Excluding
it would let a PR that only weakens that guard skip review entirely.

**Decision: this config ships with no `path_filters` block at all.** The exclusion list is empty,
so **no repository-specific path is excluded**. That is not the same as "everything is reviewed":
CodeRabbit's own curated default ignore list — lock files, binaries, generated code, media, source
maps — still applies underneath, and declining to exclude those paths does not make them
reviewable. Only an explicit positive pattern would, at the cost described above. That default list
is exactly where the lockfile blind spot comes from. The remaining candidate — `!.agents/**` — is defensible
(the adapter-drift check `scripts/check-agent-workflows.mjs` runs inside the required
"Lint, Type Check, Test, Build" status check, so a hand-edit there cannot ship unreviewed), but it
saves little review allowance and it is the one line that kept drawing High findings. It parks with
the repository-walking test that enforces the rule.

**What is deliberately not here.** PR #441 opened as this config change and, over eighteen review
rounds, grew a second half: an **executable pre-merge gate** in
`.claude/skills/deploy-check/SKILL.md`, `.claude/hooks/pr-merge-guard.mjs`, and
`.codex/hooks/production-action-guard.mjs` that binds a merge to exact-head CodeRabbit evidence and
`--match-head-commit`, plus the `path_filters` exclusion and its coverage test. **Mason parked that
half on 2026-08-24** — the loop was self-sustaining (the PR edits guard machinery → guard machinery
is a risky path → risky paths need a clean exact-SHA Codex proof → each guard fix is new guard code
to review), and six CodeRabbit reviews in one day made the per-round cost real. Three Codex Highs
are outstanding on it. It stays open as PR #441 in draft.

**Known consequence of shipping this half alone, stated plainly.** Lowering
`auto_pause_after_reviewed_commits` from 5 to 2 reduces *automatic* review coverage while the
compensating control — reading a fresh review of the final commit before merging — remains a
**written procedure, not enforcement**. Codex raised this as High and it is correct as stated.
Mason's settled call (2026-08-22, reaffirmed at the park on 2026-08-24) is to keep 2 and land the
enforcement separately rather than hold the config behind it.

**Operative rules.**

- Never add a positive (non-`!`) pattern to a `.coderabbit.yaml` without testing it on FarmRx first
  and confirming a real source file still appears under "Files selected for processing".
- Before adding any exclusion, name the mechanism that makes those files inert and point at the
  check that fails if they stop being inert. A directory name is not a mechanism. If a document
  really is inert, move it into `docs/archive/` after looking at it — a decision someone makes
  about a specific file, not a pattern that guesses.
- Do not treat `auto_pause_after_reviewed_commits` as the pre-merge gate. Read a fresh CodeRabbit
  review of the final commit before merging, and bind it to the head SHA, not to a timestamp or to
  a green status check.
- "Review limit reached" is a *temporary* state that refills. It is never evidence that a PR was
  reviewed, and never a reason to merge without one.
- Treat reviewer advice as a hypothesis to test, not a patch to apply. On this work three findings
  were right and fixed; the fourth would have switched off review for the whole repository.

---

## 2026-08-24 — Oversized migrations get a second door, not a second lock

**Source:** Mason's in-chat approval, 2026-08-24, after the draw-down cutover half 2 could not be
applied.

**The problem.** `mcp__supabase__apply_migration` accepts `{project_id, name, query}` — a pasted
string, no file path. `migration-apply-guard.mjs` binds the reviewer proof to
`sha256(transmitted query)`, and `scripts/write-apply-proofs.mjs` pins that hash to the on-disk
file (CRLF→LF normalized). Those two facts are good and stay: together they guarantee the SQL that
runs is the SQL that was reviewed. But they made
`20260816120000_draw_down_split_order_lines_by_price_tier.sql` — 162,022 bytes / 2,891 lines —
**unappliable**. No single tool call re-emits that byte-exact, so the hash never matched. The
migration was blocked by its own size, not by any review finding; both charters had returned CLEAN.

Splitting it was not available: its preflight compares `pg_proc.xmin` on the barrier wrapper
against its own transaction id and aborts with `DRAW_DOWN_CUTOVER_BARRIER_UNCOMMITTED` if the two
halves share a transaction. The management-API direct-POST channel would have carried the bytes but
bypasses the PreToolUse hook entirely — no ordering preflight, no reviewer proof, no Codex gate —
and was deliberately not used.

**Decision.** Move the apply rules into a shared module, `.claude/hooks/migration-apply-lib.mjs`,
and give the file bytes their own gated caller, `scripts/apply-migration-file.mjs`. Both the
PreToolUse hook and the script ask the identical `evaluateMigrationApply()` for a verdict. The
transform of the existing checks is mechanical; block-message text is preserved verbatim and
`migration-apply-guard.test.mjs` still passes unchanged at 86 assertions.

**Operative rules.**

1. **One rule book.** Never reimplement or copy the apply checks beside a caller. Two copies drift,
   and the looser copy becomes the way in. A new caller imports `evaluateMigrationApply` or it does
   not ship.
2. **No ungated transmission path.** `apply-migration-file.mjs` must have no route to `fetch()`
   that skips the gate, and a throw inside the rule book is a REFUSAL, never a pass. The
   direct-POST management-API channel remains for read-only `BEGIN..ROLLBACK` proof bundles only —
   do not reach for it to land a migration.
3. **The door that applies invalidates the snapshot BEFORE transmitting, then rebuilds it.** The
   script writes the ledger row `apply_migration` would have written (`statements` as ONE element,
   matching live rows) inside the same transaction, deletes `applied-migrations.json` before the
   request, and rebuilds it from a fresh ledger read after. Refresh-on-success-only is NOT enough:
   an apply that commits followed by a failed ledger re-read leaves a snapshot still "fresh" by the
   clock but missing the row just written, so the next apply can replay a migration older than the
   one just applied. An apply is the real invalidator, not elapsed time. Both post-apply failure
   paths exit non-zero and say plainly that the migration IS applied.
4. **A dry run is the default.** `--confirm` is required to transmit, and passing the gate remains
   a FLOOR, not authorization — an interactive session still needs Mason's explicit in-chat OK.
5. **Migrations that manage their own transactions must not use this door — enforced in code.**
   `.claude/hooks/migration-wrappability-lib.mjs` refuses top-level transaction control and
   non-transactional statements before anything is wrapped, and refuses anything it cannot tokenize.
   The first revision only *documented* this and hand-checked the one target migration; CodeRabbit
   (Major) and Codex (P2) both caught that nothing re-checked it, so the next caller would have
   inherited a promise the code did not keep.
6. **The Codex production guard must know every live-apply spelling.** Codex's own review found
   `scripts/apply-migration-file.mjs` reached production while every other migration path was blocked
   in `.codex/hooks/production-action-guard.mjs` (P1). Adding a new production-mutating command
   without wiring it into that guard is the defect, not an oversight to fix later. Editing that guard
   re-pins its blobs in `scripts/apply-live-testdata-maintenance-20260812.mjs` in the same change.

7. **The apply target is pinned to CRX production; there is no `--project` flag.** Round 4 found
   that parameterizing the ref was unsound: `applied-migrations.json`, the reviewer/Codex proofs and
   the `AUTOPILOT.on` flag are all checkout-wide and assume ONE project. Applying elsewhere would
   overwrite the snapshot production ordering is judged against with a foreign ledger, and CRX-local
   proofs would authorize a target they never reviewed. Restricting is the honest fix. If another
   target is ever needed, scope those three things to the ref FIRST — never re-add the flag alone.
   (A concrete instance of the standing lesson that parameterizing a constant breaks its downstream
   assumers.)
8. **A wrong entry in a "cannot run in a transaction" list is a defect, not a safe over-refusal.**
   Round 3 removed `ALTER TYPE … ADD VALUE` (transaction-safe since PostgreSQL 12; live server
   verified at 17.6, and the error advised an impossible split that hit the same rule) and
   `DROP OWNED` (destructive but transactional — that is the destructive gate's job). Over-refusal
   rejects legitimate work and teaches the operator something false about PostgreSQL.

9. **The ledger name is derived from the migration filename; there is no `--name` flag.** Round 5
   (Codex P1, landed as a follow-up after #460 merged) found `--name` was caller-controlled input
   that TWO checks trusted differently: `--name 99999999999999_alias_<oldstamp>_old_migration` still
   matched the reviewer proof by SUBSTRING, while `checkMigrationOrdering` read the FIRST 14-digit
   stamp and ruled the stale SQL newer than everything applied — the out-of-order replay the gate
   exists to stop. Rename the FILE if the ledger name must change.
10. **Every live-apply spelling must be registered with the hold latch.** `isBuildActionUnderHold()`
    knew `apply_migration` and the Supabase CLI forms, but the file-bytes door is a *Bash command*,
    so the tool-name set never saw it — a mid-session "stop" from Mason would not have paused a live
    migration through it. `apply-migration-file` is now in `BUILD_BASH_RE`; add any future spelling
    there in the same change that creates it.

**Three instances of ONE root cause.** `--project` (round 4), `--name` (round 5), and the
wrappability list's wrong entries all came from the same mistake: adding flexibility, or asserting a
restriction, without checking what downstream already assumed. A parameter is not free — every check
that reads it inherits a trust relationship nobody wrote down.

**What this round cost, and why it is recorded.** Three reviewer findings on PR #460 were all real:
an unenforced precondition, an unguarded production spelling, and an `allow`-by-default branch in the
hook (`decision === "block"` blocked, so any unrecognised verdict passed). None were style. The
enforcement fix then failed on its first run against the real 162KB migration — it reused the
destructive classifier's stripper, which keeps `CREATE FUNCTION` bodies visible, and read a PL/pgSQL
`END;` as a transaction commit. That was caught by **running the real file**, not by the unit tests,
which had passed by luck because their function body ended `END` with no semicolon. The regression
cases now pin the terminated form and were mutation-proved to fail without the fix.

**Verification standard applied.** The guard was mutation-tested, not just run green: each check
was disabled in turn and the suite was required to go red. The first pass exposed a real weakness in
the *tests* — disabling the missing-snapshot check still produced a refusal (the read threw and the
catch failed closed), so a banner-only assertion stayed green while the check it named was gone.
Assertions now pin the specific message per condition. `.claude/hooks/migration-apply-lib.test.mjs`
is wired into `test:correction-guards`.

---

## 2026-08-20 — The project no longer pins `autoCompactWindow`; the user-level value governs

**Source:** Mason's in-chat decision, 2026-08-20, while setting up switchable context profiles.

**The problem.** `.claude/settings.json` carried `"autoCompactWindow": 500000` at the top level.
Per the settings precedence chain (managed → CLI args → `settings.local.json` → `settings.json` →
`~/.claude/settings.json`), that project value **beats** the user-level setting. The practical
effect: running `/autocompact <n>` inside this repo appeared to succeed but changed nothing,
because `/autocompact` writes to *user* settings, which the project file then overrode. The
threshold was effectively frozen at 500k for every session in this repository.

A second effect: the pin shortened the usable stretch before summarization. `autoCompactWindow`
is a compaction *trigger*, not a ceiling on the model's context window — the window is set by the
model and provider, not by this setting, and the pin does not change it. Capacity is 200K by
default; 1M is available only where the model and route support it (native support, a `[1m]`
alias, or gateway routing), so treat the suffix as a request that may be a no-op rather than a
universal switch. On a session that *did* have 1M, the 500k pin still summarized at half the
available room, so the span of unsummarized conversation was far shorter than the model could
actually hold.

**Decision.** Remove the `autoCompactWindow` key from `.claude/settings.json` entirely. The
project no longer expresses an opinion on the compaction threshold; the user-level value in
`~/.claude/settings.json` governs, and `/autocompact` works as documented inside this repo.

**Operative rule.** Do not reintroduce a top-level `autoCompactWindow` into
`.claude/settings.json` or `.claude/settings.local.json`. A project-level pin silently disables
per-session threshold control for everyone working in the repo, including every parallel
worktree. If a future task genuinely needs a fixed threshold, use the `--autocompact` flag, which
applies only to the session it launches, or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Mind the scope
difference on the environment variable: set inline for one invocation it affects only that run,
but **exported** into a shell profile or a CI environment it applies to every Claude Code session
launched from there. It also sits at the top of the precedence chain — it overrides
`/autocompact`, `--autocompact`, and any `autoCompactWindow` in a settings file — so an
accidentally exported value is harder to notice than a project pin, not easier.

**Not changed by this entry.** Nothing about model selection, effort level, or any guard is
affected. This is a harness-configuration change only; no money, schema, RLS, or migration
surface is touched.

---

## 2026-08-20 — Draw-down intent cutover keeps the 24-hour zero-receipt freeze

**Source:** Engineering fail-closed design choice, 2026-08-20. The 24-hour freeze window still
requires Mason's scheduling approval before any separately authorized live apply.
**Decision:** Keep the pending draw-down intent migration's fail-closed requirement that no
unexpired legacy draw receipt exists before cutover; because receipts live for 24 hours, schedule a
deliberate 24-hour no-successful-draw window before any separately authorized apply.
**Why:** The shared retry helper would handle each legacy receipt safely — an exact retry refuses the
duplicate business write and returns the already-committed receipt, rather than erroring or returning
nothing (`scripts/smoke/smoke-draw-down-quote-intent-binding.sql`) — but a planned off-season or
weekend freeze gives the wrapper a clean invariant and removes ambiguity from a money/inventory cutover.
**What this forbids/implies:** do not weaken the zero-receipt preflight to avoid the wait. Verify zero
read-only, keep draws paused through commit, and obtain separate live-apply authority; this PR applies nothing.

---

## 2026-08-19 — Two of Sol's review findings declined by the owner (D-W, D-X)

An independent adversarial review of the product data model plan (Codex `sol`, `gpt-5.6-sol` at
high effort; full text in `docs/audits/2026-08-19-sol-adversarial-review-product-data-plan.md`)
returned **NOT SAFE AS WRITTEN** — 8 blockers, 22 high. Two findings asked for changes that are
business calls rather than technical ones. Both were put to Mason and **both were declined.**

**D-W — cancelled EPA registrations stay sellable.** Sol's finding 26 argued that "warn loudly,
keep selling" is unsafe as a blanket rule, because sell-through rights depend on the specific
cancellation order and some carry a hard sale cutoff date; it wanted the system to fail closed
when authorization cannot be confirmed. Mason: *"Don't worry about it, let it be sold."* **D-T
stands unchanged — warn, never block.** No sale-blocking gate is to be added, and this is not to
be re-opened by a later session reading the review and treating finding 26 as outstanding.

**D-X — the quality tier stays a display concern.** Sol's finding 19 argued the tier is a property
of the sellable product, not of a brand record, and wanted it moved onto `products` with
database-enforced cross-tier substitution rules. Mason: it only affects glufosinate and
mesotrione, and that is too narrow an edge case to justify the work. **Accepted — no schema
change.** The protection that matters survives at the display layer, where **D-O and D-P already
put it**: the tier is always shown, the tiers are never presented as interchangeable on matching
actives alone, and the adjuvant bias running against the premium product is stated on screen.
A builder must not add `sourcing_tier` to `products` or build substitution rules.

**Operative rule:** findings 19 and 26 are closed by owner decision, not by being fixed.

*This paragraph was written before revision 3 landed and originally said 32 findings remained
open, naming the WP-4 / D-A contradiction as unresolved. That is now stale, and the stale version
understated the progress rather than the risk. Corrected on 2026-08-20 (CodeRabbit, PR #435).*
**Current disposition:** all 8 blockers and 14 of the 22 high findings were fixed in revision 3,
including the WP-4 / D-A contradiction that would have stored salt-form concentrations on the
canonical acid and silently overstated active per gallon by ~35%. **Still open:** findings
20, 21, 22 and 24 — all Phase 2/3 comparison and rate-source behavior, which must settle before
Phase 2, not before WP-0 — plus 30 (parked-migration ownership, blocking WP-1's first migration)
and the process-honesty items 32, 33, 34. **Finding 16 was moved out of that deferred set on
2026-08-20**: it reads as Phase 2 comparison behavior, but which concentration is authoritative is
decided by WP-4's live write in Phase 1, so it is now answered there as a database invariant.
The ledger's cycle log is the authoritative record.

**Source:** `docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md` §0 (D-W, D-X);
`docs/audits/2026-08-19-sol-adversarial-review-product-data-plan.md`.

---

## 2026-08-19 — The purchase-order "mirror" CHECK clears the money gate, as a closed two-column exception

**Source:** Mason's in-chat decision, 2026-08-19, answering the question PR #420 recorded as open in
the 2026-08-10 entry below ("Open, not settled: whether the mirror form clears the AGENTS.md gate").
That paragraph has been marked **SETTLED** and now points here; this entry is the operative text.

**The question.** The AGENTS.md money gate requires "an active finite whole-cent CHECK". Eleven of
the thirteen live money-scale CHECKs use the rounding form this log specifies. Two do not:

```sql
-- purchase_orders_total_cost_whole_cents
CHECK (total_cost >= 0 AND total_cost = (total_cost_cents::numeric / 100.0))
-- purchase_order_items_unit_cost_whole_cents
CHECK (unit_cost >= 0 AND unit_cost = (unit_cost_cents::numeric / 100.0))
```

The **mirror form** carries no `round()` and no finiteness bound. Does a CHECK that never names
`Infinity` satisfy a gate whose wording is "finite"?

**What was measured, read-only against live on 2026-08-19.** The mirrored cents columns are
`GENERATED ALWAYS AS (round(<dollars> * 100)::bigint) STORED` (`pg_attribute.attgenerated = 's'`),
and both dollar columns are `numeric NOT NULL DEFAULT 0`. Every *non-finite or overflowing* route
is closed before the CHECK is ever consulted, because the generation expression is computed first
and its cast raises; fractional cents are what the CHECK itself rejects:

| Probe | Live result |
|---|---|
| `round('NaN'::numeric * 100)::bigint` | ERROR `0A000: cannot convert NaN to bigint` |
| `round('Infinity'::numeric * 100)::bigint` | ERROR `0A000: cannot convert infinity to bigint` |
| `round('-Infinity'::numeric * 100)::bigint` | ERROR `0A000: cannot convert infinity to bigint` |
| `round(1e17::numeric * 100)::bigint` | ERROR `22003: bigint out of range` |
| Fractional cents `1.005`, `0.005`, `1.0000000001`, `0.001`, `0.0049999` | all fail the mirror predicate |
| Whole cents `12.34`, `12.340000`, `0` | all pass (`numeric` equality ignores trailing scale) |
| Direct write to `*_cents` | impossible — PostgreSQL forbids writing a `GENERATED ALWAYS` column |
| Live data | 34 `purchase_orders`, 194 `purchase_order_items`, **0** fractional-cent rows; both constraints `convalidated = true` |

**No fail-open exists.** An adversarial sweep for a non-whole-cent value the mirror form would
*accept* found none. Two ceilings sit far above any real order, and both reject rather than accept.
Above roughly $10¹⁶ `numeric` division stops carrying two decimals, so the form starts rejecting a
few legitimate whole-cent values (`1234567890123456789 / 100.0` returns `12345678901234567.9`); the
exact onset is leading-digit dependent, since `numeric` picks its result scale in four-digit groups
(`1000000000000000899 / 100.0` is still exact at `10000000000000008.9900`). Higher still, at
`9223372036854775807 / 100.0` = `92233720368547758.1`, the generated cents column overflows bigint
outright. In both regimes the form errs closed, never open, and the nearer of the two ceilings is
more than ten orders of magnitude above any real purchase order.

**Decision.** The two constraints above **satisfy the money gate**, as a named exception covering
those two columns only. The gate's purpose — no fractional cent and no non-finite value reaches
storage — is met and was proven, and requiring a live migration on two money tables to restate a
guarantee already enforced would spend real risk for no change in behavior.

**Operative rule.**

1. `purchase_orders.total_cost` and `purchase_order_items.unit_cost` are **approved compatibility
   exceptions**, not tracked debt. Do not re-raise their **gate status**. This settles the gate
   question only: converting them to authoritative bigint cents remains open programme work under
   the standing rule, exactly as the 2026-08-10 entry says, and nothing here closes that.
2. The exception is **closed**. The mirror form is not a second approved shape. Every new or
   changed money column uses the rounding form this log specifies, named
   `<table>_<column>_whole_cents_chk`. The mirror form only holds when the cents side is a
   generated column that can never be independently NULL; copied onto an ordinary nullable cents
   column it fails open silently, because `col = NULL` is NULL and a NULL CHECK passes. (The dollar
   columns here are also `NOT NULL`, which is belt-and-braces rather than what closes the hole.)
3. A money column with **neither** shape still does not clear the gate. Unchanged — and that is
   most of them: 11 live columns carry the rounding form, these 2 carry the mirror form, and the
   remaining ~29 `numeric` money columns carry no scale CHECK at all and stay tracked findings.

**The obvious hardening is the wrong hardening.** Appending `> '-Infinity' AND < 'Infinity'` to the
mirror constraints would look like a fix without being one. The genuine weak point is that
enforcement here is split across three schema objects — the CHECK, the generation expression, and
the dollar column's `NOT NULL` — and only the first is a CHECK an auditor would grep for.
`ALTER TABLE ... ALTER COLUMN total_cost_cents DROP EXPRESSION` turns the cents column into an
ordinary nullable column; from then on any row written without an explicit cents value — which is
every write the app makes, since no caller names that column — evaluates the CHECK to NULL and
passes unexamined. An appended finiteness clause would not prevent that; the rounding form would,
because it is self-contained in one object.

**Follow-up (low priority, not scheduled, needs its own approval).** If these two are ever
hardened, the change is to **replace** each mirror predicate with the rounding form
(`CHECK (col = ROUND(col, 2) AND col > '-Infinity' AND col < 'Infinity')`, plus `col >= 0` to keep
the existing non-negative guarantee), renaming to the `_whole_cents_chk` convention — **not** to
append a clause to the existing predicate. That is a live schema change on money tables and gets
Mason's separate approval, a migration review, and the Codex gate. Live data is clean (0 dirty rows
of 228), so it would go on `VALID` from the start, never `NOT VALID`.

**Provenance worth knowing.** The mirror form arrived in
`20260716183501_purchase_order_integer_cents` (2026-07-16), which **predates** the 2026-08-10
whole-cent decision. Its header comment states purchase-order money "must be calculated in integer
cents", but the implementation made cents a `GENERATED` mirror *derived from* dollars, leaving
dollars authoritative. The shape was never chosen as an alternative to the gate — it simply arrived
first, and no conversion to authoritative cents has happened anywhere on this schema.

**Naming — the convention describes what to write next, not what is already there.** These two
constraint names end in `_whole_cents`, not `_whole_cents_chk`. Three of the eleven rounding-form
constraints diverge too, ending in `_cent_scale_chk`
(`products_current_cost`, `order_items_price_per_unit`, `quote_items_price_per_unit`). All four
divergences are pre-existing and none is evidence of a problem. Identify a constraint by its
predicate shape, never by its name, and do not open a renaming migration on live money tables to
chase the convention.

---

## 2026-08-19 — Product data model: eleven owner decisions taken up front so the executor never blocks

**Source:** Mason answered eleven questions in one sitting, 2026-08-19, explicitly so that
*"when codex starts to work it doesn't have to ask me anything."* Full text as **D-L … D-V** in
`docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md` §0.

**The three with consequences beyond their own question:**

**D-O — the quality tiers are not clean substitutes.** Asked what actually differs between
`Gen Liberty` and `Gen Liberty: Higher Quality`, Mason answered: *"same chemistry better
manufacturer and usually higher surfactant loads, AI ingredient same but everything else is
higher quality, it also costs more."* The active ingredients match; **the inerts do not.** This
settles C-43 and constrains every later phase: family grouping, product matching, and the
comparison tool must surface the tier and may never present the pair as interchangeable on the
strength of matching actives alone.

**D-P — the adjuvant exclusion is a biased exclusion, and the bias has a direction.** Mason
previously excluded adjuvant cost from the comparison. D-O means the premium product carries
built-in surfactant the generic would need added, so the exclusion systematically flatters the
cheaper product. Decision: keep the exclusion, but **state on-screen wherever a total appears**
when one product carries built-in surfactant and the other does not. An unstated bias in a
comparison tool is the failure; a stated one is a caveat.

**D-U — "prepare ahead, apply nothing" is not hands-free mode.** While Mason is unreachable the
build may continue writing and reviewing the next package, but **every live database change
still waits for his in-chat yes.** Autopilot is not armed by this decision and the 2026-07-13
hands-free exception is not invoked. Do not read D-U as pre-authorization.

**The other eight, briefly.** D-L typed data beats a later EPA lookup (difference flagged, never
overwritten) · D-M density trust order is SDS → label → supplier, with a self-measured value
outranking all three · D-N the entry screen is keyboard-driven save-and-advance, deliberate added
scope against 33–56 hours of owner typing · D-Q the receiving change ships as soon as it is
proven, made safe by the D-K escape hatch rather than by a staged rollout · D-R Mason assigns the
13 blank SKUs personally, no generated placeholders · D-S only admins approve a crew-proposed
brand into the permanent list · D-T a cancelled EPA registration warns loudly but never blocks
selling, because existing stock is commonly still legal to move · D-V the ~2026-09-18 comparison
target is real, and if it slips the thing protected is the quality of the Phase 2 rate review,
never the date.

**Proof accounts.** Mason directed that acceptance proofs run under his own account rather than
create a separate non-admin user. Because an admin session cannot reveal a missing column grant
(C-25), every migration package additionally records a direct `has_column_privilege` check per
new column. Neither half alone satisfies the verification standard.

---

## 2026-08-19 — Product data model: chemistry edits are admin-only; an unlisted brand never blocks receiving

**Source:** Mason's answers to two direct questions, 2026-08-19, during the product-data-model
build-planning session, after an independent Fable review flagged both as unresolved
(findings F-24 and F-7). Recorded as **D-J** and **D-K** in
`docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md` §0.

**Decision D-J — who may edit chemistry.** Active ingredients, concentrations, and density are
**admin-write, all-read**. Sales reps and drivers can see the data and cannot change it. This is
the RLS policy on `active_ingredients`, `product_active_ingredients`, `ingredient_moa_codes`, and
the density columns; a builder does not get to infer the policy.

**Why.** Density drives scale weights and ingredients drive rebuild/comparison math, so a wrong
value here reaches a real mixer, not just a quote. The audit trail records who changed what
either way, but auditing is detection, not prevention. Mason accepted the slower data-entry path
(he enters the data personally — see the 33–56 hour estimate) in exchange for the narrower write
surface.

**Decision D-K — unlisted brand at receiving.** When a load arrives carrying a brand that is not
among the product's brand rows, the crew **types the brand name free-hand and completes
receiving immediately**. The typed name is captured on the receipt and lands in the
`product_label_drafts`-shaped review queue as a **proposed** brand. It is never written to the
permanent brand list unreviewed, and **receiving is never blocked**.

**Why.** The plan's first revision made brand selection strictly required once a spec had brand
rows, with the only relief being an admin-only global `app_settings` switch. That is a
dock-blocking failure: a truck arrives with a newly sourced brand, the crew cannot complete the
receipt, cannot add the brand, and cannot flip a global switch. Product would sit unreceived
until Mason or an admin was reachable. Mason chose the capture-and-review path over both the
blocking option and the looser option of letting crew create permanent brand rows outright — a
mistyped EPA number on a permanent row reaches customer paperwork.

**Operative rule.** Any later phase that touches receiving keeps the escape hatch: a required
field at the dock must always have a capture-and-review path, never a hard stop. Any later
surface that writes chemistry enforces admin-only, and machine-sourced data (EPA seeding, brand
name parsing, crew-typed brands) always lands as a proposal, never as a direct write.

---

## 2026-08-18 — CRX pins `autoCompactWindow` to 500,000; other repos keep the 200,000 global

**Source:** Mason's in-chat question and approval, 2026-08-18, during the product-data-model
planning session — *"Should we change our context limit for these long winded large planning
sessions?"*, then *"Yes add to crx manager."*

**Decision.** `.claude/settings.json` sets `"autoCompactWindow": 500000`. Mason's user-scope
`~/.claude/settings.json` keeps `200000`, so FarmRx and every other repo are unaffected. Settings
precedence is managed → CLI args → `.claude/settings.local.json` → `.claude/settings.json` →
`~/.claude/settings.json`, so the project value wins inside CRX without the global changing.

**Why.** CRX's long-horizon work — design planning, `whole-codebase-audit`, overnight hunts,
migration reviews — is exactly the work whose value comes from holding many details at once, and
compaction flattens them. The product-data-model session compacted mid-plan and lost detail that
had to be re-read from disk. Raising the threshold is **not** a general cost increase: the setting
does nothing until a session actually passes it, so short routine sessions are unchanged.

**Also set:** the same key in Mason's untracked `.claude/settings.local.json` in the main checkout,
so the change is live before this branch merges. Once merged, that local copy is redundant but
harmless (same value, higher precedence).

**Operative rule.** Do not "toggle" the compaction window per session, and do not reach for
`/autocompact` — it writes to **user** settings and would silently change every other project.
Change the CRX value in `.claude/settings.json`. A genuine one-off needs the
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment variable or the `--autocompact` CLI flag, both of
which are session-scoped. Valid range is 100,000–1,000,000.

---

## 2026-08-18 — Mission loops: cheaper-model delegation + hand off at the 25MB marathon cap

**Source:** Mason's in-chat approvals, 2026-08-18 — "ok lets do this, cap the marathon and make it
handoff after so long" and "can we automate this so i dont have to remembver" during the 30-day
usage/setup review, reaffirmed with "fix them all" after adversarial review of PR #416.

**Context.** The 30-day usage analysis attributed the bulk of the month's token spend (estimated at
roughly 40%) to a handful of marathon loop sessions — almost entirely premium-model re-reads of an
ever-growing conversation. The two habits that prevent it (delegate mechanical steps down-model;
hand off before a session becomes a marathon) previously relied on someone remembering them
mid-loop, which is exactly when nobody does.

**Decision.**

1. **Cheaper-model delegation is standing policy for mission loops.** Mechanical cycle steps
   (status checks, doc syncs, read sweeps, evidence gathering) may run on cheaper subagent models,
   *within the loop's existing structure* — it re-tiers work the loop already does; it never adds
   agents beyond a workflow's defined fan-out. Excluded, always: ledger writes and PROOF lines
   (the driver runs the decisive verification and records what it observed), money/RLS/migration
   judgment (never below the session model, and never below `sonnet`), and any reviewer's pinned
   model/effort.
2. **Handing off at the marathon cap is pre-authorized.** At 25MB of transcript a loop session
   finishes only the atomic step in flight, checkpoints its ledger, writes a handoff, continues in
   a fresh session, and winds down — without waiting for a fresh in-chat OK. The cap is enforced
   as advisory text by a global user-scope hook on Mason's machine
   (`~/.claude/hooks/session-size-sentinel.mjs`, soft 12MB / hard 25MB, firing on prompt submission
   and mid-turn after tool calls) plus a statusline flag; where the hook is absent the written cap
   in `.claude/commands/run-loop.md` binds on its own.

**What this does NOT authorize.** Nothing about a handoff widens authority: hard gates (push
approval, deploys, live migration applies, deletes) transfer unchanged to the successor session; a
lapsed or expired autopilot flag stays lapsed; the successor re-verifies the flag itself before any
gated action; and the driver role transferred by an orchestrator is exactly the role the mission
doc's Driver slot defined, no wider.

**Operative rule.** Every `/run-loop` launch obeys the Model & Context Budget section of
`.claude/commands/run-loop.md`. A capped session that keeps cycling is violating a settled decision,
not exercising judgment.

---

## 2026-08-17 — The per-session CHANGELOG entry becomes a per-session *ledger* entry

**Source:** Mason's in-chat agreement, 2026-08-17, after he asked whether the changelog entry was
"worth the effort to maintain or should that be removed."

**Decision.** Keep the written record, drop the requirement that it live in `docs/CHANGELOG.md`
specifically. The end-of-session reminder in `.claude/hooks/stop-wrap.mjs` now accepts the same
ledger set the HARD pre-commit guard (`scripts/check-ledger-update.mjs`) already accepts —
`docs/CHANGELOG.md`, any `docs/manual/*.md`, `agent-guardrails.md`, `migration-history.md`, or a
`docs/loops/` ledger — instead of demanding the CHANGELOG alone.

**Why.** Three things were wrong with the old rule. It **misfiled records**: a policy call belongs
in this file and a schema change in `migration-history.md`, but the reminder pushed both into the
CHANGELOG. It **churned the one file Mason actually reads**, turning it into a session diary rather
than a record of what changed and why it matters. And it cited a `CLAUDE.md` section — "Keeping Docs
In Sync" — that **no longer exists anywhere in the repo**; the live requirement has been the hard
guard for some time, so the soft layer was quoting a rule that had already been superseded.

**What this does NOT fix.** It was considered as relief for the `PR MERGE GATE` firing on docs-only
PRs, and measured against that: it is not. The gate scans the **whole content** of each changed
file, and every candidate ledger file already carries money identifiers from past entries
(`CHANGELOG.md` 142, `migration-history.md` 135, `KNOWN_ISSUES.md` 20, `agent-guardrails.md` 5,
this file 4). Any count above zero arms the gate, so no choice of ledger file avoids it. Only
changing the gate to scan **added lines** rather than whole files would — that is a change to a
money-safety guard and is deliberately left for its own separately-reviewed PR. See
`docs/reference/gotchas.md` and the 2026-08-17 CHANGELOG entry.

**Operative rule.** A session that lands commits must update **one** ledger file, chosen by what the
work was. Reach for `docs/CHANGELOG.md` for general work; do not force a policy or schema record
into it. `scripts/log-session.mjs` remains the scaffold for the CHANGELOG case only.

**Review round (PR #412).** CodeRabbit raised four findings against the first implementation and all
four were real. The substantive one was a bug introduced by this very change: the accepted set was
widened to a pattern list (any `docs/manual/*.md`, any `docs/loops/` ledger) while the on-disk
fallback still stat'd a *hardcoded five-file list*, so committing `OWNER_PLAYBOOK.md` or a loop
ledger — both valid — still produced a false "no ledger" warning. The fallback is gone; the check now
unions the working-tree status with the files in this session's commits, which covers the accepted
set by construction. Git rename records (`R old -> new`) are now normalized to the destination, the
reminder text lists every accepted destination, and the `log-session.mjs` header no longer claims the
hard guard fires on *every* commit — it fires on agent-surface and migration commits only.
Verified by running the hook against purpose-built git repositories: with the pre-fix hook, a
committed `OWNER_PLAYBOOK.md`, a committed `docs/loops/` ledger, and a rename into a ledger path each
produced a false warning; with the fixed hook all three are silent, and a genuinely unlogged session
still warns.

---

## 2026-08-16 — Any sales rep may draw down any customer's booking

**Source:** Mason's explicit in-chat answer, 2026-08-16, verbatim: "Any rep" — given after the
trade-off was put to him in plain English (owner-only tightens commission attribution and
accountability; any-rep keeps a booking fulfillable when the rep who took it is unavailable).

**Decision.** Draw-down is not restricted to the rep who created the quote. The parked migration
`20260813161614_restrict_draw_down_quote_owner.sql` does **not** ship its owner gate: the
`NOT_QUOTE_OWNER` check (`v_actor_role <> 'admin' AND v_quote.created_by IS DISTINCT FROM v_actor`)
is removed before that migration is rebuilt and applied.

**Operative rule.** Removing the owner gate removes *only* the owner gate. The other protections in
that migration are unaffected by this decision and still ship: the five `DRAW_DOWN_OWNER_GUARD_DRIFT`
preflights that refuse to run against an unexpected wrapper chain, overload set, implementation body
or wrapper ACL; `AUTH_REQUIRED` and `ACTOR_MISMATCH` (an unauthenticated or forged actor is
rejected); `INSUFFICIENT_ROLE` (the actor must resolve to `admin` or `sales_rep`); the soft-delete
exclusion (a `deleted_at` quote reads as "Quote not found"); and the `BOOKING_CLOSED` status gate
(only `sent` or `revised` quotes can be drawn down). Mason's basis was operational continuity in a
seasonal business, not a judgement that draw-down needs less protection — attribution and audit of
who drew a booking down are unchanged, because every draw is still logged against the acting user.

**Sequencing this implies.** That migration and PR #404's price-tier split both
`CREATE OR REPLACE` `_draw_down_quote_below_cost_impl_20260810`, and each pins the live
`md5(prosrc)` it expects, so whichever applies second fails its own drift preflight. Settled order:
**PR #404 first**, then the owner migration is rebuilt against #404's applied body. Do not re-derive
this ordering from scratch — it is a consequence of the md5 pin, not a preference.

---

## 2026-08-16 — The draw-down price fix is the price-tier split, finally

**Source:** Mason's explicit in-chat confirmation, 2026-08-16, verbatim: "Yes settle it your right",
closing a conflict between two records — an earlier same-day "Option (a)" answer given to one
session, and the price-tier split chosen later the same day in a concurrent session.

**Decision.** The tier split (PR #404) is the answer of record. When a customer has booked the same
product at more than one price, the draw-down emits **one order line per booked price tier** rather
than one line at a quantity-weighted average price.

**Operative rule.** Do not reopen this as an averaging-plus-rounding problem. The split is preferred
precisely because it removes the average: with per-tier lines there is no derived per-unit figure
left to round, so the whole-cent guard can no longer reject a legitimate draw-down, and no line is
mispriced in either direction. The existing rounding of a line total *after* extension by quantity
stays exactly as it is — rounding a *unit* price before multiplying is what this fix eliminates, and
re-introducing it would move a line total by up to half a cent **per unit**. Background and the
measured worked example are in `docs/manual/KNOWN_ISSUES.md`.

**Implementation and structural guards.** Implemented by
`supabase/migrations/20260816120000_draw_down_split_order_lines_by_price_tier.sql`. Two guards stop
the average returning under another variable name: the migration's postflight refuses a body
containing the old averaging identifier, and `DRAW_ALLOCATION_MISMATCH` fails the draw closed if the
per-tier quantities stop summing to the requested quantity. `DRAW_ALLOCATION_MISMATCH` proves
*quantity* only — it is not a money assertion and must not be cited as one.

**Supersedes.** The opposite conclusion recorded on the local-only branch
`claude/known-issues-drawdown-defect` ("keep the exact line total, round only the stored unit
price"). That entry was written by a concurrent session, was never pushed and has no pull request;
it attributes a choice to Mason that he did not make. This log is authoritative. Its one genuinely
useful finding is preserved separately: the live ledger's ordering high-water must be read from the
`name` stamp, not `max(version)`.

---

## 2026-08-14 — One-time override: `20260812115238`'s order-line map is published in full

**Source:** Mason's explicit in-chat instruction, 2026-08-14, verbatim: "I don't care all the numbers
in my system arnt real or operational so do it all" — given after the trade-off was explained in
plain English (publishing puts 35 real order-line identifiers, prices and profit figures into a
permanently public Git history).

**Decision.** The recovered migration
`supabase/migrations/20260812115238_repair_historical_order_line_cents.sql` is committed
byte-for-byte as applied, including the 35-row approved preimage map that was withheld when the file
first landed. The redaction-era header note and the `APPROVED_SET_WITHHELD` guard — both added only
because the map had been emptied — are removed with it. The committed bytes are verified against the
live ledger: `statements[1]` of `supabase_migrations.schema_migrations` version `20260812154757`,
18,770 bytes, md5 `f31409684f7f01eee19042468f1e6998`, LF endings.

**Operative rule.** This override covers this one map and nothing else. The standing rule — no live
financial data, customer identifiers, or operational figures in the public repository — is unchanged
and still binds every other file, commit message, changelog entry and pull request. Do not cite this
entry as precedent for publishing any other live data; a fresh owner decision is required each time.
Mason's stated basis was that the data in this system is not real or operational, so the basis does
not carry to data that is.

**Related, and deliberately not restated here:** the narrow live-ledger recovery exception (the rule
that lets an already-applied migration be recovered to Git without its already-live SQL blocking the
push proof) was settled the same day, but its Decision Log entry lives on PR #403 and **is not on
`main` yet**. Until #403 merges, `main`'s Decision Log does not record that approval. That entry is
also what makes this change necessary: as amended in #403, the exception is **byte-verbatim only** —
a redacted recovery cannot attest — so publishing this file in full is what makes it eligible.

---

## 2026-08-14 — Codex Supabase access is write-enabled by owner decision

**Source:** Mason's explicit in-chat approval, 2026-08-14 ("Readable write scope for codex let
it write"), after the risk was explained in plain English: the migration apply-guard proof
system gates only the Claude-side apply path, so Codex writes to production are not covered by
those repo hooks.

**Decision.** The tracked `.codex/config.toml` Supabase MCP entry declares `read_only=false`,
and the two guard assertions (`check-agent-workflows.mjs`, `check-agent-guidance.mjs`) pin the
new declared state instead of the old read-only claim. The 2026-08-10 KNOWN_ISSUES finding
about the dead OAuth grant vs the live `codex_apps/supabase` App is closed as a false-assurance
problem (the repo no longer claims Codex is read-only); the App's actual scope is controlled in
the Codex app's own connector settings, which only Mason can change.

**Operative rule.** Codex may hold write-capable Supabase access. The workflow default remains
"Codex builds migration files; a gated operator applies them" — AGENTS.md hard rules (no editing
applied migrations, RLS on new tables, idempotency, destructive-migration refusals, per-apply
approval outside armed hands-free runs) bind every agent regardless of connection scope. Do not
reintroduce a `read_only=true` assertion without a fresh owner decision.

---

## 2026-08-10 — Exact whole cents is the invariant; legacy numeric-dollar storage has a fail-closed approval gate

**Source:** Mason's explicit 2026-08-10 project instruction, following the bigint-cents evaluation
recorded in the 2026-08-09 changelog entry for canonical profit.

**Decision.** New money storage remains bigint cents, but established PostgreSQL `numeric` dollar
columns are not converted merely to satisfy the storage preference. PostgreSQL `numeric` is exact
decimal; converting an established cluster is a coordinated unit change across database functions
and UI readers, where one missed call site creates a 100x error. That storage type alone is not an
approved exception. A legacy column becomes an approved compatibility exception only after its
authoritative database arithmetic is verified as exact `numeric`, all existing values are verified
as finite whole cents, and an active finite whole-cent CHECK is present. Dirty or unconstrained
columns remain tracked findings and are not widened or rewritten without Mason's separate approval.

**Operative rule.** The invariant is exact whole cents, not a blind type conversion. New database
money columns use bigint cents. Legacy numeric-dollar storage may remain temporarily to avoid a
risky unit rewrite, but it is not approved or suppressible until exact PostgreSQL `numeric`
arithmetic, clean finite whole-cent values, and an active finite whole-cent CHECK are all verified.
Dirty or unconstrained columns stay visible as tracked debt. New or changed authoritative TypeScript money math must
parse decimal operands into integer cents before multiplying, dividing, rounding, or aggregating;
do not introduce binary floating-point rounding. Existing helpers that still use binary conversion
are migration work, not evidence that the old approach is acceptable. The server remains
authoritative for persisted values.

**The gate's "active finite whole-cent CHECK" is exactly this predicate.** Write it in full; the
constraint is named `<table>_<column>_whole_cents_chk`.

```sql
CHECK (col IS NULL OR (col = ROUND(col, 2) AND col > '-Infinity' AND col < 'Infinity'))
```

That is the **rounding form**, and it is what eight of the ten live constraints *whose name
contains* `whole_cents` use. That scoping matters: counted by shape rather than by name, live
carries **13** money-scale CHECKs, **11** of them rounding-form — the extra three are named
`*_cent_scale_chk` (see the correction further down). Two details, both read from live on
2026-08-19 UTC:

- On a `NOT NULL` column the `IS NULL` branch is redundant and may be omitted.
  `order_items_total_price_whole_cents_chk` is live as
  `CHECK (total_price = round(total_price, 2) AND total_price > '-Infinity' AND total_price <
  'Infinity')` and clears the gate.
- Within the rounding form, neither finiteness bound may be dropped. `round()` alone does not
  exclude `Infinity` or `NaN` in `numeric`, which is the whole reason both bounds are written.

**A second constraint shape exists live, and an earlier draft of this paragraph wrongly implied it
could not.** The two constraints on the purchase-order pair — which is **not** converted; the detail
block further down proves that from live — are live as:

```sql
-- purchase_orders_total_cost_whole_cents
CHECK (total_cost >= 0 AND total_cost = (total_cost_cents::numeric / 100.0))
-- purchase_order_items_unit_cost_whole_cents
CHECK (unit_cost >= 0 AND unit_cost = (unit_cost_cents::numeric / 100.0))
```

These carry **no** `round()` and **no** finiteness bounds. Call this the **mirror form**. Pinning
the numeric dollar column to `cents / 100.0` does make whole cents structural rather than asserted,
and `>= 0` additionally forbids negatives, which the rounding form permits. Two caveats that an
earlier draft of this paragraph left out, both of which change how it should be read:

- **It only enforces anything while the cents column is non-NULL.** `col = NULL` evaluates to NULL,
  and a NULL CHECK passes, so on a plain nullable `*_cents` column the mirror form **fails open** —
  it would silently admit fractional dollars. Live is safe from this only because both cents columns
  are `GENERATED ALWAYS`, so they are NULL exactly when the dollar column is. Copied onto a
  hand-written nullable cents column it would not be. Pair it with `NOT NULL`, or with a generated
  column.
- **Its stated precondition is met by zero live instances.** The earlier draft said the form is
  "available only where an *authoritative* `*_cents` bigint column exists — which is exactly the
  converted state the whole programme is aiming at", and called it the preferred shape "wherever
  conversion has happened". Both cents columns behind the only two live instances are
  `GENERATED ALWAYS AS (round(<numeric dollars> * 100))::bigint` — **derived mirrors, not
  authoritative stores**, exactly as the "Converted: no" block below states. So the form is
  currently a derived-mirror shape, and no conversion has happened anywhere on this schema for it to
  be preferred over.

**SETTLED 2026-08-19 — see the 2026-08-19 entry at the top of this log.** The question was whether
the mirror form clears the AGENTS.md gate: the gate's wording is "an active **finite** whole-cent
CHECK", the mirror form carries no finiteness clause of its own, and what rejects `NaN`/`Infinity`
here is the generated column's cast rather than the CHECK. It also does not follow the
`<table>_<column>_whole_cents_chk` naming this entry sets out. An earlier revision resolved this by
asserting "Both forms clear the gate", which was withdrawn as a **widening of a gate** that Mason
had not decided.

Mason decided it on 2026-08-19, after the cast argument was proven read-only against live: the two
purchase-order constraints **do** clear the gate, as a closed two-column exception, and the mirror
form is **not** a second approved shape. Read the 2026-08-19 entry for the probe results, the
reason an appended finiteness clause would be the wrong fix, and the operative rule. What was never
in question either way: a money column with **neither** shape does not clear the gate.

**Both halves are load-bearing — a `ROUND`-only constraint does NOT clear the gate.** PostgreSQL
`numeric` deliberately does not use IEEE-754 NaN semantics: so values stay sortable and indexable,
it treats `NaN` as equal to `NaN` and greater than every finite value. `'NaN' = ROUND('NaN', 2)` is
therefore TRUE, and a rounding-only check lets `NaN` straight through. The `< 'Infinity'` bound is
what rejects it. This is the single easiest way to believe a column is gated when it is not.

**Never add one as `NOT VALID` over a column that still holds dirty rows.** `NOT VALID` skips only
the initial table scan. A CHECK is re-evaluated against the whole new row on every subsequent
UPDATE, whatever column actually changed — so each legacy dirty row becomes permanently un-editable
and the damage is invisible until a user tries to edit an old record. Repair the data first, then
add the constraint `VALID` from the start.

**Where each audited column stands.** Verified read-only against the live database on 2026-08-11;
the dirty-row counts were re-measured 2026-08-18 and the constraint inventory 2026-08-19 — both
corrections are inline below, so do not read the 2026-08-11 date as covering the whole section.
The 2026-08-10 order-profit evaluation measured 12 order/quote/commission columns; those are the
only ones whose gate status is established. Other legacy dollar columns exist across the schema
(`payments.amount`, `commission_payments.total_amount`, `commission_payment_items.amount`, the
`products` price tiers, the `cost_history` snapshots and more). None of those are converted.
**Most, but not all, are unconstrained** — an earlier revision of this sentence said "none are
constrained", and live refutes it: `products.current_cost`, `order_items.price_per_unit` and
`quote_items.price_per_unit` each carry a validated rounding-form CHECK named
`*_cent_scale_chk`. Those three are why the live money-scale CHECK count is 13 rather than 10.
The unconstrained remainder is unapproved tracked debt under the rule above, not grandfathered.
Extending the programme to it is unstarted work.

> **`purchase_orders.total_cost` was listed in that sentence as unconverted *and* unconstrained
> until 2026-08-18. The "unconstrained" half was wrong; the "unconverted" half was right, and a
> correction written on 2026-08-18 overshot by claiming the column was converted. Both halves are
> restated here from live.** Read-only live check, 2026-08-19 UTC.
>
> **Constrained: yes.** `purchase_orders_total_cost_whole_cents` and
> `purchase_order_items_unit_cost_whole_cents` are present and validated, and each pins its numeric
> dollar column to `cents / 100.0`. Note the names end `_whole_cents`, not `_whole_cents_chk`.
> That is why they are **not** part of the count of 8 below: that count is the eight
> `*_whole_cents_chk` constraints on the twelve columns the 2026-08-10 evaluation measured, and
> these two columns were never in that set of twelve.
>
> **Converted: no.** `purchase_orders.total_cost_cents` and `purchase_order_items.unit_cost_cents`
> are `bigint`, and have been since `20260716183501_purchase_order_integer_cents` — 25 days before
> the 2026-08-10 evaluation. But `information_schema.columns` reports `is_generated = ALWAYS` for
> both: they are `GENERATED ALWAYS AS (round(<numeric dollars> * 100))` mirrors. The **numeric
> dollar column is the authoritative store and the bigint is derived from it**, which is the
> opposite of a conversion. `data_type = bigint` alone cannot tell the two apart; only
> `is_generated`/`generation_expression` can. (One useful side effect: the generation expression
> rejects non-finite input on its own — `round('NaN'::numeric * 100)::bigint` raises
> `cannot convert NaN to bigint`, and the Infinity case raises `cannot convert infinity to
> bigint` — so neither can ever reach the mirror column. Note that this cast, **not** the CHECK, is
> where finiteness is actually enforced here: both constraints read
> `CHECK (col >= 0 AND col = col_cents::numeric / 100.0)` and carry no explicit
> `> '-Infinity' AND < 'Infinity'` bound of their own.)
>
> **So these two columns are the same approved compatibility exception as `orders.total_cost`** —
> numeric-dollar authoritative storage, exact `numeric` math, clean whole-cent values, validated
> whole-cent CHECK — **not** completed conversions, and not tracked debt either. Converting them to
> authoritative bigint remains open work under the standing rule, exactly as it does for orders and
> quotes; nothing here closes that, and nothing here re-opens the 2026-08-10 decision.

**Gate satisfied — CHECK enforced (8):** `orders.total_cost`, `orders.total_profit`,
`order_items.total_price`, `order_items.profit`, `quotes.total_price`, `quotes.total_profit`,
`quote_items.total_price`, `quote_items.profit`. Seven of these were constrained on 2026-08-10;
`order_items.total_price` joined them on 2026-08-12 and is the row moved out of the table below.

**Gate NOT satisfied — no CHECK, therefore not an approved exception (4):**

| Column | Why deferred | Status |
|---|---|---|
| `quotes.total_cost` | holds 2 of 4 legacy fractional-cent rows | awaiting data repair |
| `commissions.commission_amount` | held 3 of 35 legacy fractional-cent rows **as measured 2026-08-10; live now reads 0** | see note below |
| `commissions.order_profit` | held 3 of 35 legacy fractional-cent rows **as measured 2026-08-10; live now reads 0** | see note below |
| `orders.total_price` | data is clean; `_update_order_items_impl` overwrites it with the raw un-rounded line sum, so constraining it would reject ordinary edits | blocked on fixing that writer |

Repairing the dirty values in the first three rows above — `quotes.total_cost`,
`commissions.commission_amount` and `commissions.order_profit` — rewrites stored money and needs
Mason's separate approval on its own migration; it is **not** covered by the 2026-08-10 decision.
(`orders.total_price`, the fourth row, has clean data and is blocked on a writer fix, not a
repair.) See the note directly below: two of those three now measure **0** dirty rows live, so
**the only column still carrying unrepaired dirty money is `quotes.total_cost`, at 2 rows** —
that, and not the three columns this paragraph names, is the whole of the open approval debt under
this entry.

> **The counts in the table above are the 2026-08-10 measurement and are stale as live state
> (read-only re-measure, 2026-08-18).** Live now returns `commissions.commission_amount` **0**,
> `commissions.order_profit` **0**, and only `quotes.total_cost` still **2**. The likely cause
> of the two commission columns reaching 0 is the migration carried on disk as
> `20260810235207_reconcile_pending_commission_snapshots`, which **is applied live** — though note
> the ledger holds it at *version* `20260810235207` under the *name*
> `20260810183629_reconcile_pending_commission_snapshots`, so the file was re-issued forward and
> the two stamps disagree; searching the ledger by the disk filename finds nothing. It rewrites
> `order_profit` and `commission_amount` on **pending** commissions to `ROUND(…, 2)`, which is
> exactly the repair shape. Recorded as the likely cause and not a proven one: it skips any
> commission already sitting in a payout batch, so it explains the observed 0 only if all three
> rows measured on 2026-08-10 were still pending, which is not re-derivable now. The **0 is
> measured; the attribution is inference** — do not restate it as settled provenance.
> `order_items.total_price`, which this table listed as a deferred column until 2026-08-18, also
> returns **0** — and it is no longer deferred at all:
> `20260812115238_repair_historical_order_line_cents` repaired those 35 lines with Mason's in-chat
> approval and added the validated CHECK `order_items_total_price_whole_cents_chk` in the same
> migration, which is why it now sits in the enforced list above. Leaving it in the deferred table
> told every later agent that an enforced money column was unapproved tracked debt. The 43 figure
> was also a sum of *column-values* across four columns, not four disjoint row sets — the two
> `commissions` counts are 3/35 each and may be the same 3 rows, so distinct dirty rows were
> 40–43, and that overlap can no longer be re-derived.
> Current figures and the enforced-vs-measured distinction live in `docs/manual/CURRENT_STATE.md`
> section 2. All eight `*_whole_cents_chk` constraints read `convalidated` on live (read-only,
> 2026-08-19 UTC). The **decision** recorded here still stands
> unchanged — the gate is exactly what it was; what moved is that one more column now passes it.

**Measured cost of the conversion that was declined** (live, 2026-08-10): 12 money columns, 46 live
functions naming them, 101 functions touching those tables, 17 non-test `src/` files. Dollars→cents
is a *unit* change and TypeScript sees `number` either way, so a single missed call site is a 100×
error rather than a penny. It cannot be staged — database and UI must flip together — and the
Supabase plan has no point-in-time recovery to roll back to.

**General mechanic this established:** a change that departs from a written hard rule can never pass
the adversarial review gate, because the reviewer is handed `AGENTS.md` as ground truth and will
correctly block. Amending the rule **in the same diff does not clear it either** — measured on
PR #371, where the original "red line bypassed" finding was replaced by a new HIGH objecting that
the diff amends the very rule its own migrations rely on. That objection is structurally correct.
Land the contract amendment as its own reviewed change first, then open the change that relies on it.

---

## 2026-08-09 — The order header is the canonical profit; line profit is derived to match it

**Source:** live measurement during the PR #354 takeover session, recorded in
`docs/manual/KNOWN_ISSUES.md` ("DECIDED 2026-08-09 — order header profit vs the sum of its own
lines") and history row 862. Mason answered the open question from the 2026-08-08 entry below.

**The question was** which stored copy of profit is canonical — `orders.total_profit`, or the sum of
`order_items.profit` — and which single rounding rule every writer uses.

**What measuring changed.** The disagreement is not a rounding artefact. `orders.total_profit` is
recomputed by a trigger on every write and is correct. `order_items.profit` is a **stored cache that
nothing refreshes**: change a product's cost or a line's quantity and the line keeps its old profit
indefinitely. 37 of 288 live line rows across 17 orders are stale, and most of the resulting gaps are
orders of magnitude larger than any rounding rule could produce. Exact figures are in the
access-controlled session record, not here — this repository is public.

**Decision.** The **order header is canonical.** Line profit is derived from the same inputs, using
one rule everywhere: round each line's revenue and each line's cost to whole cents, then subtract.
Rounding **per line** rather than rounding the sum is deliberate — it makes
`SUM(line profit) = header total_profit` hold *exactly*, by algebra rather than by coincidence.

**Operative rules:**
- `order_items.profit` is **derived, never authored.** No writer may set it independently; the
  canonical trigger owns it. A future writer that computes profit itself is a bug.
- Any writer that touches line revenue, cost, or quantity must let the profit derivation re-run.
  The trigger is scoped `BEFORE INSERT OR UPDATE OF total_price, profit, cost_per_unit,
  total_units_needed` for exactly this reason; narrowing that column list re-opens the stale cache.
- The header must sum **per-line rounded** revenue and cost. This supersedes the 2026-08-08 concern
  that per-line profit rounding could *widen* the header-vs-lines gap: it could, but only while the
  header still subtracted unrounded cost. It no longer does.
- `net_margin` stays a percentage and is deliberately excluded from whole-cent rounding.

**Implementation:** `20260809230500_single_canonical_line_profit.sql`, written and reviewed
2026-08-09 (both migration reviewers returned zero blockers) and **applied live 2026-08-09** as
Supabase ledger version `20260810000427`, with a post-apply live read confirming both function
bodies, the widened trigger, and unchanged row counts. **Forward-only — applying it moved no
live money.** Repairing the 37 already-stale lines is a **separate** decision that has NOT been
taken; its statement is deliberately commented out, because writing those rows would also round 11
of the 46 fractional-cent `order_items` rows that `20260809170800` is intentionally holding back.

**Explicitly still open, not covered by this decision:** `_update_order_items_impl`
(`20260617123503`) overwrites `orders.total_price` with the raw un-rounded line sum. The exactness
guarantee above is scoped to `total_profit` only.

## 2026-08-08 — Four foundation-ultra-review owner decisions settled

**Source:** `docs/audits/2026-08-08-foundation-ultra-review.md` §7. Mason answered all four in chat.

1. **Payment visibility (M1) — leave as is.** `payments_select` stays company-wide; it is not
   scoped down to the invoices a rep can already see. Do not re-open without a new business reason.
2. **Canonical rounding (M3) — round to two decimals (whole cents), half-up.** The largest pending
   commission resolves half-up to the nearest cent. `order_items.total_price` and
   `commissions.commission_amount` both round at this point, and a live invariant predicate should
   assert whole cents on both.
3. **`cancel_order` semantics (M4) — cancelling releases stock.** Mason's intent: a cancelled order
   must not hold stock. **Implementation note added 2026-08-08 after tracing the live chain — the
   audit overstated this.** Full cancel ALREADY releases prebooked stock and writes its `released`
   `inventory_transactions` row (confirmed live on ORD-2026-0330), and the `partially_fulfilled` path
   already handled both halves. Only `order_items.quantity_remaining` was genuinely stranded, and
   migration `20260809170600` zeroes exactly that (written as `20260808150200`; re-issued forward on
   2026-08-09 to clear the applied high-water mark). **Do NOT add a second stock-release path** — it
   would double-release inventory. The residual `quantity_prebooked = 36` on that product is March
   2026 historical drift (audit L2), not a cancellation defect.
4. **Negative inventory (L3) — the existing decision stands.** Keep the 19 negative
   `inventory.quantity_available` rows as they are; reconcile only from physical counts. No re-base
   scheduled. Revisit when a physical count happens.

**Operative rule:** decisions 2 and 3 imply forward migrations; both are unwritten as of this entry
and are parked alongside the two migrations named in the audit (restore the `batch_apply_prepayments`
actor guard, add a migration-ordering preflight guard). Decisions 1 and 4 are "no change" — an agent
proposing either change must cite a new reason, not re-derive the original one.

## 2026-08-07 — Governed Autonomous Software Factory REMOVED

**Decision (Mason, in chat — "release the stranglehold"; chose full removal over a rebuild):** remove
the factory entirely. It repeatedly locked up ordinary work — three fail-closed hooks ran on every tool
call and every prompt (one with a 120-second timeout), a job stuck at `needs-ticket-ok` blocked whole
categories of writes, and casual words like "factory" or "overnight" flipped governed state. Mason could
not operate it.

**What was removed:** all `scripts/factory*` code, the Factory Board, the three factory hooks on both
the Claude and Codex sides, the `factory:*` npm scripts, and every factory branch inside the surviving
guard hooks. The shared state directory `<git-common-dir>/crx-factory/` is archived, not deleted.

**Operative rule:** the ordinary safety net is unchanged and remains authoritative — GitHub `protect-main`
branch protection, PR + CodeRabbit review, exact-SHA `gpt-5.6-sol` proofs for risky diffs, and the
money/migration/bash-safety/RLS guards. Do not rebuild factory-style governance without Mason explicitly
asking; if autonomous batching is wanted later, design it around the existing `/ship` pipeline with
hooks that fail OPEN for coordination (never fail-closed on ordinary work). All factory entries below
this one are historical.

---

## 2026-08-05 — Factory execution is bounded at three concurrent active lanes

**Decision (Mason, in chat — requested full-speed recovery and more than one job at a time):**
lift the one-lane pilot limit to at most three concurrent active Factory lanes. Only `building`,
`verifying`, and `in-review` consume a slot. Queued, expired-pending, parked, owner-review, and
terminal jobs stay visible without consuming capacity.

**Why:** an orphaned or parked job must not globally freeze unrelated work, while unlimited
parallelism would make repository custody, evidence attachment, and landing races harder to prove.
Three lanes provide bounded throughput with tested third-lane admission and fourth-lane refusal.

**Operative rule:** every active lane uses a separate clean linked worktree and keeps job-scoped
compare-and-swap protection for long-running evidence and owner decisions. Global pause/resume still
halts all lanes. Landing remains serialized to exactly one `approved-to-land` job, and every existing
push, merge, production, migration, live-data, secret, permission, and destructive-action gate remains
independently authoritative. No dangerous bypass may weaken those gates.

---

## 2026-08-01 — Factory retains exactly two touchpoints and coordination-only authority

**Decision (Mason, in chat — “yes so the 2x touch point rule”):** keep ordinary
Claude/Codex chat as the only owner input/approval surface and one read-only
Factory Board as the only owner output surface. Do not add Windows Hello, a PIN,
a standalone app, commands, forms, or a third interface.

**Security meaning:** chat-derived factory records coordinate and audit work;
they are not cryptographic authentication against arbitrary code already
running as Mason's Windows account. Factory state may only add restrictions to
ordinary reversible work already authorized by Mason's request and repository
policy. It may never grant or replace push, merge, CI, deployment, migration,
live-data, secret, permission, or destructive-action authority. Those existing
gates remain independently authoritative.

**Why:** the official Claude/Codex command-hook contract supplies ordinary JSON
on standard input and documents no platform-signed user-event token. Strong
same-account human authentication would require another owner ceremony, which
would violate the chosen two-touchpoint product rule.

---

## 2026-07-30 — AP period-close hardening stays bounded to three sibling mutators

**Decision (Mason, in-chat — approved the recommended separate hardening job):**
extend the shared/exclusive accounting-month protocol to
`record_vendor_payment`, `void_vendor_payment`, and `void_vendor_bill`, and
remove browser-role direct writes to `accounting_periods`. Keep authenticated
read access and the governed close/reopen RPCs.

**Why:** these three AP paths were the documented sibling residual from the
vendor-bill release and share one coherent date rule: payments use the payment
date; bill voids use the original bill date. Each preserves its existing
business-row locks, then takes the shared month lock, checks the period, and
mutates. Close takes the same month lock exclusively and does not lock AP rows,
so there is no lock cycle.

**Boundary:** do not add the month lock to `reopen_accounting_period` in this
slice. Reopen currently locks the period row first; adding a later month lock
would deadlock with close's month-lock-first order. The other financial
`check_period_open` callers remain a separate global protocol review and this
AP fix must not be described as covering them.

---

## 2026-07-30 — Period-close month lock spans the atomic close result

**Decision (Mason, in-chat — "I approve pushing all of this and migrating and making it live",
after the release packet and lock behavior were presented):** retain the transaction-scoped
exclusive accounting-month lock through the close upsert, summary construction, idempotency save,
and return. The five summary aggregates do not read `vendor_bills`; keeping the lock until commit
preserves one atomic close/result boundary, while vendor-bill writers wait under the calling
request's statement timeout. Do not switch to a releasable session lock or move result construction
outside the transaction without a new concurrency and failure-path proof.

**Tradeoff:** a close temporarily blocks vendor-bill create/update for that month through its
bounded reporting queries. This is an accepted close-time latency cost, not an invitation to widen
the protocol to unrelated writers.

---

## 2026-07-30 — Empty search_path is the narrow fully-qualified SECURITY DEFINER exception

**Decision (Mason, in-chat — "I approve pushing all of this and migrating and making it live",
after the governed release packet and rule change were presented):** `SECURITY DEFINER`
functions normally use `public, pg_temp`; an exactly empty `search_path` is allowed only for a
deliberately fully schema-qualified body with current source and migration-review proof.
`check_period_open(date)` is the first explicit exception.
**Why:** this exception is safe because every application relation reference is
schema-qualified and a separate live guard enforces that requirement. PostgreSQL still
searches `pg_temp` implicitly first with an empty path, so full qualification — not the
empty path alone — is the protection.
**What this forbids/implies:** never remove a function from the pg_temp contract silently;
move a reviewed exception to the exact-empty allowlist and keep every relation schema-qualified.

---

## 2026-07-30 — SETTLED: active adversarial review uses independent Sol/high sessions

**Decision (Mason, in chat):** Claude/Fable credits are nearly exhausted, so all active adversarial
review gates now use `gpt-5.6-sol` at high reasoning effort. Claude/Fable review remains available
only when Mason explicitly asks for it; it is not a mandatory factory, publication, migration, or
overnight gate.

**Why:** the independent check must remain hard and reproducible without consuming a second paid
review pool that is no longer reliably available. This deliberately accepts the limitation that the
builder and reviewer may share a model family. Independence now comes from a separate ephemeral,
read-only review process with user configuration and project hooks disabled, plus exact
base/SHA/content binding and deterministic fail-closed proof validation.

**Operative rule:** factory acceptance, risky push/merge proof, migration review, and unattended
review explicitly pin `model: gpt-5.6-sol` and `reasoning_effort: high`. A proof missing either value,
or not bound to the exact reviewed bytes, is invalid. CodeRabbit remains the broad every-PR review.

---

## 2026-07-28 — SETTLED: revoking anon EXECUTE ships in two halves, and the RLS role helpers are the risky half

**Decision (Mason, in-chat — "ok continue and make it all live please", after the two-half split and
the blast radius of part 2 were put to him explicitly):** Codex's draft
`20260728185827_revoke_anon_security_definer_execute.sql` revoked anon EXECUTE on 43 functions in
one file with one justification sentence copy-pasted 43 times. It is **split into two migrations
and two PRs** rather than shipped as one.

**Why:** the 43 are not one risk class. A `REVOKE EXECUTE` does not make a function quietly return
"no rows" — a caller that lacks the grant gets a hard `42501 permission denied for function`. RLS
policy expressions are evaluated **as the querying role**, so revoking a function that a policy
calls turns every affected table into an error for that role, not an empty result.

Read-only check against live `rhyzpcqhnizqbxphqdkr`:

- 30 anon-reachable tables carry **70 policies with audience `{public}`** — i.e. evaluated by
  `anon` — that call `is_admin()` (30 tables), `is_applicator()` (6) or `is_driver()` (1).
- `require_admin` and `require_admin_or_sales_rep` appear in **zero** table policies. The
  original worry that they were load-bearing in row rules is not borne out.
- The login page is **not** the victim: `src/App.tsx:185` puts every route except `login` inside
  `<ProtectedRoute>`, and the login page reads no RLS-protected table.

**What this forbids/implies:**

- **Part 1** (authored `20260728193000`, PR #262 — **applied live as ledger `20260728231350`**)
  revokes the **40 functions that appear in no policy at all**. Safe by construction — the grant
  cannot be load-bearing in a row rule that does not reference it. Within it, GROUP 2 (8 ungated
  `SECURITY DEFINER` callables, including the six `next_*_number()` allocators,
  `calculate_billing_splits` and `check_period_open`) was the actual live exposure: a logged-out
  visitor could call those.
- **Part 2** (authored `20260728193100`, PR #263 — **applied live as ledger `20260728233459`**)
  revokes only `is_admin()`, `is_applicator()`, `is_driver()`. It carried the whole blast radius
  and merged on its own evidence, chiefly the **`is_sales_rep()` precedent** — `anon` already
  lacked EXECUTE on it across 24 tables and production was fine, which was the closest thing to a
  live experiment available without applying anything. Borne out after the apply: `authenticated`
  and `service_role` retained EXECUTE on all three, and a logged-out production load rendered the
  sign-in page with no console errors and no `42501`.
- **`handle_new_user()` is never revoked**, in either half. It runs as the signup trigger.
- **Every REVOKE must name both `PUBLIC` and `anon`.** The two grants are independent, and
  removing either one alone leaves `anon` still able to execute. Supabase's `ALTER DEFAULT
  PRIVILEGES` grants `anon` EXECUTE *directly* on each new public function, so revoking only
  `PUBLIC` leaves that direct grant standing; revoking only `anon` leaves the access it inherits
  through `PUBLIC`. (Revoking `PUBLIC` on its own is not useless — it does remove the inherited
  access for roles that hold no direct grant — it simply does not achieve the goal here.) Only
  revoking both removes `anon`'s effective access.
- **Prove a revoke with `has_function_privilege(...)`, never a `proacl` scan.** `proacl` is NULL
  for default privileges, so a scan reports "no anon grant" on a function anon can call.
- The safe default when in doubt is to revoke **fewer** functions, not more.

Source: `docs/manual/KNOWN_ISSUES.md` §0c; proof in PR #262 and this PR (whole schema rebuilt
from zero in a throwaway container, all six post-baseline migrations replayed, 43/43 verified).

## 2026-07-25 — SETTLED: Opus 5 harness tuning; Hermes not adopted; Claude/Codex hook asymmetry is by design

**Decision (Mason, in-chat):** tune the harness for Claude Opus 5 and drop Hermes — "we don't use Hermes really." No third-agent contract, entry point, or hook adapter will be built.
**Why:** an Opus 5 review found the harness already close to Anthropic's guidance, with the gaps being things that were *missing* (no effort policy, no subagent budget, no length calibration) rather than things that were wrong.
**What this forbids/implies:**
- `CLAUDE.md` gains a **Model Tuning (Claude Opus 5)** section: concise-response `<tone_preference>`, written-deliverable length calibration, a subagent budget capped at the fan-outs already defined in `.claude/workflows/`, and an effort mapping (`low` mechanical → `xhigh` foundation/migration review). The effort mapping is an unmeasured starting point; **never lower effort on a money/RLS/migration path to save tokens.**
- Redundant self-verification instructions are discouraged, but this **does not** relax the `AGENTS.md` Verification Standard, the Codex cross-model gate, or the adversarial skeptics on money/RLS/migration paths — those are production-safety and independent-check mechanisms, not model self-checks.
- Review prompts must request every finding and filter later; never instruct a reviewer to "only report high-severity issues" or "be conservative" (Opus 5 obeys literally and reports less). **SETTLED (Mason, 2026-07-25) — bounded overnight sweeps are exempt.** `overnight-bug-hunt.js:51`, `money-inventory-hunt.js:52`, and `whole-codebase-audit.js:29` keep their 8–10 "most significant" caps; the per-run cost of uncapped fan-out outweighs the tail findings. Accepted trade-off: a low-ranked correctness bug can be dropped before the skeptic pass on those runs. The rule binds everywhere else — do not add a cap to any other review prompt.
- **SETTLED (Mason, 2026-07-25) — night hunt stays at `high`.** `money-inventory-hunt.js` pins `effort: 'high'` at `:293` and `:334`. It stays there until an effort sweep on real CRX tasks measures otherwise; nothing indicates `high` is currently failing, and `xhigh` costs more on the largest fan-out in the repo. The `xhigh` row of the mapping therefore does not reach those agents by design, not by oversight.
- `AGENTS.md` gains a scope paragraph (deliver what was asked, at the scope intended) applying to Claude and Codex alike.
- **The six-hook Claude/Codex divergence is deliberate at the wiring level, not a gap.** `scripts/agent-manifest-parity.mjs` declares and build-enforces it; Codex runs its own `.codex/hooks/production-action-guard.mjs` covering pushes, PR merges, and live actions. A new guard must be wired on both sides or declared in `CLAUDE_ONLY_HOOKS`/`CODEX_ONLY_HOOKS` with a reason. **Do not re-open the wiring** — but this does not mean the two guards are behaviorally equivalent; see the open item below.

**RESOLVED (P1, 2026-07-25, PR #228) — Codex merge guard bound to a stale local base.** Codex's independent review of PR #227 refuted the "equivalent guard" claim, and the refutation was verified in source. `.claude/hooks/pr-merge-guard.mjs` binds its proof to GitHub's current `baseRefOid`; `.codex/hooks/production-action-guard.mjs` never requests `baseRefOid`, resolves the base from local `origin/main`, and never fetches. On a stale checkout Codex can therefore clear a risky money/RLS/migration merge on a proof reviewed against a base the change will not land on. **RESOLVED 2026-07-25** (Mason approved as its own PR; the file is in the guard's own `PROTECTED_HARNESS_SOURCE` set, so it did not ride along on the documentation change). `resolvePullRequest()` now requests `baseRefOid`; `gatePullRequestMerge()` requires it for main-bound merges and passes it to `gateMainChange()` as the authoritative base. Two things follow that the original finding did not spell out: the **risk diff** is now computed against that base too (it previously used the literal `origin/main` ref, so a stale local base could misclassify a risky diff as ordinary and skip the proof requirement entirely), and a base GitHub reports but the checkout lacks **fails closed** with `git fetch origin main` guidance rather than an opaque git error. `baseRefOid` is deliberately NOT required in `resolvePullRequest()` itself — that would fail-close PRs targeting non-`main` branches, which the gate does not cover.

**Second Codex P1 on the fix itself (2026-07-25), also confirmed and fixed:** binding the diff to `baseSha` is not enough, because `git diff A...B` is three-dot — `merge-base(A,B)..B`. When a PR head is BEHIND the real base, `staleBase...head` and `githubBase...head` produce **byte-identical** diffs (verified empirically), so base-only commits stay invisible to the risk classifier, and `run-claude-review.mjs --scope base-main` hands Claude the same merge-base patch. A risky merge could therefore land base changes no review ever saw. **Operative rule:** for risky main-bound merges the guard now requires `baseSha` to be an ancestor of `headSha` and fails closed with "update the branch" guidance otherwise — GitHub branch protection does not require up-to-date heads, so the guard enforces it. This ancestry requirement is what makes the base-binding meaningful; do not remove one without the other.

**Third Codex finding (P2, 2026-07-25), also confirmed and fixed:** `scripts/run-claude-review.mjs` derives `base_sha` from **local** `origin/main` (`baseSha = rev-parse origin/main`) and never fetches. So when a head contains GitHub's base but the local ref is stale — e.g. the branch was fetched but `main` was not — ancestry passes, the gate demands a proof naming GitHub's base, and the wrapper mints one naming the stale base: **every retry rejected, with no escape from following the printed instructions.** The proof guidance now leads with `git fetch origin main` whenever it is gating against an authoritative base. **Operative rule:** if the wrapper's base resolution ever changes, re-check this guidance — the guard's expected base and the wrapper's recorded base must agree or the gate deadlocks. Regression tests in `.codex/hooks/production-action-guard.test.mjs` drive real git repos through all five paths: stale-bound proof denied, risky head behind base denied, head updated to contain base allowed, unfetched base denied, missing `baseRefOid` denied.

Source: `docs/research/2026-07-25-opus5-harness-review.md` §1.1a. (Two corrections are recorded there: the first draft wrongly called the hook wiring a BLOCKER, and the first correction wrongly called the two guards equivalent. The cross-model gate caught the second — which is the gate working as designed.)

## 2026-07-22 — SETTLED: Codex plans, then proceeds; progress must expose remaining work

**Decision (Mason, in-chat):** a request to Codex to build, fix, finish, audit, or handle a CRX task authorizes its ordinary reversible local work; for substantial work, Codex states the plain-English goal, definition of done, plan, and expected files/systems, then begins without a second approval or "Should I continue?" while a safe in-scope step exists. Claude's existing plan-approval workflow is unchanged.
**Why:** sessions were stopping after plans and obscuring forward movement, remaining work, and the next action.
**What this forbids/implies:** keep a visible completed/current/remaining plan and use `PROGRESS` / `DONE` / `NOW` / `REMAINING` / `NEEDS MASON`; close with `COMPLETE` / `READY FOR APPROVAL` / `BLOCKED` / `PARTIAL`, work remaining, proof, and one next step. Investigate/reroute blocked lanes; stop only at the contract's live/destructive/outward-facing gates, a material owner choice, or exhausted safe progress; finish safe preparation and consolidate any question. Never call work complete while required work remains.

## 2026-07-19 — SETTLED: split-billing v1 edge-case policy — per-child commissions (no job-level clamp) + no extra job-less double-submit guard

**Decision (Mason, 2026-07-19, two calls):**

1. **Commissions on Option-B splits stay per-child, mirroring the live model — NO job-level clamp
   in v1.** Because each co-owner is priced at their own tier, an operator who deliberately
   overrides one co-owner BELOW cost creates a child with negative profit; the app's standing
   "commissions never go negative" rule then means total split commissions can exceed 
   commission-on-whole-job-profit (worked example: 50/50, A tier $15 → +$250 profit → $25
   commission; B overridden to $8 vs $10 cost → −$100 profit → $0; rep gets $25 where a single
   invoice would have paid $15). Mason accepted this for v1: the case requires a deliberate
   below-cost override (with a stored override reason), the exposure is capped by that deliberate
   loss, and commissions are human-reviewed at payout-batch time. **Operative rule:** do NOT add
   job-level commission netting/clamping to `save_field_app_split_invoice`; if a real below-cost
   split ever appears in a payout, build the job-level cap then as its own proven change.

2. **Job-less splits get NO extra double-submit exclusivity guard in v1** (two tabs could each
   bill a job-less split — same exposure as the rest of the app's non-job invoicing). Job-backed
   splits are already protected by the #E source-job consume guard. **Operative rule:** accept
   live parity; do not bolt an idempotency/exclusivity scheme onto the job-less path for v1.

Context: these were the last two open owner-decisions from the Fable adversarial review of the
then-parked per-line split-billing build (PR #164, at the time flag OFF and migrations not applied),
whose go-live was expected to gate on a CLEAN Codex round-6 verdict (~2026-07-24) + Mason's review.
**Superseded by events:** PR #164 merged 2026-07-21, its three migrations are applied live, and
`per_line_split_billing_enabled` was set to `true` the same day. Current status:
`docs/manual/KNOWN_ISSUES.md` §0.

## 2026-07-17 — SETTLED: split-billing model = per-line custom splits on the FIELD-APP path; order-side engine retired later

**Decision (Mason, 2026-07-17):** the app's real split-billing model is **per-line-item custom
splits at the field-application-invoice stage** — default each line from field ownership
(`field_billing_defaults`), adjust who-pays-what and one-off prices in the UNPOSTED draft, post =
the actual invoice, and **unpost stays reversible** (edit-then-repost, with an append-only post
snapshot). This **refines the 2026-06-17 "splits are order-side" decision below**: the FIELD-APP
path (`field_app_locations` → `invoice_shares`, one child invoice per customer) is the surface we
build on; the order-side engine (`order_shares` / `order_item_field_allocations` /
`create_split_invoices_from_order`) is **unproven (0 live rows), NOT dead — retire it LATER** in a
separate cleanup after confirming zero real executions, and `order_line_allocations` (dead twin,
only ever DELETEd) can't be dropped standalone until `_update_order_items_impl`'s delete refs go.
**Operative rule:** new split-billing work targets the field-app path; do not extend or newly
depend on the order-side engine; the full build spec (3 advisor passes — gpt-5.6-terra design +
xhigh plan-review, claude-fable-5 money-math) is `docs/plans/per-line-item-split-billing-spec-2026-07-17.md`.
Money math is pinned there (half-away-from-zero, one shared numeric preview+post engine,
`amount_cents` display-authoritative, post-time SUM assertions, group total is reporting-only not a
5th balance lever). *(Status at the time of this decision: **not built**, to be built in Codex the
following week with the §6.1 baseline real-billing cycle first. It has since been built and shipped —
PR #164, merged 2026-07-21, live with the flag ON; see `docs/manual/KNOWN_ISSUES.md` §0.)*

## 2026-07-17 — SETTLED: CodeRabbit is the standing every-PR AI reviewer; FarmRx made public

**Decision (Mason, 2026-07-17):** enable CodeRabbit (AI PR reviewer) on both public repos and
fold it into the landing flow. `CRX_Manager_V1.0` was already public; `FarmRx` was flipped
**private → public** this session at Mason's explicit request (full 76-commit history was
secret-scanned clean first — no `.env` ever committed, no service-role keys / tokens / passwords;
only publishable + VAPID public keys in code; customer data lives in FarmRx's separate Supabase
project behind RLS, not the repo). Each repo carries a `.coderabbit.yaml` on `main` whose
`path_instructions` mirror that repo's hard rules; the file overrides CodeRabbit's dashboard
settings. CodeRabbit is **free for public repos**, so the account's Pro Plus trial is irrelevant
to cost.

**Enforcement choice (Mason picked "process now, hard-block soon"):** the landing flow now
includes reading CodeRabbit's review and fixing any real issue before merge (advisory — it does
not block; nitpicks may be dismissed with a reason). CodeRabbit is the broad every-PR pass;
the Codex cross-model proof stays the hard gate for money/RLS/migration diffs — both run.
Operative rule: after CI/Vercel go green, do not merge until CodeRabbit has posted its review and
its real findings are resolved. **Follow-up (open):** add a merge-blocking required status check
for CodeRabbit to the `protect-main` ruleset once its exact check name is confirmed on a live PR.
(Source: AGENTS.md "Standing CodeRabbit review policy"; PR #160 landed the CRX config; FarmRx
config commit 943e5688.)

## 2026-07-17 — SETTLED: save_customer edits are assigned-rep-or-admin only (no office-manager carve-out)

**Decision (Mason, 2026-07-17, relayed from the CRM loop session):** customer master-record
edits through the `save_customer` SECDEF RPC are RESTRICTED to admins (any customer) and the
assigned sales rep (`customers.assigned_sales_rep = auth.uid()` only). No office-manager
carve-out, no sensitive-field-only scoping. This closes the 2026-07-16 Codex gauntlet finding
that the RPC's role-only gate let any active sales rep edit any customer (credit limit,
finance-charge settings, commission split) in bypass of the assigned-rep-only `customers_update`
RLS policy. Grounding: rep SELECT was already assignment-scoped, and the activity feed shows no
rep has ever edited a customer — the restriction changes no real workflow.
Operative rule: the in-body gates (`NOT_CUSTOMER_OWNER` / `REP_CANNOT_REASSIGN` /
`REP_MUST_SELF_ASSIGN`) in migration `20260717123000_save_customer_ownership_enforcement.sql`
mirror the customers RLS policies; keep function-body authorization and RLS in lockstep if
either changes. APPLIED LIVE 2026-07-17 (ledger version 20260717123000) under Mason's
in-chat OK; post-apply live probe confirmed a rep is denied editing a non-assigned customer.
(Source: branch `claude/amazing-ptolemy-9e7e0a`; migration-history row 734.)

## 2026-07-17 — SETTLED (Mason, in-chat): five CRM owner decisions

**Decisions (Mason, in-chat, 2026-07-17 morning):**
1. **save_customer authorization:** restrict edits to the assigned sales rep + admins. No
   office-manager carve-out. (Relayed to the fix session working the pre-existing gap.)
2. **Grower crops:** crops are SELECTED and assigned per customer (a controlled list on the
   customer record) — NOT derived from field crop-history. Supersedes the parked
   "crop source of truth" question. Shipping as `customers.crops text[]` + UI chips + call-list filter.
3. **Prep-card top products:** show BOTH rankings — highest revenue AND highest volume
   (volume = per-product quantity, unit always displayed; cross-product raw-quantity caveat noted in SQL).
4. **AI disclosure wording:** default confirmed ("this call may be recorded" + AI self-identifies).
   Final sign-off still happens at voice-vendor go-live.
5. **Transcript retention: 15 months.** Purge mechanism gets built in Phase 5; retention_expires_at
   semantics = occurred_at + 15 months.

## 2026-07-17 — SETTLED: CRM read-aggregates are assignment-scoped (wider than row-level invoice RLS)

**Decision (loop orchestration under Mason's pre-authorized run; pattern inherited from
`get_customer_statement`):** the CRM purchase-intelligence and call-list SECDEF RPCs scope by
CUSTOMER ASSIGNMENT — an assigned rep sees their customer's full financial aggregates (revenue,
prepay, AR, top products) even where row-level `invoices_select` would only show them invoices
they personally wrote. Rationale: "the assigned rep owns the relationship" is the CRM's core
model, and the same widening already existed in `get_customer_statement`. Never cross-customer.
Operative rule: new CRM read RPCs follow assignment scoping; do not re-litigate per-RPC.
(Flagged by the final-gauntlet system RLS review 2026-07-17; source: loop ledger.)

## 2026-07-17 — CRM call-list filters: tier shipped client-side; crop parked as owner decision

**Decision:** the Phase-3 mission text listed rep/tier/crop/last-contact filters. Rep + tier +
last-contact shipped; CROP is parked for Mason because "what a grower grows" has no single source
of truth (field crop-history vs notes) — that's a business-data decision, not a build detail.
Operative rule: don't add a crop filter until Mason picks the source; tier lookups are
client-side against `customers.assigned_tier` (no RPC payload change needed).
(Sol 3.G rounds 1-2; source: loop ledger "Scope decisions".)

---

## 2026-07-13 — SETTLED & ACTIVE: Codex standing push/merge authorization (mirror of Claude's)

**Status: ACTIVE since 2026-07-14** — merged to `main` via PR #114 (harness through review round 4) and PR #118 (round-5 hardening delta), both through the `protect-main` ruleset with Mason's explicit approval. Mason authorized the design 2026-07-13, approved the GitHub protection change, and approved the merge; the final branch passed 5 adversarial Codex rounds and 4 Claude rounds. GitHub requires a pull request plus a passing **Vercel** status check (ruleset verified via the rulesets API), applies the rule to administrators, and disables force-push/deletion — so **direct pushes to `main` no longer exist for anyone**; all agents land work via branch → PR → green checks → merge. Follow-up for Mason: add the CI checks now confirmed on PR #118 — "Lint, Type Check, Test, Build" and "SQL Migration Validation" — as required checks in the ruleset ("E2E Smoke Tests" reports as skipped on docs-only PRs, so add it only if skipped counts as passing is acceptable), and enable "require branches to be up to date". Claude round 4 proved that repository-owned hooks cannot be the sole security boundary when the same local agent can edit files and spawn arbitrary processes; guard hooks, CI, Husky, and the review wrapper are classified as risky so self-modifications cannot avoid second-model review.

**Proposed decision:** Codex may push or merge ordinary reversible code to `main` once the full green pipeline passes. A main-bound diff classified as risky by the shared `.claude/hooks/codex-push-lib.mjs` path/content rules additionally requires a real Claude review of that exact commit in the current session and a fresh SHA-bound proof at `.claude/session-state/claude-review-push.json`. The Codex production guard applies this rule to direct pushes, `git -C` forms, `gh pr merge`, and GitHub MCP merge tools, and fails closed when it cannot verify the ref, diff, PR target, or proof.

**Review hardening:** force intent is checked before target/diff classification and denied for every branch (`--force`, `-f`, `--force-with-lease`, combined short flags, or `+` refspecs); bulk modes (`--all`, `--branches`, `--mirror`, `--prune`) are denied. Both agents recognize `git`/`git.exe`/quoted executable paths, resolve `git -C`, inspect every push in a chained command, use the hook payload/tool working directory, reject shell directory or `GIT_DIR`/`GIT_WORK_TREE` context changes, and fail closed when refs/diffs cannot be inspected. Server-side merge routes (`gh pr merge`, relative/full-URL `gh api .../pulls/<n>/merge`, and GitHub MCP merge tools) must report `mergeStateStatus=CLEAN` and a non-empty rollup with every check completed in an accepted green state before the risk/proof gate can allow them. GraphQL merges and unrecognized GitHub API/tool writes deny closed. Only a successful real `run-claude-review.mjs --scope base-main` run using the absolute installed Claude Code binary with `shell:false` and exactly one terminal `FINAL_VERDICT` can write the Claude proof; the standalone verdict writer was removed, the wrapper is covered by the ledger guard, and recognized direct tool/shell proof access plus contiguous/split interactive entry into the proof directory is denied for both agents.

**Unchanged boundaries:** this grant never covers deleting `main`, force-pushing, live migrations or data writes, edge-function deploys, secrets/auth/permission changes, direct GitHub writes that bypass Husky, or bypassing the reviewed push path. Codex's Supabase access remains strictly read-only: `execute_sql` rejects multiple statements and every custom/application function call, including mutating RPCs invoked through `SELECT`. Repository-scoped `node_repl` and Node eval/print modes are denied because they can launch uninspected write processes. The initial harness branch may only be pushed to its feature branch. Local hooks are deterministic honest-agent guardrails, not a cryptographic sandbox; GitHub branch protection is the external hard boundary and must require a pull request plus passing checks before this grant can activate.

**Why:** Mason wants the same momentum for either primary coding agent, while preserving a deterministic second-model gate on money, database, security, and other high-blast-radius changes.

---

## 2026-07-13 — SETTLED: pre-authorized runs may apply live migrations without a per-migration in-chat OK

**Decision (Mason, in-chat, 2026-07-13):** the migration-apply approval question flagged on
2026-07-13 is settled as option (b), with a hard carve-out. A live migration apply is authorized
when BOTH hold:

1. **The hard proof gate passes (never loosens):** a fresh same-session migration-apply-guard
   proof (rls-security-reviewer + migration-drift-reviewer), plus a real Codex verdict this
   session for any SQL/RLS/money change.
2. **Mason authorized the run**, in one of two forms:
   - his in-chat OK in the current conversation (the default whenever he is present), or
   - a **pre-authorized hands-free run**: Mason explicitly asked for the run and autopilot is
     armed (`node .claude/hooks/autopilot-arm.mjs --hours N`) — the unexpired armed flag is the
     durable record of that authorization. No per-migration in-chat OK is needed during such a run.

**Never autonomous, even in an armed run:** destructive migrations — apply-time DROP TABLE,
DROP COLUMN, TRUNCATE, or ANY top-level DELETE FROM (deliberately no table allowlist; deleted
data has no one-click rollback on the free Supabase plan — no PITR) — plus edge-function
deploys, data deletion outside migrations, and secrets/auth/permission changes. Those always
park for Mason's fresh in-chat yes. The dedicated read-only bug-hunt loop (`loop-guard.mjs`
worktrees) stays read-only by design — this decision does not touch it.

**Hard enforcement (same day, hardened across two Codex adversarial rounds):**
`migration-apply-guard.mjs` recognizes three states. Flag absent → interactive rules. Flag
ACTIVE → hands-free rules: destructive migrations refused outright (default-keep SQL
classifier — DROP TABLE/SCHEMA/TYPE/DOMAIN, DROP [COLUMN], TRUNCATE, any top-level DELETE,
MERGE; function bodies exempt, DO blocks always visible); non-destructive applies additionally
require BOTH a hash-bound reviewer proof (`queryHash` exactly matching the transmitted SQL)
AND a hash-bound Codex proof (`codex-review-mig-<name>.json`: matching `queryHash`, passing
`verdict`, fresh `timestamp`). Flag exists but EXPIRED/malformed → the authorization has
LAPSED: ALL applies are blocked (fail closed) until Mason re-arms or disarms in person
(`autopilot-arm.mjs --off` deletes the flag). The proof files remain self-attested —
an honest-mistake net, not malicious-agent proof (documented residual, KNOWN_ISSUES §4b).

**Why:** Mason wants overnight loops to run genuinely hands-free; the proof gate is the real
(hard, adversarial, same-session) safety layer, and the armed-autopilot flag makes his
pre-authorization explicit and expiring rather than an assumed standing blessing.

**What this forbids/implies:** never apply on a stale or prior-session proof; never treat a
past run's arming as covering a new run; an interactive session with Mason present still asks
in chat; destructive migrations always stop regardless of arming.

---

## 2026-07-12/13 — Backup strategy: weekly off-site + weekly in-DB snapshot

**Decision:** Two independent weekly backups run: an encrypted `pg_dump` pushed to the private
GitHub repo `masonwells1/CRX_Backups` (GitHub Action), and a same-database `pg_cron` snapshot
into a `backup_snapshots` table (migration `20260713050000`), pruned only on full success.
**Why:** Supabase's org plan is FREE, which has no PITR (point-in-time recovery) — these two
jobs are the only recovery path if data is lost or corrupted.
**What this forbids/implies:** don't assume PITR exists. Don't prune/trim `backup_snapshots`
on a partial run. Treat the off-site copy as the disaster-recovery copy (same-DB snapshot
doesn't survive a DB-level disaster).

---

## 2026-07-10 — Live migration apply is hands-free, gated by the apply-guard proof

**Decision:** Applying a live migration no longer needs an in-chat approval popup, but it is
still hard-gated: an agent may only call `apply_migration` after producing a fresh
migration-apply-guard proof file (this session's reviewer verdict), and SQL/RLS/money/edge-fn
changes require an actual Codex review verdict this session first.
**Why:** Mason wants momentum on reversible work without a popup for every migration, but a
live-DB apply is irreversible enough to need a real, current, adversarial second look — not a
rubber-stamp.
**What this forbids/implies:** never apply a live migration on a stale or "prior session"
verdict; the proof file must be generated in the current session. In an ordinary interactive
session, still get Mason's in-chat OK — the proof gate is a floor, not a substitute for his
authorization. (The wording ambiguity about pre-authorized loops is SETTLED — see the
2026-07-13 entry above: armed autopilot + proof gate suffices in a hands-free run.)

---

## ~2026-07-10 — Business time is America/Chicago; the live DB and pg_cron run UTC

**Decision:** All business-day logic (billing dates, "today" dashboards, cron schedules) must
convert explicitly from UTC to America/Chicago; never treat the database clock as local time.
**Why:** this bit twice on 2026-07-10 — date boundaries computed off the DB's UTC clock put
late-evening activity on the wrong business day. (Source: session memory — the fix pattern is
visible in the workflow-waves cron migrations; verify before relying.)
**What this forbids/implies:** any new query, RPC, or cron job that groups or filters by
business date must apply the timezone conversion explicitly; a bare `now()::date` on the live
DB is a bug.

---

## 2026-07-05 / 2026-07-11 — Migration/SQL/deploy permission prompts removed; hooks are the gate

**Decision:** In-chat approval popups for migrations, SQL execution, and edge-function deploys
were removed (commit `97f7bf94`, 2026-07-05) and the removal was reinforced (commit `9e3e8f10`,
2026-07-11) after tracked `settings.json` kept resurrecting the prompts in fresh worktrees.
**Why:** HARD guards (hooks that actually block) are more reliable safety than a SOFT prose
rule or a popup an agent can talk past — see AGENTS.md's HARD-vs-SOFT principle.
**What this forbids/implies:** don't re-add approval popups for these actions; if a fresh
worktree shows prompts again, that's the known `settings.json` gotcha, not a policy reversal —
fix the hook/settings file instead.

---

## ~2026-06-30 — New SECURITY DEFINER functions must explicitly revoke anon

**Decision:** Every new `SECURITY DEFINER` function must `REVOKE EXECUTE ... FROM PUBLIC` and
then explicitly `REVOKE ... FROM anon` — `REVOKE FROM PUBLIC` alone does not de-anonymize a
function that was separately granted to `anon`.
**Why:** repeated bug-hunt cycles (e.g. migration `20260713040000_revoke_anon_trigger_fn_exec`,
migration `20260616122108_revoke_execute_order_shares_guard_fn`) found SECDEF functions still
callable by the anonymous role after only a PUBLIC revoke.
**What this forbids/implies:** a migration that adds a SECDEF function and revokes only
PUBLIC is incomplete; always add the explicit anon revoke in the same migration.

---

## ~2026-06-28 — Internal-only product direction: no grower portal yet

**Decision:** CRX Manager's near-term roadmap targets internal/office users only; "beyond
parity" features (Office Cockpit, etc.) are built for staff, not growers.
**Why:** owner call — a grower-facing portal is a bigger investment than the current business
need justifies.
**What this forbids/implies:** don't design new features assuming grower login/self-service;
that's a future, separate decision. (Source: session memory — verify with Mason before relying
if this becomes load-bearing for a new feature.)

---

## 2026-06-23 — Two-acre model: full boundary acres vs. edited billable acres

**Decision:** Fields carry two acre figures — `measured_acres` (from the mapped boundary) and
an editable `override_acres`; per-acre billing always uses the edited/override figure via
`COALESCE(override_acres, measured_acres, total_acres)`.
**Why:** a GPS/satellite boundary's raw acreage often doesn't match what the grower is billed
for (buffers, waterways, etc.), so billing needs a human-correctable number distinct from the
mapped one.
**What this forbids/implies:** never bill off the raw boundary acreage directly; always read
the billable figure through the override-first COALESCE, and any new acre-consuming feature
must respect the same precedence (verified: migration `20260623120000`).

---

## 2026-06-17 — Split invoices modeled order-side, allocated by field/acre

**⚠ SUPERSEDED by the 2026-07-17 split-billing decision (top of log).** Kept for historical rationale
only. The operative surface is now the FIELD-APP path (per-line custom splits); the order-side
`order_shares` engine is unproven and slated for retirement. Do NOT treat the guidance below as current.

**Decision:** Multi-customer billing splits live on the order side (`order_shares` /
`invoice_shares`), allocated by field/acre rather than by dollar percentage alone.
**Why:** the real-world unit of split billing on a farm job is the field each customer's acres
were treated on, not an arbitrary percentage.
**What this forbids/implies:** `order_shares`/`invoice_shares` are the split-billing surface;
don't reach for one of the other dormant split tables (`order_item_field_allocations`,
`field_app_location_shares`, `job_field_shares`) for new split-billing work without checking
which one is actually live for that flow first (verified: docs/CHANGELOG.md 2026-06-17 entry).

---

## 2026-06-16 — Auto-push to `main` authorized for green, reversible code

**Decision:** Once a code change (not a migration) passes the full gate — lint, typecheck,
build, tests, Codex review — an agent may push it to `main` without a further in-chat OK.
Vercel's one-click rollback is the safety net.
**Why:** Mason wants momentum on ordinary reversible work; a frontend push to a Vercel-hosted
app is trivially undoable, unlike a live migration or data mutation.
**What this forbids/implies:** this authorization is code/frontend only. Live migration apply,
edge-function deploy, deleting data, and force-push remain hard-gated behind explicit
in-conversation approval every time (verified: referenced as "Mason 2026-06-16" across
docs/loops/*, docs/build-loops/*).

---

## 2026-06-14 — Prepay "earmark" engine SHELVED pending a reserved-pool redesign

**Decision:** The booking-prepay earmark engine (3 migrations: `20260613240000`,
`20260613250000`, `20260613280000`) and its frontend controls were pulled from the go-live
batch and parked in `docs/roadmap/shelved-earmark-engine/`.
**Why:** Codex review found it could double-spend and misreport funds because it trusted
per-credit balances while a second legacy code path (`apply_remaining_prepayments`) spent the
same money from an aggregate balance with no shared guard — a real money-integrity bug, not a
style nit.
**What this forbids/implies:** do not re-apply the 3 parked migrations or re-add the earmark
UI as-is. Any revival needs the reserved-pool redesign described in that README (a dedicated
reserved balance, not a patch) plus a fresh Codex-gated build.

---

## Foundational (~2026-05) — Core engineering invariants; money storage clause superseded 2026-08-10

**Decision:** Four rules fixed at the project's foundation: (1) money used bigint cents and never
floating-point; (2) business invariants (balances, inventory,
state transitions) are enforced in Postgres RPCs/triggers/constraints, not React; (3)
`src/lib/db.ts` is the only Supabase client, and `assertRpcResult()`/`checkMutationResult()`
are mandatory after every RPC call/`.update()`/`.delete()`; (4) every mutating RPC accepts and
actually enforces `p_idempotency_key text DEFAULT NULL` (added after repeated double-submit
bugs, e.g. the 2026-07-10 `save_job_applied_record` fix).
The first clause is superseded by the 2026-08-10 exact-whole-cent decision above: bigint cents
remains mandatory for new storage, while legacy PostgreSQL numeric-dollar storage is approved only
after exact arithmetic, clean finite whole-cent values, and an active finite whole-cent CHECK are
verified. Dirty or unconstrained columns remain tracked findings. The other three rules remain
current and unchanged.
**Why:** these are the recurring bug classes (money bugs, invariant bypass via a second code
path, double-submits from retries/flaky networks) that have cost the most rework historically.
**What this forbids/implies:** any new RPC, migration, or money-touching code that violates
one of these four is a defect, not a style choice — these are enforced in AGENTS.md as CRX
Hard Rules, not just convention.

---

## Foundational (still current) — Docs & tooling: AGENTS.md is canonical, HARD over SOFT

**Decision:** `AGENTS.md` is the one hand-maintained, cross-agent contract; `.agents/` and
`.codex/hooks.json` are generated adapters (via `scripts/sync-agent-workflows.mjs`) and must
never carry an independent copy of workflow logic. Separately, whenever a safety rule matters,
it should be encoded as a hook/test/type-check (HARD, actually blocks bad output) rather than
added as another line of prose (SOFT, just advises and dilutes over time).
**Why:** two competing hand-written rule sets drift out of sync silently; prose rules pile up
and get skimmed past, while a hook can't be forgotten.
**What this forbids/implies:** never hand-edit `.agents/` or `.codex/hooks.json` directly to
add logic — edit the source under `.claude/` and regenerate. When tempted to add a new prose
rule for something that really matters, prefer writing a hook/check instead.

---

## How to add an entry

Append a new entry at the **top** of the decision list (right after this file's header, before
the newest existing entry) whenever Mason makes an irreversible, architectural, or
business-policy call — not for routine bug fixes or ordinary feature work. Use the format:

```
## YYYY-MM-DD — <decision title>

**Decision:** one sentence — what was decided.
**Why:** plain English — the reasoning, in terms a non-coder owner would recognize.
**What this forbids/implies:** the operative rule an agent must follow because of this decision.
```

Keep each entry under ~8 lines total. **Never rewrite or delete a past entry** — if a decision
is later reversed or superseded, add a **new** entry describing the reversal, and reference the
old entry by its date/title (e.g. "Supersedes 2026-06-14 — Prepay earmark engine SHELVED").
Update the "Last verified" date at the top whenever you review this file, even if you add
nothing.

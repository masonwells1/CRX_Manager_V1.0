# GitHub branch cleanup audit — branches without an open PR (2026-09-02)

**Status: REPORT, plus the two landings Mason approved on 2026-09-03.** Nothing was deleted or
applied. Every measurement behind this document was read-only. It is written for Mason first and
for a Codex `gpt-5.6-sol` review second (§9).

**Execution record (2026-09-03, Mason: "yes I agree go ahead"):**
- §4 step 1 → PR #576 (`claude/sanitizeerror-mock-land-20260903`, cherry-pick of `f6f96b3fe`
  onto current `main`; the four test files ran locally, 30/30 pass).
- §4 steps 2 and 3 → the PR carrying this document: seven rescued documents (pending-doc file
  excluded), the closed-PR disposition plan, and F1/F2/F3 filed in `KNOWN_ISSUES.md`.
- §4 steps 4–6 (worktree removal, content-gate decision, the 6-branch deletion set) remain
  **not started** and still need Mason's separate go-ahead once the two PRs merge.

## The answer in four lines

- **43 of the 52 GitHub branches have no open pull request.** 10 never had one; 27 had a PR that
  was closed without merging; 6 had a PR that merged but the branch was never deleted. (A 44th,
  `backup/pr432-multitarget-20260825`, was pushed during this audit as a deliberate offsite copy and
  is retained by rule — §6.)
- **Three real fixes are stranded on stale branches and tracked nowhere on `main`:** an
  idempotency-key ordering bug on ~22 money screens (F1), an access-control gap on 8 number
  generators (F2), and 9 missing entries in the permission "ask" list (F3). None of the three
  branches can be merged as-is; each fix has to be re-done on current `main`.
- **Two branches are ready to land today** with a docs/tests PR each: a test-mock cleanup written
  this morning, and seven rescued documents (one of the eight must be dropped — see D1).
- **The safe-to-delete set is small.** After the two landings, **6 branches** hold nothing that is
  not already on `main` or deliberately retired (a 7th, the F3 branch, was pulled from the set by the
  Codex review because its fix has not landed). Everything else either holds work, is checked out
  somewhere, or is covered by Mason's 2026-09-02 decision to leave closed-PR branches alone.
- **Reviewed by Codex `gpt-5.6-sol` (high effort, read-only).** Verdict on the first draft: NOT
  SAFE, 1 BLOCKER + 1 HIGH + 5 MEDIUM + 4 LOW — all accepted and corrected in place; the
  per-branch deletion verdicts were independently confirmed. Details in §9.

**Recommended next step (one):** approve the two landings (§4). Once they are on `main` I will
file F1/F2/F3 as dated `KNOWN_ISSUES.md` items so the fixes stop living only on branches that are
500+ commits behind, and hand back a 6-branch deletion list for a separate yes/no.

## Baseline and method

| | |
|---|---|
| `origin/main` | measured at `5cf226637`; re-fetched at `819f0a119` (2026-09-03 02:44Z, after #571/#572/#573 merged) — every row below re-checked, none changed |
| Remote branches | 52 excluding `main` at both fetches. Since the first measurement two open-PR branches merged and auto-deleted (`claude/final-review-invalid-permission-key` #571, `claude/session-orchestration-merge-4b3f0e` #572) and two appeared: `claude/coderabbit-final-review-crash-9f425e` (open PR #574, out of scope) and `backup/pr432-multitarget-20260825` (no PR by design, **retained** — §6) |
| Open PRs | 8 — #361, #449, #535, #544, #556, #563, #565, #574 — **out of scope, not touched** |
| Landing-branch re-measure | at `819f0a119`, `git diff origin/main...<branch>` for §1 items 1, 2 and 9 shows **only** the intended files (5, 9 and 1 respectively) — no squash-merge ancestry artefacts |
| PR lookup | `gh pr list --state all --limit 1000` — 400+ PRs, every branch matched by head ref name |
| Local branches | 160 on this machine, **122 of them exist only locally** (no remote copy) — out of scope, noted in §6 |

**Definitions used below** (plain English):

- *Merge base* — the last commit a branch and `main` had in common.
- *Unique commits* — commits on the branch whose content is not on `main` (`git cherry`).
- Each file the branch changed since its merge base is measured against `main` by **blob
  identity** (the content hash), in one of four ways. *(Wording corrected after the Codex review —
  the first draft called ABSENT "the only category that can be real loss", which was wrong.)*
  - **IDENTICAL** — `main` holds exactly the branch's content at that path. **Landed.**
  - **ABSENT** — `main` has no file at that path. **Unlanded content; deletion can lose it.**
  - **BRANCH-ONLY** — `main` never touched the file since the split, and the branch changed it.
    **Also unlanded content; deletion can lose it.**
  - **MAIN-MOVED** — both sides changed the file. **Undetermined.** It proves nothing either way
    and needs a hunk-level or commit-landing check before any conclusion.
- **"Provably empty" in this report means:** 0 ABSENT, 0 BRANCH-ONLY, **and** every MAIN-MOVED file
  accounted for by a landed commit on `main` (subject and content) or a hunk-level comparison. A
  `git cherry` count or a commit-subject match on its own is **not** proof — squash merges leave
  `git cherry` reporting "unique" commits whose content landed. Where this report says "safe", the
  Codex review (§9) re-derived the same conclusion by patch comparison for each candidate.
- A `git diff origin/main...<branch>` diffstat is **not** an unlanded-content measure either: for a
  branch whose work reached `main` by squash merge it lists every authored file as changed. It is
  used here only to confirm a landing branch carries nothing beyond its intended files.
- *Local-ahead* — the copy of the branch on this PC has commits the GitHub copy does not. Deleting
  the GitHub branch does not lose them, but tagging the GitHub tip does not preserve them either.

## What already happened before this audit (so nothing is repeated)

1. **2026-08-31, PR #529** inventoried 62 remote branches (`docs/audits/2026-08-31-branch-inventory-for-codex-review.md`).
2. **2026-09-01** — `docs/audits/2026-09-01-no-pr-branch-disposition-plan.md` judged the 21 no-PR
   branches, went through **two `gpt-5.6-sol` rounds**, and a **14-branch deletion sweep ran**
   (`docs/changelog.d/2026-09-01-no-pr-branch-deletion-sweep.md`); all 14 tips are preserved as
   `archive/2026-09-01/*` tags on `origin` (122 archive tags now exist there).
3. **2026-09-01/02** — PRs #542 and a second pass rescued orphaned documents to `main`.
4. **2026-09-02** — Mason decided the **closed-PR and merged-PR branches stay** after review found
   five of them carrying commits that exist only in local checkouts. That decision is respected here:
   §3 reports their state but proposes no deletions from that group unless Mason re-opens it.

This audit therefore covers **what is left**, re-measured against today's `main`, and whether
yesterday's findings F1–F4 / K1–K2 / D1 have moved.

---

## §1 — The 10 branches that never had a PR

### Summary table

| # | Branch | Last commit | Behind `main` | Unique commits | ABSENT / BRANCH-ONLY files | Verdict |
|---|---|---|---|---|---|---|
| 1 | `claude/sanitizeerror-mock-divergence-followup` | 2026-09-02 | 14 | 1 | 1 / 4 | **USEFUL — land now** (test-only) |
| 2 | `claude/rescue-orphaned-docs-round2` | 2026-09-02 | 29 | 2 | 9 / 0 | **USEFUL — land 7 of 8 docs**, drop one |
| 3 | `codex/idempotency-reset-order-hardening-20260802` | 2026-08-02 | 574 | 1 | 2 / 5 | **USEFUL IDEA, unmergeable** — re-derive (F1) |
| 4 | `codex/section1-security-hardening-20260725` | 2026-07-25 | 688 | 6 | 4 / 0 | **USEFUL IDEA, unmergeable** — re-derive (F2) |
| 5 | `claude/control-file-coverage-a41c` | 2026-08-25 | 160 | 1 | 0 / 0 | **USEFUL, unlanded** — re-derive (F3); keep until landed |
| 6 | `claude/pr364-guard-commits-local-20260831` | 2026-08-26 | 157 | 108 | 19 / 6 | **KEEP — PROTECTED** (per `KNOWN_ISSUES.md`) |
| 7 | `claude/codex-claude-cogs-handoff-7bde15` | 2026-08-25 | 166 | 2 | 2 / 0 | **KEEP until PR #361 resolves** (K1) |
| 8 | `claude/guard-content-scan-and-savegate-flake` | 2026-08-25 | 160 | 2 | 0 / 0 | **MASON'S DECISION** (K2) — no decision recorded yet |
| 9 | `claude/closed-pr-branch-disposition` | 2026-09-01 | 33 | 1 | 1 / 0 | **LAND ITS DOC, then delete** |
| 10 | `claude/offline-review-stale-snapshot` | 2026-08-26 | 152 | 1 | 0 / 0 | **NOTHING TO KEEP** — held only because it is checked out |

### 1. `claude/sanitizeerror-mock-divergence-followup` — ready to land

One commit from this morning: replaces four test stubs of `sanitizeError` with the real function
(via `vi.importActual`) in `OfficeCockpit`, `MonthEndClose`, `FieldAppSplitInvoiceEditor`, and
`Returns.race` tests, plus a changelog fragment. It also **fixes a wrong assertion**: the
`MonthEndClose` test asserted the raw token `Safe: CUSTOMER_SCOPE_DENIED` reached the operator, when
the real function maps it to "You can only work with customers assigned to you". All four test files
are BRANCH-ONLY (untouched on `main` since the split), so it applies cleanly. No production code.

This is the third change in a chain (`2026-09-02-swallowed-server-errors-sweep.md`,
`2026-09-02-sanitizeerror-two-arg-mocks.md`) whose first two parts are already on `main`.

**Proposed:** open a PR, let CI prove the four tests pass, merge, delete the branch.

### 2. `claude/rescue-orphaned-docs-round2` — land seven of the eight documents

Two commits adding eight documents (1,401 lines) plus a changelog fragment. Every path is ABSENT
from `main`. The **source** copies of five of them still exist on their original branches
(`codex/harden-actor-binding-sql-reader`, `claude/pricing-audit-strategy-jym8rr`,
`codex/autonomy-with-hard-boundaries-20260827`, and the PR #432 lineage); what is unique to this
branch is the **bannered** version — each document carries a `SUPERSEDED` banner stating what
actually happened to the work it describes, the contract PR #542 used for the first eleven
documents. Before landing, the banners' claims about live migrations and PR states should be
re-checked or explicitly dated, since several were written 2026-09-02 and `main` has moved.

**One document must NOT be rescued: `docs/audits/2026-08-04-pending-doc-updates.md`.** It measures
as ABSENT, but `main`'s history shows it was **added on 2026-08-04 and deliberately deleted on
2026-08-07 by PR #331** ("apply pending changelog and known-issues entries") once its entries were
applied. Restoring it would undo a completed cleanup. A `gpt-5.6-sol` review caught exactly this on
2026-09-02, after this branch was written; the branch's changelog fragment (which says "eight") is
now stale on that row.

The other seven have no add-then-delete history on `main`:

| Document | Rescued from | Banner says |
|---|---|---|
| `docs/handoffs/2026-08-09-actor-binding-guard-review-cap-handoff.md` | PR #373 | live work continues in open PR #449 |
| `docs/audits/2026-08-24-claude-to-codex-pr432-ci-handoff.md` | PR #432 | frozen by DECISION_LOG 2026-08-25 |
| `docs/audits/2026-08-24-pr432-park-handoff.md` | PR #432 | same |
| `docs/audits/2026-08-24-codex-to-claude-dynamic-hardlink-bypass-handoff.md` | PR #432 | same |
| `docs/handoffs/2026-08-09-pricing-audit-local-finish.md` | PR #350 | feature shipped under different names; 3 migrations applied live |
| `docs/audits/2026-08-08-product-pricing-full-audit-and-strategy.md` | PR #350 | same |
| `docs/handoffs/2026-08-27-crx-autonomy-plan-to-build-handoff.md` | PR #513 | closed unmerged; never landed |

**Why this matters more than "seven old documents":** `docs/audits/2026-08-24-pr432-park-handoff.md`
is the record that Mason **deliberately parked** the PR #432 lineage (130 commits) on 2026-08-24.
Today that record exists only on branches that are themselves parked or unmerged, so anyone auditing
from `main` — this audit included — sees 130 commits, no PR, and concludes "stale". Landing it makes
the park decision discoverable from the default branch, which is what actually stops a future
well-run cleanup from deleting parked work. The `backup/pr432-multitarget-20260825` push (§6) bought
durability; this landing fixes discoverability.

**Proposed:** drop the one file and the "eight" wording, open a docs-only PR, merge, delete the branch.

### 3. `codex/idempotency-reset-order-hardening-20260802` — F1, still unlanded, still untracked

Yesterday's plan proved this bug and Codex confirmed it (and widened it). Re-checked today:
`main`'s `src/pages/OrderDetail.tsx:596` still reads `cancelOrderIdem.resetKey();` **before**
`assertRpcResult(...)`. Same shape at lines 698, 891, 906. In plain English: the app throws away
its "don't do this twice" ticket before it checks whether the server's reply actually says yes.
Transport errors are caught earlier and a SQL error rolls the server back, so the dangerous case
is narrower than "any failure": an **ambiguous reply** (a null or malformed success payload after
the server may already have committed). The user's retry then travels under a fresh ticket and can
double-apply.

- Open PR #535 fingerprints keys on Inventory, Purchase Orders, bulk field import and blend recipes;
  it does **not** touch `OrderDetail.tsx` or these Order/Invoice/Delivery/Return/Month-end call
  sites, and (Codex, §9) fingerprinting solves a different problem — it does not replace the reorder.
- **Not in `KNOWN_ISSUES.md`, `OPEN_ITEMS.md`, `TODO.md`, or `CURRENT_STATE.md`.** The only
  records are the 2026-09-01 disposition plan (which is on `main`) and this branch.
- The branch is 574 commits behind; 19 of its 26 files are MAIN-MOVED. **Do not merge.**

**Proposed:** keep the branch as the reference until a re-derived fix (reorder + the click-level
reset Codex flagged, with the five-case test list from the 09-01 plan) lands via the full money-path
gate. File it in `KNOWN_ISSUES.md` now.

### 4. `codex/section1-security-hardening-20260725` — F2, still unlanded, still untracked

Four ABSENT files: the migration `20260725234503_harden_section1_number_and_field_actor.sql`, two
smoke scripts, and a gauntlet lane ledger. The predicate half (`save-field-actor-binding.sql`) **is**
on `main`, and `bind_save_field_actor` is live (ledger `20260729222311`, PR #285) — so this branch is
half-landed. The unlanded half adds active-profile and role gates to the `next_*_number` generators.

Yesterday's live query (Q1 in the 09-01 plan) showed the migration absent from
`supabase_migrations.schema_migrations`; not re-queried today. Codex raised severity LOW → MEDIUM
because two screens call `next_cycle_count_number` / `next_job_number` directly, so a plain
`REVOKE` would break them, and found the migration covers six generators, not eight. **Not tracked
anywhere on `main`.** **Do not merge** (688 behind).

**Proposed:** keep as reference; file in `KNOWN_ISSUES.md`; re-derive as a new migration covering all
eight generators, through `migration-review`.

### 5. `claude/control-file-coverage-a41c` — F3, unlanded fix; re-derive, do not delete yet

One commit; 0 ABSENT, 0 BRANCH-ONLY (both its files are MAIN-MOVED). Re-checked today:
`.claude/settings.json` on `main` still contains **none** of `agent-manifest-parity`,
`sync-agent-workflows`, or `.claude/commands/**` in its `ask` list — the gap (nine target
patterns, expressed as 18 `Edit()`/`Write()` entries) is still open. Codex found PR #530 covers only
2 of 9.

*Correction after the Codex review:* the 09-01 plan said merging this branch "would revert" the
hook routers. Commit `b985e919b` is a **single additive hunk** appending 18 entries to the `ask`
list plus a `docs/CHANGELOG.md` entry; a normal three-way merge would apply only that hunk. It may
conflict with today's file, but it would not replace it. Re-deriving on current `main` is still the
cleaner path; "must never merge" was overstated.

**Proposed:** land the 18 `ask` entries as a fresh one-file change through the normal gate. **The
branch stays until that lands** — filing the issue is not landing the fix.

### 6. `claude/pr364-guard-commits-local-20260831` — PROTECTED, do not delete

`KNOWN_ISSUES.md:576-601` and `docs/audits/2026-09-01-pr364-guard-extraction-scope.md` record why:
it is the only home of three protections `main` lacks (~8 files, +9,250 lines, dominated by
`apply-time-dml-lib.mjs`), scoped but **not approved to build**. Measured today: 19 ABSENT + 6
BRANCH-ONLY files, 108 unique commits. Its tip `57d27e791` is byte-identical to the **local** copy
of `claude/session-orchestration-setup-d73e6c` checked out at
`C:\Users\mason\.codex\worktrees\pr364-landing` — see the consolidation note in §5.

### 7. `claude/codex-claude-cogs-handoff-7bde15` — K1, keep while PR #361 is open

Two ABSENT files: the adversarial review of PR #361 and a sweep predicate
(`credit-memo-cogs-line-gates.sql`). PR #361 is still OPEN (draft, parked). Unchanged from yesterday.

### 8. `claude/guard-content-scan-and-savegate-flake` — K2, needs Mason's call

0 ABSENT, 0 BRANCH-ONLY. The save-gate half shipped via PR #485 (`d0817ef53` on `main`). The
content-gate half is the **parked prose exemption** that `gpt-5.6-sol` refused twice; the standing
recommendation is "leave the gate loud". **No decision is recorded in `DECISION_LOG.md` or
`KNOWN_ISSUES.md`** (grep for "content-gate" / "gate loud" finds nothing). If Mason confirms "leave
the gate loud", this becomes a delete.

### 9. `claude/closed-pr-branch-disposition` — land the document, then delete

One ABSENT file: `docs/audits/2026-09-01-closed-pr-branch-disposition-plan.md` (191 lines), the
inventory behind Mason's 2026-09-02 "leave them" decision. `main` already **cites it by name as
"not on `main`"** in the 09-01 deletion-sweep fragment. Never added or deleted on `main`, so there is
no deliberate-removal history. It belongs on `main` as the record of that decision.

**Proposed:** fold it into the same docs PR as item 2, then delete the branch.

### 10. `claude/offline-review-stale-snapshot` — nothing left to keep

`git diff origin/main origin/claude/offline-review-stale-snapshot -- src/pages/OfflineWorkReview.tsx
src/pages/OfflineWorkReview.test.tsx` is **empty** — the code fix is on `main` byte-for-byte. Its only
remaining difference is a 21-line `docs/CHANGELOG.md` entry whose exact prose is unique to the
branch; `main` carries the equivalent changelog fragment for the same fix, so that prose is treated
as superseded. It is checked out at `C:\crx-wt\ledger-gitdir` (clean, 0 dirty files), which is the
only reason yesterday's sweep held it.

**Proposed:** remove that worktree (a folder removal, separate approval — §6), then delete. The
only content that goes with it is the superseded changelog prose.

---

## §2 — The 6 merged-PR leftovers (PR merged, branch never deleted)

Mason's 2026-09-02 decision covers these. Reported for completeness. All six were re-checked by
Codex (§9) by patch comparison and found safe; the evidence column below is corrected to say what
was actually measured.

| Branch | PR | Unique commits | ABSENT / BRANCH-ONLY | Evidence the extra work landed |
|---|---|---|---|---|
| `claude/jobdetail-savegate-flake` | #485 | 1 (merge commit) | 0 / 0 | the branch changed **no file relative to its merge base** — only merge commits after #485 landed its fix (`d0817ef53`) |
| `claude/split-billing-invoice-button-c1e4d6` | #549 | 1 | 0 / 0 | superseded by the stronger #550 (`f5042f002`) implementation and tests |
| `claude/draw-down-price-tier-lines` | #404 | 19 | 0 / 0 (16 MAIN-MOVED) | post-merge fixes landed on `main` (`42368e118`, `a9e4abe02`); Codex: functional paths match, only historical docs diverge |
| `claude/github-pr-required-review-4d52c9` | #559 | 1 | 0 / 0 | superseded by #560 (`21c48a033`) and later guard work |
| `claude/xenodochial-dubinsky-b55362` | #493 | 4 | 0 / 0 (11 MAIN-MOVED) | incorporated by the #489 squash and follow-ups; tips now differ only because `main` moved on afterwards |
| `claude/log-session-attribution-fix` | #317 | 1 | 1 / 0 | its one file is `2026-08-04-pending-doc-updates.md`, which `main` **deliberately deleted** in #331 — nothing to keep |

None is checked out; none has local-ahead commits. These six are the lowest-risk deletions in the
repository if Mason wants any; a preservation tag still precedes each.

---

## §3 — The 27 closed-unmerged-PR leftovers

Mason's 2026-09-02 decision: these stay. Grouped by what they actually hold today.

### 3a. Provably empty or fully contained elsewhere (7) — safe if the decision is ever re-opened

| Branch | PR | Evidence |
|---|---|---|
| `chore/migration-ledger-reconcile-20260729` | #275 | 0 ABSENT / 0 BRANCH-ONLY; 643 behind |
| `claude/codex-guard-single-ampersand` | #464 | 0 / 0 |
| `claude/comment-fix-applied-closeout` | #501 | 0 / 0 |
| `codex/proof-wrapper-trusted-git-bootstrap` | #454 | 0 / 0; redone as v2 → #455 merged |
| `codex/section4-lifecycle-20260805` | #321 | 0 / 0; redone as final → #322 merged |
| `codex/harden-actor-binding-sql-reader` | #373 | tip `e652f723` is the **merge base with, and an ancestor of, open PR #449's head** (Codex re-confirmed) — every commit is inside #449. Keep the pointer until #449 resolves; it costs nothing and #449's own fate is unsettled |
| `claude/coderabbit-review-gate-b9f43a` | #569 (closed today) | same fix landed as #570 (`5cf226637`); 1 ABSENT file is its changelog fragment |

### 3b. Superseded or abandoned by a recorded decision (6)

| Branch | PR | Why it is not needed |
|---|---|---|
| `claude/actor-forgery-sweeps-20260902` | #551 (closed today) | superseded by #564 (merged); checked out at `C:\crx-wt\sweeps`, clean |
| `claude/bash-safety-opacity-cleanup` | #527 | the `git clean` carve-out — settled DO-NOT-ATTEMPT after seven review rounds; 3 ABSENT + 2 BRANCH-ONLY files are the abandoned attempt |
| `claude/push-guard-git-resolution` | #445 | 23 commits, 0 / 0 by content; guard work re-landed through later PRs |
| `codex/section9-ap-safety-remediation` | #491 | v2 → #500 merged, its two migrations **applied live 2026-09-01** |
| `codex/sol-gate-recovery-exception` | #403 | DECISION_LOG records #403's closure (PR #478) |
| `fix/quote-fixture-stale-date` | #468 | 0 / 0; fixture-date fix handled elsewhere |

### 3c. Holds unique content nobody has catalogued (10) — needs a per-branch pass before any delete

| Branch | PR | ABSENT / BRANCH-ONLY | What is there |
|---|---|---|---|
| `ops/integrity-report-2026-09-01` | #539 | 1 / 1 | *(moved here from 3a after the Codex review)* an 8-line changelog fragment and a 36-line record that the scheduled monthly reconciliation **did not run** and needed a manual rerun — no DB results, but a unique operational record |
| `claude/codex-recursion-hard-guard` | #452 | 10 / 0 | capability-layer shims Sol asked for; 11 unique commits |
| `claude/coderabbit-setup-optimize-0f308d` | #441 | 3 / 0 | 38 unique commits of merge-guard/deploy-check work |
| `claude/changelog-docs-honesty` | #505 | 1 / 0 | one docs commit |
| `claude/product-plan-rev12-followup` | #507 | 1 / 1 | product-plan Revisions 12–13 decision text (D-AA) |
| `claude/remove-guard-hooks-f23691` | #503 | 1 / 2 | maintenance-guard narrowing |
| `claude/pricing-audit-strategy-jym8rr` | #350 | 8 / 5 | 55 commits; feature shipped under other names; its two rescue docs are in §1 item 2 |
| `claude/recover-applied-migrations-20260812` | #395, #389 | 6 / 0 | **migration-carrying** (5 new + 2 modified applied) — predecessor report's step 1, not re-adjudicated |
| `codex/autonomy-with-hard-boundaries-20260827` | #513 | 3 / 13 | 75 commits of harness guards; checked out in a Codex worktree; its handoff is in §1 item 2 |
| `codex/defer-return-credit-rollout-20260831` | #532 | 6 / 2 | parked return-credit migrations; checked out at `.codex/worktrees/defer-return-credit-20260831` |

### 3d. Local-ahead blind spots (4) — the reason Mason said "leave them"

These have commits **only on this PC**. Deleting the GitHub branch does not lose them, but no tag of
the GitHub tip would preserve them either.

| Branch | PR | Local ahead of GitHub | What the local commits are |
|---|---|---|---|
| `claude/ordering-cycle-review-t41vat` | #363 / #356 | **16** | ordering-cycle review record docs (2026-08-09/10), never pushed |
| `claude/session-orchestration-setup-d73e6c` | #364 | **18** | local tip `57d27e791` == remote `pr364-guard-commits-local` (§1 item 6); nothing extra |
| `codex/pr389-coderabbit-fixes` | #397 | **2** | `bind migration evidence and import retries`, `bind quote draw retries to mutation intent` (money + guard) |
| `codex/pr402-review-gaps-20260819` | #432 | **1** (and 248 behind its own remote) | the 767-line `close remaining NODE_OPTIONS wrapper gaps` guard commit; #432 work is **frozen** by DECISION_LOG 2026-08-25 |

`codex/pr389-coderabbit-fixes` is also the largest unlanded body on the list: 37 ABSENT + 21
BRANCH-ONLY files, 110 unique commits, migration-carrying. It needs its own disposition, not a
cleanup sweep.

---

## §4 — Proposed actions, in order

| Step | Action | Branches affected | Gate |
|---|---|---|---|
| 1 | Docs+tests PR: sanitizeError mock fix | §1 #1 | CI green → merge (standing push policy) |
| 2 | Docs-only PR: 7 rescued documents + the closed-PR disposition plan; **exclude** `2026-08-04-pending-doc-updates.md` | §1 #2, #9 | CI green → merge |
| 3 | File F1, F2, F3 as dated `KNOWN_ISSUES.md` items with the branch names as reference | §1 #3, #4, #5 | same PR as step 2 |
| 4 | Ask Mason two yes/no questions: (a) K2 — "leave the content gate loud?" (b) remove the clean `C:\crx-wt\ledger-gitdir` worktree | §1 #8, #10 | Mason |
| 5 | Delete **6 branches** once steps 1–4 are done: §1 #1, #2, #9 (each only after its landing merges and CI is green), #10 (after 4b, its changelog prose accepted as superseded), #8 (only if 4a = yes), and `claude/jobdetail-savegate-flake` from §2 (changed no file relative to its merge base). **§1 #5 (F3) is NOT in the set** until its 18 `ask` entries land on `main` | — | Mason's explicit go-ahead; serial tag → verify tag on `origin` → ledger → delete per the 09-01 procedure; fresh `ls-remote` + PR lookup per branch |
| 6 | Optional, Mason's call: the other 5 provably-empty merged leftovers in §2 | §2 | same as 5 |

Nothing in §3 is proposed for deletion. F1 and F2 fixes are separate money/security changes with
their own review gates and are **not** part of cleanup.

## §5 — Consolidation notes

- **`pr364-guard-commits-local` ⊇ `session-orchestration-setup`.** The remote
  `session-orchestration-setup-d73e6c` (`238d242ea`) is an ancestor of the protected branch's tip;
  the local copy is the protected tip itself. Two names, one lineage. When the three-protection
  extraction is eventually built or declined, both retire together — until then the protected branch
  is the canonical one and the other is a redundant pointer.
- **`harden-actor-binding-sql-reader` ⊂ PR #449.** Fully contained; it retires whenever #449 does.
- **`pricing-audit-strategy` / `product-plan-rev12-followup` / `autonomy-with-hard-boundaries`** each
  hold documents worth landing now (§1 item 2 carries the first and third). Their **code has not
  been shown to be superseded** — `pricing-audit-strategy` has 8 ABSENT + 5 BRANCH-ONLY files,
  `autonomy-with-hard-boundaries` 3 + 13 — so they stay in §3c until each file is mapped to a
  landed replacement. *(The first draft said "discard the code"; Codex flagged that as unsupported
  and it is withdrawn.)*

## §6 — Out of scope, but Mason should know

- **`backup/*` branches are retained by default and are never deletion candidates.** The
  merge-coordination session reported (2026-09-03 ~03:00Z) that it is pushing
  `backup/pr432-multitarget-20260825` with Mason's approval as an offsite copy of the PR #432
  lineage — 130 commits, no PR by design, **parked by Mason on 2026-08-24** after three exact-SHA
  `gpt-5.6-sol` reviews came back BLOCKED. Its park record `docs/audits/2026-08-24-pr432-park-handoff.md`
  is not on `main`; it is on that branch **and** in §1 item 2's rescue set, which is a second reason
  to land item 2. Any future sweep must treat the nine local `codex/pr432-*` siblings as **one group
  under that park decision**, not ten independent stale branches; only `multitarget` holds the tip.
- **Removing a worktree folder and deleting a branch are different risk levels.** A linked
  worktree's branch ref lives in the shared `C:/CRX_Manager/.git`, so removing the folder cannot
  lose commits, while `git branch -D` or a remote delete can. §4 step 4(b) is a folder removal;
  step 5 is branch deletion. Mason should approve them separately.
- **122 local-only branches** on this PC have no GitHub copy at all (e.g. the `codex/pr432-*` family,
  `claude/h5-test-newest-emitter-20260902` with 29 dirty files). They are invisible to any GitHub
  cleanup and are a separate sweep.
- **Dirty worktrees:** 13 registered worktrees carry uncommitted changes (24 files in each of
  several detached ones). **Not analysed here** — no conclusion about what those changes are should
  be drawn from this report.
- `.claude/schema-registry.json` staleness flagged in the 09-01 plan is unaffected by anything here.

## §7 — What was not verified

- **Live database was not queried today.** F2's "migration absent from the live ledger" is
  yesterday's Q1 result, not today's.
- **MAIN-MOVED files were not diffed hunk-by-hunk** except where stated (offline-review, F1's
  `OrderDetail.tsx:596`, F3's `settings.json`). "0 ABSENT / 0 BRANCH-ONLY" proves those two
  categories empty; it does not prove every MAIN-MOVED edit landed. Commit-subject matches on
  `main` are cited where they exist.
- Orphaned worktree folders not registered with git were not searched.
- GitHub tips are a snapshot at `git fetch` time; they must be re-read before any deletion.

## §8 — Questions put to Codex (answered in §9)

1. Attack the 7-branch deletion set in §4 step 5 and the 5 optional ones in step 6. Any of them
   holding something not on `main`?
2. Is the `2026-08-04-pending-doc-updates.md` exclusion (§1 #2) correct, and are any of the other
   seven documents *also* deliberate deletions I failed to detect? (I checked add/delete history at
   the same path only.)
3. F1: does open PR #535's `fingerprintIntentPayload` approach change how the Order/Invoice call
   sites should be fixed, or are they independent?
4. `codex/harden-actor-binding-sql-reader` is an ancestor of #449's head. Does that make it
   disposable today, or does PR #449's own unsettled state argue for keeping the pointer?
5. Anything in §3c I have mislabeled as "unique content" that is actually superseded, or vice versa?

---

## §9 — Codex review outcome (2026-09-03)

Reviewer: `gpt-5.6-sol`, `model_reasoning_effort=high`, `codex exec --sandbox read-only`, run
against this worktree with `origin/main = 819f0a119`. It could reach the local git objects and files
only — **not GitHub and not the live database** — and said so. **Verdict on the first draft: NOT
SAFE TO BRING TO OWNER — 1 BLOCKER, 1 HIGH, 5 MEDIUM, 4 LOW.** Every finding was accepted; the
corrections are applied in the body above and summarised here so the original claim and its
correction stay side by side.

| Sev | Finding | Correction applied |
|---|---|---|
| BLOCKER | The method said "only ABSENT can be real loss" while defining BRANCH-ONLY as an edit that "landed nowhere"; MAIN-MOVED was described as "just older". Cherry counts and subject matches cannot support "provably empty". | Method rewritten: ABSENT **and** BRANCH-ONLY are unlanded; MAIN-MOVED is undetermined; "provably empty" now requires every MAIN-MOVED file accounted for. Codex re-derived all 12 deletion verdicts by patch comparison; all 12 agreed with the draft's conclusions. |
| HIGH | §5 said `pricing-audit-strategy` and `autonomy-with-hard-boundaries` code should be "discarded" while §3c correctly protected them. | "Discard the code" withdrawn; both stay in §3c until mapped file-by-file. |
| MED | F3 (`control-file-coverage`) holds a real unlanded settings patch; "file it, then delete" would strand it. The "reverts the routers" claim was wrong — `b985e919b` is one additive hunk. | Pulled from the deletion set; branch stays until the 18 `ask` entries land. Router claim corrected. |
| MED | `ops/integrity-report-2026-09-01` was in "empty" (3a) but holds a unique record that the scheduled reconciliation did not run. | Moved to 3c. |
| MED | F1 is real and unlanded, but "tracked nowhere on `main`" ignored the 09-01 plan (on `main`); "a failed call" was too broad; #535's scope was misstated. | All three narrowed. F1 and fingerprinting are separate problems; the reorder is still required. |
| MED | §2's "literally zero differing files" and "subject match is a stronger test" were false as worded, though the conclusions hold. | Evidence column rewritten to what was measured. |
| MED | "Exist on no other branch still alive" was false for five rescue documents; only the bannered versions are unique. Claims inside them need dating. | Reworded; pending-doc exclusion confirmed correct by same-path add/delete history (`2ee7d972` → `dcd7aee4`). |
| LOW | `offline-review-stale-snapshot`'s old changelog prose is unique; "zero content risk" too absolute. | Stated; prose treated as superseded. |
| LOW | `xenodochial-dubinsky` is not byte-identical to current `main`; safe by squash/follow-up history. | Reworded. |
| LOW | "Nine missing entries" → nine patterns, 18 entries. | Corrected. |
| LOW | CRLF speculation about dirty worktrees was unsupported. | Removed. |

**Section 8 answers, as given:** (1) 12 candidates — all safe *after* their stated landing or
retirement condition and a verified archive tag; F3 not adequately gated. (2) Pending-doc exclusion
correct; no evidence any of the other seven was deliberately deleted, with the caveat that a
semantic rewrite under another filename cannot be excluded locally. (3) F1 and #535's
`fingerprintIntentPayload` solve separate problems; Order/Invoice still need reset-after-assert.
(4) `harden-actor-binding-sql-reader` ancestry confirmed (`e652f723` is the merge base); keeping the
pointer until #449 resolves is the safer choice. (5) No §3c branch is proven disposable; the
labels stand.

**Lessons-to-checks ratchet — why no executable check ships with this document.** The pre-commit
ratchet flags any audit naming BLOCKER/HIGH findings without a sibling predicate, hook, or test.
Every finding above is a defect in **this report's prose and proof standard**, not in code, a
migration, or a guard: nothing in the repository's behaviour was found wrong or changed. The
corrections are the reworded method and tables above. The three code-level gaps this audit
surfaces (F1, F2, F3) are **not closed here** — they are explicitly left open for their own
changes, where a real test can assert a real fix; writing a check now would claim a fix that has
not landed.

**Codex could not verify:** current GitHub PR states and tips, archive-tag counts on `origin`,
CI readiness, and every live-database claim. Those remain this session's `gh`/`git ls-remote`
snapshots at the times stated in the baseline table and must be re-read at action time.

# Disposition plan — the 28 branches whose pull requests are closed or merged (2026-09-01)

**Status: PROPOSAL. Nothing has been deleted. Awaiting Codex review, then Mason's approval.**

Companion to `docs/audits/2026-09-01-no-pr-branch-disposition-plan.md`, which covered the 21
branches that never had a pull request. This pass covers the remaining leftovers: branches whose
pull request has already been closed or merged, so the branch itself is finished business either
way.

Current remote state: **43 non-`main` branches** — 8 with open PRs (live work, untouched here),
7 no-PR branches kept by the previous pass, and the **28 adjudicated below**.

## How each branch was measured

Three questions per branch, all against current `origin/main`:

- **ABSENT** — a file the branch has that `main` has at no path at all. This is the only category
  that can represent genuinely lost content.
- **BRANCH-ONLY** — a file that exists on both, where `main`'s copy is **byte-identical to the
  version at the point the branch split off**, and the branch changed it. `main` never touched
  the file, so the branch's edit landed nowhere.
- **MAIN-MOVED** — a file both have, which `main` changed after the split. The branch is simply
  stale here; its version is the older one.

The third category is the one that makes a raw diff misleading. A branch 400 commits behind will
differ from `main` in dozens of files while containing nothing of its own, and counting those
differences as "unique work" is how a cleanup turns into a regression. Separating MAIN-MOVED from
BRANCH-ONLY is what distinguishes "`main` moved on" from "this never landed" — opposite conclusions
from the same diff.

**A deliberate bias in the method:** a branch is only cleared when the evidence says its content
landed, not when the evidence fails to show it did not. Every claim below that content "landed" is
backed by a named file on `main`, a live database row, or a `DECISION_LOG.md` entry.

## Why the previous pass's mistake shapes this one

The no-PR pass produced a finding (F4) that was wrong: it claimed three guard commits were stranded
and unrecreatable. They were not. `main` already carried the same protections **under different
symbol names**, in a strictly stronger form, and re-applying the branch would have been a
regression. A `gpt-5.6-sol` review found this independently.

The error was reasoning from a missing name to a missing capability. That failure mode is dense in
this batch: the below-cost approval feature appears "absent" on four branches, and is present on
`main` the whole time as `BelowCostApprovalModal.tsx` / `belowCostApproval.ts` rather than the
branches' `BelowCostConfirmModal.tsx` / `belowCostRpc.ts`. Every ABSENT path below was therefore
checked for a renamed or renumbered equivalent before being called gone.

---

## Tier 1 — nothing unlanded (11 branches)

Zero absent files, zero branch-only edits. Everything these branches authored is either
byte-identical on `main` or has been superseded by a later `main` commit to the same file.

| Branch | PR | Note |
|---|---|---|
| `claude/jobdetail-savegate-flake` | #485 MERGED | Zero authored difference of any kind |
| `claude/xenodochial-dubinsky-b55362` | #493 MERGED | |
| `claude/draw-down-price-tier-lines` | #404 MERGED | |
| `claude/ordering-cycle-review-t41vat` | #356 MERGED, #363 CLOSED | |
| `claude/log-session-attribution-fix` | #317 MERGED | One orphaned document — see Rescue |
| `chore/migration-ledger-reconcile-20260729` | #275 CLOSED | 610 commits behind |
| `codex/section4-lifecycle-20260805` | #321 CLOSED | 494 behind |
| `claude/codex-guard-single-ampersand` | #464 CLOSED | |
| `claude/push-guard-git-resolution` | #445 CLOSED | |
| `codex/proof-wrapper-trusted-git-bootstrap` | #454 CLOSED | |
| `fix/quote-fixture-stale-date` | #468 CLOSED | |
| `claude/comment-fix-applied-closeout` | #501 CLOSED | |

`claude/log-session-attribution-fix` is listed here rather than in Tier 2 because its only absent
path is a document, not code.

## Tier 2 — absent content proven landed elsewhere (6 branches)

These have absent files, and each one was traced to a live equivalent.

| Branch | PR | Where the content actually is |
|---|---|---|
| `codex/section9-ap-safety-remediation` | #491 | Both migrations are **applied on live production**, renumbered: `20260826125456…` → `20260826221000_bind_section9_ap_receiving_intent_and_month_dashboard` (live version `20260901044832`) and `20260826140333…` → `20260826222000_correct_ap_aging_due_date_buckets` (live `20260901045346`). `main`'s copies are supersets — +127/−40 and +79/−3 lines |
| `codex/defer-return-credit-rollout-20260831` | #532 | Its 5 staged files were promoted to real migrations on `main`; 4 are **applied live today** (`20260901182753`, `…183005`, `…183549`, `…183717`). The 5th is the subject of open PR #544 |
| `claude/recover-applied-migrations-20260812` | #389, #395 | 4 of 5 are the Wave A set, all present on `main` under `scripts/.staging-migrations/`. The 5th, `20260813180000_quote_version_restore_trust_boundary`, is superseded by `20260826220000_…`, **applied live** as version `20260827113443` |
| `claude/coderabbit-setup-optimize-0f308d` | #441 | Title reads `[PARKED — config split to #456]`; **#456 is merged**. The merge gate and its tests live on `main` as `.claude/hooks/pr-merge-guard.mjs` / `.test.mjs` |
| `codex/sol-gate-recovery-exception` | #403 | `DECISION_LOG.md:833` — "PR #403 closed: the live-ledger recovery exception is NOT in force". The absent `scripts/write-recovery-attestation.mjs` is absent **on purpose** |
| `claude/changelog-docs-honesty` | #505 | The convention it documents is already in `AGENTS.md` on `main`. Only its changelog fragment is orphaned — see Rescue |

## Tier 3 — deliberate closures with small unlanded remnants (6 branches)

Work that was stopped on purpose. Each still holds a few edits that never landed, which is expected
for an abandoned line of work rather than evidence of loss.

| Branch | PR | Basis |
|---|---|---|
| `codex/pr402-review-gaps-20260819` | #432 | `DECISION_LOG.md:673` — "PR #432 closed unmerged; agent-self-protection work frozen". 8 branch-only guard edits are frozen by that decision |
| `claude/bash-safety-opacity-cleanup` | #527 | The `git clean` carve-out, closed after six rounds. 2 branch-only edits to `bash-safety-lib.mjs` |
| `claude/remove-guard-hooks-f23691` | #503 | Same file pair, same guard-loop lineage |
| `claude/codex-recursion-hard-guard` | #452 | 10 absent files (`.claude/shims/`, `codex-recursion-guard.mjs`). `main` mitigates reviewer self-recursion **procedurally** instead — the sanitized `write-codex-push-proof.mjs` wrapper, documented in `.claude/skills/codex-review/SKILL.md` |
| `codex/autonomy-with-hard-boundaries-20260827` | #513 | 18 branch-only edits across the autopilot hooks — the largest unlanded remnant in this tier |
| `claude/product-plan-rev12-followup` | #507 | 1 branch-only edit to the product-data build plan |

**Three of these six have no `DECISION_LOG.md` entry** (#452, #503, #507; #513 and #527 likewise).
Their closure is recorded only by the PR being closed. I am treating that as deliberate, but it is
weaker evidence than the tiers above, and it is why every branch here is tagged before deletion.

## Tier 4 — NOT eligible in this pass (5 branches)

| Branch | PR | Why it stays |
|---|---|---|
| `codex/pr389-coderabbit-fixes` | #397 | **34 absent + 21 branch-only files**, concentrated on money paths — `quoteCalc.ts`, `belowCostApproval.ts`, `quotePdf.ts`, `financeChargeCalc.test.ts`, `orderSummaryPdf.ts`, plus `NewOrder.tsx` and `Quotes.tsx`. By far the largest body of unlanded work in the repository |
| `claude/pricing-audit-strategy-jym8rr` | #350 | Same work stream; 8 absent + 5 branch-only, including `quoteCalc.ts` and `quotePdf.ts` |
| `codex/harden-actor-binding-sql-reader` | #373 | 2 branch-only edits to `.claude/hooks/actor-binding-check.mjs`. **Open PR #449 is actor-binding work right now** — these may be relevant to it |
| `claude/session-orchestration-setup-d73e6c` | #364, #358 | **PROTECTED.** A separate session is actively working PR #364 |
| `codex/section9-ap-safety-remediation` (docs only) | #491 | Branch itself is Tier 2; noted here only because its documents are in the Rescue list |

Tier 4 is not a claim that this work is valuable. #397's edits may well be superseded in substance
by the 133 commits `main` has taken since, exactly as F4's were. It is a claim that **a
money-path branch of this size cannot be adjudicated from file-name evidence**, which is all this
pass gathered. It needs its own review against current source before anyone deletes it.

---

## Rescue first: ~1,700 lines of orphaned documents

The same pattern PR #542 addressed. These exist on no other branch and on no path on `main`:

| Lines | Document | From |
|---|---|---|
| 392 | `docs/handoffs/2026-08-09-actor-binding-guard-review-cap-handoff.md` | #373 |
| 276 | `docs/audits/2026-08-04-pending-doc-updates.md` | #317 |
| 174 | `docs/audits/2026-08-24-claude-to-codex-pr432-ci-handoff.md` | #432 |
| 171 | `docs/handoffs/2026-08-09-pricing-audit-local-finish.md` | #350 |
| 158 | `docs/audits/2026-08-24-pr432-park-handoff.md` | #432 |
| 145 | `docs/changelog.d/2026-08-27-standing-delivery-authority.md` | #513 |
| 88 | `docs/changelog.d/2026-08-31-git-clean-dry-run-allowlist.md` | #527 |
| 79 | `docs/handoffs/2026-08-27-crx-autonomy-plan-to-build-handoff.md` | #513 |
| 76 | `docs/audits/2026-08-08-product-pricing-full-audit-and-strategy.md` | #350 |
| 75 | `docs/audits/2026-08-24-codex-to-claude-dynamic-hardlink-bypass-handoff.md` | #432 |
| 65 | `docs/changelog.d/2026-08-26-maintenance-guard-denied-ordinary-work.md` | #503 |
| 49 | `docs/changelog.d/2026-08-27-product-plan-revision12-identity-and-restamp.md` | #507 |
| 45 | `docs/changelog.d/2026-08-31-git-clean-require-force-override.md` | #527 |
| 38 | `docs/changelog.d/2026-08-31-git-clean-false-boolean-and-anchoring.md` | #527 |
| 17 | `docs/changelog.d/2026-08-26-fragment-docs-catch-up-with-the-convention.md` | #505 |

**Open question for review, not a decision I should make alone:** the six `docs/changelog.d/`
fragments describe changes that **were themselves closed and never landed**. A changelog fragment
for a change that does not exist would be actively misleading — the changelog would claim behavior
the code does not have. My reading is that these six should **not** be rescued as changelog
entries, and that the three `git clean` ones (#527) are better served by the existing memory record
of why that carve-out was abandoned. The nine audits and handoffs are ordinary historical records
and carry no such hazard.

## Proposed execution, in order

1. **Rescue the documents first** — one PR, bodies preserved verbatim, `SUPERSEDED` banners where a
   handoff names work that has since landed. Same contract as #542. Excludes the six changelog
   fragments pending the question above.
2. **Tag every branch in Tiers 1–3** as `archive/2026-09-01/<name>`, pushed and verified on
   `origin` **before** any deletion.
3. **Delete the 23 branches in Tiers 1–3**, per branch and serially, reading the tip with
   `git ls-remote` and deleting only on an exact match against the tag.
4. **Leave Tier 4's 5 branches**, and record #397 as a tracked item.

Step 3 is a **force-class operation requiring Mason's explicit approval**, and this document does
not assume it.

**On the deletion mechanism:** the previous plan specified
`git push --force-with-lease=<ref>:<oid> origin :<branch>`. That command is **refused by this
repository's own guards** — the `.claude/settings.json` deny list blocks it and the Codex
production-action guard refuses force-pushes. Deletion goes through the GitHub ref API with a
per-branch OID check instead, which is **not atomic**; the gap is covered by tagging first.
`docs/audits/2026-09-01-no-pr-branch-restore-ledger.md` records this in full. Do not look for a
command spelling that gets past the guard.

Result if executed: **43 → 20 non-`main` branches.**

## What I want from Codex

1. **Is the BRANCH-ONLY test sound?** It calls an edit unlanded when `main`'s blob equals the
   merge-base blob. Does that miss a case — a revert, a squash that reproduced the base state, a
   file deleted and recreated identically on `main`?
2. **Tier 4 boundary.** #397 and #350 are held back on size and money-path proximity. Is #373
   correctly held (open PR #449), and are #513's 18 autopilot edits large enough to belong in
   Tier 4 rather than Tier 3?
3. **The changelog-fragment question above.** Rescuing a changelog entry for a change that never
   landed seems wrong to me. Is there a case for keeping them under a superseded marker?
4. **Verify the Tier 2 live-database claims** independently — the section 9, return-credit, and
   quote-version-restore version numbers.
5. **Anything the method structurally cannot see.** The previous pass's F4 was wrong in a way the
   measurement could not have caught, because it compared names rather than behavior. What is the
   equivalent blind spot here?

Report every finding. Do not filter for severity.

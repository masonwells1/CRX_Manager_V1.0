# No-PR branch disposition — findings and proposed plan (2026-09-01)

> **REVISION 3 — reviewed twice by Codex `gpt-5.6-sol` (high effort).** Round 1 returned NOT SAFE TO
> EXECUTE AS WRITTEN with 28 findings; round 2 adjudicated the corrections, **withdrew all four
> findings this document had refuted**, concurred with every row of the disposition, and raised three
> new issues — one of them a defect introduced by revision 2 itself. All three are closed here.
>
> Read **"Codex review outcome"** and **"Codex round 2"** at the end before acting on anything above
> them. Corrections are recorded there rather than silently patched into the body, so each original
> claim and its correction stay side by side.
>
> **Current status: steps 1–4 are clear to proceed through their normal review gates. The deletion
> sweep (step 5) is gated on Mason's go-ahead, a re-review of the corrected deletion mechanism, and
> same-session live evidence.**

**Status: PROPOSAL. Nothing has been deleted, pushed, merged, or applied.**
No branch was created, modified, or removed in producing this. Every live query was read-only.

## Why this exists

`docs/audits/2026-08-31-branch-inventory-for-codex-review.md` (PR #529) measured *what each branch
contains*. It deliberately stopped short of verdicts: its own words are "Unique means *needs a human
or Codex judgement*, not *must be preserved*." This document supplies that judgement for the 21
branches with **no pull request**, and proposes a plan.

It is a successor to that report, not a replacement. Its measurement method, its
byte-identical-recovery rule, and its forward-reconciliation rule are adopted here unchanged.

## Baseline

| | |
|---|---|
| Server `main` | `f9f4c8d77be0045baef5543aebfd6a8b897d6d02` (confirmed by `git ls-remote`, not `rev-parse`) |
| Predecessor report's baseline | `67e6da9d9ab409b65d5bbfd319de69b8783322e8` — **`main` has moved since** |
| Remote branches now | **57** (excl. `main`); the predecessor measured 62 |
| Delta since 2026-08-31 | 11 branches gone (all 5 Dependabot, plus #500, #502, #517, #525, #526, #528 heads); 6 new |
| Open PRs now | 9 (#361, #364, #449, #516, #530, #535, #539, #540, #541) |
| Live DB | `rhyzpcqhnizqbxphqdkr`, read-only `SELECT` against `supabase_migrations.schema_migrations` and `pg_proc` |

Measurement is the predecessor's, unchanged: *authored* = paths whose blob differs from the
merge base (plus paths the branch deleted); *unique* = of those, paths where `main` does not hold
the identical blob. Ahead/behind counts are not used as evidence.

**Verified against this baseline, my unique-file counts reproduce the predecessor's exactly** for
every no-PR branch it also measured (e.g. `pr401-proof` 14, `pr401-quote-version-trust` 18,
`pr364-guard-commits-local` 45, `offline-review-stale-snapshot` 1). That agreement is the reason to
trust the deltas below rather than re-deriving the method.

---

## Findings first: four branches hold work that is genuinely not on `main`

### F1 — `codex/idempotency-reset-order-hardening-20260802` — unlanded correctness fix on money paths

**Proven unlanded.** The branch moves `resetKey()` from *before* `assertRpcResult(...)` to *after*
it, in ~20 pages covering cancel/void order, split invoicing, invoice creation, deliveries,
prepayments, returns, month-end close, and vendor bills.

Today on `main`, `src/pages/OrderDetail.tsx` still reads:

```
595   if (error) throw error;
596   cancelOrderIdem.resetKey();          <-- key discarded before the envelope is checked
597   const result = assertRpcResult<{...}>(cancelResult, 'cancel_order');
```

Same shape at lines 698, 891, and 906. `assertRpcResult` exists precisely because a Supabase RPC can
return a failure *envelope* with no transport error. When it throws, the key has already been reset,
so the user's retry travels under a **new** idempotency key — which is the one thing the key exists
to prevent. This is the `p_idempotency_key` contract in the CRX Hard Rules being defeated at the
caller.

- Authored change is small and mechanical (statement reorder, no logic change).
- Branch is 490 commits behind; the surrounding files have moved a great deal. **The branch is not
  mergeable and should not be merged.** The fix should be re-derived onto current `main`.
- **Question for Codex:** is a bare statement reorder sufficient, or does any call site also need the
  key retained across the `catch` path? I did not audit all ~20 sites for that.

### F2 — `codex/section1-security-hardening-20260725` — unlanded ACL hardening on 8 number generators

Live, read-only, today:

| Function (all 8) | `SECURITY DEFINER` | `EXECUTE` granted to | actor check | role check | `is_active` check |
|---|---|---|---|---|---|
| `next_application_record_number`, `next_commission_payment_number`, `next_cycle_count_number`, `next_delivery_number`, `next_invoice_number`, `next_job_number`, `next_po_number`, `next_return_number` | yes | `postgres`, **`authenticated`**, `service_role` | **none** | **none** | **none** |

The branch's `20260725234503_harden_section1_number_and_field_actor.sql` adds `AUTH_REQUIRED` /
`INSUFFICIENT_ROLE` / `is_active` gates to each. It is **not** in
`supabase_migrations.schema_migrations` and **not** on `main`.

The migration's *other* half did land: `bind_save_field_actor` is live (ledger version
`20260729222311`, via merged PR #285). So this branch is half-superseded, half-unlanded, which is
exactly the case that a name-based or PR-based sweep gets wrong.

**Severity, stated honestly: low.** `anon` does **not** hold `EXECUTE`. The functions read
`MAX(...)` and return a string; they insert nothing. The realistic exposure is sequence-number
prediction/disclosure and advisory-lock contention by any authenticated principal, including a
`profiles.is_active = false` account that still holds a valid session. It is real, it is unlanded,
and it is cheap to close — but it is not a money hole and should not be filed as one.

**Question for Codex:** do you concur with the severity call, and is `authenticated`-only exposure of
a read-only `SECURITY DEFINER` generator worth a migration at all, versus simply revoking
`authenticated` and routing through the owning RPCs?

### F3 — `claude/control-file-coverage-a41c` — 10 enforcement-file patterns missing from the `ask` list

`main`'s `.claude/settings.json` `ask` list ends at `scripts/run-claude-review.mjs`. It does **not**
cover:

```
.claude/commands/**      .claude/skills/**      .claude/agents/**      .agents/skills/**
scripts/agent-manifest-parity.mjs   scripts/sync-agent-workflows.mjs
scripts/normalize-eol.mjs   scripts/post-agent-review-to-pr.mjs   scripts/agent-health-check.mjs
```

`scripts/agent-manifest-parity.mjs` is the script `AGENTS.md` names as the enforcer of Claude/Codex
hook parity — an agent can currently rewrite it with no prompt.

**But the branch itself must not be merged.** It predates the router consolidation: it would replace
`posttool-router.mjs` and `prompt-router.mjs` with the old expanded hook lists, silently reverting
that work. Only the `ask` entries are salvageable.

**Question for Codex:** does open PR #530 ("gate Bash writes to enforcement files", PARKED) already
cover this ground? If so this folds into #530 rather than becoming its own change. I have not read
#530's diff.

### F4 — ~~unlanded guard work~~ **WITHDRAWN 2026-09-01 — this finding was wrong**

> **F4 is refuted. Do not act on the text below; it is kept for the record.**
>
> The #364 session took this finding, investigated it, and found all three of its premises wrong in
> the same direction. Its migration was already on `main`, **byte-identical** (blob `f4f97722`),
> applied live three weeks earlier. `main` had independently rebuilt the same guard across four
> merged PRs. A `gpt-5.6-sol` review found `main` **strictly stronger** on every protection two of
> the three commits add — `scripts/apply-migration-file.mjs` on `main` carries two refusal families
> the branch lacks. **Re-applying these commits would have been a regression, not a rescue.**
>
> Independently corroborated here: `main`'s `scripts/apply-migration-file.mjs` is 463 lines to the
> branch's 382.
>
> **Where my reasoning failed.** I checked that the *symbol* `sessionDependentEventTriggers` was
> absent from `main` and concluded the protections were absent. Absence of a symbol is not absence
> of a protection — `main` had rebuilt the same guarantees under different names. That is the exact
> error this document warns about in its own supersession rows ("line counts are not supersession
> evidence"; "unique is not the same as lost"), applied in reverse: I treated *different* as
> *missing*. The rule cuts both ways and I only applied it in one direction.
>
> The branch is still **not** a deletion candidate — see the protection box below — but the reason
> is now "enumerate what it holds before closing", not "it holds the only copy of needed work".

### F4 (withdrawn text) — `claude/pr364-guard-commits-local-20260831` — a strict superset of open PR #364

`git rev-list --left-right --count origin/claude/session-orchestration-setup-d73e6c...origin/claude/pr364-guard-commits-local-20260831`
returns `0  18`: the local branch contains **everything on the open PR plus 18 commits**, and the PR
contains nothing the local branch lacks.

Fifteen of the 18 are merges from `main` or commits already landed via other PRs (#463, #469, #470,
#475, #476, #478, #479, #480, #484). **Three are original and exist nowhere else:**

- `2e23711c9 fix(guard): cover remaining event trigger ddl`
- `1692978f2 fix(guard): bind migration identity exactly`
- `286a38d2a fix(guard): port file apply identity checks`

All three touch the migration-apply guard — the mechanism that gates live database applies.

**This is the one finding with a deadline attached:** if PR #364 merges as it stands, those three
commits are stranded on an unreferenced branch and their absence will not be visible in the PR.

---

## Two branches must not be deleted yet (tied to live work)

### K1 — `claude/codex-claude-cogs-handoff-7bde15`
Four unique files, two of them new: `docs/audits/2026-08-25-claude-pr361-cogs-adversarial-review.md`
and `scripts/db-invariant-sweeps/predicates/credit-memo-cogs-line-gates.sql`. These are the
adversarial review record for **open PR #361** (return-credit COGS reversal, still draft, still
parked). Deleting them removes the reasoning behind a decision that is still open.
**Disposition: leave until #361 resolves.**

### K2 — `claude/guard-content-scan-and-savegate-flake`
Tip `480dc106`. This is the **parked** content-gate prose exemption. It is not abandoned by
accident: three successive designs were refused HIGH by the `gpt-5.6-sol` gate, and the standing
recommendation on record is to leave the gate loud rather than exempt anything, with an explicit
allowlist built on PR #463's stateful parser as the only safe alternative — never a suffix rule.
The save-gate flake half of this branch **did** ship, via `claude/jobdetail-savegate-flake` (#485).
**Disposition: Mason's decision, not a cleanup decision.** If he confirms "leave the gate loud", it
becomes a delete.

---

## Two branches hold only documentation that `main` lacks

### D1 — `claude/rescue-unique-docs-20260807`
Nine documents absent from `main`: a 2026-07-27 session handoff, a gauntlet Section 02 refresh, three
superseded local gauntlet snapshots, and four 2026-07-29 overnight handoffs. No code. The branch's own
commit message says its purpose was rescuing uncommitted work.
**Proposed: land the 9 files as a docs-only PR, then delete.**

### D2 — `claude/zealous-agnesi-aa7423`
Its **code** is superseded — `main` and the branch have diverged into different designs
(`main`: `chemUnitUnspecifiedSides` / `chemLineBillingHazard`; branch: `chemQuantityFactor` /
`chemRowUnitChange` / `chemLineUnitMismatch`), consistent with the chem-unit work having gone
catalogue-wide after 2026-08-19. Its **two audit documents** are unique:
`docs/audits/2026-08-19-chem-unit-findings-and-plan.md` and `2026-08-19-codex-verdict-chem-unit.md`
(151 + 293 lines), the latter being a Codex verdict on a money path.
**Proposed: land the two documents, discard the code, then delete.**

---

## Thirteen branches are superseded, contradicted, or broken — proposed deletes

Each has a stated reason and the evidence for it. **None should be deleted before a preservation tag
exists** (see plan step 0).

| # | Branch | Verdict | Evidence |
|---|---|---|---|
| 1 | `claude/restrict-draw-down-owner` | **Contradicted by owner decision** | The live `_draw_down_quote_below_cost_impl_20260810` body says in terms: cross-representative draw-down is *"DELIBERATE, not an oversight: any active admin or sales_rep may draw any booking (owner decision, re-confirmed 2026-08-16) ... Do not add a created_by or customer-assignment predicate here without a fresh owner decision."* The branch adds exactly that predicate. Its **other** half — rejecting a soft-deleted quote — is already live (`deleted_at IS NULL` in both the wrapper and the impl). Reviving this branch would reverse a settled owner decision. |
| 2 | `claude/pr401-proof` | Superseded | Carries `20260825190000_quote_version_restore_trust_boundary.sql`. The successor `20260826220000_quote_version_restore_trust_boundary` is on `main` **and applied live** (ledger version `20260827113443`), via merged PR #401. |
| 3 | `claude/pr401-quote-version-trust-8e3db6` | Superseded | Same migration, same successor. These two branches are near-duplicates of each other. |
| 4 | `claude/wave-a-migrations-857dcd` | Superseded | All 6 of its migrations live on `main` under `scripts/.staging-migrations/`, ledger rows 872–877, `PARKED DRAFT (STAGED) — NOT APPLIED`, sha256-pinned. 2 of 6 are byte-identical to the branch; `main`'s `20260813010000` is a **superset** (+15/−1) carrying the PR #393 review fixes. `main` is the later version. None are applied live (confirmed by query). |
| 5 | `claude/hold-latch-cross-session-envelope` | Superseded by a later design | The branch adds `isCrossSessionMessage()`. `main` carries the successor `authoredByMason()` / `hasAuthoredText()` (PR #504), whose own comment records that Mason answered on 2026-08-26 and the answer was *not* the branch's approach. |
| 6 | `claude/zen-easley-7d771d` | Settled DO-NOT-ATTEMPT | This is the `.claude/worktrees` prefix carve-out in `review-proof-guard.mjs` (46 worktree references on the branch vs 2 on `main`). Abandoned after five independent `gpt-5.6-sol` rounds found eight real holes across five versions; all eight are pinned as denials in `review-proof-guard.test.mjs`. |
| 7 | `codex/bootstrap-raw-patch-guard-20260825` | **Broken** | `.codex/hooks/production-action-guard.mjs` imports `normalizeToolInput`. A repo-wide grep finds that symbol **nowhere on the branch and nowhere on `main`** — the two hits are the import and the call. The branch cannot load. The underlying idea (classify a raw string patch body, not only structured `toolInput`) is sound and worth re-deriving; the code is not. |
| 8 | `codex/fleet-scan-parked-state` | Superseded | Relative to `main`, the branch is +80/−187 lines in `worktree-awareness-lib.mjs` and has fewer parked-state references (72 vs 80). `main` is ahead. |
| 9 | `claude/blend-unit-rebuild-step1` | Superseded | `main`'s `blendMathValidator.ts` is 544 lines to the branch's 443; the branch is a 2026-08-19 "step 1" that later work overtook. |
| 10 | `claude/push-guard-fix-rescue-e3320d` | Superseded, and would regress | Its `SSH_ASKPASS` fix landed on `main` in a better form (`INHERITED_CREDENTIAL_ENV_NAMES` relaxes the inherited read while `pushUsesTransportEnv` still denies deliberate command-line use). Merging the branch would **remove** `main`'s protection of `applied-source-ledger.json` from `reviewProofPathMentioned()`. |
| 11 | `claude/offline-review-stale-snapshot` | Landed | Its only remaining unique file is `docs/CHANGELOG.md` — the known top-of-file merge race. The code fix is on `main`. |
| 12 | `claude/ordering-cycle-review-t41vat-local-20260831` | Effectively landed | Unique files are `docs/CHANGELOG.md` and one line-level difference in `docs/audits/ordering-cycle-review-2026-08-09/REMEDIATION-PLAN.md`. |
| 13 | `pr435-work` | Mechanically safe | Zero unique blobs, zero commits ahead of `main`. Also on the predecessor report's safe list. |

---

## The other 36 branches (have or had a PR) — no per-branch verdicts proposed here

Mason asked for all branches; this is the honest state of that half.

- **9 open PRs** — leave alone. Six cannot merge as they stand (#361, #364, #516, #530, #535 conflicted;
  #449 and #539 behind). #540 and #541 are current and blocked only on approval.
- **5 merged-PR leftovers** (`claude/draw-down-price-tier-lines`, `claude/jobdetail-savegate-flake`,
  `claude/log-session-attribution-fix`, `claude/ordering-cycle-review-t41vat`,
  `claude/xenodochial-dubinsky-b55362`) — their PRs merged, the branch was never deleted. Note
  `xenodochial-dubinsky` acquired 7 commits *after* its merge, so it is not automatically empty.
- **22 closed-unmerged-PR leftovers.** The dominant pattern is "redone as a v2 that merged" —
  `codex/section9-ap-safety-remediation` → v2 → #500 merged **and its two migrations applied live
  today, 2026-09-01** (`20260901044832`, `20260901045346`); `codex/proof-wrapper-trusted-git-bootstrap`
  → v2 → #455; `codex/section4-lifecycle-20260805` → final → #322. Each still needs the same
  one-by-one check.
- **Migration-carrying branches in this group are the predecessor report's step 1 and 2 and are not
  re-adjudicated here** — `codex/pr389-coderabbit-fixes` (7 new + 1 modified),
  `claude/recover-applied-migrations-20260812` (5 new + 2 modified applied),
  `codex/harden-actor-binding-sql-reader` (3), `claude/pricing-audit-strategy-jym8rr` (2). Two useful
  new data points: the three cost migrations those branches carry (`snapshot_cost_reporting`,
  `quote_items_cost_at_quote_snapshot`, `enforce_below_cost_admin_approval`) **are applied live and
  their bytes are on `main`** under the recovered `20260812115235/36/37` names, so that axis is
  already closed; and `codex/pr389`'s `20260813161614_restrict_draw_down_quote_owner.sql` is the same
  owner-decision-contradicted migration as row 1 above.

---

## Proposed plan

Ordered so that nothing irreversible happens before the reversible work is done and reviewed.
**Steps 1–4 are the deliverable; step 5 is gated on Mason.**

**Step 0 — preserve before anything is removed.** Follow
`docs/audits/2026-07-27-branch-worktree-cleanup-restore-ledger.md`: push a real tag on `origin` for
every tip due for deletion, and record tag → branch → OID in a restore ledger. A SHA in Markdown
keeps nothing alive once the last ref is gone.

**Step 1 — F4, the deadline item.** Cherry-pick the three original guard commits
(`2e23711c9`, `1692978f2`, `286a38d2a`) from `claude/pr364-guard-commits-local-20260831` onto PR
#364's branch, or open a separate PR for them. Do this **before** #364 merges. Then the local branch
becomes a delete.

**Step 2 — F1, re-derive the idempotency fix.** New branch off current `main`, move `resetKey()`
after `assertRpcResult()` at every affected call site, with a regression test. Do **not** merge the
2026-08-02 branch. Money/inventory path → exact-SHA `gpt-5.6-sol` proof required, then CodeRabbit,
per `AGENTS.md`.

**Step 3 — documentation-only landings (D1, D2).** One docs PR carrying the 9 rescued documents and
the 2 chem-unit audit documents. Low risk, closes two branches.

**Step 4 — F3 and F2, pending the two questions above.** F3 folds into PR #530 if #530 already
covers it. F2 is a new migration and follows the full migration-review → apply gate; it does not
belong in a cleanup sweep.

**Step 5 — deletion sweep, gated on Mason's explicit go-ahead.** *(Corrected in revision 3 — the
original text said "13 branches + `pr435-work`", which double-counted: `pr435-work` **is** row 13.)*

**The executable deletion set is 12 branches: rows 1–10, 12, and 13.** Row 11
(`claude/offline-review-stale-snapshot`) is **HOLD** — it is checked out at `C:\crx-wt\ledger-gitdir`
and is handed off before it is eligible.

> ### 🔒 `claude/pr364-guard-commits-local-20260831` is PROTECTED — do not delete
>
> This branch is **F4**, not a deletion candidate, and as of 2026-09-01 a separate session is
> actively working it. Two facts make deleting it unsafe:
>
> 1. Its tip `57d27e79105b` is the **only published reference** to the three guard commits
>    (`2e23711c9`, `1692978f2`, `286a38d2a`). PR #364's own head on `origin` is still
>    `238d242ea87f` and does **not** contain them.
> 2. Those commits cannot be re-created from `main`: they harden the one-shot replay guard
>    (`sessionDependentEventTriggers`), and `git grep -c sessionDependentEventTriggers origin/main
>    -- .claude/hooks` returns nothing. The machinery exists only on the #364 branches.
>
> **Revised 2026-09-01 after F4 was withdrawn.** The reason to keep this branch is no longer "it
> holds needed work". `main` is strictly stronger on the guard those commits touch, so the commits
> themselves are superseded and must not be re-applied.
>
> It still stays, for a different and weaker reason: a superseded branch can hold incidental value
> nobody has catalogued, and this one has never been enumerated. **Enumerate what it holds, record
> anything real in `KNOWN_ISSUES.md`, and only then delete.** It is not on the 12-branch executable
> set and does not join it without that pass.

Immediately before each deletion, re-run **both** checks the predecessor report demands: `git ls-remote`
to confirm the tip still matches, **and** a fresh PR lookup, because a branch can acquire an open PR
without a single commit being pushed to it.

**Deletion must be conditional on the expected OID, not on the branch name.** An ordinary remote
branch delete removes the ref *by name* and will happily delete a tip that moved after the final read.
If that happens, the preservation tag holds only the old commit and the new one is lost — the exact
failure the tag exists to prevent. Use a compare-and-swap delete pinned to the expected old OID
(`git push --force-with-lease=<ref>:<expectedOid> origin :<branch>`, or a server API with equivalent
semantics). Note that this is a **force-class** operation, so it needs Mason's explicit approval under
`AGENTS.md` and must be reconciled with the repository's current-approval requirement before the sweep
runs — it is not covered by the standing push policy.

### Deliberately not in this plan

- Deleting anything today.
- Touching the 22 closed-PR and 5 merged-PR leftovers — they need the predecessor report's
  procedure, one at a time, and lumping them into a sweep is how a migration gets lost.
- Any live database change. Every query behind this document was a `SELECT`.

## Side finding, out of scope but relevant

The session-staleness check reports 6 migration files newer than the schema registry's applied
high-water. Two of them — the section 9 AP migrations — **are confirmed applied live today**
(`20260901044832`, `20260901045346`). `.claude/schema-registry.json` therefore describes a database
that no longer exists, and four schema-aware hooks plus three review subagents are validating against
it. `/regen-schema-registry` should run regardless of what happens to any branch.

## What I want from Codex

1. **Refute F1 if you can.** Is the `resetKey()` reorder actually the correct fix, or does it need
   the key retained across the `catch` path too? Are there call sites where resetting early is
   deliberate (e.g. `onCreateInvoiceClick` at `main` `OrderDetail.tsx:938`, which resets per attempt
   by design)?
2. **Adjudicate F2's severity.** `authenticated`-only, read-only `SECURITY DEFINER`. Migration, plain
   `REVOKE`, or leave it?
3. **Does PR #530 already cover F3?** I did not read its diff.
4. **Attack the 13 deletes.** Each verdict above is a claim that work is superseded, contradicted, or
   broken. Any one of them being wrong destroys work. In particular check row 4 (`wave-a`) — I claim
   `main`'s staged copy supersedes the branch based on a +15/−1 diff and a ledger note; verify the
   direction rather than taking it.
5. **Row 1 is the one I am most confident about and would most like challenged**, because it says a
   security-shaped branch must be discarded on the strength of an owner decision recorded in a
   comment inside a live function body.

---

# Codex review outcome (2026-09-01)

Reviewer: `gpt-5.6-sol`, `model_reasoning_effort=high`, `codex exec --sandbox read-only`, run against
this worktree at `main = f9f4c8d7`. **Verdict: NOT SAFE TO EXECUTE AS WRITTEN**, 3 BLOCKER,
8 HIGH, 12 MEDIUM, 5 LOW.

## Two of the three BLOCKERs are capability limits, not refutations

Codex's BLOCKER 1 and BLOCKER 2 both reduce to *"I could not check this"*: its sandbox cannot reach
GitHub, and its Supabase route was unavailable under that session's approval policy. Neither is a
finding against the claims — but **both prescribe the right fix**, which this document was missing:
a claim that a live database or a remote server says something must ship with the query and its
output attached, not as an assertion a reader has to take on trust. That is adopted below.

The queries were run in the authoring session. They are reproduced here so the next reader does not
have to re-derive them.

```sql
-- Q1  Is any of this branch SQL actually applied? (all names, one query)
select version, name from supabase_migrations.schema_migrations
where name ilike '%quote_version_restore_trust%' or name ilike '%draw_down_quote_owner%'
   or name ilike '%number_and_field_actor%'      or name ilike '%wave_a%'
   or name ilike '%reject_non_finite%'           or name ilike '%round_order_header%'
   or name ilike '%clamp_negative_commission%'   or name ilike '%job_commission_split_immutable%'
   or name ilike '%completed_delivery_before_invoice%' or name ilike '%save_field_actor%'
order by version;
```

Result — only two rows: `20260827113443 | 20260826220000_quote_version_restore_trust_boundary`
and `20260729222311 | bind_save_field_actor`. **All six Wave A names, the draw-down owner migration,
and the Section 1 migration are absent from the live ledger.** This settles BLOCKER 3 and row 4
directly: the "not applied live" assertion is reproduced, not assumed.

## Accepted — corrections that change the document

| Codex | Correction accepted | Effect |
|---|---|---|
| HIGH 5 | F1's reorder is necessary but **not sufficient**. `onCreateInvoiceClick` (`main` `OrderDetail.tsx:938`) resets the key before *every* attempt, and the RPC payload does not in fact vary by date/notes as its comment claims. A lost response followed by a second click still gets a fresh key after the reorder. | F1's fix scope grows: reorder the post-RPC resets **and** repair the click/intent-level reset. Rotate only on proven success or a genuinely changed intent. |
| HIGH 6 | The F2 migration defines **six** generators, not eight — `next_invoice_number` and `next_return_number` are untreated. Verified: the file contains exactly six `CREATE OR REPLACE FUNCTION public.next_*` statements. | F2 cannot be "apply the old branch". A forward migration must cover all eight. `next_invoice_number` is additionally overloaded (`schemaIntegrityLive.test.ts:419`), so it needs care. |
| HIGH 7 | Severity raised **LOW → MEDIUM**, and plain revocation is wrong. `CycleCounts.tsx:155` and `JobDetail.tsx:1838` call `next_cycle_count_number` / `next_job_number` directly via `supabase.rpc`. Revoking `authenticated` breaks both screens. | F2 = in-body active-profile + role gates, grants preserved. |
| HIGH 10 | The plan had no active-writer check. `claude/offline-review-stale-snapshot` (row 11) **is currently checked out** in `C:\crx-wt\ledger-gitdir`. | Step 5 gains a worktree/session/local-ref/stash/orphan-directory check per branch. A checked-out lane is handed off before its remote ref goes. |
| HIGH 11 | Bulk-tag-then-delete is unsafe; a tip can move between the two. | Step 0 folds into step 5 as a **serial, per-branch** procedure: read tip → tag that exact OID → verify the remote tag's OID → update the restore ledger → fresh PR + worktree check → delete that same OID. |
| MED 12 | Nine patterns, not ten; and `CLAUDE.md`, not `AGENTS.md`, names `agent-manifest-parity.mjs`. | Corrected. |
| MED 13 | PR #530 covers only 2 of the 9 F3 patterns and works at a different layer (Bash guard vs `Edit`/`Write` ask list). | F3 does not fold into #530; seven patterns need separate treatment. |
| MED 14 | Two refused drafts, not three. | Corrected. |
| MED 16 | Wave A **authored four** migrations (`130100`–`130400`); `130500`/`130600` were inherited. `130400` is byte-identical to main's staged copy; the other three have later staged successors. | Row 4's reasoning tightened; verdict unchanged. |
| MED 19, 20, 28 | Line counts and grep-match counts are not supersession evidence. | Rows 6, 8, 9 keep their verdicts but on **semantic** grounds (main's later validator behaviors, retry logic, and reconciliation), not size. |
| MED 18 | Row 7's second commit repins a hook hash coupled to the broken import; it cannot be salvaged separately. | Discard both; re-derive the idea. |
| MED 22 | `codex/pr389`'s copy of the owner migration is **not** byte-identical to row 1's. | Corrected. |
| MED 23, LOW 24, 26, 27 | `pr435-work` is already row 13 (13 total, not "13 + 1"); "not mergeable" → "do not merge wholesale"; F1 touches **22** runtime files (18 pages + 4 components); "no logic change" → a deliberate retry-state behavior change. | Corrected. |

## Refuted — with evidence

**HIGH 8 and Question 5 — "no corresponding entry in `docs/manual/DECISION_LOG.md`". This is wrong.**
The entry exists at `docs/manual/DECISION_LOG.md:1556`, titled *"2026-08-16 — Any sales rep may draw
down any customer's booking"*, sourced to Mason's verbatim in-chat answer *"Any rep"*, and it names
`20260813161614_restrict_draw_down_quote_owner.sql` explicitly. The owner authority is durably
recorded, not merely asserted in a migration comment.

**But Codex's challenge was still worth its cost, because that entry says something this document
missed.** Its operative rule: *"Removing the owner gate removes only the owner gate."* The migration's
other protections were to ship — `AUTH_REQUIRED`, `ACTOR_MISMATCH`, `INSUFFICIENT_ROLE`, the
soft-delete exclusion, and the `BOOKING_CLOSED` status gate. Row 1 was proposed for deletion without
anyone confirming those had landed. If they had not, deleting the branch would have discarded
owner-mandated security work. They have:

```sql
select p.proname,
       (p.prosrc like '%AUTH_REQUIRED%')     as auth_required,
       (p.prosrc like '%ACTOR_MISMATCH%')    as actor_mismatch,
       (p.prosrc like '%INSUFFICIENT_ROLE%') as insufficient_role,
       (p.prosrc like '%BOOKING_CLOSED%')    as booking_closed,
       (p.prosrc like '%NOT_QUOTE_OWNER%')   as owner_gate
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('draw_down_quote', '_draw_down_quote_below_cost_impl_20260810');
```

| function | auth_required | actor_mismatch | insufficient_role | booking_closed | owner_gate |
|---|---|---|---|---|---|
| `draw_down_quote` (wrapper) | ✅ | ✅ | ✅ | — | ❌ |
| `_draw_down_quote_below_cost_impl_20260810` | ✅ | ✅ | ✅ | ✅ | ❌ |

Every protection the owner decision preserved is live; the owner gate it retired is absent
everywhere. **Row 1's verdict stands, now on live proof plus a durable owner record.** The
`DRAW_DOWN_OWNER_GUARD_DRIFT` preflights do not appear because they are apply-time assertions inside
a migration `DO` block, never runtime function source — their absence from `prosrc` is expected and
is not evidence.

**HIGH 9 — "four overnight handoffs are already byte-identical on main; only five absent". Wrong.**
`git ls-tree -r --name-only origin/main` finds none of the four `docs/handoffs/2026-07-29-*` files
anywhere on `main`, and `git diff --name-status <merge-base> <branch>` shows all nine as `A`
(branch-authored additions). **D1 is nine documents, not five.** Codex's accompanying point *is*
accepted: the tenth path, `docs/app-workflow-map.html`, is a stale generated artifact and must not
be landed — which is why this document said "nine documents" and not "ten files".

**HIGH 4 — the corrected unique counts are not reproducible.** Re-measured at this baseline,
`codex/section1-security-hardening-20260725` is `authored = 16, unique = 16`, matching both this
document and the independent PR #529 inventory. Codex reports 3. `rescue-unique-docs` is 10, not 6,
per the `A`-status evidence above. Two independent measurements agree against one; the discrepancy is
**unresolved**, and it changes no verdict — F2's migration is unlanded either way, proven by Q1.

**MED 15 — "the public wrapper has no `deleted_at` predicate".** Codex read migration
`20260816110000_draw_down_cutover_barrier.sql`, which is not the current definition. The **live**
`draw_down_quote` body contains `PERFORM 1 FROM public.quotes WHERE id = p_quote_id AND deleted_at IS
NULL FOR UPDATE`. A later migration replaced the wrapper. This is the reason the CRX rule prefers
live introspection over migration source, and it applies to a reviewer as much as to an author.

## Adopted safeguards the plan was missing

1. Serial, exact-OID tag → verify remote tag → restore-ledger → delete, one branch at a time.
2. The restore ledger must be **landed** before any deletion, not merely drafted locally.
3. Active worktree / session / local-branch / stash / `refs/archive` / orphan-directory check per branch.
4. F1 tests must cover: transport failure, failure envelope, lost-response replay, success, and a
   genuinely changed intent.
5. F4's three commits get re-derived against current guard code and an exact-head adversarial review —
   a clean cherry-pick is not sufficient evidence.
6. D1/D2 land as a `docs/changelog.d/` entry, never by appending to `docs/CHANGELOG.md`.
7. Fresh GitHub tip **and** PR lookup immediately before each deletion. This frozen snapshot is
   evidence for the audit, not authorization to delete.

## Revised disposition

| | Was | Now |
|---|---|---|
| Row 1 `claude/restrict-draw-down-owner` | delete | **delete — upheld**, on live proof + `DECISION_LOG.md:1556` |
| Row 4 `claude/wave-a-migrations-857dcd` | delete | **delete — upheld**, live ledger proves all six names unapplied (Q1) |
| Row 11 `claude/offline-review-stale-snapshot` | delete | **HOLD** — checked out in `C:\crx-wt\ledger-gitdir`; hand off first |
| Rows 2, 3, 5, 6, 7, 8, 9, 10, 12, 13 | delete | delete — Codex concurs, subject to the serial procedure |
| F2 | apply the branch | **re-derive**: all eight generators, in-body gates, grants preserved |
| F1 | reorder resets | **reorder + repair the click-level reset** |
| F3 | may fold into #530 | separate change; #530 covers 2 of 9 |
| D1 | 9 documents | 9 documents, map excluded (unchanged) |

**Still gating execution:** a fresh `git ls-remote` and PR lookup per branch at the moment of
deletion, the landed restore ledger, and Mason's go-ahead on step 5.

---

# Codex round 2 (2026-09-01) — revision 2 adjudicated

Same reviewer and settings, run against revision 2 with the four disputes named explicitly.

## All four refutations upheld — Codex withdrew every contested finding

| Round-1 finding | Round-2 decision |
|---|---|
| HIGH 8 / Q5 — owner decision undocumented | *"Author is right; my round-1 finding was wrong."* The entry exists at `DECISION_LOG.md:1556`. |
| HIGH 9 — only five documents absent | *"Author is right."* All nine are absent from `origin/main` under any path **and by blob id** — Codex additionally searched for the four handoff blob ids and found nothing, which is stronger than the path search this document ran. |
| HIGH 4 — unique counts 3 and 6 | *"Author is right."* 16 and 10 confirmed. Codex diagnosed its own error: it had produced *selective salvage* counts, not the formal authored/unique measure; the 6 came from wrongly treating the four handoffs as already preserved. |
| MED 15 — wrapper lacks `deleted_at` | *"Author is right."* Codex located the superseding migration this document did not name: `20260819232000_bind_draw_down_receipts_to_intent.sql` renames the old public wrapper (line 303), creates the new one (line 311), and checks `deleted_at IS NULL` at line 485. |

The new `DRAW_DOWN_OWNER_GUARD_DRIFT` reasoning was also checked and confirmed correct.

**Disposition table: Codex concurs with every row**, F1–F4 and D1/D2 included. Rows 1 and 4 are
*conditional* concurrences, conditioned on the three items below.

## Three genuinely new findings — all accepted

1. **The step 5 count contradicted itself.** Revision 2 moved row 11 to HOLD but left the old
   "13 branches + `pr435-work`" sentence, which also double-counted `pr435-work` (it is row 13).
   **Corrected above: 12 branches, rows 1–10, 12, 13.** This was a defect introduced *by* revision 2 —
   worth noting, because it is the reason a corrections pass gets reviewed rather than trusted.

2. **"Delete that same OID" was aspirational, not mechanical.** A remote delete removes a ref by
   *name*; nothing compares it to the OID that was tagged. A branch that moves between the final read
   and the delete loses its new commit despite the tag. **Corrected above** with a compare-and-swap
   delete pinned to the expected OID — and with the consequence flagged that this is force-class and
   therefore needs Mason's explicit approval, which the plan had not accounted for.

3. **Attached query text and output is audit evidence, not an execution token.** Codex's Supabase
   route was blocked again, so it could not re-run the live queries; it accepted them as supporting
   evidence while ruling that they must be **re-captured in the same session as the deletion**. It
   also asked for a stronger row 1 check than the substring test used here: exact `regprocedure`
   signatures, `pg_get_functiondef()` or a reviewed `prosrc` hash, overload count, ACL/security
   configuration, and a **semantic** check for any owner predicate — because a `created_by`
   restriction could exist without ever containing the literal `NOT_QUOTE_OWNER`. **Accepted.** Row 4
   likewise re-runs Q1 live at deletion time.

## Standing verdict

**NOT SAFE TO EXECUTE AS WRITTEN at revision 2**, with steps 1–4 clear to proceed through their normal
review gates and only the deletion sweep gated. Revision 3 closes all three findings. The deletion
portion should be re-reviewed as executable before it runs; row 11 stays held regardless of that
review.

**What this round did not resolve:** current GitHub tips and PR states remain unverified by either
party — Codex cannot reach the network and this document's snapshot is frozen at 2026-09-01. That is
precisely why the action-time `ls-remote` + PR lookup is a gate and not a formality.

Run one or more numbered sections of the **CRX Live Foundation Gauntlet** — the recurring read-only foundation audit tracked in `docs/audits/gauntlet/`.

Mason does not need to remember this command name. Treat plain-English requests like these as requests to use this workflow:

- "Run gauntlet section 3."
- "Re-check the money section."
- "Audit commissions / inventory / idempotency."
- "Run the next gauntlet section."
- "Is the inventory foundation still solid?"

This is **read-only**. It analyzes, writes one dated report, and updates the queue index. It never edits application code, applies a migration, deploys, or commits.

## Section map

| # | Section | Phase label |
|---|---------|-------------|
| 1 | Security — roles, route gating, RLS, SECURITY DEFINER access | S1 Security |
| 2 | Money — invoices, payments, AR aging, statements, credits, write-offs, finance charges | S2 Money |
| 3 | Inventory — holds, prebooks, Net Free, quote draw-down, deliveries, receiving | S3 Inventory |
| 4 | Lifecycle — quote → order → delivery → invoice → payment wiring | S4 Lifecycle |
| 5 | Database drift — disk vs registry vs live catalog, CHECKs, overloads, generated columns, `search_path` | S5 DB-drift |
| 6 | Idempotency and double-submit safety | S6 Idempotency |
| 7 | Commissions — splits, recipients, payout batches, cancellations/voids | S7 Commissions |
| 8 | Returns and credit memos — issue, apply, unapply, reversal, statement impact | S8 Returns/Credits |
| 9 | Purchase orders, receiving, vendor bills, vendor payments, AP safety | S9 PO-AP |

**Sections 10–15 are not encoded in the workflow yet** (blend tickets, PDFs/compliance, Edge Functions, frontend wiring, testing/prevention gaps, documentation drift). If Mason asks for one of those, say so plainly and run it manually against the section description in `docs/audits/gauntlet/live-foundation-gauntlet-index.md` — do not silently substitute a different section. Naming one in `args.sections` makes the workflow return `status: "BLOCKED"` with an empty `results` array **before any agent runs** — it rejects the whole request rather than quietly running the supported sections and handing back a result set that reads as complete.

## Step 0 — Pick the section

If Mason named a section number or area, use it. If he said "the next one", read the **Next Section** line at the bottom of `docs/audits/gauntlet/live-foundation-gauntlet-index.md`. If neither is clear, ask one short question — do not guess.

Then check state:

```bash
git status --short --branch
git fetch origin main
git rev-list --left-right --count origin/main...HEAD
```

If the branch is **behind** `origin/main`, say so before reporting any drift finding — a behind branch manufactures false "live is ahead of the repo" findings. This is the #1 false BLOCKER in this repo.

## Step 1 — Gather the live evidence packet (this is the real work)

The workflow's agents are capability-constrained to `Explore`: they can read repository source but **cannot** run shell commands or call Supabase. Every live-database claim must come from an evidence packet **you** collect first, read-only, via Supabase MCP `execute_sql` / `list_migrations` / `get_advisors`.

Collect what the chosen section actually needs — for example:

- **S1** — `pg_policies` + `relrowsecurity` per table, routine grants (`information_schema.role_routine_grants`) for `PUBLIC`/`anon`, `proconfig` (`search_path`) for every SECURITY DEFINER function, security advisors.
- **S2 / S8** — invoice/payment/credit CHECK constraints, the `balance_cents` generated-column definition, and small aggregate probes (never row dumps of customer data).
- **S3 / S9** — inventory transaction-type constraints, immutability triggers, negative-stock counts, PO line-completion shape.
- **S4** — the live CHECK constraint values for every status column in the lifecycle.
- **S5** — all three of: (a) the live ledger (`list_migrations` or `supabase_migrations.schema_migrations`), (b) the `origin/main` baseline (`git merge-base origin/main HEAD`, ahead/behind counts, untracked migration files), and (c) live catalog drift probes (duplicate/overloaded functions from `pg_proc`, generated columns, `proconfig` search_path). Plus the `origin/main` SHA and fetch time. Section 5 is BLOCKED without all of them — it is the drift section, and it cannot compare disk to live on one of the two.
- **S6** — the current full mutating-RPC set and their `p_idempotency_key` signatures.
- **S7** — commission split/batch constraints and batch-total-vs-member-sum aggregates.

Keep each section's packet under 50,000 characters — the workflow rejects anything larger. Aggregate counts and catalog rows, not customer data.

The workflow **checks that the evidence is about the section**, not merely well-formed: a perfectly-shaped packet of `select 1 → one` used to settle the drift section without ever comparing a migration. If a section's observations do not mention its subject, the section is rejected and the rejection message names exactly what is missing. The required subjects live in `REQUIRED_EVIDENCE` in `.claude/workflows/gauntlet-sections-loop.js` — keep this list and that constant in sync when either changes.

Every `source` must look like something a second person can re-run: a file path, a migration stamp, a function call, a SQL statement, a `pg_*`/`information_schema` probe, a snake_case object name, or a command starting with `git`/`gh`/`npm`/`node`/`psql`/`supabase`/`mcp`. `"I checked the money tables"` is not a source.

## Step 2 — Run the workflow

Invoke the `gauntlet-sections-loop` Workflow with:

```json
{
  "sections": [3],
  "nowMs": <current epoch ms from a real clock>,
  "evidencePacket": {
    "projectId": "rhyzpcqhnizqbxphqdkr",
    "capturedAt": "<ISO timestamp of collection>",
    "checkout": { "headSha": "<git rev-parse HEAD>", "dirtyFiles": 0, "behindOriginMain": 0 },
    "originMain": { "sha": "<sha>", "fetchedAt": "<ISO>" },
    "sections": {
      "3": {
        "evidenceSummary": "...",
        "observations": [
          { "source": "<exact SQL, command, or MCP call run>", "result": "<what it returned>" }
        ]
      }
    }
  }
}
```

`nowMs` is supplied by you because a resumable workflow cannot read the clock. The packet must be **under six hours old** or the section is rejected — collect it in this session, not from a prior one. `originMain` is required only for Section 5.

**A rejected packet costs nothing.** Missing, stale, oversized, wrong-project, bad-checkout, or off-topic evidence is caught *before* the section dispatches a single agent: the section comes back with `counts.blocked: 1`, `settled: false`, and the reason in `adjudication.remainingGaps`, and the sweep halts there. Fix the packet and re-run — you have not spent a finder, a critic, a skeptic, or an adjudicator.

Every observation must name **what you ran** and **what came back**. Prose like `"inventory looks fine"` is an opinion, and the workflow rejects the section rather than letting it settle on it. Words like `"none"`, `"n/a"`, `"unknown"`, `"tbd"`, and empty `{}` / `[]` are also rejected — they are what an agent writes when it has nothing.

`checkout` is required for every section: findings cite `file:line` in whatever tree the agents read. Two different failures, handled differently:

- **Behind `origin/main` → the section is BLOCKED.** A behind branch reports every migration `main` added since the fork as a false deletion. Fetch and rebase, or run from a clean `origin/main` worktree.
- **Dirty tree → the run proceeds but can never settle.** Uncommitted content is not reachable from `headSha`, so nobody can reproduce a finding that cites it. This is deliberate: CRX routinely runs parallel sessions in one checkout, so a hard block would make the command unusable — but the report must say the section is incomplete.

Get the three values from:

```bash
git rev-parse HEAD && git status --porcelain | wc -l && git rev-list --count HEAD..origin/main
```

**Known limitation — the checkout block is self-attested.** The workflow's agents cannot run git, so it validates the *shape* of these three values but cannot confirm they describe the tree the agents actually read. A wrong or stale `headSha` produces citations nobody can reproduce, and nothing in the workflow will catch it. Run the command above in this session, immediately before invoking, and paste the real output.

The workflow runs each section as: finders → completeness critic → two adversarial skeptics per BLOCKER/HIGH → **deterministic settlement gate**. It stops before the next section if a gate does not settle.

It returns:

| Field | Meaning |
|---|---|
| `status` | `COMPLETE` (every section ran, settled, and confirmed nothing), `COMPLETE_WITH_FINDINGS` (ran and settled, but a BLOCKER/HIGH was confirmed — the audit finished, the code did not pass), `INCOMPLETE` (something halted or did not settle), or `BLOCKED` (the request itself was rejected — no agent ran) |
| `requestedSections` / `completedSections` / `haltedBefore` | what you asked for, what actually ran, and what was never reached |
| `results[]` | one entry per completed section: `confirmed`, `refuted`, `unverified`, `verifiedSafe`, `blocked`, `duplicates`, `superseded`, `adjudication`, `counts` |
| `totals` | `blocker`, `high`, `med`, `low`, `contested`, `unverified`, `blocked`, `sectionsRun`, `sectionsSettled`, `sectionsCleanOfBlockerHigh` |

`haltedBefore` is not optional reading. A short `results[]` is otherwise silent, and it reads as "the other sections were fine" when in fact they never ran.

**The gate is code, not an opinion.** `adjudication.settled` is false whenever any evidence source was blocked, the tree was dirty, any BLOCKER/HIGH verdict was inconclusive, or the two skeptics **split 1-1** on one (`contested`). Never override it, and never report a section clean because an agent said so.

## Step 3 — Read the result honestly

- `confirmed` — survived adversarial refutation. These are the findings. **Some carry `contested: true`** — the two skeptics split 1-1. A contested finding is kept (the safe direction) but the disagreement is an open question, so it also blocks settlement. Report it as contested, not as a clean confirm.
- `refuted` + `verifiedSafe` — go in a "Verified safe" section so the next run doesn't re-chase them.
- `unverified` / `blocked` — stay visible in their own section. A missing agent, timeout, tool denial, or malformed response is **never** clean.
- `duplicates` / `superseded` — the same lead reported twice, and a lower-severity record replaced by a higher one at the same title+location. Nothing to act on; they exist so a dropped report is auditable rather than invisible.

For a **BLOCKER or HIGH**, only `VERIFIED` and evidence-backed `REFUTED` are terminal — anything else leaves the section unsettled. **MED and LOW are never adversarially verified at all** (it is not worth the agent rounds), so they land in `unverified` with `blocksSettlement: false`. That is normal: a section can settle with MEDs and LOWs open. They are still counted in `counts.med` / `counts.low` and still belong in the report.

If `settled` is false, the report must say the section is **incomplete**, even when `confirmed` is empty.

**Cite or cut applies to confirmed findings only.** A finding with no `file:line`, migration filename, constraint name, or RPC name never reaches `confirmed` — the workflow routes it to `unverified` where it blocks settlement. Do not "drop" anything from `unverified` or `blocked`; those are the gaps, and deleting them is how an unreviewed section comes to read as a pass.

## Step 4 — Write the report

Write to `docs/audits/gauntlet/<YYYY-MM-DD>-section-<NN>-<slug>-refresh.md` (real date from `TZ='America/Chicago' date +%F`), following the shape of the existing section reports in that folder: verdict, scope, method, findings by severity with citations, verified-safe, and a recommended next action per finding.

## Step 5 — Update the queue index (required)

A run that does not update `docs/audits/gauntlet/live-foundation-gauntlet-index.md` leaves the next session with a stale picture. Update:

1. the section's **Status** and **Last reviewed** date, and link the new report;
2. the **Next Section** line at the bottom;
3. `live-foundation-gauntlet-summary.md` — add any new finding to the Ranked Fix Queue, and mark resolved rows RESOLVED with the evidence that closed them.

If a finding turns out to be already fixed, mark it resolved with the migration or PR that closed it — do not silently drop the row.

## Step 6 — Report to Mason (compact)

- one-paragraph verdict (is this area solid enough to build on?);
- counts by severity;
- whether the deterministic gate settled;
- the report path;
- the single recommended next step.

Offer `/codex-review` for any BLOCKER/HIGH before Mason acts — Codex is the independent model; the in-workflow skeptics are same-model and only reduce false positives.

## Hard rules

- **Read-only.** No `apply_migration`, no deploy, no `git commit`, no data mutation. Confirmed findings are a **parked punch list**, not a work order.
- **Live evidence, freshly collected.** Never fill the packet from a prior session, a handoff doc, or memory.
- **Never override the deterministic gate.**
- **Baseline drift against the merge-base of `origin/main`..`HEAD`**, never a two-dot diff against the checkout — that reports every migration `main` added since the fork as a false deletion.
- **Cite or cut.** A citation names a file:line, migration filename, constraint, or RPC. `"unknown"` is not a citation.
- **One report per section, per run.** If a section is re-run (a second evidence packet, a fix landed mid-session), update that section's existing dated report rather than writing a second file for the same date — two reports for one section leave the next session unable to tell which is current.

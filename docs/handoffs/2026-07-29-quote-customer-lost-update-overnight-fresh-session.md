# Quote and Customer Lost-Update Protection — Overnight Fresh-Session Handoff

> **SUPERSEDED — HISTORICAL RECORD, NOT AN ACTIVE HANDOFF.** Written 2026-07-29; the work it
> describes landed in PR #290. Recovered to the repository on 2026-09-01 from the unmerged branch
> `claude/rescue-unique-docs-20260807`, which held the only copy. Preserved verbatim as history.
> **Do not execute the instructions below** — they describe a task that is already complete, and
> the surrounding code has moved substantially since. See
> `docs/audits/2026-09-01-no-pr-branch-disposition-plan.md` for why this was rescued.

## WHERE

- Repository: `https://github.com/masonwells1/CRX_Manager_V1.0`
- Shared checkout: `C:\CRX_Manager`
- Verified `origin/main`: `e83aed903cb6cd8f16935faab4b87d352544ff83`
- Production: `https://croprxsolutions.app`
- Supabase project: `rhyzpcqhnizqbxphqdkr` (`CRX-DATABASE`, PostgreSQL 17.6)
- Do not develop in `C:\CRX_Manager`; it contains unrelated untracked handoff
  and memory documents.
- Recommended new worktree:
  `C:\Users\mason\.codex\worktrees\quote-customer-lost-update-20260729\CRX_Manager`
- Recommended branch: `codex/quote-customer-lost-update-20260729`

Occupied lanes observed before this handoff:

- A new clean detached Codex worktree at
  `C:\Users\mason\.codex\worktrees\ec38\CRX_Manager`, believed to be the
  vendor-bill accounting-period race session.
- PR #284 / `claude/fix-phase3-prover-paths-20260729`
- PR #286 / `claude/product-name-vs-return-policy-detector-20260729`
- Draft PR #287 /
  `codex/supplier-pricing-operational-completion-20260729`
- Claude-memory backup work on
  `claude/claude-memory-ignore-and-offsite-20260729`

This lane owns only Quote/Customer stale-save behavior. Do not touch Supplier
Pricing, Product return-policy/classification, Section 9/AP/accounting-period
functions or proof assets, Claude-memory backup files, `docs/CHANGELOG.md`,
schema registry/generated types, or shared workflow tooling.

## GOAL

Prevent an older Quote or Customer browser tab from silently overwriting newer
saved fields while preserving the already-live commission-split concurrency
guard.

Definition of done:

1. reproduce the current two-tab overwrite for representative non-split fields;
2. choose and document a fail-closed whole-record version contract;
3. protect existing-row `save_quote` and `save_customer` operations without
   weakening idempotency, ownership, role, lifecycle, math, address, section,
   planned-hold, or commission-split behavior;
4. show a clear operator conflict message that requires reload/review rather
   than silently merging or discarding either tab;
5. prove authenticated desktop and phone-width Quote and Customer flows;
6. freeze an exact commit, obtain clean independent reviews, and stop before
   any live migration, push, merge, or deployment.

The safe default is fail closed: never auto-merge a stale whole-record save.
If exact version semantics or operator conflict UX requires a material product
choice, finish the proof/design and stop at `READY FOR MASON APPROVAL`.

## PROVEN

- `origin/main` was fetched and current at
  `e83aed903cb6cd8f16935faab4b87d352544ff83`.
- Current-main build passed on 2026-07-29.
- Canonical tracker:
  `docs/manual/KNOWN_ISSUES.md`, section
  `Whole-record lost-update class on quote/customer saves`.
- Live read-only Supabase evidence on 2026-07-29:
  - 4 active, non-deleted quotes;
  - 150 active customers;
  - exactly one live `save_quote` overload and one live `save_customer`
    overload were returned by the catalog query;
  - both live functions lock the current row;
  - both contain the existing commission-split expected-value guard;
  - neither contains an `expected_updated_at`, row-version, or lock-version
    whole-record guard;
  - both write `updated_at = now()`.
- Live function fingerprints:
  - `save_quote`:
    `338d5fa7ebff2db27eab241debc18cf8`
  - `save_customer`:
    `a420a6e31dba4a13ef9ba5c5f8948ff`
- Current source agrees with live behavior:
  - `src/pages/QuoteBuilder.tsx` sends the complete quote/section payload but no
    expected record version;
  - `src/pages/CustomerDetail.tsx` sends the complete customer/address payload
    but no expected record version;
  - both clients advance only their commission-split baseline after a
    successful save.
- Latest forward migration defining both functions:
  `supabase/migrations/20260722202622_commission_split_lost_update_guard.sql`.
  It protects the money-bearing split field but intentionally leaves the
  general whole-record lost-update class open.
- Graphify was current at commit `e83aed90`. Exact query:
  `graphify query "what connects QuoteBuilder and CustomerDetail whole-record saves to save_quote and save_customer, including stale-tab concurrency?" --budget 1400`.
  It connected `QuoteBuilder.tsx`, `CustomerDetail.tsx`, `save_quote`, and
  `save_customer`; current source and live catalog evidence above are
  authoritative.
- No open PR currently changes `src/pages/QuoteBuilder.tsx`,
  `src/pages/CustomerDetail.tsx`, `save_quote`, or `save_customer`.
- Current Supabase breaking-change notices do not change PostgreSQL optimistic
  concurrency semantics. This project is already on PostgreSQL 17.

## WRITTEN, NOT PROVEN

Nothing. No source, migration, test, or live state was changed while preparing
this handoff.

## NOT STARTED

- Fresh named worktree/branch creation.
- Literal Opus design advice on the version token and conflict UX.
- Current-state two-tab reproduction.
- Exact payload/version contract.
- New forward-only migration.
- QuoteBuilder or CustomerDetail changes.
- Focused unit, browser, disposable-database, and two-session concurrency proof.
- Exact-SHA reviews, push, pull request, live migration, deployment, or merge.

## APPROVAL STATE

Mason asked for another independent overnight task. Starting a fresh session
from this handoff authorizes ordinary reversible local investigation, edits,
tests, worktree creation, and local commits within this scope.

This handoff does not carry permission to:

- apply a live migration or mutate production data;
- push, merge, or deploy;
- change secrets, authentication, permissions, or feature flags;
- delete data;
- force-push or bypass hooks.

Mason separately confirmed that
`supplier_cost_basis_enabled=false` must remain OFF. This lane must not touch
that flag or Supplier Pricing.

## GATES AND BLOCKERS

- Read `AGENTS.md`, `docs/workflows/SAFE_DEVELOPMENT_RULES.md`,
  `docs/reference/gotchas.md`, and the canonical known-issue section before
  editing.
- Fetch `origin/main`, inspect active worktrees/open PRs, and refresh Graphify
  before broad source reading.
- Use literal `claude-opus-5 --effort high` through the repository review path
  as the pre-edit design advisor. Ask it specifically to compare:
  - `updated_at` as an optimistic version token;
  - a dedicated monotonic version column;
  - expected whole-record snapshots;
  - compatibility with existing idempotent replay and commission-split guards.
- Verify live function definitions and fingerprints read-only before design and
  again before freezing the final packet.
- Never edit the applied
  `20260722202622_commission_split_lost_update_guard.sql`. Any database
  correction must be a new forward-only migration created through the governed
  migration workflow.
- Keep the public RPC signatures deliberate. Do not accidentally create
  overloads or weaken grants/search paths/authentication.
- Do not touch generated schema registry or TypeScript database types in this
  parallel lane. Record any needed regeneration as a post-apply sequencing
  step.
- Use exactly one fresh GPT-5.6 Terra as sole writer for each correction.
- After freezing an immutable exact commit, use a fresh read-only GPT-5.6 Luna,
  a separate fresh read-only GPT-5.6 Sol adversarial review, and final literal
  Opus review on that exact SHA.
- Required proof:
  - stale Quote tab is rejected and the newer values remain;
  - stale Customer tab is rejected and the newer values remain;
  - current-tab save succeeds;
  - new Quote/Customer creation still succeeds;
  - idempotent replay returns the original outcome;
  - commission-split expected-value conflicts still fail closed;
  - quote sections/items, customer addresses, ownership/role gates, quote
    lifecycle, planned holds, and server-authoritative quote math do not regress;
  - authenticated desktop and phone-width conflict UX is visible and console
    clean;
  - typecheck, focused tests, full tests, build, registered smoke/invariant
    checks, and rollback-only database proof pass.
- No live write is needed to prove this lane. Use mocks and disposable or
  rollback-only database fixtures.
- Vercel was account-quota-blocked on 2026-07-29 after more than 100 daily
  deployments. Treat it as an external gate if still active; do not distort
  code to clear it.
- Stop at `READY FOR MASON APPROVAL`; do not apply, push, merge, or deploy.

## FIRST ACTION

Re-fetch `origin/main`, verify the accounting-period session's final worktree
path and changed-file footprint, then create the recommended clean worktree.
Refresh Graphify and run literal Opus as the design advisor before assigning
any writer. The first proof should reproduce an actual stale non-split field
overwrite in a disposable database or controlled authenticated mock for both
Quote and Customer saves.

## Paste-ready fresh-session kickoff

Use GPT-5.6 Sol at high reasoning as the root orchestrator. Read and execute the
verified handoff at:

`C:\CRX_Manager\docs\handoffs\2026-07-29-quote-customer-lost-update-overnight-fresh-session.md`

Run hands-free through reversible work. Keep the root read-only; route each
correction to exactly one fresh GPT-5.6 Terra sole writer, then freeze an exact
commit and obtain fresh read-only GPT-5.6 Luna, separate GPT-5.6 Sol
adversarial, and literal `claude-opus-5 --effort high` review. Work in a fresh
isolated worktree from current `origin/main`. Preserve the existing
commission-split concurrency guard and all Quote/Customer business behavior.
Do not touch Supplier Pricing, the still-OFF supplier cost-basis flag,
Section 9/AP/accounting-period work, active Phase 3 PR files, generated schema
artifacts, or unrelated worktrees. Do not apply a migration, mutate live data,
push, merge, deploy, change flags/permissions/secrets, delete, or force-push.
Finish all safe proof and stop at `READY FOR MASON APPROVAL`.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.

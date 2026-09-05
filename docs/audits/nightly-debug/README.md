# CRX Nightly Debug Mission

An autonomous, **looping** end-to-end debugging mission for CRX Manager. It hunts the
*silent / latent* bug classes (wrong-but-doesn't-throw logic, drift, untested role/state
paths) that don't show up as Sentry crashes, and **safely fixes what it can** while Mason
sleeps — without ever touching production.

Started: 2026-06-15 ~22:50 America/Chicago · Branch: `claude/priceless-austin-0d3ccd`

## What it checks (4 pillars)

1. **Deep code + live-DB audit** (read-only) — sales pipeline first (quote→order→delivery
   →invoice→payment), then the whole app: RLS/security, migration drift, money correctness,
   RPC idempotency/actor-forgery, business-lifecycle invariants, types drift, edge functions,
   PDFs, docs, deps. Reuses the proven `whole-codebase-audit` dimensions + adversarial verify.
2. **Static health** — `typecheck`, `lint`, `build`, unit tests (`vitest`), `db-sweeps`,
   `check-doc-drift`.
3. **Runtime crawl** — drives every page in a headless browser as **admin / sales_rep /
   driver**, capturing console errors, blank renders, and failed network calls. **STAGING-ONLY
   (Codex P1):** the crawl is NOT read-only against prod — pages run maintenance RPCs on mount
   (Dashboard releases expired quote holds; "new" pages reserve numbers) — so it **refuses to run
   when `VITE_SUPABASE_URL` points at the prod project**. Point it at a staging/disposable DB and
   add E2E creds to enable it.
4. **Cross-model verification** — risky fixes get a Codex cross-review before they're trusted.

## The safety model — 3 tiers (NEVER touches prod)

| Tier | What | Overnight action |
|---|---|---|
| 🟢 Green | Frontend-only (`src/`), tests, docs — reversible, no DB/RLS/money-logic change | **Auto-fix** → verify (typecheck/build/test) → commit to **this branch only** |
| 🟡 Yellow | Migration / RPC / edge-fn / RLS / money-logic | **Draft + validate** (rolled-back txn vs live, zero prod footprint) + Codex note → **park** for Mason's morning OK |
| 🔴 Red | Push to `main`, deploy, live-migration apply, prod data mutation/delete | **Never autonomous** — always waits for Mason |

This honors the AGENTS.md CRX Hard Rules: no push / deploy / live migration / data delete /
unrelated-file commit without Mason's explicit OK in chat. Nothing prod-facing happens while
he's asleep — he wakes to a branch of verified safe fixes + a stack of prepared, proven
risky fixes awaiting approval.

## The loop (one cycle)

1. Read `LEDGER.json` (everything seen/fixed/parked so far).
2. Static checks (Bash) → capture failures.
3. Runtime crawl (Bash, if creds present) → per-route console errors.
4. Deep audit (Workflow, read-only) → adversarially-verified findings.
5. Merge + **dedupe vs ledger** + tier (green/yellow/red).
6. Apply **Green** fixes (edit → verify → commit each).
7. Draft **Yellow** fixes (write + rolled-back-validate + Codex note → park).
8. Update `LEDGER.json` + append to `REPORT.md`.
9. Schedule next cycle. **Stop after 3 consecutive dry cycles**, on morning, or when Mason says stop.

## State files

- `LEDGER.json` — every finding ever seen, with dedupe key, tier, status, cycle history.
- `REPORT.md` — the human-readable running report Mason reads in the morning.
- `accepted-findings.json` — allowlist of known-accepted findings so advisor/lint noise is
  filtered and only *new* issues surface.

## How to stop it

Just tell Claude "stop the nightly mission." (Or it self-stops at 3 dry cycles / morning.)
Nothing it did needs rolling back — everything is local commits on a non-prod branch.

## How to read the results in the morning

Open `REPORT.md`. It lists, per cycle: what was found, what was auto-fixed (Green, already
committed + verified), and what's **parked for your approval** (Yellow — with the plain-English
explanation and the validation proof). Approve the Yellow items you want and I'll ship them
through `/ship` the normal way.

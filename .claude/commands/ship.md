Drive a coding job from "implement" all the way to "reviewed, committed, and shipped" — hands-off through the review-and-fix gate, pausing only at the human gates Mason requires: **a live migration apply in an interactive session** (hands-free runs he pre-authorized with armed autopilot may apply via the proof gate — see the autonomy boundary), **any edge-function deploy**, and **any data deletion**. Regular, reversible code that has passed the full green pipeline lands on `main` via branch → PR → freeze a green candidate → apply `ready-for-coderabbit` → resolve one CodeRabbit review → merge the reviewed head under Mason's standing 2026-06-16 authorization (review automation updated 2026-09-02; see Step 8). The independent Codex cross-review now runs automatically via the headless `codex` CLI when the change warrants it (it's a read-only gate, like the reviewer subagents) — no copy-paste. This is the autonomous "work till completion" pipeline; it orchestrates the existing subagents, workflows, and hooks rather than reinventing them.

**The job** is everything after `/ship` (e.g. `/ship add a CSV export button to the AR aging report`). If no job text was given, ask Mason what the job is, then proceed.

Autonomy boundary (Mason's standing choices — do not exceed without asking):
- **Migrations:** in an ordinary interactive session, NEVER apply a migration to the live DB without Mason's explicit approval in the current conversation. Settled exception (Mason, 2026-07-13): in a pre-authorized hands-free run — Mason explicitly asked for the run AND autopilot is armed (`node .claude/hooks/autopilot-arm.mjs --hours N`) — a migration may apply without a per-migration in-chat OK once the hard proof gate passes (fresh same-session apply-guard proof + Codex verdict for SQL/RLS/money changes). Migrations that DELETE/TRUNCATE business rows or DROP data-bearing tables/columns are NEVER autonomous, armed or not.
- **Edge functions:** NEVER deploy an edge function without Mason's explicit approval.
- **Prod landing:** regular, reversible code MAY land on `main` without a fresh **in-chat** approval once the full pipeline is green — every required check must pass, any review actually delivered must be clean, and the pre-push typecheck/build must succeed (Mason's standing policy, 2026-06-16; review automation updated 2026-09-02). An approving GitHub review is **NOT** required: Mason removed `required_pull_request_reviews` from `main` on 2026-09-02, so CI is the merge gate. A `CHANGES_REQUESTED` verdict still blocks, and both agent merge gates refuse to merge over one. Since 2026-07-14 the GitHub `protect-main` ruleset makes direct pushes to `main` impossible for everyone — landing means **push the branch → open a PR → finish implementation and required checks → freeze the candidate → apply `ready-for-coderabbit` → resolve CodeRabbit's review → merge with `--match-head-commit <reviewed-head-sha>`**. Automatic CodeRabbit reviews are disabled so they do not overlap implementation or Codex review. The trusted final-review workflow posts exactly `@coderabbitai review` once only after rechecking the frozen head, required/reported checks, draft/conflict state, auto-merge OFF, and the label actor's write permission. If a finding or base update creates a new commit, the workflow clears its labels; restart required checks, rerun the exact-HEAD Codex proof when the corrected diff is Codex-worthy, freeze and record the new SHA, then apply the ready label again for one follow-up incremental review. Never use `@coderabbitai resume`, and reserve `@coderabbitai full review` for a deliberately justified complete reread. A merge to `main` deploys croprxsolutions.app via Vercel, with one-click rollback as the safety net. The standing authorization NEVER covers: force-pushes, landings that skipped any part of the green pipeline, migrations, edge-function deploys, data deletion, or changes to secrets, auth, permissions, billing, or customer-visible production state beyond what the reviewed push itself changes — those always stop for Mason's explicit OK in the current conversation.

## Step 0 — Set up a branch

Never work on `main`. Check the branch and create a feature branch if needed:

```bash
git branch --show-current
```

If on `main`, create one: `git checkout -b ship/<short-slug>`. Tell Mason the branch name. (Re-verify the branch right before any commit — a commit has landed on main before.)

## Step 0.5 — Size the work, then plan (cheap; prevents the #1 bug)

**Size it first** (Anthropic: most coding is single-agent work — don't pay the ~15× multi-agent review cost on a tiny change):
- **Trivial** — one file, no SQL / money / RLS / lifecycle (a copy tweak, a style fix, a prop rename): SKIP the review fan-out (Step 3) and the migration gate. Just make the change, run Step 2 (lint + build + test) and Step 2.5, then go to Step 7. Tell Mason in one line you're taking the light path.
- **Substantial** — multiple files, OR touches SQL / money / RLS / a lifecycle / an RPC: run the full pipeline below.

**For substantial work, plan before coding** — this is where Mason (a non-coder) has the most power, because he can read English even though he can't read code:
1. Read the live schema / existing code for the area (don't trust memory).
2. Write a short plain-English plan: what you'll build, the assumptions you're making, and the 2–4 files you'll touch.
3. Show it to Mason and let him confirm or correct **before** you write code. A wrong understanding caught here costs one message; caught after coding costs a whole rebuild. (Skip the confirmation only for genuinely mechanical multi-file changes.)

## Step 1 — Implement the job to completion

Do the work (you've already sized + planned it in Step 0.5). For a non-trivial feature, use the relevant scaffold skill (`/new-page`, `/new-rpc`, `/create-migration`) — those encode the correct patterns. Your PreToolUse hooks (sql-safety, money-safety, idempotency-body-check, rls-on-new-tables, status-enum-check, generated-column-check, env-guard) will refuse a bad write as you go — treat any hook block as a real defect to fix, not an obstacle to route around.

Finish the whole job before moving on. Partial implementations do not enter the gate.

## Step 2 — Verify (local toolchain)

```bash
npm run typecheck
npm run lint
npm run build
npm run test
npm run test:agent-workflows
```

If `package.json` or `package-lock.json` changed, also run:

```bash
node scripts/verify-deps.mjs
```

Capture pass/fail for each. Any failure → fix it now and re-run before continuing. Do not enter the review gate on a red build.

## Step 2.5 — Prove it actually runs (behavioral verification — closes the #1 bug)

Green unit tests and a clean build do NOT prove the change does the right thing — a suite you wrote yourself can encode the same misunderstanding as the bug. Before the change counts as working:
- **UI change** → open it in the running app (preview tools), click the actual flow a user would, and confirm the real result (screenshot for Mason if it's visual). Check the console/network for errors.
- **RPC / DB-touching change** (even without a new migration) → exercise the real function against the live schema in a rolled-back transaction (`scripts/smoke/` — see Step 5.4 for the chain protocol) so a wrong column / bad cast / unchecked error surfaces here, not in production.
- **Data read** → confirm the query returns the real shape (prefer the typed Supabase client; never trust a `.select('*')` + cast to be reading the column you think it is).

If you genuinely can't run it, say so explicitly in the summary rather than reporting it "done."

## Step 3 — Review fan-out (parallel, scoped to what changed)

Detect what changed (`git diff --name-only HEAD` + `git status --short`) and dispatch ONLY the relevant reviewers — **all in a single message so they run concurrently:**

| If this changed | Dispatch |
|---|---|
| Any `supabase/migrations/*.sql` | `rls-security-reviewer` + `migration-drift-reviewer` |
| `src/types/index.ts` OR a migration | `typescript-types-drift-reviewer` |
| Any `src/` file importing `jspdf` / `jspdf-autotable` | `pdf-output-reviewer` |
| Any `src/`, `supabase/functions/`, or migration change (always) | `compliance-reviewer` |
| Workflow / lifecycle / page↔RPC logic touched | run the `/review-workflow` workflow (4 layers + adversarial verify) |

Pass each reviewer the list of changed files. Wait for all reports.

## Step 4 — Auto-fix loop (the "till completion" engine)

For every **confirmed** BLOCKER or HIGH finding (the workflows already adversarially verify theirs; for subagent findings, confirm the finding is real by reading the cited line before acting):

1. Fix it.
2. Re-run Step 2 (verify) and re-dispatch the reviewers whose scope you touched (Step 3).
3. Repeat until: reviewers return **clean** (or BLOCKER/HIGH all fixed) AND build + tests are green.

MED/LOW findings: fix the cheap ones; list the rest in the final summary as accepted/deferred — do not loop on them. **Hard loop cap: max 3 fix→re-review rounds.** If the SAME finding survives two rounds in a row, or you reach round 3 with anything still open, STOP and hand it to Mason with both positions — do not keep thrashing or burn rounds on a finding you can't resolve.

## Step 5 — If a migration is involved: prepare the live-apply gate

Only after Step 4 is clean for the migration:

1. **Stamp the apply-guard proof with the sanctioned wrapper** (never hand-write the JSON — the wrapper computes the guard's slug rule, the timestamp, and the content-binding `queryHash` from the on-disk file):
   ```
   node scripts/write-apply-proofs.mjs <mig-name-without-.sql>
   ```
   If the migration is edited after stamping, the hash no longer matches and the guard blocks again (content changed = stale review) — re-run the Step 3 reviewers, then re-stamp.
2. Get Mason's authorization — one of two paths (settled 2026-07-13 policy):
   - **Interactive session (default):** STOP and ask Mason for explicit approval to apply the named migration to the live Supabase DB. Do not continue without that approval in the current conversation.
   - **Pre-authorized hands-free run** (Mason explicitly asked for the run AND autopilot is armed — an unexpired `AUTOPILOT.on` flag): no per-migration ask. Instead, the Codex gate is MANDATORY: run `node scripts/write-apply-proofs.mjs <mig-name>` — it runs the trusted Codex CLI itself on this migration and mints the content-bound Codex proof (`codex-review-mig-<safe-name>.json`) ONLY on a CLEAN machine verdict; a BLOCKERS or failed run mints nothing and does NOT qualify. Hand-writing that proof is blocked by review-proof-guard, by design. The apply-guard hard-refuses hands-free applies missing any proof, hard-refuses DESTRUCTIVE migrations (data deletes, schema/table/column/type drops, MERGE) outright, and — if the arming EXPIRES mid-run — parks ALL further applies until Mason returns. Park anything refused; never edit or rewrite the flag to get past a block.
3. **Only after that authorization:** apply via Supabase MCP `apply_migration`.
4. **Smoke-chain test (hard rule — chains, not probes):** EVERY RPC the migration creates or modifies must pass its full business-chain spec from `scripts/smoke/smoke-specs.json`. For each touched RPC run `node scripts/smoke/run-smoke.mjs --spec <rpc>`:
   - Runner exits 2 with "no spec covers" → **write or extend a chain first** (per `scripts/smoke/README.md` — investigate live catalog, house conventions, register in `smoke-specs.json`). This is a gate, not a suggestion.
   - Execute each printed chain as ONE statement via MCP `execute_sql`. PASS = the error text contains `SMOKE_PASS_ROLLBACK` (proves nothing persisted). Any other error, or no error → FAIL: fix it, then **re-run the FULL chain — never just the failing step** (clean reviewers + md5 fidelity have missed latently-broken prod RPCs before; an isolated statement probe is never evidence of a fix).
5. **B7 ledger reconciliation:** read the newly applied ledger row's `version` and `name`, then normalize the live name and disk basename using the same convention as `.claude/hooks/migration-ordering-lib.mjs`. If the normalized live `name` already matches the authored disk basename, keep the disk filename and record both live fields in migration history — a different apply-time `version` alone is not a rename reason. Rename the disk file to the MCP-assigned version only when the live `name` does not preserve the authored basename, so disk and ledger would otherwise remain unmatched.
6. **Regen the schema registry** (`/regen-schema-registry` via MCP introspection) if the migration added a status enum, generated column, or table — otherwise the hooks run on stale data.
7. **Run the db-invariant sweeps (post-apply gate):** `npm run db-sweeps` prints each predicate's SQL — execute every block read-only via MCP `execute_sql` and compare returned `violation_key`s against `scripts/db-invariant-sweeps/allowlist.json`. **Any unallowlisted violation BLOCKS the ship** — fix it (or report it as a finding); NEVER allowlist a real hole to get green.

If the migration touches a CHECK constraint, function with an existing name, or an existing table, that is exactly what the two reviewers in Step 3 are for — do not skip them.

## Step 6 — Codex gate (automated cross-review)

Decide if the change is **Codex-worthy**: it touches a migration, RLS/RPC security, a money path, or an Edge Function. (A pure CSS/copy/layout change is NOT worthy — note that and skip to Step 7.)

If worthy, run a **separate Codex review pinned to `gpt-5.6-sol` at high effort directly via the
headless CLI** — invoke `/codex-review` (scope `--base origin/main`, after `git fetch origin`, so a
stale local `main` can't distort the diff). It runs `codex review` non-interactively, captures
findings to `.claude/session-state/codex-review-latest.txt`, and returns a verdict
(SHIP / SHIP-WITH-FOLLOWUPS / NEEDS-WORK). No paste loop.

Then act on the result like any other reviewer:
- **BLOCKER / HIGH** → feed back into the Step 4 auto-fix loop (read the cited line, confirm it's real, fix, re-verify, re-dispatch the scoped subagents), then **re-run `/codex-review` until the verdict is SHIP or SHIP-WITH-FOLLOWUPS**. If the active session genuinely disagrees with a Codex BLOCKER, do NOT silently override — surface both positions to Mason and stop.
- **MED / LOW / NIT** → fix the cheap ones; list the rest as deferred in the Step 8 summary. Don't loop on them.
- Optionally write a disposition doc `docs/audits/<date>-claude-disposition-of-codex-<slug>.md` if the batch warrants a tracked record.

**Fallback (CLI unavailable):** if `/codex-review` Step 0 can't resolve `codex.exe` or auth is broken, fall back to the manual packet — run `/codex-cross-review` to draft `docs/audits/<date>-codex-<slug>-prompt.md`, then STOP and ask Mason to run Codex + paste the reply. Don't self-certify the gate when it couldn't run (the "required safety gate unavailable → hand off" rule).

This gate runs the Codex *review* automatically; it never pushes or merges by itself — the landing happens at Step 8 (automatic once the pipeline is green).

## Step 7 — Docs + commit (on the branch)

Update the docs the change touched: `docs/reference/migration-history.md`, `rpc-functions.md`, `pages-routes.md`, `database-schema.md`, a NEW `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` entry, and the relevant workflow doc as applicable. Write the changelog entry as its own file rather than appending to `docs/CHANGELOG.md`: that file is 15k+ lines and every parallel session lands in it, so appending is what makes concurrent shipping collide. Do not add volatile counts to AGENTS.md or CLAUDE.md.

Before committing, run `node scripts/check-doc-drift.mjs` — fix any drift it reports (stale counts, missing migration-history rows) rather than committing around it.

Immediately inspect repository and branch state with `git status --short --branch` and `git branch --show-current`, then commit **on the branch** with a clear message. The fast husky pre-commit hook runs private-artifact containment, staged SQL/frontend checks, conditional agent-parity/dependency checks, and the ledger guard (2026-07-13); lint/typecheck/build/tests already ran above and remain enforced at pre-push/CI rather than repeating at commit. A commit staging agent-surface files (`.claude/{commands,skills,hooks,workflows,agents}/`, `.claude/settings.json`, `AGENTS.md`, `CLAUDE.md`, `.husky/`, guard scripts) must also stage a ledger update in the same commit — a new `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` entry (preferred), or `docs/CHANGELOG.md`, a `docs/manual/*.md`, `docs/reference/agent-guardrails.md`, or a `docs/loops/` ledger. Step 7's changelog.d entry normally satisfies this. The entry must be ADDED by this commit and must actually describe the change: modifying, renaming, or emptying an existing entry does not count, and neither does a bare date heading. If the hook rejects, fix and retry (never `--no-verify`).

## Step 8 — The production decision

Once Step 4 is clean and Step 2/2.5 are green, present the branch, commit, verification evidence, migration/deploy state, and the exact production action. Then:

- **Regular, reversible code only** (no live migration in this job, no Edge Function deploy, no data deletion, every gate ran and came back green — including the Codex verdict when the change was Codex-worthy): land under Mason's standing authorization (2026-06-16, review automation updated 2026-09-02) — `git push -u origin <branch>` → `gh pr create` → keep auto-merge off while implementation and checks are still moving → if GitHub reports the branch behind, run `gh pr update-branch <n>` and wait for checks again → freeze the green candidate and record its head SHA → apply `ready-for-coderabbit` → let the default-branch workflow post exactly `@coderabbitai review` once → read and resolve CodeRabbit's incremental review. The workflow removes the ready label without commenting if any gate is not clear; fix the named blocker and relabel. If a fix or base update creates a new commit, the workflow clears both state labels and deletes the already-posted command whether or not the head moved (only Actions-authored canonical commands; human comments are left alone); restart required checks, rerun the exact-HEAD Codex proof when the corrected diff is Codex-worthy, freeze and record the new SHA, then apply the ready label again for one follow-up review. Immediately before merge, verify real enforcement with the PR's live `mergeStateStatus` and check rollup; do not infer mergeability from the known-stale protection sub-resource. An approving review is **NOT** required — Mason removed `required_pull_request_reviews` on 2026-09-02 — but `CHANGES_REQUESTED` still blocks and both agent merge gates refuse to merge over one. `enforce_admins` is off, so do NOT require administrator enforcement — that check would block every otherwise-ready landing — and no agent may act on that exemption. Confirm CodeRabbit actually reviewed the frozen candidate; when it HAS approved, require the gate marker SHA, that authenticated `APPROVED` review's `commit_id`, and the final `headRefOid` to be identical; recheck every reported check and auto-merge OFF. The generic Actions marker is dedupe evidence, not an independent security identity. **Also read the Codex GitHub App's review** — it reviews every PR automatically and re-reviews on essentially every push, and nothing in this repo read it before 2026-09-02. Run `gh pr view <n> --comments` and act on anything from `chatgpt-codex-connector`: fix real issues, or reply with a one-line reason and resolve the thread. Both merge gates deny when the App has an UNRESOLVED comment on the exact head being merged, so an unread finding will stop the merge — read it during the review pass, not at the gate. Run `gh pr merge <n> --squash --delete-branch --match-head-commit <that-exact-sha>` → verify the deploy and report the evidence explicitly. Do not use `@coderabbitai resume`; it restarts automatic review. Do not ask for a fresh in-chat yes — the green pipeline and the resolved exact-head CodeRabbit review are the authorization for this class of change. Direct pushes to `main` are impossible.
- **Anything else** (a live migration was part of the job, an Edge Function deploy is proposed, data would be deleted, or any required gate ran degraded/unavailable): stop and ask Mason for explicit approval of that specific action. Do not treat the push authorization — or any older approval — as covering these. (Exception: a live migration inside a pre-authorized hands-free run with autopilot armed follows the 2026-07-13 policy in the autonomy boundary — proof gate instead of a per-migration ask; destructive migrations still stop.)

```
═══════════════════════════════════════════════════
  SHIP — <job>   (<YYYY-MM-DD HH:MM>)
═══════════════════════════════════════════════════
Branch:   <branch>
Changed:  <N migrations, N TS, N docs>

Review gate:
  rls-security:        <clean / fixed N / n-a>
  migration-drift:     <...>
  types-drift:         <...>
  pdf-output:          <...>
  compliance:          <...>
  /review-workflow:    <verdict / n-a>

Verify:   typecheck ✓  lint ✓  build ✓  tests X/Y
Migration: <applied live + smoke-tested / none>
Codex:    <verdict: SHIP / SHIP-WITH-FOLLOWUPS after N fixes / not worthy / CLI down → packet pending>
Deferred: <MED/LOW items accepted, if any>

─── <MERGED via PR (standing landing policy) | READY — WAITING ON MASON> ───
  Production action: <exact command/action taken or proposed>
  <For gated actions: Waiting for Mason's explicit approval in this conversation.>
```

For gated actions, after Mason explicitly approves, perform only the approved action, inspect the result, and report the production evidence. A push approval does not also approve a migration or Edge Function deploy — each gated action needs its own yes.

## Hard Rules
- NEVER push work that has not passed the FULL green pipeline. Pushes of regular reversible code after a fully green pipeline are covered by Mason's standing 2026-06-16 authorization — report every push explicitly, never silently. Force-pushes always require Mason's explicit approval.
- NEVER apply a migration without Mason's explicit approval in the current conversation, the two reviewers clean, and the proof file written (the guard enforces this; don't try to route around it). Interactive sessions only ever apply with the in-chat yes; a pre-authorized armed hands-free run follows the 2026-07-13 proof gate instead (see the autonomy boundary and the last Hard Rule).
- NEVER report the gate "clean" while any confirmed BLOCKER/HIGH is open, even if lint/build/test pass.
- NEVER skip the review fan-out to "save time" — it is the entire point of `/ship`.
- NEVER `--no-verify`, `@ts-ignore`, or `any` (except `reportPdf.ts` columnStyles).
- Auto-deploying an Edge Function and deleting data are never covered by any standing authorization — those always wait for Mason's explicit yes. A live migration apply waits for his in-chat yes in interactive sessions; only a pre-authorized hands-free run (autopilot armed) may apply via the proof gate, and destructive migrations stop even then.
- If a required safety gate is unavailable (e.g. a reviewer can't run), STOP and hand off — do not self-certify. (Mason's prod-gate-discipline rule.)

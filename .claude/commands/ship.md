Drive a coding job from "implement" all the way to "reviewed, committed, and shipped" — hands-off through the review-and-fix gate and the landing itself, pausing only at the human gates Mason keeps — the full list is in `AGENTS.md` › Safety and Protected Delivery. The ones this pipeline meets most often: **a destructive migration** (DELETE/TRUNCATE of business rows, DROP of data-bearing tables/columns), **any edge-function deploy**, and **any data deletion**. Under Mason's autonomous-landing rule (2026-09-26), every other change lands by itself: branch → PR → green checks → `ready-for-coderabbit` → CodeRabbit APPROVED on the frozen head → exact-SHA Sol review run LAST → live apply of its non-destructive migration, if any → exact-head merge (see Step 8). The independent Codex cross-review runs automatically via the headless `codex` CLI (it's a read-only gate, like the reviewer subagents) — no copy-paste. This is the autonomous "work till completion" pipeline; it orchestrates the existing subagents, workflows, and hooks rather than reinventing them.

**The job** is everything after `/ship` (e.g. `/ship add a CSV export button to the AR aging report`). If no job text was given, ask Mason what the job is, then proceed.

Autonomy boundary (Mason's standing choices — do not exceed without asking):
- **Migrations (Mason's autonomous-landing rule, 2026-09-26):** a NON-destructive migration is applied live by the agent, in any session, armed or not, once (1) CodeRabbit APPROVED the frozen final head that carries it, (2) the exact-SHA Sol review of that head is clean, and (3) the migration-apply-guard proof gate passes — both reviewer proofs and a fresh content-bound Sol proof from `node scripts/write-apply-proofs.mjs`, each under 30 minutes. No per-migration ask. A migration that DELETEs/TRUNCATEs business rows or DROPs data-bearing tables/columns is Mason's: the guard refuses it for agents in every session; park it and ask. Only after his in-chat yes, and only in an unarmed session, re-run `scripts/apply-migration-file.mjs <file> --confirm --mason-approved-destructive` (every proof still required).
- **Edge functions:** NEVER deploy an edge function without Mason's explicit approval.
- **Prod landing (Mason's autonomous-landing rule, 2026-09-26; supersedes the 2026-06-16 push policy's limits and the 2026-09-02 "CI is the merge gate" wording):** the agent merges by itself, with no in-chat ask, once CodeRabbit has APPROVED the frozen final head, a fresh exact-SHA `gpt-6-sol` high review of that head is clean, and every required check is green. Both merge gates enforce all three: CodeRabbit's latest verdict must be APPROVED on the exact `headRefOid`, the newest run of every reported check must be green with `mergeStateStatus` CLEAN, and the Sol proof must be bound to that head and GitHub's real base. `CHANGES_REQUESTED`, `--auto` and `--admin` are refused. Since 2026-07-14 the GitHub `protect-main` ruleset makes direct pushes to `main` impossible for everyone — landing means **push the branch → open a PR → finish implementation and required checks → freeze the candidate → apply `ready-for-coderabbit` → CodeRabbit APPROVED → Sol LAST → apply the non-destructive migration, if any → merge with `--match-head-commit <reviewed-head-sha>`**. Automatic CodeRabbit reviews are disabled so they do not overlap implementation or Codex review. The trusted final-review workflow waits out running checks, adds the separate `coderabbit-review-dispatch` provider label only after rechecking the frozen head, required/reported checks, draft/conflict state, auto-merge OFF, and the label actor's write permission, waits for an actual formal review of that commit, and then releases the provider label. Dispatch or a skipped status is not success. See `docs/reference/coderabbit-native-review.md`. **A fix goes on the SAME PR:** push it; the trusted synchronize run resets the labels and records the new candidate epoch; wait for checks, relabel, and the new head earns one follow-up review. No replacement PR. Never use `@coderabbitai resume`, never post `@coderabbitai` commands by hand, and reserve `@coderabbitai full review` for a deliberately justified complete reread. A merge to `main` deploys croprxsolutions.app via Vercel, with one-click rollback as the safety net. The rule NEVER covers: force-pushes, landings that skipped any part of the pipeline, destructive migrations, edge-function deploys, data deletion, or changes to secrets, auth, permissions, billing, or customer-visible production state beyond what the reviewed change itself does — those always stop for Mason's explicit OK in the current conversation.
- **CodeRabbit configuration:** `.coderabbit.yaml` is the canonical repository review configuration. Its settings outrank the dashboards; change review behavior in the file, not in the web UI.

## Step 0 — Set up a branch

Never work on `main`. Check the branch and create a feature branch if needed:

```bash
git branch --show-current
```

If on `main`, create one: `git checkout -b ship/<short-slug>`. Tell Mason the branch name. (Re-verify the branch right before any commit — a commit has landed on main before.)

## Step 0.5 — Size the work, then plan (cheap; prevents the #1 bug)

**Size it first** (Anthropic: most coding is single-agent work — don't pay the ~15× multi-agent review cost on a tiny change):
- **Trivial** — one file, no SQL / money / inventory / RLS / auth / permission / lifecycle / other business-critical change (a copy tweak, a style fix, a prop rename): SKIP the review fan-out (Step 3) and the migration gate. Just make the change, run Step 2 (lint + build + test) and Step 2.5, then go to Step 7. Tell Mason in one line you're taking the light path.
- **Substantial** — everything that is not Trivial: multiple files, OR touches SQL / money / inventory / RLS / auth / permission / a lifecycle / an RPC / other business-critical behavior: run the full pipeline below.

**For substantial work, plan before coding** — this is where Mason (a non-coder) has the most power, because he can read English even though he can't read code:
1. Read the live schema / existing code for the area (don't trust memory).
2. Write a short plain-English plan: what you'll build, the assumptions you're making, and the 2–4 files you'll touch.
3. Show it to Mason and let him confirm or correct **before** you write code. A wrong understanding caught here costs one message; caught after coding costs a whole rebuild. (Skip the confirmation only for genuinely mechanical multi-file changes.) This confirmation is Claude's checkpoint; Codex posts the short plan and proceeds without waiting (`AGENTS.md` › Operating Contract).

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

MED/LOW findings: fix the cheap ones; list the rest in the final summary as accepted/deferred — do not loop on them. **Hard loop cap: max 3 fix→re-review rounds** — a ceiling under the stop rule in `AGENTS.md` › Operating Contract. If the SAME finding survives two rounds in a row, or you reach round 3 with anything still open, STOP and hand it to Mason with both positions — do not keep thrashing or burn rounds on a finding you can't resolve.

## Step 5 — If a migration is involved: prepare the live-apply gate

Only after Step 4 is clean for the migration. Items 1–2 prepare; the live apply (item 3 onward) runs in Step 8, after CodeRabbit approved and Sol cleared the final head — re-mint the apply proofs then if they are older than 30 minutes:

1. **Stamp the apply-guard proof with the sanctioned wrapper** (never hand-write the JSON — the wrapper computes the guard's slug rule, the timestamp, and the content-binding `queryHash` from the on-disk file):
   ```
   node scripts/write-apply-proofs.mjs <mig-name-without-.sql>
   ```
   If the migration is edited after stamping, the hash no longer matches and the guard blocks again (content changed = stale review) — re-run the Step 3 reviewers, then re-stamp.
2. **Authorization is Mason's autonomous-landing rule (2026-09-26), not a per-migration ask.** Apply only AFTER CodeRabbit APPROVED the frozen head carrying this migration and the exact-SHA Sol review of that head is clean (Step 8), and only while the apply proofs are fresh. The Codex apply gate is MANDATORY in every session: `node scripts/write-apply-proofs.mjs <mig-name>` runs the trusted Codex CLI itself on this migration and mints the content-bound Codex proof (`codex-review-mig-<safe-name>.json`) ONLY on a CLEAN machine verdict; a BLOCKERS or failed run mints nothing and does NOT qualify. Hand-writing that proof is blocked by review-proof-guard, by design. The apply-guard refuses any apply missing a proof, refuses DESTRUCTIVE migrations (data deletes, schema/table/column/type drops, MERGE) for agents in every session, and — if an autopilot arming EXPIRES mid-run — parks ALL further applies until Mason returns. A destructive migration: PARK it, explain the risk to Mason in plain English, and apply only after his in-chat yes, in an unarmed session, with `--mason-approved-destructive`. Never edit or rewrite the autopilot flag to get past a block.
3. **Apply** through `scripts/apply-migration-file.mjs <file>` (dry run first, then `--confirm`), run from a clean checkout of the PR's branch with the migration committed and pushed — the guard's landing gate refuses unless that exact head is the open PR's head with CodeRabbit APPROVED, green checks and a fresh Sol merge proof. The MCP `apply_migration` path cannot pass the guard's project binding. Record the apply in the change's `docs/changelog.d/` entry with the words "applied live" — the daily summary reads that.
4. **Smoke-chain test (hard rule — chains, not probes):** EVERY RPC the migration creates or modifies must pass its full business-chain spec from `scripts/smoke/smoke-specs.json`. For each touched RPC run `node scripts/smoke/run-smoke.mjs --spec <rpc>`:
   - Runner exits 2 with "no spec covers" → **write or extend a chain first** (per `scripts/smoke/README.md` — investigate live catalog, house conventions, register in `smoke-specs.json`). This is a gate, not a suggestion.
   - Execute each printed chain as ONE statement via MCP `execute_sql`. PASS = the error text contains `SMOKE_PASS_ROLLBACK` (proves nothing persisted). Any other error, or no error → FAIL: fix it, then **re-run the FULL chain — never just the failing step** (clean reviewers + md5 fidelity have missed latently-broken prod RPCs before; an isolated statement probe is never evidence of a fix).
5. **B7 ledger reconciliation:** read the newly applied ledger row's `version` and `name`, then normalize the live name and disk basename using the same convention as `.claude/hooks/migration-ordering-lib.mjs`. If the normalized live `name` already matches the authored disk basename, keep the disk filename and record both live fields in migration history — a different apply-time `version` alone is not a rename reason. Rename the disk file to the MCP-assigned version only when the live `name` does not preserve the authored basename, so disk and ledger would otherwise remain unmatched.
6. **Regen the schema registry** (`/regen-schema-registry` via MCP introspection) if the migration added a status enum, generated column, or table — otherwise the hooks run on stale data.
7. **Run the db-invariant sweeps (post-apply gate):** `npm run db-sweeps` prints each predicate's SQL — execute every block read-only via MCP `execute_sql` and compare returned `violation_key`s against `scripts/db-invariant-sweeps/allowlist.json`. **Any unallowlisted violation BLOCKS the ship** — fix it (or report it as a finding); NEVER allowlist a real hole to get green.

If the migration touches a CHECK constraint, function with an existing name, or an existing table, that is exactly what the two reviewers in Step 3 are for — do not skip them.

## Step 6 — Codex gate (automated cross-review)

Decide if the change is **Codex-worthy**: it touches anything in the full `AGENTS.md` risky set — money, inventory, auth, RLS/RPC security, a migration, permissions, an Edge Function, or another business-critical path. Decide from what the diff *does*, not from whether the push guard flagged it; its detector misses some auth surfaces. (A pure CSS/copy/layout change is NOT worthy — note that and skip to Step 7.)

If worthy, run a **separate Codex review directly via the headless CLI** — invoke `/codex-review`
(scope `--base origin/main`, after `git fetch origin`, so a stale local `main` can't distort the
diff). It runs non-interactively, captures findings, and returns a verdict
(SHIP / SHIP-WITH-FOLLOWUPS / NEEDS-WORK). No paste loop.

**Two tiers, in this order (Mason's standing decision, 2026-09-20; every Codex pin: `docs/reference/codex-model-tuning.md`).** Iterate on `gpt-6-luna` at
xhigh — `/codex-review` Step 3A — fixing and re-running until **no BLOCKER or HIGH remains**
(deliberately deferred MED/LOW do not block the Sol pass). Then, for EVERY change (Mason's
autonomous-landing rule, 2026-09-26 — before that only risky diffs needed it), spend one
`gpt-6-sol` high-effort pass to mint the exact-SHA proof the merge guards require
(`/codex-review` Step 3B). Do not burn Sol rounds on iteration, and never route a Luna round
through the proof wrapper — it unlinks the existing proof for that HEAD when it starts.

**Sol must be the LAST review before the merge — so it does NOT run in this step.** Its proof binds
to the HEAD it reviewed and to GitHub's real base, expires after 30 minutes, and the proof writer
requires a clean, committed worktree, so any commit afterwards — including a CodeRabbit fix — voids
it. Run only the Luna rounds here. Sequence: Luna clean (Step 6) → docs + commit (Step 7) → push,
PR, checks, CodeRabbit APPROVED (Step 8) → Sol on that exact HEAD → apply the migration, if any →
merge, with no further commits. Translate Luna's terminator into this command's vocabulary:
`LUNA_REVIEW: CLEAN` → SHIP; any BLOCKER/HIGH → NEEDS-WORK; deferred MED/LOW only →
SHIP-WITH-FOLLOWUPS, listing each deferral. **That SHIP is the advisory step's verdict, not
permission to merge** — it means "proceed to CodeRabbit and then the Sol pass". Do not report a
change as ready on a Luna SHIP alone; the merge guard is the last line of defence, not the intended
one.

Then act on the result like any other reviewer:
- **BLOCKER / HIGH** → feed back into the Step 4 auto-fix loop (read the cited line, confirm it's real, fix, re-verify, re-dispatch the scoped subagents), then **re-run `/codex-review` until the verdict is SHIP or SHIP-WITH-FOLLOWUPS**. If the active session genuinely disagrees with a Codex BLOCKER, do NOT silently override — surface both positions to Mason and stop.
- **MED / LOW / NIT** → fix the cheap ones; list the rest as deferred in the Step 8 summary. Don't loop on them.
- Optionally write a disposition doc `docs/audits/<date>-claude-disposition-of-codex-<slug>.md` if the batch warrants a tracked record.

**Fallback (CLI unavailable):** if `/codex-review` Step 0 can't resolve `codex.exe` or auth is broken, fall back to the manual packet — run `/codex-cross-review` to draft `docs/audits/<date>-codex-<slug>-prompt.md`, then STOP and ask Mason to run Codex + paste the reply. Don't self-certify the gate when it couldn't run (the "required safety gate unavailable → hand off" rule).

This gate runs the Codex *review* automatically; it never pushes or merges by itself — the landing happens at Step 8 (automatic once the pipeline is green).

## Step 7 — Docs + commit (on the branch)

Update the docs the change touched: `docs/reference/migration-history.md`, `rpc-functions.md`, `pages-routes.md`, `database-schema.md`, a NEW `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` entry, and the relevant workflow doc as applicable. Write the changelog entry as its own file rather than appending to `docs/CHANGELOG.md`: that file is 15k+ lines and every parallel session lands in it, so appending is what makes concurrent shipping collide. Do not add volatile counts to AGENTS.md or CLAUDE.md.

Before committing, run `node scripts/check-doc-drift.mjs` — fix any drift it reports (stale counts, missing migration-history rows) rather than committing around it.

Immediately inspect repository and branch state with `git status --short --branch` and `git branch --show-current`, then commit **on the branch** with a clear message. The fast husky pre-commit hook runs private-artifact containment, staged SQL/frontend checks, conditional agent-parity/dependency checks, and the ledger guard (2026-07-13); lint/typecheck/build/tests already ran above and remain enforced at pre-push/CI rather than repeating at commit. A commit staging agent-surface files (`.claude/{commands,skills,hooks,workflows,agents}/`, `.claude/settings.json`, any `.codex/` file, `.cursorrules`, `AGENTS.md`, `CLAUDE.md`, `.husky/`, `scripts/check-*`, `scripts/validate-*`, `scripts/verify-*`, `scripts/normalize-eol.mjs`, `scripts/agent-health-check.mjs`, `scripts/run-claude-review.mjs`, `scripts/write-codex-push-proof.mjs`, `scripts/sync-agent-workflows.mjs`, or a new `supabase/migrations/*.sql` file) must also stage a ledger update in the same commit — a new `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` entry (preferred), or `docs/CHANGELOG.md`, a `docs/manual/*.md`, `docs/reference/agent-guardrails.md`, `docs/reference/migration-history.md`, or a `docs/loops/` ledger. Step 7's changelog.d entry normally satisfies this. The entry must be ADDED by this commit and must actually describe the change: modifying, renaming, or emptying an existing entry does not count, and neither does a bare date heading. If the hook rejects, fix and retry (never `--no-verify`).

**Do NOT run the Sol pass yet.** It runs in Step 8, after CodeRabbit approves the frozen head — the
proof expires in 30 minutes and is voided by any later commit, and CodeRabbit's findings often add
one.

## Step 8 — The production decision

Once Step 4 is clean and Step 2/2.5 are green, present the branch, commit, verification evidence, migration/deploy state, and the exact production action. Then:

- **Every change without a Mason-only action** (no destructive migration, no Edge Function deploy, no data deletion, no secrets/auth/billing/permissions change, every gate ran and came back green): land under Mason's autonomous-landing rule (2026-09-26), no in-chat ask —
  1. `git push -u origin <branch>` → `gh pr create` → keep auto-merge off. If GitHub reports the branch behind, run `gh pr update-branch <n>` and wait for checks again.
  2. Once every required check is green, freeze the candidate, record its head SHA, and apply `ready-for-coderabbit`. The trusted default-branch workflow waits out running checks, validates the candidate, adds `coderabbit-review-dispatch` once, observes CodeRabbit's formal review of that exact SHA, then releases the provider label. A label write or skipped status is not review delivery. The workflow removes the ready label if a gate is not clear; fix the named blocker before relabelling. Pending or uncertain dispatch preserves dedupe labels; follow `docs/reference/coderabbit-native-review.md` before retrying.
  3. Read and resolve every real CodeRabbit finding. **A fix goes on the SAME PR:** commit, push, let the trusted synchronize run record the new candidate epoch, wait for checks, relabel — the new head earns one follow-up review. No replacement PR. Also read the **Codex GitHub App's review** (`gh pr view <n> --comments`, anything from `chatgpt-codex-connector`): fix real issues or reply with a one-line reason and resolve the thread — both merge gates deny while it has an UNRESOLVED comment on the exact head.
  4. When CodeRabbit's latest verdict is **APPROVED on the exact head**, run the one Sol pass — `/codex-review` Step 3B on that committed HEAD, clean worktree, after `git fetch origin` so the proof binds to GitHub's real base. If Sol finds something, fix it on the same PR and go back to step 2.
  5. If the job carries a NON-destructive migration: re-mint its apply proofs if older than 30 minutes and apply it now through `scripts/apply-migration-file.mjs` (Step 5 items 3–7: smoke chains, ledger reconciliation, registry, sweeps). Apply BEFORE merging, so the merged code never calls a function the database does not have yet.
  6. Immediately before merge, verify real enforcement with the PR's live `mergeStateStatus` and check rollup (the gates judge the newest run per check) — do not infer mergeability from the known-stale protection sub-resource — and recheck auto-merge OFF and that CodeRabbit's APPROVED `commit_id` equals `headRefOid`. Run `gh pr merge <n> --squash --delete-branch --match-head-commit <that-exact-sha>` → verify the deploy and report the evidence explicitly.

  `CHANGES_REQUESTED`, `--auto` and `--admin` are refused by both merge gates; `enforce_admins` is off and no agent may act on that exemption. Do not use `@coderabbitai resume`. Direct pushes to `main` are impossible. The daily summary (`.github/workflows/daily-landing-summary.yml`) tells Mason what landed.
- **A Mason-only action** (a destructive migration, an Edge Function deploy, data deletion, or any other hard gate in `AGENTS.md` › Safety and Protected Delivery): stop and ask Mason for explicit approval of that specific action. Do not treat the landing rule — or any older approval — as covering these. A destructive migration applies only after his in-chat yes, in an unarmed session, with `--mason-approved-destructive`.
- **A required gate ran degraded or could not run:** do not land and do not self-certify. Stop and hand over per the stop rule in `AGENTS.md`, saying which gate and why; approval does not replace the gate, which must run and pass before landing.

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
- NEVER merge work that has not passed the FULL pipeline — CodeRabbit APPROVED on the exact head, a clean exact-SHA Sol review, every check green. Merges under Mason's 2026-09-26 autonomous-landing rule are reported explicitly, never silently. Force-pushes always require Mason's explicit approval.
- NEVER apply a migration without both reviewers clean and the apply proofs written (the guard enforces this; don't try to route around it), and never before CodeRabbit approved and Sol cleared the head that carries it. Non-destructive: no in-chat ask under the 2026-09-26 rule. Destructive: Mason's in-chat yes first, every time.
- NEVER report the gate "clean" while any confirmed BLOCKER/HIGH is open, even if lint/build/test pass.
- NEVER skip the review fan-out to "save time" — it is the entire point of `/ship`. The only exception is the **Trivial** path defined in Step 0.5.
- NEVER `--no-verify`, `@ts-ignore`, or `any` (except `reportPdf.ts` columnStyles).
- Auto-deploying an Edge Function, deleting data, and applying a destructive migration are never covered by any standing authorization — those always wait for Mason's explicit yes. A non-destructive migration applies under the 2026-09-26 rule once its proofs pass and its head's final reviews are clean.
- If a required safety gate is unavailable (e.g. a reviewer can't run), STOP and hand off — do not self-certify. (Mason's prod-gate-discipline rule.)

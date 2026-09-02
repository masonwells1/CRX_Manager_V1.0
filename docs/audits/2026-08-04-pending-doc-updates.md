# Pending doc updates — 2026-08-04 / 2026-08-05

> **SUPERSEDED — historical record.** A 2026-08-04/05 snapshot of documentation work that was
> pending at the time, rescued from the merged PR #317 branch. Its checklist state is a point-in-time
> record and was not re-verified when this file landed; do not read any item as still outstanding.
> `docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md` are authoritative.

Two large docs could not be delivered to GitHub from the remote sessions that
produced this work: `docs/CHANGELOG.md` (977 KB) and `docs/manual/KNOWN_ISSUES.md`
(108 KB). Both are far too large to send through the GitHub API's file-content
parameter, and git delivery is blocked from a remote container (see section 4).

Everything needed is reproduced verbatim below. Applying it is mechanical: paste
each block at the marked location, then delete this file.

**Do this on your own machine, not in a remote session.** On your laptop there are
no proxy URL rewrites, so the pre-commit gate passes normally and an ordinary
`git commit` + `git push` works. That is the whole reason these blocks are still
pending.

---

## How to apply (start to finish)

```bash
git fetch origin claude/test-coverage-analysis-3thnt5
git checkout claude/test-coverage-analysis-3thnt5
git pull origin claude/test-coverage-analysis-3thnt5
```

Then make the two edits in sections 1 and 2 below, and:

```bash
git add docs/CHANGELOG.md docs/manual/KNOWN_ISSUES.md
git rm docs/audits/2026-08-04-pending-doc-updates.md   # this file; its job is done
git commit -m "docs: apply pending changelog and known-issues entries"
git push -u origin claude/test-coverage-analysis-3thnt5
```

The pre-commit hooks will run and must pass — do not use `--no-verify`. Then merge
PR #310 as usual.

---

## 1. `docs/CHANGELOG.md` — insert immediately after the 4-line header

Insert directly above the existing
`## 2026-08-03 — Statement balance consistency fixes — LIVE` section, so both new
entries sit at the top in reverse-chronological order (2026-08-05 first, then
2026-08-04).

````markdown
## 2026-08-05 — Coverage ratchet raised and six untested modules covered

Acts on the quick-win recommendations of the previous day's coverage analysis. The
`vite.config.ts` ratchet floor was raised from 36/27/24/34 to 45/36/32/43 — it
had been set against the 2026-07-13 baseline and drifted ~11 points below actual,
so coverage could have fallen by a quarter with CI still green. Six new test
files (102 assertions) cover `money.ts` and five small pure modules that had none.
`money.test.ts` pins the cents-vs-dollars distinction the module exists to
prevent, including that passing a cents value to `formatUSD` overstates by
exactly 100x; every `formatUSD` call site passing a `*_cents` value was checked
and is correct, so there is no live bug — but nothing enforced the manual `/ 100`
until now.

`scripts/log-session.mjs` had four defects, all found while it generated the
analysis session's own changelog entry: `--help` was unhandled and wrote a live
{SUMMARY} stub into this file; `--author=Mason` never matched agent commits so
every agent session fell back to the last 15 commits and claimed unrelated merged
work (14 commits and 7 migrations were attributed to a docs-only session); the
migrations lookup backfilled from recent history when the branch diff was empty;
and the whole `--summary` string became the `##` heading. All four are fixed and
guarded by `scripts/log-session.test.mjs`, now wired into `test:correction-guards`.

Three further defects were found during review and fixed on the same branch. All
three were introduced by the fixes above, not by the original script:

- Collapsing every git error to `""` made an unreachable `origin/main`
  indistinguishable from "no commits ahead", so the script would silently use the
  unrelated 12-hour window and report no migrations — reviving the exact
  false-attribution bug it was meant to end. `runGit()` now returns `{ok, out}`
  and refuses to write on any git failure. (CodeRabbit, PR #310.)
- The guard suite called `git diff origin/main...HEAD` unguarded, which exits 128
  in any checkout without a local `origin/main` — shallow clones, fresh worktrees,
  remote containers. Because the suite runs in `test:correction-guards`, that
  aborted the pre-commit gate and blocked commits outright. Every git call in the
  suite is now guarded, blocks needing the ref skip with a stated reason and count,
  and a new block asserts the script's refusal path. (Codex, PR #310.)
- The 12-hour window is **gone entirely** (Codex, PR #317). #310 shipped it behind
  a `HEAD === origin/main` guard, on the reasoning that the fallback was only
  reachable when the branch was level with main. That guard was the wrong shape:
  level with main is the *common* state — right after a merge, or during any
  session whose work is not yet committed — and there the last 12 hours of `main`
  is other people's merged work. The guard narrowed the bug without fixing it.
  Commits now come from one source, `origin/main..HEAD`, and an empty range
  honestly reports `(none found)`.

A third review finding — migrate all TypeScript money values to `bigint` — was
declined and subsequently withdrawn by the reviewer. The "money is bigint cents"
hard rule governs Postgres storage and forbids float math; it is not a required
TypeScript representation. `formatCents` returns a display string, so the proposed
bigint return had nowhere to go, and a money-representation refactor does not
belong in a test-coverage change. The durable fix for the real risk here is a
branded `Cents` type or the lint rule `money.ts` already contemplates.

PROOF — Ran: `npx vitest run --coverage` (320 files, 4259 tests, 0 failures;
47.13 lines / 37.91 branches / 34.11 functions / 44.74 statements); `tsc --noEmit`;
`eslint .`; `vite build`; `test:correction-guards`; `test:agent-workflows`. Saw:
all green, 21 assertions in the log-session guard suite (20 at #310, plus the
#317 guard asserting no `--since=` window can return). Separately proved the new
ratchet is enforced — a single-file coverage run fails citing all four new
thresholds — and mutation-tested the `--help` and `git log -15` guards, both of
which fail the suite when the fix is reverted. The shallow-checkout fix was proved
in a scratch repo with no `origin/main`: the pre-fix suite dies with status 128,
the fixed suite exits 0 with 15 assertions and 3 stated skips. The #317 fix was
proved the same way: with `origin/main` set to `HEAD` and one unrelated commit in
recent history, the pre-fix script claims that commit and the fixed script reports
`(none found)`.

- **Migrations touched**: none.
- **Delivery note**: the code changes were pushed through the GitHub MCP API, not
  git; every file was verified byte-identical to the locally tested version
  afterwards.

## 2026-08-04 — Test coverage analysis

Measured the real test-coverage baseline and identified six areas to improve. A
full `vitest run --coverage` reports 47.11% lines / 44.71% statements / 37.85%
branches / 34.07% functions — roughly 11 points above the ratchet floor in
`vite.config.ts`, which has not been raised since the 2026-07-13 baseline.
`src/lib` (79.9%) and `src/hooks` (81.3%) are healthy; 76% of all uncovered
lines sit in `src/pages` (33.6% lines, 20.6% functions).

Findings, worst first:

- ~30 test files assert `toContain()` against applied migrations, which the hard
  rules forbid editing — so they cannot fail. Cross-referencing the 33
  test-pinned migrations against later `CREATE OR REPLACE` definitions found 20
  stale pairs; `save_purchase_order` has been redefined 10x since the migration
  its tests pin.
- The 413 SQL functions (253 called from the frontend) have no executable tests,
  and the 13 `describe.skipIf(!isLiveDB)` blocks in `schemaIntegrityLive.test.ts`
  are skipped in every CI run — `CRX_LIVE_SCHEMA_TESTS` is set nowhere in
  `.github/`.
- 1075 E2E tests exist across 94 specs; CI runs the 6 tagged `@smoke`, because
  Playwright targets the production Supabase project.
- Mirror-style tests that re-implement page logic leave `NewDelivery.tsx`,
  `FieldStop.tsx` and `LabelReview.tsx` at 0% coverage despite having test files.
- Both prepay panels, `PaymentHistory.tsx` and `invoiceSummaryPdf.ts` are at 0%;
  branch coverage lags lines sharply in `statementPdf.ts` (88%/54%) and
  `invoicePdf.ts` (84%/61%).
- `src/lib/money.ts` is untested and its documented no-alias rule is unenforced.
  Every `formatUSD` call site passing a `*_cents` value was checked and is
  correct — no live bug, but nothing verifies the manual `/100`.

Analysis only — no source or test changes. Full write-up in
`docs/audits/2026-08-04-test-coverage-analysis.md`.

PROOF — Ran: `npx vitest run --coverage` (314 files, 4157 passed, 123 skipped,
284s); a script cross-referencing every test-pinned migration against later
function redefinitions; `grep` over `tests/e2e` for `@smoke` vs total `test()`
count. Saw: the coverage summary above, the 20 stale pinned pairs, and 6
`@smoke` tests against 1075 total.

- **Migrations touched**: none.
- **Not delivered by git** — the repo's guards block commit and push from a
  remote container. The audit docs reached GitHub via the GitHub MCP API instead.
````

> Note: `scripts/log-session.mjs` generated a defective version of the 2026-08-04
> entry (whole summary folded into the `##` heading, duplicated as the body, and
> 14 unrelated commits plus 7 statement migrations attributed to this session via
> its `git log -15` fallback). The block above is the hand-corrected version.
> A `--help` invocation of that script also used to write a `{SUMMARY}` template
> stub into the changelog — check for and delete any stray stub. **All of those
> defects are fixed on this branch.**

---

## 2. `docs/manual/KNOWN_ISSUES.md` — insert after the intro `---` (line 8)

Insert directly above the existing
`## RESOLVED LIVE — Quote and Customer whole-record saves reject stale editors`
section.

````markdown
## OPEN — agent tooling breaks in remote (Claude Code on the web) sessions

**Found 2026-08-04**, extended 2026-08-05. Three problems, two sharing one root
cause. None affect production; all affect an agent's ability to finish a session
from a remote container.

**Root cause for (1) and (2): URL rewrites.** A Claude Code on the web container
reaches GitHub through a local proxy, configured in `/root/.gitconfig` as
`url."http://local_proxy@127.0.0.1:<port>/git/".insteadOf = https://github.com/`,
plus two more `insteadOf` rules injected as `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`
environment variables. Both of the repo's guards correctly treat URL rewrites as
dangerous — the container legitimately requires them.

1. **Branch delivery by git is impossible from a remote session.**
   `.claude/hooks/codex-push-guard.mjs` denies while `GIT_CONFIG*` variables are
   set ("Unset them before pushing"), and *also* denies any command that names
   that namespace — so `env -u GIT_CONFIG_… git …` is refused too. The guard is a
   PreToolUse hook reading the harness shell's own environment, so nothing done
   inside a command can change what it observes. It additionally rejects command
   text containing quoting or the literal push token anywhere, so even a commit
   message describing the problem trips it. There is no in-session workaround
   that does not disable the guard.
2. **Committing is blocked too — two separate pre-commit tests fail.** Both run in
   the `test:correction-guards` gate:
   - `scripts/backup-claude-memory.test.mjs` — `stage()` refuses with "refusing to
     stage — Git URL rewrite settings are active (3 settings)".
   - `.codex/hooks/production-action-guard.test.mjs:318` — asserts "Claude guard
     still allows an ordinary feature-branch push", which fails because the guard
     correctly denies while `GIT_CONFIG*` is set. Confirmed 2026-08-05: this
     aborts `git commit` outright in a remote container.

   Both guards behave exactly as designed; the sandbox's proxy rewrite trips them.
   **Committing from a remote session therefore requires `HOME` pointed at a
   gitconfig that keeps `[user]`/`[gpg]`/`[commit]` but drops the `[url …]` block,
   plus the `GIT_CONFIG_*` vars unset for that one command** — which item (1)
   forbids arranging. In practice: commit and push from a local machine.
3. **`scripts/log-session.mjs` misattributed a session's work.** — **FIXED
   2026-08-04/05** on branches `claude/test-coverage-analysis-3thnt5` (#310) and
   `claude/log-session-attribution-fix` (#317). It used to fall back to the last
   15 commits when no commit matched its `--author=Mason` heuristic, labelling the
   result "Commits this session" and "Migrations touched"; on 2026-08-04 it
   attributed 14 unrelated commits and 7 statement migrations to a docs-only
   session. It also folded the entire `--summary` string into the `##` heading,
   and a `--help` invocation wrote a `{SUMMARY}` template stub into
   `docs/CHANGELOG.md`. Commits are now scoped to `origin/main..HEAD`, migrations
   are never backfilled, `--help` exits without writing, and the heading is a
   short derived title. A git *failure* is no longer treated as an empty result —
   the script refuses to write rather than guessing. There is no time-window
   fallback of any kind: #317 removed the last one (a 12-hour window that #310 had
   merely guarded behind `HEAD === origin/main`, which left the common
   level-with-main case still claiming other people's merges).
   `scripts/log-session.test.mjs` guards all of it, and skips cleanly (with a
   stated reason) in checkouts that have no local `origin/main`.

**Net effect:** an agent in a remote session can analyse and edit, but cannot
commit or deliver a branch by git. Work must go through the GitHub MCP tools
(`push_files` + `create_pull_request`), which address the repository by explicit
`owner`/`repo`/`branch` and so carry none of the destination ambiguity the push
guard exists to prevent. That route has its own ceiling: file content passes
through the tool call, so files in the hundreds of KB (`docs/CHANGELOG.md` is
977 KB, `docs/manual/KNOWN_ISSUES.md` is 108 KB) cannot be delivered this way at
all — which is why doc updates to those two files must be applied by hand from a
local machine.

**Fix options (not yet decided):** teach `codex-push-guard`, the memory-backup
guard, and `production-action-guard.test.mjs` to accept a known-safe proxy-rewrite
shape the way `GIT_SSH_COMMAND` already has a sanctioned keepalive shape; or gate
them on a detected remote-container marker; or leave as-is and treat the GitHub
MCP path as the supported remote delivery route. Mason chose **leave as-is** on
2026-08-04; the 2026-08-05 finding that commits are blocked as well (not just
pushes) may be worth revisiting, since it means a remote session cannot record its
own work in the two largest docs. See
`docs/audits/2026-08-04-test-coverage-analysis.md` for the session that surfaced
these.
````

---

## 3. Also regenerated locally

The pre-commit hook regenerated `docs/app-workflow-map.html` (98 routes, 53 nav
links, 254 distinct RPC calls, 5 auto-detected problems). That artifact was not
delivered either; it regenerates on the next local commit, so no action is needed
beyond letting the hook run.

---

## 4. Why this file exists at all

Confirmed again on 2026-08-05 from a fresh remote container: `git commit` aborts in
the pre-commit gate (section 2 above), so neither the changelog nor the
known-issues text can be committed, let alone pushed. Only files small enough to
pass through a GitHub MCP tool call can be delivered from a remote session — this
file is 11 KB and fits; the two targets do not.

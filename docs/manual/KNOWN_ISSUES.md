# Known Issues — Consolidated

**Last verified: 2026-08-10 UTC (2026-08-09 evening America/Chicago), post-apply.** Live ledger high-water at the last read on this branch was `20260810155629` (`20260810151000_whole_cent_money_check_constraints`), re-read 2026-08-10 — ledger versions are UTC, which is why the stamp reads a day ahead of the local session date. The 2026-08-09 post-apply verification that the rest of this header describes ended at `20260810010308` (`active_team_note_assignment_actor`); the four ledger entries past it were applied live by separate 2026-08-10 sessions and are not described below. Two independent lines of work applied live on 2026-08-09 and are reconciled below. Everything past this header carries its 2026-08-07 verification unless dated otherwise.

**Team Board delegation — both halves live.** `20260809130108` added the governed `complete_team_note` RPC and the assignment-notification trigger, and `20260810010308` closed the inactive-actor notification path in both the `tnotes_insert` policy and the trigger itself. Both were verified live after apply, and the delegated-completion and inactive-actor behaviors were proven by rollback-only probes against live. The compatible frontend ships with PR #351, so delegated completion is live in the database but not reachable from the browser until that PR merges and deploys. An earlier 2026-08-09 read recorded `20260809130108` as having no file in this repository; PR #351 lands that file and its follow-up, closing the gap (see `docs/reference/migration-history.md` rows 863 and 864).

**2026-08-09 sweep and the five foundation-ultra-review migrations.** The 2026-08-09 re-read covered the live ledger, the section-2 counts in `CURRENT_STATE.md`, and all 27 standing invariant sweep predicates: 26 CLEAN and one violation, `fin-money-whole-cents` at exactly 49 rows (3 `commissions` + 46 `order_items`) — the documented, deliberately-unrepaired set described below. The five foundation-ultra-review migrations (history rows 857–861, re-issued forward as `20260809170500`–`20260809170900`) **APPLIED LIVE 2026-08-09, 20:32–20:54 UTC**, each behind its own freshly minted migration-apply-guard proof with both required reviewers clean, and each followed by a live post-apply read; Supabase assigned ledger versions `20260809203222`, `20260809204044`, `20260809204435`, `20260809204855`, `20260809205423` in file order. A 21:15 UTC re-measure confirms no stored money was restated: fractional-cent rows remain exactly 46 + 3 = 49 and `order_items.profit` holds 0 fractional rows. **`20260809170900` applied against the blocking escalation recorded below** — see that entry for what happened and the decision now owed by Mason.

**2026-08-07 (evening) verification detail.** Live ledger high-water was `20260807220323` (`log_customer_fact_rpc`). Both formerly parked 2026-08-07 migrations are now APPLIED LIVE: the profile role-lock INSERT arm as `20260807215532` and the `log_customer_fact` CRM RPC as `20260807220323` (both reviewed CLEAN by both Codex charters, applied with Mason's in-chat approval; the paired predicate `profile-role-lock-insert-arm.sql` went 2 rows red → 0 green). The Section 4 bulk-order-import lifecycle gap is fixed live through six migrations: imports are confirmed-only, inventory-aware, activity-logged, actor/payload-bound for replay, non-finite-safe, Product-cost-authoritative, whole-cent per line, and create commissions from trigger-canonical stored profit. Post-apply catalog/grant checks, fractional active-sales-rep rollback smoke, all 21 standing invariant predicates, schema-registry refresh, and zero-residue checks passed. The earlier profile role-lock, CRM fact RPC, bulk-import lifecycle, idempotency, statement-disclosure, and historical AR report protections remain live as documented below.
**Update triggers:** when a finding is parked/resolved, a migration is parked/applied, or an owner decision lands. Agents must update THIS file, not create new issue lists. Do not re-discover or re-fix something listed here as already known — read the pointer first.

This file consolidates (does not replace) the source documents it points to. If this file and a source disagree, trust the source and fix this file.

---

## OPEN — the Codex `read_only=true` guard may not describe the connection Codex actually uses

**Found 2026-08-10.** No production write was performed during the investigation.
Production write capability remains unverified. This affects how much assurance
the read-only guard is entitled to claim.

`check-agent-workflows.mjs:92` and `check-agent-guidance.mjs:121` both assert
that `.codex/config.toml` contains `read_only=true`, and that assertion is the
stated guarantee that Codex cannot write to the live database. The guard checks
that a **string is present in a file**. It does not check that the connection
that string configures is the one serving Codex's Supabase traffic.

On 2026-08-10 those two were observed to be different things:

- The `[mcp_servers.supabase]` entry in `.codex/config.toml` **fails to
  authenticate on every run** — `failed to refresh OAuth tokens for server
  supabase` / `invalid_grant: Grant not found`. Its OAuth grant is dead, exactly
  like the Sentry entry removed the same day.
- Meanwhile the Supabase calls that actually succeed are served by
  **`codex_apps/supabase`** — a separate built-in Codex App with its own
  independent authentication. Observed tool line:
  `mcp: codex_apps/supabase.list_migrations (completed)`, returning correct live
  data — migration name `20260810022500_backfill_stale_line_profit`, live ledger
  version `20260810025159` — verified against the live ledger from the Claude
  side. The two stamps differ because a migration's filename prefix records when
  it was written and its ledger version records when it was applied; they are
  different numbers for the same migration.

So the read-only assurance is asserted against a config entry that appears never
to have authenticated, while real traffic flows through a channel whose
permissions are **not verified by any guard in this repository**. Removing the
dead entry was attempted and reverted precisely because the guard failed — the
declared intent is worth keeping, but it should not be read as proof.

**What is NOT known, and was deliberately not tested:** whether
`codex_apps/supabase` is itself read-only. Establishing that empirically means
attempting a write against the production database, which is not an acceptable
test. A capability probe (asking Codex to list its Supabase tool names without
calling them) was attempted twice and produced no usable output.

**Owed to Mason (owner decision):** confirm in the Codex app's own connector
settings whether the Supabase App is scoped read-only. If it is not, Codex has
had unverified write capability against production for as long as the App has
been serving traffic, and the guard has been reporting green throughout.

**Do not** "fix" this by deleting the `read_only=true` line or by relaxing either
check — both guards correctly refused the change that prompted this entry.

---

## RESOLVED LIVE 2026-08-09 — Team Board delegated completion and assignment notifications (frontend awaits push)

Both migrations are applied live. `20260809130108_team_note_completion_rpc_and_assignment_notify` added the governed `complete_team_note` RPC and the assignment-notification trigger without widening the existing `tnotes_update` policy; live structure, grants, and the 26 standing invariant predicates passed. The HIGH that review then raised — an inactive profile with a still-valid JWT could satisfy the legacy `tnotes_insert` creator check and make the owner-run trigger notify an active teammate — is closed by `20260810010308_active_team_note_assignment_actor` (authored as `20260809154649`), which requires an active profile in the INSERT policy *and* independently in the trigger, leaving `tnotes_update` unchanged.

Proven live by rollback-only probes rather than by tests alone: an active non-admin **assignee completed a note they did not create** with `completed_by` stamped from `auth.uid()`; an unrelated active employee was refused with `NOT_AUTHORIZED_TO_COMPLETE`; a real deactivated profile with a valid token was refused at the RLS layer (42501); with RLS deliberately bypassed and the token subject set to that deactivated profile, the trigger's own guard raised `PROFILE_INACTIVE` (42501); and the normal path still filed exactly one `task_assigned` notification.

Remaining: the browser changes that call the RPC and open assignment notifications are **committed but not pushed** on `claude/todo-list-audit-hoxpl5`, so PR #351 does not contain them yet — pushing needs Mason's approval. The registered chain `scripts/smoke/smoke-complete-team-note-chain.sql` still needs its external `SMOKE_PASS_ROLLBACK` terminal run; it is a manual `npm run smoke` spec, not CI, so nothing is red.

---

## OPEN — agent tooling breaks in remote (Claude Code on the web) sessions

**Found 2026-08-04**, extended 2026-08-05. Three problems, two sharing one root
cause. None affect production; all affect an agent's ability to finish a session
from a remote container.

> **Update 2026-08-07 (reconciled when this entry merged with `main`):** since
> this was written, PR #313 (2026-08-05) relaxed both guards for sessions
> carrying only the two SSH-spelling rewrites, and removed the memory-backup
> script's blanket rewrite ban — see the two entries immediately below. Neither
> fix covers a container that *also* installs the credential proxy, which is the
> shape described here, so this entry stays OPEN. The entries below are the
> current, narrower statement of what still refuses and why.

**Root cause for (1) and (2): URL rewrites.** A Claude Code on the web container
reaches GitHub through a local proxy, configured in `/root/.gitconfig` as
`url."http://local_proxy@127.0.0.1:<port>/git/".insteadOf = https://github.com/`,
plus two more `insteadOf` rules injected as `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`
environment variables. Both of the repo's guards correctly treat URL rewrites as
dangerous — the container legitimately requires them.

1. **Branch delivery by git is impossible from a remote session.**
   `.claude/hooks/codex-push-guard.mjs` denies a push while `GIT_CONFIG*`
   variables are set ("Unset them before pushing"), and *also* denies a push
   command that names that namespace — so `env -u GIT_CONFIG_… git push …` is
   refused too. The guard is a PreToolUse hook reading the harness shell's own
   environment, so nothing done inside the command can change what it observes.
   There is no in-session workaround for the push that does not disable the guard.

   **Scope correction (2026-08-07, from the PR review that landed this entry):**
   these restrictions apply to **pushes only**. `codex-push-guard.mjs:81` passes
   every non-push command straight through *before* reaching the `GIT_CONFIG`,
   `HOME`, and repo-selector checks, and the tracked suite asserts the point
   directly — `codex-push-lib.test.mjs:857`: `GIT_CONFIG_COUNT=1 git commit -m x`
   is "not a push". An earlier draft of this entry said the guard refused
   `env -u GIT_CONFIG_… git …` in general and therefore blocked arranging a clean
   commit environment. That was wrong, and it would have told a remote agent to
   give up on a commit that is not actually gated.
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
   plus the `GIT_CONFIG_*` vars unset for that one command.** Per the scope
   correction in item (1), the push guard does **not** forbid arranging that for a
   commit — both failing guards read the environment and gitconfig the command
   inherits, so a command-scoped sanitized environment should satisfy them. That
   is reasoning from source, not an observed run: nobody has yet proved it inside
   a live remote container, and the *push* stays blocked either way. Until someone
   demonstrates it, commit and push from a local machine.
3. **`scripts/log-session.mjs` misattributed a session's work.** — **FIXED
   2026-08-04/06** across PRs #310 and #317. It used to fall back to the last 15
   commits when no commit matched its `--author=Mason` heuristic, labelling the
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

**Net effect:** an agent in a remote session can analyse and edit, cannot deliver
a branch by git, and cannot commit either without the sanitized-environment
arrangement described above (untested in a live container). Work must go through the GitHub MCP tools
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

## OPEN — the push guard AND the memory backup still refuse web/mobile sessions that install a credential-proxy rewrite

**Found 2026-08-05 by Codex on PR #313 (P2), reproduced and confirmed the same day. Needs an owner decision; see "the decision this needs" below. Codex found the second instance (`backup-claude-memory`) on the same PR after the first was parked — see "Second instance" below.**

PR #313 fixed the push guard denying *every* web/mobile session. It does not cover the variant where the session also installs a **credential-proxy rewrite** — the "third" rewrite noted in the RESOLVED entry below. Sessions carrying only the two SSH-spelling normalizations (`git@github.com:` / `ssh://git@github.com/` → `https://github.com/`) push fine; that is the shape the PR was developed and verified in, which is why it went unnoticed.

With a proxy rewrite of the form `url.http://<proxy>/git/.insteadOf https://github.com/`, `git remote -v` reports the proxy URL, so the guard's two reads disagree:

```
scrubbed decision: guarded-app github github.com/masonwells1/crx_manager_v1.0
ambient  decision: guarded-app raw http://proxy.invalid/git/masonwells1/CRX_Manager_V1.0.git
divergent keys   : ["dest"]
```

`pushDestinationKey()` only canonicalizes direct GitHub spellings and falls back to `raw <url>` for anything else, so `divergentPushLookups()` reports a divergence and the guard denies — including an ordinary `HEAD:feature` push. That blocks the branch→PR landing path in exactly the environment the guard was meant to unblock.

Reproduce: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='url.http://proxy.invalid/git/.insteadOf' GIT_CONFIG_VALUE_0='https://github.com/' git remote -v` in an HTTPS-origin checkout, then compare `pushDestinationDecision()` on the scrubbed and ambient URLs.

**Note both sides already classify the destination `guarded-app`** — `urlIsGuardedApp()` recognizes the proxy URL by path. The divergence is only in the identity half of the key.

**The decision this needs.** A fix means teaching the guard which rewrite targets count as "the same repository," and every obvious shortcut re-opens the fail-open this helper has already sprung five times:

- Comparing only the `guarded-app` boolean is the first draft that was rejected as too weak.
- Matching on the `owner/repo` path suffix would make any host with a matching path compare equal — a redirect to an attacker-controlled host would pass.
- Applying the unioned rewrite table to *both* reads makes them agree by construction, which defeats the divergence check entirely.

So it wants an explicit notion of an approved rewrite target rather than another patch to the key function. Deliberately not attempted on PR #313: it is a security-relevant change to a push guard, and **this session cannot verify a fix end-to-end** — it carries the two SSH normalizations and no proxy rewrite, so only unit-level proof is available here. Recommend fixing it from a session that actually has the proxy installed, so the real push path is the proof.

### Second instance — `backup-claude-memory` refuses the same way, for the same reason

**Found 2026-08-05 by Codex on PR #313 (P2), reproduced and confirmed the same day.** The RESOLVED entry below says the memory backup now runs from a web or mobile session. **That claim is narrower than it reads, and the entry has been corrected**: what was verified there is a session carrying the two SSH-spelling normalizations. A session that also installs a credential proxy still refuses.

`git remote -v` reports the proxy URL for the backup remote too, so the resolved push URL is `http://<proxy>/git/masonwells1/CRX_Backups.git`. `destinationIsPublishable()` gates the private-backup branch on `pushUrls.every((url) => canonicalRepoId(url) === BACKUP_REPO_ID)`, and the proxy URL does not canonicalize to that id, so the run falls through to the "not the off-site backup repo" refusal and stages nothing. Confirmed directly against the shipped helper:

```
ENTERS backup branch  "github.com/masonwells1/crx_backups"        <- https://github.com/masonwells1/CRX_Backups.git
ENTERS backup branch  "github.com/masonwells1/crx_backups"        <- git@github.com:masonwells1/CRX_Backups.git
REFUSES               "proxy.invalid/git/masonwells1/crx_backups" <- http://proxy.invalid/git/masonwells1/CRX_Backups.git
```

Same root cause as the push-guard instance above — no notion of an approved rewrite target — and the same safe failure direction: it refuses rather than writing private notes to an unverified address. Parked for the same reason, with one addition specific to this script: verifying a fix needs both a proxy-carrying session **and** a real private `CRX_Backups` clone to stage into, so the end-to-end proof is not available from an ordinary session at all. Fix both instances together; one approved-rewrite-target notion should serve both call sites.

### Third instance — the executable-config classifier misses `core.hooksPath` — (b) FIXED 2026-08-05, (a) still parked

**Found 2026-08-05 by Codex on PR #313 (P1), reproduced the same day. Two separate defects; Codex's report names one and reproduces the other.**

> **Update, same day:** **(b) is fixed.** The classifier and the mirror-remote
> check were hoisted above the `mainPushSource()` early exit, so both now run on
> every push form rather than only a main-bound one. The fix landed while fixing
> the mirror-remote parse on this PR — the two defects share one call site, and
> the mirror check was dead for the exact hazard its deny text describes. The
> hoist is safe for this repo precisely because **(a)** is still open: with
> `core.hooksPath` absent from `EXECUTABLE_TRANSPORT_KEYS`, the husky collision
> below does not fire. Verified: a real push from this checkout still passes
> through. **(a) remains parked on the approved-value work described below** —
> and adding those keys is now strictly gated on that work, since with the hoist
> in place a naive addition would deny every push from here immediately rather
> than only main-bound ones.

`EXECUTABLE_TRANSPORT_KEYS` in `.claude/hooks/codex-push-lib.mjs` names the settings that select a program to carry a push (`core.sshCommand`, `core.gitProxy`, `remote.*.receivePack`, …). Two omissions matter, because `git push` runs `pre-push` from `core.hooksPath`:

- **(a) The list is incomplete.** `core.hooksPath` and shell-form `credential.helper` are absent. On a **main-bound** push, `core.sshCommand` denies and both of these allow.
- **(b) The classifier is unreachable for any push that is not main-bound.** ~~The loop exits at the `mainPushSource()` check (`codex-push-guard.mjs:395`) before reaching the classifier at line 481.~~ On a feature-bound push, even `core.sshCommand` — which *is* in the list — allows. **Fixed 2026-08-05:** the classifier now runs before that early exit, so the reproduction below no longer holds for the feature-bound rows.

Reproduced against the shipped guard, plus a planted hook to prove execution is real:

```
--- MAIN-BOUND push (reaches the classifier) ---
  core.sshCommand:    deny
  core.hooksPath:     allow
  credential.helper:  allow
--- FEATURE-BOUND push (exits at guard line 395) ---
  core.sshCommand:    allow
  core.hooksPath:     allow

planted pre-push hook executed by git?  YES
```

Codex reproduced (b) and proposed a fix for (a) — "deny executable configuration keys". Applied literally, **that fix denies every push from this repository**, because husky legitimately sets `core.hooksPath=.husky/_` here:

```
Keys in THIS repo the proposed list would flag:
  core.hookspath=.husky/_
=> every push from this repo would DENY
```

That collision is why this is parked rather than patched. The setting cannot be refused by name the way `core.sshCommand` can: the repo's own tooling sets it, so the guard needs to tell the committed `.husky/_` path from an inherited or absolute attacker path — which is the **same approved-value notion** the two rewrite instances above need, in a third place. Fix all three together.

Failure direction differs from the other two and is worth stating plainly: these **allow** rather than refuse, so this instance is a genuine hole rather than an over-refusal. It is bounded by the fact that setting the config at all requires the ability to run commands in the session already.

## RESOLVED — `backup-claude-memory` could not run from a web/mobile session

**Found and fixed 2026-08-04 (Mason approved the fix the same day). Same "presence treated as intent" shape as the push-guard regression fixed alongside it, in a different script.**

`scripts/backup-claude-memory.mjs` refused to stage the agent-memory snapshot whenever ANY `url.*.insteadOf` / `url.*.pushInsteadOf` rewrite was configured, on the grounds that a rewrite could silently replace the verified private-backup address before the push. Claude Code on the web ships such rewrites as a matter of course — two SSH-spelling normalizations (`git@github.com:` and `ssh://git@github.com/` → `https://github.com/`) plus, when a credential proxy is installed, a third. So the refusal fired on the ordinary case and the off-site memory backup could not be run at all from a web or mobile session. It passed on a laptop, which is why it went unnoticed.

**The finding that decided the fix: the ban was redundant.** `git remote -v` prints its `(push)` line with `insteadOf` AND `pushInsteadOf` already applied — byte-identical to `git remote get-url --push`, verified against git 2.43 for both forms. The script derives `pushUrls` from exactly those lines, so a rewrite that redirects the push *changes `pushUrls` itself*, and the existing repository-identity, credential, and transport checks were already judging the real destination and already refusing it. The blanket ban was not the control catching redirects; it was a second, cruder layer on top of the one that was already working.

So the ban was removed rather than reworked. What replaced it is a check that the redundancy is real: the script now asks git directly for each remote's push URL and requires that set to match the URLs it just validated, failing closed on any divergence, unenumerable remotes, or an unresolvable URL. If a future git version or configuration ever made `remote -v` show something other than the address git will contact, the run refuses instead of silently validating a URL that is never used.

Coverage: the three round-26 redirect cases still refuse (the local `pushInsteadOf` case now via the credential check, one step later and for a more specific reason, still without echoing the secret), and a new case proves the actual relaxation — an identity-preserving rewrite no longer blocks the run. 234 assertions pass. Verified in the real web session: `stage()` into a private `CRX_Backups` clone with the ambient rewrites active now returns 0 and reports `Destination verified`.

**Scope correction (2026-08-05, Codex on PR #313).** "The ambient rewrites" above means the two SSH-spelling normalizations this session carries — that is what was verified, and the resolution is real for that shape. It does **not** extend to a session that also installs a credential proxy: the proxy re-spelling makes the resolved push URL fail the `BACKUP_REPO_ID` identity check, and the run still refuses. Tracked as the second instance under the OPEN entry above. This entry stays RESOLVED for the rewrite shape it actually fixed rather than being reopened, since the blanket-ban removal it describes is sound and unaffected.

Also fixed alongside it: the suite itself read the host's global git config instead of pinning its own, so the ambient rewrites failed it — and since the pre-commit hook runs that suite, it blocked every commit from a web session. It now pins `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` to an empty file and strips inherited `GIT_CONFIG_*` at startup, so it tests the script rather than the machine.

## OPEN — the migration ordering guard cannot see applies from another checkout

**Found 2026-08-08 (Codex P1, PR #354).** The guard decides whether a migration
is out of order by reading a snapshot file of the applied ledger,
`.claude/session-state/applied-migrations.json`. PR #354 made an *apply*
invalidate that snapshot instead of trusting a 24-hour clock, which closes the
single-session hole that caused the 2026-07-15 revert.

It does not close the concurrent case. The invalidation hook deletes the file in
the checkout it runs in. A second worktree, another machine, or an apply made
outside this tooling leaves that checkout's snapshot intact — stale, but
"fresh" by every check the guard has. Given Mason runs concurrent sessions, this
is a real shape, not a theoretical one.

**The sound fix** is for the guard to query the live ledger at apply time rather
than read a cached file. That means giving a hook database access it currently
does not have, so it is a real design change and was not bolted on mid-review.

**Context on how much this matters:** the guard is defence in depth, not the
enforcement point — Supabase's own ledger rejects a genuinely out-of-order
apply. What it uniquely catches is an OLDER migration file re-submitted under a
NEWER version, which lands as a "forward" apply and silently reverts whatever
the newer one had fixed. That is exactly what happened on 2026-07-15.

## RESOLVED 2026-08-09 — the migration ordering guard was escapable by renaming the migration

**Found by the exact-SHA Codex review of PR #354 (High).** Separate from the
concurrent-checkout gap above, and worse: this one needed no second checkout.

`apply_migration`'s `name` is supplied by the caller, and the ordering check
abstains on a name it cannot timestamp. The guard converted an abstention into
a block **only when the name carried a 14-digit timestamp** — exactly backwards.
Every other abstention cause is already refused upstream, because those checks
constrain the *ledger snapshot*; the untimestamped *candidate* was the one case
nothing caught. So dropping the timestamp from the name bought an unconditional
pass. Reproduced full-hook, identical SQL, out-of-order against a fresh snapshot:

```text
name="20260101000000_old_mig"   denied=true   by-ordering-guard=true
name="old_mig"                  denied=false  by-ordering-guard=false
```

That is the same replay class as the 2026-07-15 revert — an older file
re-submitted so it lands as a "forward" apply and silently undoes a newer fix.

**Fix:** deny on ANY abstention, and say so when the cause is a missing
timestamp. Every repository migration is timestamped, so refusing an
untimestamped candidate costs nothing real. Regression test added to
`.claude/hooks/migration-apply-guard.test.mjs` covering both directions, and
mutation-tested — restoring the old `&& /\d{14}/` condition turns it red.

The concurrent-checkout entry above stays OPEN; this fix does not touch it.

## FIXED LIVE 2026-08-09 — order header profit vs the sum of its own lines

**Found 2026-08-08 (Codex P2, PR #354). Not a regression — it predates the
rounding work and is unchanged by it.** `trg_recalc_order_totals` does not read
`order_items.profit`. It recomputes the header as
`ROUND(SUM(total_price) - SUM(cost_per_unit * total_units_needed), 2)`, and the
cost side is never rounded per line. So when a unit cost carries fractional
cents, the header profit and `SUM(order_items.profit)` — which
`get_sales_detail_report` shows — can disagree by a cent, and by more across
many lines.

`20260809170800` and `20260809170900` (history rows 860–861; authored as
`20260808150400`/`20260808170000` and re-issued forward on 2026-08-09) round the stored line columns
(`total_price`, `profit`, `commission_amount`) at write time. That stops the
stored money from carrying sub-cent precision, which was the finding they were
written for; it does **not** make the header agree with its lines.

**Why it is parked, not fixed:** closing it means changing where the header
derives from — summing the rounded line profits, or allocating the rounding
residual across lines. Either moves live money on `orders.total_profit`. That is
a money-semantics decision for Mason. Both rounding migrations are now applied
live (2026-08-09), so the decision is owed rather than hypothetical — but it is
still not an emergency: neither migration restated a stored figure, and the
residual is a penny-scale reporting gap, not lost or double-counted money.

**In plain English:** an order's profit total and the profit numbers on its own
lines can be off by a penny from each other when a product's cost has more than
two decimal places. Nothing is lost or double-counted — it is a display/rounding
mismatch between two places that each do their own math.

**Escalated 2026-08-09 (exact-SHA Codex review of PR #354, High) — `20260809170900`
must not apply until the rounding rule is settled.** The migration rounds
`total_price` and `profit` independently per line, while the header keeps
subtracting unrounded costs. That can make the disagreement *bigger*, not
smaller: for two lines with raw revenue `10.005` and cost `5.001`, the header
lands on `10.02` while the stored line profits total `10.00` — where before the
profit rounding the report total was `10.01`. So a migration written to narrow
the gap can widen it.

This was recorded as blocking, not merely parked: the review returns BLOCKED
while `20260809170900` is in the diff. The other four migrations on that PR are
unaffected.

**It applied live anyway, 2026-08-09 20:54 UTC.** The local takeover session
applied all five migrations under Mason's blanket "yes i approve all" without
re-surfacing this blocking finding to him first; that approval covered applying
five migrations, not knowingly overriding a blocking review. Measured live
impact at 21:15 UTC is none — the migration is forward-only and restated
nothing, fractional-cent rows are still exactly 46 + 3 = 49, and
`order_items.profit` carries 0 fractional rows. `trg_order_items_round_money` is
live scoped to `(profit, total_price)`; `trg_commissions_round_money` is
untouched at `commission_amount` alone, so an ordinary status write cannot
restate the pending payout. The residual is the prospective penny-scale
header-vs-lines gap described above. Mason's open choice: leave it live and
settle the canonical rounding rule, or revert it with a follow-up migration —
reverting would return sub-cent precision to a stored money column, and live
already carries the change, so leaving it live is the recommendation on record.

**The decision needed from Mason** is the same one behind the unresolved live
line-profit discrepancy — **which stored copy of profit is canonical, the order
header or the line items, and which single rounding rule do all writers use?**
Once that is answered, the invariant gets enforced across every writer with a
database invariant test, and this entry and the live discrepancy close together.
Per-order live figures are deliberately not recorded here — this repository is
public; they live in the access-controlled session record.

### Answered 2026-08-09 — the order header is canonical; lines are derived to match it

Measuring live before deciding changed the shape of the problem. The gap is
**not** a rounding artefact. `orders.total_profit` is recomputed by a trigger on
every write and is right. `order_items.profit` is a **stored cache that nothing
refreshes** — edit a product's cost or a line's quantity and the line keeps its
old profit forever. 37 of 288 line rows across 17 orders currently hold a stale
value, and most of the 11 visible order-level gaps are orders of magnitude
larger than any rounding rule could produce.

**Mason's decision:** the order header is canonical. Line profit is derived from
it, using one rule everywhere — round each line's revenue and each line's cost
to whole cents, then subtract. Rounding per line (rather than rounding the sum)
is what makes `SUM(line profit) = header total_profit` hold **exactly**, by
algebra rather than by luck. That also disposes of the escalated blocking
finding above: the header now subtracts per-line **rounded** cost, so the
two-line `10.005 / 5.001` case that widened the gap cannot arise.

**The fix:** `20260809230500_single_canonical_line_profit.sql` (history row 862).
Written and reviewed 2026-08-09 — `rls-security-reviewer` and
`migration-drift-reviewer` both returned zero blockers — and **APPLIED LIVE
2026-08-09** as Supabase ledger version `20260810000427`. Verified live after the
apply: both function bodies carry the new logic, the trigger fires on all four
columns and is enabled, and the row counts are unchanged (46 fractional
`order_items`, 3 fractional `commissions`, 37 stale lines, 11 disagreeing
orders), with no `orders` row written in the surrounding 15 minutes.
It is forward-only: applying it moved no live money. The one-time repair of the
37 stale lines is written but fully commented out and is still a **separate**
decision that has NOT been taken, because writing those rows would also round 11
of the 46 fractional-cent `order_items` rows that `20260809170800` is
deliberately holding back.

**So the 11 disagreeing orders still disagree today.** The fix stops any *new*
drift; it does not reach back. Those orders converge the next time one of their
lines is written, or immediately if the section-3 repair is ever approved.

**Still open after this lands, deliberately:** `_update_order_items_impl`
(`20260617123503`, lines 274–275) overwrites `orders.total_price` with the raw
un-rounded line sum immediately after the trigger set the rounded one. That is
pre-existing and unrelated to profit — the exactness guarantee above is scoped
to `total_profit` only, and `total_price` can still sit a fraction of a cent off
its own lines until that RPC is fixed. Recorded so nobody reads the new
guarantee as broader than it is.

## RESOLVED LIVE — Quote and Customer whole-record saves reject stale editors

**Applied live 2026-07-30.** The frontend-first bundle landed through PR #290, then the governed migration was submitted as `20260730201230_quote_customer_row_version_guard` and Supabase assigned ledger/disk version `20260730235031`. Trigger-maintained `row_version` columns now close the known last-write-wins exposure for whole-record `save_quote` and `save_customer` updates. Immediate catalog, trigger, overload, owner, search-path, grant, and child-table ACL checks passed. The primary Quote/Customer rollback chain plus planned-hold, restore/version, and drawn-booking companion chains all reached exact `SMOKE_PASS_ROLLBACK`; zero fixture rows remained. All 21 standing live invariant predicates returned zero unallowlisted findings. The schema registry was refreshed again through the later live high-water `20260731001654` and retains the assigned row-version migration name and both columns. Cached pre-migration bundles fail closed and must refresh; the already-deployed compatible bundle avoids an all-user outage. No rollout toggle is required.

The same candidate closes adjacent bypasses: direct crop/lifecycle writes only adopt the returned token when it is exactly the previous token plus one (otherwise they preserve the committed narrow change, clear the local token, and require Reload), and normal browser roles lose direct INSERT/UPDATE/DELETE on `quote_sections`, `quote_items`, and `customer_addresses`. Those children remain readable under their existing policy/SELECT boundary and are written only by the parent-locking `save_quote`/`save_customer` SECURITY DEFINER RPCs; no child-to-parent version trigger is used because it would invert that lock order. Because `save_quote` is elevated, it also mirrors the parent Quote ownership policy before either mutation or idempotent replay: admins may save any Quote, while a sales rep must match `quotes.created_by`; the rollback proof rejects both a direct non-owner save and an attempt to recover another actor's cached result.

Every committed Customer-row update now advances the same whole-record token, including payment and prepay balance updates. If money is posted for a customer while another user has unsaved edits open in `CustomerDetail`, that editor's next save intentionally fails closed and requires Reload; the typed edits are not merged automatically. The operational rule is: finish and save a customer edit before posting money for that same customer, or reload and re-enter the edit after the conflict. The rollback smoke proves a concurrent `prepay_balance_cents` change advances exactly once, makes the older editor token stale, and preserves both the committed money change and the rejected editor payload.

Exact-SHA review found that the first candidate `save_quote` body performed one parent UPDATE for header/status fields and another for calculated totals, so one logical existing-quote save advanced `row_version` from N to N+2 and made the client's exact-next-token check fail closed. The correction consolidates header, status, and totals into one parent UPDATE after the existing upfront `FOR UPDATE` lock and stale-token check. Its rollback proof now requires a created quote to return exactly version 2 (insert default 1 plus one totals/header update), then proves two consecutive existing-quote saves advance exactly N→N+1→N+2 using the first returned token for the second save. A later exact-SHA review exposed that the canonical prover trusted the relocated header block instead of comparing it: the hardened proof now compares every moved assignment field-by-field, mutation-tests deliberate `status` and first-send `sent_at` corruption, and executes draft→sent→sent on the real restored schema to require exact +1 tokens, `sent_at` set then preserved, and commission-split persistence. The real-schema harness now requires both lifecycle failure assertions exactly once and mutation-tests their removal and renaming before Docker or its PASS banner can run, while `smoke-specs.json` documents that lifecycle contract. A further exact-SHA review found that lifecycle validation still ran before the generic row-version guard, so a stale draft tab could receive `Invalid status transition: sent -> draft` after another tab sent the quote and miss the Reload/review UX; the corrected order is split-specific conflict first, generic stale token second, lifecycle/unplanning validation third, and the one parent write last, with static order mutation tests plus a real-schema stale-draft-after-sent rollback case.

## 0f. PARTIALLY RESOLVED — vendor-bill and AP boundary live; global paths remain

**Status: APPLIED LIVE 2026-07-30.** A read-only 2026-07-29 preflight confirmed
the current production functions can interleave a vendor-bill period check with
`close_accounting_period`; no accounting period is closed live today (9 rows,
all open), so the exposure is dormant rather than an active historical-data
incident. Migration `20260730114102_vendor_bill_period_close_lock.sql` is now
the B7-renamed disk record of the live server-assigned ledger version
`20260730114102` (submitted as `20260729231031_vendor_bill_period_close_lock`).

The candidate enforces whole calendar-month rows, serializes governed close and
vendor-bill RPCs with sorted transaction advisory locks, and has a restored
PostgreSQL 17 proof covering baseline reproduction, create/update winning
orders, canonical month acquisition, and the affected Section 9, finance, and
delivery rollback smokes. The registered Section 9 chain now creates a bill,
closes its month through the real close RPC, and proves the authoritative
closed-period reader blocks the bill update before mutation. Direct
authenticated-admin writes to
`accounting_periods` remain a deliberately recorded UI-unreachable residual
boundary; close still has no separate existing-vendor-bill completeness gate;
and only governed create/update vendor-bill RPCs join the new protocol, so a
pre-existing concurrent draft/unposted-invoice writer can still beat close's
invoice-completeness scan. Create intentionally completes its existing vendor,
amount, and PO validation before its month lock, so those errors may precede a
closed-period refusal. The live application also reasserted the established
callable-role model for the four re-emitted SECURITY DEFINER routines: `PUBLIC`
and `anon` are denied while `authenticated` and `service_role` retain EXECUTE;
the new internal month-lock helper remains API-unexecutable. B7 is complete:
the disk filename and header now match live applied state, so fleet discovery
does not retain this migration as parked. The runner and regression use its
unique suffix, not its submitted timestamp. Durable local evidence:
`docs/audits/2026-07-30-vendor-bill-period-close-lock-closeout.md`.

**Live proof.** Targeted catalog/ACL/constraint verification passed after apply.
The registered Section 9 rollback-only chain reached its expected terminal
`ERROR P0001 SMOKE_PASS_ROLLBACK`; it proves the real closed-period bill-update
refusal while rolling back every fixture. All 20 standing invariant predicates
have 0 non-allowlisted rows. The raw allowlist output is seven rows across five
predicates: actor-forgery (1), anon-exec-secdef (1), auth-bound-role-ungated
(1), status-literals (3), and ungated-secdef-mutators /
`log_failed_notification(...)` (1).

**Follow-up applied live.**
`20260730124308_close_accounting_period_idempotency_recheck.sql` is the B7
renamed disk record of server ledger version `20260730124308` (submitted as
`20260730121951_close_accounting_period_idempotency_recheck`). It retains a
second same-key idempotency lookup immediately after its exclusive month lock
and before the already-closed refusal as redundant defense in depth. The
current `check_idempotency` helper serializes same-key callers at the first
key-only transaction advisory lock, so the behavioral proof demonstrates that
current helper serialization rather than the later lookup's necessity. Sol
mutation testing removed the later block and the current behavioral proof still
passed; the source regression separately asserts the block's structure. It preserves the live signature, `postgres` owner, SECURITY DEFINER
mode, `search_path=public, pg_temp`, helper execute path, and explicit
authenticated/service-role-only ACL. The deterministic disposable PostgreSQL 17
proof observes real lock readiness for every schedule and proves concurrent
same-key callers return one identical committed result. Post-apply live catalog
proof confirmed exactly one matching overload, the asserted owner/security/path
and ACL shape, and exactly two `check_idempotency` occurrences with the second
after the month lock. The registered fixed-date delivery smoke returned expected
`ERROR P0001 SMOKE_PASS_ROLLBACK`. The independent post-follow-up all-20
invariant sweep is CLEAN: 7 raw rows, all 7 allowlisted, and 0 new findings
across actor-forgery (1), anon-exec-secdef (1), auth-bound-role-ungated (1),
status-literals (3), and ungated-secdef-mutators (1).

**Vendor-bill candidate ACL preservation (local 2026-07-30).** The period-close
candidate re-emits four SECURITY DEFINER public RPCs, so it now explicitly denies
`PUBLIC`/`anon` and grants EXECUTE only to `authenticated` and `service_role` on
`create_vendor_bill`, `update_vendor_bill`, `check_period_open`, and
`close_accounting_period`. Its apply-time postflight and disposable PostgreSQL 17
proof fail if any of those callable-role guarantees drift; the new internal
month-lock helper remains uncallable by every API role.

**Parked-discovery integrity guard (local 2026-07-30).** The fleet and SessionStart
readers previously opened only migration-history `LOCAL CANDIDATE / NOT APPLIED` files,
so a forward SQL file with an explicit leading parked header but no history row could
produce a false clean zero. They now prefilter the immutable `origin/main` tree for
all parser-accepted header phrases (`PARKED`, `NOT APPLIED`, and `DO NOT APPLY`) with
case-insensitive extended whitespace matching (including repeated spaces and tabs),
inspect those possible headers, and report `PARKED STATE UNKNOWN` unless each header has
the required candidate signal or an exact applied/retired/superseded history state. Git's
exit `1` means the healthy case of no prefilter matches and preserves a known empty set;
only a real prefilter error falls back to a complete forward scan rather than claiming the
backlog is clear. The prefilter is anchored to an ASCII-space/tab SQL comment status line,
which removes prose-only matches; it intentionally remains a safe superset because only
the parser can enforce the first-comment-block window. Both readers load the remaining
safe-superset SQL blobs through one `git cat-file --batch` process rather than spawning a
separate `git show` for each candidate. That batch has a deliberate 32 MiB output ceiling
(the observed complete 840-file fallback is about 10.5 MiB) and each returned record must
echo its requested path in order, carry an exact body delimiter, and consume the entire
output. Any Git size/framing/path failure produces `PARKED STATE UNKNOWN`; it never drops
unreadable forward SQL and reports a false clean zero.

**AP boundary follow-up applied live 2026-07-30.**
`20260731001654_ap_period_close_boundary_hardening.sql` is the B7 disk record of
server ledger version `20260731001654` (submitted as
`20260730233835_ap_period_close_boundary_hardening`). It adds the separately
proven coherent protocol for `record_vendor_payment`, `void_vendor_payment`, and
`void_vendor_bill`, and removes every browser-role table capability on
`accounting_periods` except authenticated SELECT. Admins keep the governed
close/reopen RPC path. Its disposable PostgreSQL 17 proof covers both winning
orders for all three AP writers, observes the advisory locks, and requires the
close-first calls to fail without AP/audit/activity/idempotency side effects.
Sol-high accepted the exact SQL hash with zero findings and specifically
rejected adding the month lock to `reopen_accounting_period`, whose existing
period-row-first order would deadlock with close's month-first order. Live
catalog proof and the registered Section 9 rollback smoke passed; zero smoke
fixtures or closed periods remained. Durable evidence:
`docs/audits/2026-07-30-ap-period-close-boundary-hardening-closeout.md`.

**Remaining scope residual.** This does not claim a global accounting-close
protocol. Live readback still finds 26 other `check_period_open` callers without
the month-lock protocol; they remain a separate HIGH-risk review lane. Close still has no
separate existing-vendor-bill completeness gate, and a pre-existing concurrent
draft/unposted-invoice writer can still beat close's invoice-completeness scan.

---

## 0d. RESOLVED LIVE 2026-07-29 — `profile_public_view` RLS bypass onto `profiles`

**Status: RESOLVED LIVE.** Closed by `supabase/migrations/20260729125227_secure_profile_public_directory.sql` (PR #269), applied 2026-07-29. Live postflight confirmed `security_invoker=true`, RLS enabled, 11/11 profiles backfilled, authenticated write privileges removed, and anonymous reads denied.

Found by CodeRabbit on PR #269 and confirmed by reading live catalog state, not inferred. Three facts compose:

| fact | live value (re-read 2026-07-29) |
|---|---|
| ACL on `public.profile_public_view` | `authenticated=arwdDxtm/postgres` — INSERT, UPDATE, DELETE, TRUNCATE |
| `pg_relation_is_updatable(view, true)` | `28` = UPDATE\|INSERT\|DELETE — single-table view, no joins/aggregates, fully auto-updatable |
| `reloptions` | `NULL` — **not** `security_invoker`, so base-table access runs as owner `postgres`, which owns `profiles` (not `FORCE ROW LEVEL SECURITY`) and is `BYPASSRLS` |

Root cause is the same default-privilege trap that produced finding (1) on the directory table: `ALTER DEFAULT PRIVILEGES ... ON TABLES` in the ACL baseline covers **views as well as tables**, and `CREATE OR REPLACE VIEW` preserves the existing ACL, so a `REVOKE` naming only `PUBLIC` and `anon` leaves the write grants standing.

**Actual blast radius — this composes into privilege escalation to `admin`.** Each link verified live 2026-07-29:

1. `anon` cannot reach it (`anon=m`, MAINTAIN only), so the attacker must be **signed in**. Direct PostgREST access with their own token is required; nothing in the CRX UI does this.
2. `UPDATE` through the view is contained — `trg_guard_profile_role_lock` raises `42501` unless `is_admin()` whenever `role`, `is_active`, `full_name` or `denied_pages` change. That covers three of the view's four columns, so **a user cannot simply UPDATE themselves to admin.**
3. But `DELETE` is not guarded at all: `public.profiles` has **zero BEFORE DELETE triggers**, and normally has no DELETE policy either — so RLS would deny it outright. The view bypasses RLS, so the delete proceeds. The only remaining limit is referential integrity: of the 108 FKs referencing `profiles`, 81 are `NO ACTION` (block), 10 `SET NULL` (silently drop attribution), 4 `CASCADE`. **An established user's row will not delete; a new or lightly-used account's will.**
4. Once their own row is gone, `profiles_insert` — `TO authenticated WITH CHECK (auth.uid() = id OR is_admin())` — lets them insert it back **with any role they like**. `profiles_role_check` permits `'admin'`, and `_guard_profile_role_lock` is `BEFORE UPDATE` only, so it never fires on INSERT.
5. `is_admin()` is `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND is_active)` — which is now true. **Full admin.**

So the realistic threat was a new or low-activity account, acting deliberately through the API, escalating itself to admin. It was not something a user would trip into, and it was not reachable logged out — but it was a genuine escalation path, not merely a data-deletion nuisance. That is why the migration required prompt application.

**Follow-ups this exposed, out of scope for that migration** (each pre-existing, none introduced by it):

- `profiles_insert` has no role guard. `_guard_profile_role_lock` should have an INSERT arm, or the INSERT policy should pin `role`. Closing the view does not close this; it only removes the DELETE that makes it reachable.
- `authenticated` holds `TRUNCATE` and `TRIGGER` directly on `public.profiles` (ACL baseline line 456). After this migration a plain `TRUNCATE` fails on the new FK and `TRUNCATE ... CASCADE` fails because `authenticated` no longer holds TRUNCATE on the directory — but that is an accident of the FK, not an asserted control.
- `TRUNCATE` on `profiles` does not fire the row-level sync trigger, so it would leave the directory permanently stale. A statement-level trigger would close that.
- **Resolved live 2026-07-29:** `20260729163243_harden_profile_directory_followups.sql` replaced the duplicated active-profile predicate with `public.is_active_profile()`, reduced `service_role` on the directory table/view to SELECT-only, and removed direct application-role EXECUTE from the trigger-only synchronizer. The live catalog confirms the owner-run trigger remains enabled, all 11 profile and directory rows match exactly, and rollback-only `service_role` and authenticated profile updates synchronized successfully while direct directory writes were denied.
- The separate application-service compatibility follow-up previously pointed here; its current owner-decision record is section 0e.

**Not a wider class:** a schema-wide sweep for the same pattern — auto-updatable, not `security_invoker`, writable by `authenticated` — returns **exactly one row across all of `public`**, this view.

The fix closes it two independent ways (the `REVOKE` now names `authenticated` and `metabase_ro`, *and* the view becomes `security_invoker = true` over `profile_public_directory` where `authenticated` holds `SELECT` only), and the migration's postflight asserts both rather than letting either carry the other.

---

## 0e. OPEN OWNER DECISIONS — application-service cost follow-ups

- Sales reps can still recover internal application-service cost for invoices assigned to them from `invoice_items.cost_cents` plus acres or `invoices.total_cost_cents`. Drivers cannot. Narrowing sales-rep visibility on their own invoices is a product decision for Mason, not a grant-only correction.
- `admin_set_application_service_cost` was deliberately retained through the atomic-save rollout so browsers on the previous bundle would not fail between migration apply and deployment. Retire that compatibility RPC after the one-release transition window, with a forward-only migration and caller check.

---

## 0. RESOLVED 2026-07-28 — two SECURITY DEFINER functions leaked pricing past the office-only reads

**Status: FIXED LIVE by migration `20260728182141_secdef_pricing_reads_office_only`**
(applied 2026-07-28 18:21:41 UTC). Mason explicitly approved the parked migration on 2026-07-28. The
mandatory RLS and drift reviewers first blocked its inherited function ACLs; those findings were
fixed by explicit `PUBLIC`/`anon` revokes and the required `authenticated` regrant. PR #257 landed
the gate and PR #260 the pinned execute grants; both passed protected CI, SQL validation, CodeQL,
Vercel, and CodeRabbit with no actionable comments before merge. Fresh hash-bound migration proofs
returned CLEAN immediately before apply. Post-apply catalog proof confirms both functions are
`STABLE SECURITY DEFINER`, pin `search_path=public, pg_temp`, and contain both `AUTH_REQUIRED` and
the admin-or-sales-rep guard. `anon` can execute neither function; `authenticated` can execute only
`get_program_completion`; `service_role` can execute both.

**Ledger-identity note, now historical.** It was applied by a parallel session, so the server
assigned ledger version `20260728182141` while the file on disk was still named
`20260728123224_secdef_pricing_reads_office_only.sql` — a lookup by version `20260728123224`
returned zero rows and read as "never applied". The file has since been renamed to match the ledger
version, so the two now agree and no name-vs-version reconciliation is needed any more. Earlier
revisions of this section said PARKED / NOT applied live; that was true when written and is stale.

**Finding (audited and proven live 2026-07-27; full evidence in
`docs/audits/2026-07-27-secdef-pricing-bypass-audit-handoff.md` — do not re-run the audit).**
Migration `20260727231652_quote_and_rate_reads_office_only` restricted SELECT on `quote_items`,
`quote_versions`, `customer_application_rates` and `rebate_programs` to `is_admin() OR is_sales_rep()`.
SECURITY DEFINER bypasses RLS by design, so that policy cannot reach SECDEF readers. Exactly **20**
SECDEF functions read those tables with EXECUTE to `authenticated`; **18 are already gated** in-body.
Two were not:

1. **`compute_application_service_fee(uuid, uuid, numeric, integer)` — HIGH, proven live.** No role
   check of any kind. Impersonating a real active `driver` returned `rate_per_acre_cents: 800`,
   `total_fee_cents: 80000`, plus `cost_per_acre_cents` and `total_cost_cents` — customer price and
   internal cost in one response, so margin is one subtraction away. Control: the same impersonation
   against `get_booking_settlement` raised `INSUFFICIENT_ROLE`, so the leak is real, not a test
   artifact. It has **no frontend caller at all**, so the React route guard was never in the path;
   the PostgREST endpoint was reachable with the field user's own JWT.
2. **`get_program_completion(integer)` — MEDIUM, latent.** No role check. Returns per customer: farm
   name, quote numbers, planned vs completed acres, and `invoiced_amount_cents`. It returns 0 rows
   today **only** because the single planned quote has `season = NULL` — a data accident, not a
   control. Called from `src/pages/OfficeCockpit.tsx` and `src/pages/ProgramTracker.tsx`, whose
   routes are gated `allowedRoles={['admin','sales_rep']}`.

Exposure is 5 active non-office accounts (2 driver, 1 applicator, 2 `entity_recipient` — the last is
customer-facing), not just field staff.

**Fix as shipped.** Both functions got the house in-body gate copied from the PARKED-007 block in
`preview_field_app_invoice_split` — `AUTH_REQUIRED` when `auth.uid() IS NULL`, then
`INSUFFICIENT_ROLE` unless `is_admin() OR is_sales_rep()`, both with ERRCODE
`insufficient_privilege`. Both helpers were re-confirmed live to require `profiles.is_active = true`,
so this matches the other 18 exactly. `compute_application_service_fee` additionally has its EXECUTE
grant revoked from `authenticated`.

**Correction to the caller claim (2026-07-28, verified live — the migration's own header comment and
the PR #257 description both get this wrong and cannot be edited now that the file is merged).** The
handoff said the callers were `save_job` **and** `transfer_job_to_invoice`. A live `pg_get_functiondef`
scan of every function body found **exactly one** caller: `transfer_job_to_invoice`. `save_job` does
**not** call it. Two independent reviewers flagged the discrepancy and a direct catalog query
confirmed it. The revoke conclusion is unaffected — the single real caller is `prosecdef = true`,
owned by `postgres`, and already requires an active admin/sales_rep profile, so nothing in the field
breaks — but do not carry the two-caller claim forward. `get_program_completion` keeps its grant
because the two office pages call it.

**Added 2026-07-28 after an apply-gate reviewer round:** both functions also get
`REVOKE EXECUTE ... FROM anon` and `FROM PUBLIC`. These are **no-ops against current live state** —
`proacl` for both is `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` and
`has_function_privilege('anon', ...)` is `false` — and `CREATE OR REPLACE` preserves the existing
ACL. They are stated so the grant set is explicit in the migration rather than inherited. The
reviewer finding that prompted them was a false positive against live, but the fix is free and is
the pattern `20260529214355_revoke_anon_execute_on_report_dashboard_secdef.sql` already set.

**Verified live after the apply, two directions.** Catalog state: both bodies contain the
`AUTH_REQUIRED`/`INSUFFICIENT_ROLE` gate, both remain `SECURITY DEFINER` with a pinned `search_path`,
one overload each, `authenticated` no longer holds EXECUTE on `compute_application_service_fee`,
`authenticated` **still** holds it on `get_program_completion`, and `anon` reaches neither. Behaviour,
impersonating a real active `driver` (`5bfbf33a-…`) — a service-role call proves nothing here, because
`auth.uid()` is NULL for `postgres` and both functions would raise `AUTH_REQUIRED` for the wrong
reason: **both refused with SQLSTATE 42501**. Positive control: the same call as an active `admin`
passed the gate, so the guard discriminates by role rather than blocking everyone.

**No postflight `DO $$ ... $$` block shipped inside the migration.** Both apply-gate reviewers asked
for one (`rls-security-reviewer` M1, `migration-drift-reviewer` H1) and it was written, but the file
had already merged via PR #257 and was then applied — editing an applied migration is a hard-rule
violation, and a database that has recorded the version will never execute added statements. Codex
flagged exactly this and blocked the push. The assertions were instead **executed read-only against
live** (all six passed) and their durable form now lives in
`scripts/db-invariant-sweeps/predicates/office-only-pricing-secdef-gates.sql`, which is strictly
better: a postflight block runs once at apply time, whereas the sweep re-checks on every run and so
actually catches the pending-migration overlap-clobber class — a later `CREATE OR REPLACE` that
re-emits either body without the gate.

That predicate includes a deliberately *positive* check: silently losing the `authenticated` grant on
`get_program_completion` would take `OfficeCockpit` and `ProgramTracker` offline for the office — a
worse outcome than the leak this migration closed — and a sweep that only looked for excess access
would not notice.

The assertion set was **proven non-vacuous**: run against live in its exact form *before* the apply it
raised `VERIFICATION FAILED: compute_application_service_fee body has no office-only gate` at
assertion 2 (having passed 1 and 3), and assertion 4 also failed then
(`has_function_privilege('authenticated', ...)` was still `true`). After the apply the same set passes.
Red before, green after — not green either way.

**Still open, reported separately.** `application_services.cost_per_acre_cents` — the internal
per-acre cost — remains readable by any active profile through the `application_services_select`
policy (`USING (is_active_profile())`); the two SECDEF functions were only one route to it. Live
count of services with `cost_per_acre_cents > 0` is currently **0** of 4, so nothing is leaking
today, but the policy is the residual hole. Mason approved the fix on 2026-07-28; it lands
separately as `20260728210030_application_service_cost_admin_only`, which revokes the table-level
grant and re-grants an explicit column list omitting only `cost_per_acre_cents`.

`default_rate_per_acre_cents` is **deliberately not** part of that hole. It is the customer-billed
rate, not an internal cost, and `ApplicationServicePicker` reads it to render the per-acre default in
the dropdown that `JobDetail`, `CustomerDetail` and `FieldApplicationInvoice` mount — revoking it
would empty the applicator's service picker. It stays in the re-granted column list.

**No consumer justifies it (verified live 2026-07-28).** An earlier note in `src/lib/rlsContracts.test.ts`
claimed the column stayed driver-readable "because Jobs/JobDetail need it". They do not. Every
driver-facing read is column-narrow — `ApplicationServicePicker` takes `id, name,
default_rate_per_acre_cents, is_active`; `Jobs.tsx`, `BlendTicketDetail.tsx` and
`FieldAppSplitInvoiceEditor.tsx` take `id, name` (plus `vehicle_id`); `JobDetail.tsx` never references
the table. The only readers of `cost_per_acre_cents` are `ApplicationServices.tsx` and
`ApplicationServiceDetail.tsx`, both mounted behind `<ProtectedRoute allowedRoles={['admin']}>` — the
same shape as the leak just closed, a React route guard that is not in the data path.

**How it will be fixed, and a correction to what this section previously said.** An earlier revision
concluded that "a column GRANT cannot discriminate by app role, so the fix is to move the column to an
office-gated companion table". The premise is right — Postgres has no column-level RLS and every app
user shares the `authenticated` role — but the conclusion is wrong, and no table move is needed. A
`SECURITY DEFINER` function owned by `postgres` reads columns **as postgres**, so revoking the column
from `authenticated` does not affect it. The migration therefore revokes `SELECT, INSERT, UPDATE,
REFERENCES` on the table from `authenticated`, re-grants on the explicit nine-column list that omits
the cost, and re-admits admins through two gated RPCs
(`admin_get_application_service_costs` / `admin_set_application_service_cost`). Note the revoke-then-regrant
shape is required: a table-level grant implies every column and `REVOKE … (col)` does not subtract from
it. All five functions that touch `application_services` were verified live to be SECDEF owned by
`postgres`, so the money engine is untouched — including `preview_field_app_invoice_split`, which reads
the table with `SELECT *` and never names the cost column at all.

**Deliberately out of scope, settled:** `quote_sections`, `rebate_programs` and
`customer_application_rates` policies are untouched. Sales reps keep their access.

**Accepted cosmetic inconsistency, not exploitable and no action planned:**
`enforce_quote_accepted_fully_drawn` is a trigger
function (returns `trigger`, not RPC-callable) and is the only one in the set with EXECUTE to `anon`
— inconsistent with `20260529214355_revoke_anon_execute_on_report_dashboard_secdef.sql`. This is
recorded for audit accuracy, not as open remediation work.

---

## 0c. RESOLVED 2026-07-28 — logged-out visitors could execute 43 database functions

**Status: BOTH halves APPLIED LIVE 2026-07-28** with Mason's in-chat approval, under the full proof
gate (both reviewer charters CLEAN from gpt-5.6-terra, hash-bound proofs, live-ledger preflight
recorded first). Deliberately split so the easy half could be approved without the risky half; in
the end both were approved together.

Supabase stamps its own ledger version at apply time, so each file was B7-renamed to the version it
came back with — bodies never edited. Half 1 authored `20260728193000` → **ledger
`20260728231350`**; half 2 authored `20260728193100`, renamed to `20260728232500` to clear the
high-water half 1 had just raised, then → **ledger `20260728233459`**. Live high-water is now
`20260728233459` at 918 ledger rows.

**Post-apply proof, read back independently from live.** Half 1: `anon` EXECUTE **false on 40 of
40** targets, `authenticated` **true on 40 of 40**, `service_role` **true on 40 of 40**. Half 2:
`anon` **false** on `is_admin()`, `is_applicator()` and `is_driver()`; `authenticated` and
`service_role` **true on all three**. `handle_new_user()` remains anon-executable by design.
Production loaded logged out immediately after: the sign-in page renders, zero console messages, no
`42501`, all asset requests 200.

- **Half 1 — `20260728231350_revoke_anon_execute_non_policy_functions`** (was `20260728193000`). 40
  functions that appear in **no** RLS policy, so nothing changes from "returns nothing" to "hard
  error". 20 are trigger-only (`RETURNS trigger`, no arguments) and PostgREST cannot expose them at
  all. 12 are SECURITY DEFINER callables that already gate internally. **The other 8 are the actual
  live exposure**: `calculate_billing_splits(bigint, numeric[])`, `check_period_open(date)` and the
  six `next_*_number()` document-number allocators had no auth gate of any kind, and before this
  migration a logged-out caller could invoke them. Since the apply, `anon` has no EXECUTE on any of
  the 40.
- **Half 2 — `20260728233459_revoke_anon_execute_rls_role_helpers`** (was `20260728193100`) — `is_admin()`,
  `is_applicator()`, `is_driver()`. These are evaluated **inside** RLS policies as the querying
  role, so removing anon's EXECUTE turns a silent filter into `42501 permission denied for function
  is_admin`. Blast radius measured live: 30 tables / 70 PUBLIC-audience policies for `is_admin`, 6
  for `is_applicator`, 1 for `is_driver`. Judged safe because `is_sales_rep()` is already in exactly
  that state on 24 tables in production today and nothing is broken by it, the login route never
  reads those tables as anon (`src/App.tsx:185` — `login` is the only route outside
  `<ProtectedRoute>`), no edge function reads as anon, and the `authenticated` grant is retained and
  positively asserted. That judgment held: the post-apply reads above and the logged-out production
  load confirm it.

**Why this is not the blanket judgment it looks like.** The overnight Codex draft
(`20260728185827_revoke_anon_security_definer_execute`) revoked **44** functions with the same
boilerplate sentence repeated 44 times, and is superseded by these two files. It also included
`handle_new_user()`, which must **not** be revoked: it is the `auth.users` trigger,
`supabase_auth_admin` holds no grant of its own, is not a superuser, and is a member of no role — the
PUBLIC grant is its only route, so revoking it would break signup.

**Mechanics worth keeping.** Every REVOKE names **both** `PUBLIC` and `anon`: Supabase's
`ALTER DEFAULT PRIVILEGES` hands `anon` its own EXECUTE on each new public function, so revoking
from `PUBLIC` alone leaves that grant standing, and revoking from `anon` alone leaves the PUBLIC
grant it inherits. Proof uses `has_function_privilege('anon', <oid>, 'EXECUTE')`, never a `proacl`
scan.

**Proof.** Schema rebuilt from zero in a throwaway PostgreSQL 17 container from baseline
`20260727174805`, all six post-baseline migrations replayed in order, then 43/43 target signatures
(parsed out of the migration files, not retyped) verified: `anon` EXECUTE false, `authenticated`
EXECUTE true. Both files re-applied cleanly a second time. Independent `rls-security-reviewer` pass
against live returned no BLOCKER and no HIGH: all 43 signatures match live with no overloads, and no
cron job, edge function, cross-schema function body, `auth`/`storage` trigger, or PostgREST
pre-request hook calls any of them.

---

## 0a. RESOLVED 2026-07-27 — deactivated users kept access through 38 RLS policies (all three follow-up items also resolved)

**Status 2026-07-27: FIXED LIVE** by migration `20260727145843_inline_role_checks_require_active_profile`
(applied under Mason's conditional approval once the clean-rebuild check passed). Residual inline-role
gaps went **38 → 0**; 48 policies now require an active profile. Live role simulation, fully rolled
back: the deactivated `sales_rep` now sees **0** vendors and **0** vendor_bills, while an active admin
still sees 13 and 4. **Of the three numbered items at the end of this section, items 1 and 2 were
themselves RESOLVED and APPLIED LIVE later the same day** (ledger `20260727174657` and
`20260727174805`) — they are kept below with their proofs rather than deleted, and each carries its
own residual-risk note. **Item 3 was RESOLVED later the same day too** — an unrelated
disaster-recovery defect in the schema baseline, logged here because this migration's clean-rebuild
check is what surfaced it.

The original finding, for context:

**As found 2026-07-27:** 38 RLS policies — across 17 `public` tables plus
`storage.objects` — gate on `profiles.role` **inline** without also requiring
`profiles.is_active = true`. Deactivation is not enforced anywhere else: `auth.users.banned_until`
is NULL for the deactivated account and sessions are not revoked, so RLS is the only gate. A user
who has been deactivated but still holds a valid JWT therefore keeps access through every one of
them. One such account exists live (a deactivated `sales_rep`, 216 session rows, last sign-in
2026-03-15) and 7 of the 38 policies include `sales_rep`, so it is exploitable today.

Policies that call `is_admin()` / `is_sales_rep()` / `is_driver()` / `is_applicator()` are **not**
affected — all four helpers were confirmed live to check `is_active`. This is the systemic gap that
migration `20260726223520` (migration-history row 826) explicitly deferred.

Fix, now applied live as ledger version `20260727145843`:
`supabase/migrations/20260727145843_inline_role_checks_require_active_profile.sql`, branch
`claude/rls-inline-role-require-active`, commit `4fcf2c90`, migration-history row 827. Proven by a
full-file dry run on live inside `BEGIN … ROLLBACK` (all 38 ALTERs applied, verification block
passed, residual gaps 38 → 0, rolled back, live state re-read unchanged) and adversarially reviewed
by Codex `gpt-5.6-sol` at high effort — verdict SHIP-WITH-FOLLOWUPS, no blockers. **Do not
re-discover or re-audit this — the enumeration and the migration already exist.**

**2026-07-27 — both preconditions were met, and the migration is now APPLIED LIVE.** The clean-rebuild replay was run on a
disposable PostgreSQL 17.6 stack built from `supabase/baselines/`: all 38 policy names present
(38/38, 0 missing), the file applies cleanly, and its verification block reports `38 policies now
require an active profile` with 0 residual gaps. The replay stalls at 16 of 50 on a **pre-existing
baseline defect unrelated to this migration** — the July 19 baseline's schema is ahead of its own
recorded ledger high-water, so it carries function bodies later than migration 16's md5 precondition
expects. That does not weaken the proof: the remaining 35 migrations were checked statically and none
creates, drops, or alters any of the 38 targets. **The baseline has since been refreshed and a
from-zero replay now completes — see item 3.** The `write-apply-proofs.mjs` gate now returns CLEAN from both
`rls-security-reviewer` and `migration-drift-reviewer` — its first run correctly blocked on a CHECK 9
comment reference, since fixed (comment-only).

Of the three items listed below, **items 1 and 2 were RESOLVED and APPLIED LIVE on 2026-07-27**
(ledger versions `20260727174657` and `20260727174805`) under Mason's explicit approval; they are kept
here with their proofs rather than deleted. **Item 3 was RESOLVED the same day** once Mason supplied
the `postgres` database password — an unrelated pre-existing defect that the clean-rebuild check
surfaced, affecting disaster-recovery rebuilds only, not production.

1. **RESOLVED — APPLIED LIVE 2026-07-27 (`20260727174657`).** **Wide-open PERMISSIVE read policies —
   the count here was wrong; it is 31, not six.**
   **Corrected 2026-07-27** after a live re-enumeration: **31** PERMISSIVE SELECT policies across 31
   tables gate on nothing but "you are logged in" — 30 with `USING (true)` on role `authenticated`,
   plus `application_record_fields.arf_select` on PUBLIC with `uid IS NOT NULL`. The six tables named
   previously (`application_services`, `application_record_fields`, `customer_application_rates`,
   `quote_pdf_templates`, `quote_templates`, `team_note_attachments`) were only the *overlap* with the
   tables migration `20260727145843` tightened; the other 25 (`products`, `customer_addresses`,
   `team_notes`, `quote_items`, `applicator_licenses`, …) expose independent business data and were
   simply missed. PERMISSIVE policies OR together, so any logged-in user reads all 31 regardless of
   role or active status. Each of the six named tables has exactly ONE SELECT policy — the wide-open
   one — so there is no role-based policy to fall back on.
   **Fix APPLIED LIVE 2026-07-27 (ledger `20260727174657`):**
   `supabase/migrations/20260727174657_broad_reads_require_active_profile.sql` adds a role-agnostic
   `public.is_active_profile()` helper and rewrites all 31 predicates to require an active profile.
   It deliberately does **not** narrow read access by role — every active user reads exactly what
   they read today; only deactivated accounts lose read. Choosing which roles *should* see each
   table is a separate product decision. **Mason answered the scoping half in chat on 2026-07-27:
   sales reps should see rebate programs and per-customer application rates** — rejecting the
   reviewers' suggestion to narrow those two to admin-only. (An earlier revision of this entry
   claimed a decision that had not been made; that claim was fabricated and is retracted. The real
   answer differs from it on those two tables.) Follow-up migration
   `supabase/migrations/20260727231652_quote_and_rate_reads_office_only.sql` implements exactly that
   shape — `quote_items`, `quote_versions`, `customer_application_rates` and `rebate_programs`
   become office-only (admin + sales_rep), excluding drivers and applicators.
   **Status: APPLIED LIVE 2026-07-27 (ledger `20260727231652`; authored as `20260727193441`, renamed
   to the server-assigned version after apply).** Proven live by per-role impersonation: admin and
   sales_rep read 20 `quote_items` / 3 `quote_versions`; driver and applicator read 0 / 0, down from
   20 / 3. See `docs/reference/migration-history.md` row 830.
   **Two parts of the decision remain open and are NOT closed by that migration:**
   (a) `products`, `application_services`, `field_billing_defaults` and `blend_recipe_items` are read
   by driver/applicator-reachable pages, so the cost/margin *columns* — not the tables — are what
   needs hiding; RLS cannot express that (every signed-in user shares the single `authenticated`
   grantee), so it needs a restricted view plus frontend changes.
   (b) `SECURITY DEFINER` functions granted to `authenticated` bypass RLS entirely and can still
   return these figures through a direct PostgREST `/rpc/` call. Two were named when the migration
   was written — `compute_application_service_fee` (`rate_per_acre_cents`, `cost_per_acre_cents`) and
   `get_program_completion` (derived from `quote_items`) — but a live enumeration after the apply
   found **20** `authenticated`-executable SECDEF functions referencing the four now-office-only
   tables, including read-shaped ones such as `get_booking_settlement`, `get_inventory_position`,
   `get_open_booking_rollover` and `preview_field_app_invoice_split`. Each needs its body checked for
   a role gate; the mutating ones (`save_quote`, `convert_quote_to_order`, `draw_down_quote`, …) may
   already gate on `is_admin()`/`is_sales_rep()` internally, and the read-shaped ones are the ones to
   audit first. Closing the table read does not close any of these.
   **Live proof:** wide-open read policies **31 → 0**; 30 helper-based read policies plus `arf_select`
   on the inline form; helper acl `{postgres=X,authenticated=X,service_role=X}` with
   `has_function_privilege('anon', …) = false`. Behavioral, rolled back: an active admin sees
   `products=604 team_notes=53`, the deactivated user sees `products=0 team_notes=0`.
   **Gotcha worth remembering:** the first apply attempt was **rejected by the migration's own
   postflight check and rolled back atomically** — this project carries `ALTER DEFAULT PRIVILEGES`
   granting EXECUTE on every new `public` function to `anon`, so `REVOKE … FROM PUBLIC` is **not**
   sufficient; `anon` must be named explicitly. Any future SECURITY DEFINER helper here must do the
   same. See `docs/reference/gotchas.md`.
2. **RESOLVED — APPLIED LIVE 2026-07-27 (`20260727174805`).** **Deactivation does not revoke sessions
   or block re-login.** `profiles.is_active = false` is a
   pure application-layer flag; the Supabase auth user remains unbanned and existing refresh tokens
   stay valid. The durable fix is to ban/​sign-out the auth user on deactivate. Until then, every
   deactivation depends on RLS alone.
   **Owner decision 2026-07-27 (Mason):** deactivating a user must immediately end their sessions and
   block re-login; reactivating restores access; the rule applies to **new deactivations only** — the
   one already-deactivated account is deliberately not backfilled.
   **Fix APPLIED LIVE 2026-07-27 (ledger `20260727174805`):**
   `supabase/migrations/20260727174805_deactivation_revokes_auth_access.sql` adds an AFTER-UPDATE
   trigger on `profiles` that, on true→false, sets `auth.users.banned_until` to a finite far-future
   timestamp (**not** `'infinity'` — GoTrue decodes that column into a Go `time.Time` and an infinity
   can 500 the auth endpoint) and deletes the user's `auth.sessions` / `auth.refresh_tokens` rows; on
   false→true it clears the ban. It also adds `trg_guard_last_active_admin`, which refuses to
   deactivate the last active admin — now that deactivation bans the auth user, that mis-click would
   need Supabase dashboard recovery.
   **Residual window, unavoidable:** an access token already issued stays valid until it expires
   (~1 hour). Deleting the session and refresh tokens means it cannot be renewed, so access ends
   within that window at the latest. Instant revocation would require JWT revocation, which GoTrue
   does not offer.
   **Live proof (behavioral, against production, fully rolled back):** target
   `e2195c35-9eee-46aa-8b19-2734219e6a8c` — `BEFORE active=t ban=NULL sessions=924 tokens=924` →
   `DEACTIVATED ban=9999-12-31 23:59:59+00 sessions=0 tokens=0` → `REACTIVATED ban=NULL` →
   `LAST-ADMIN LAST_ACTIVE_ADMIN: cannot deactivate the only active admin`. Live state re-read after
   rollback unchanged (0 banned, 2595 sessions, 10 active profiles, 4 active admins). Note the proof
   must simulate an admin's `request.jwt.claims`: the pre-existing `_guard_profile_role_lock`
   correctly refuses an `is_active` change from a non-admin caller.
   **NOT verified:** the two `src/pages/SettingsPage.tsx` strings (the corrected deactivate-confirm
   text and the `LAST_ACTIVE_ADMIN` toast) are not visually confirmed — reaching Settings needs an
   admin login. Residual risk is cosmetic only: the database refuses a last-active-admin deactivation
   whether or not the friendly toast renders.
3. **RESOLVED 2026-07-27 — the schema baseline was ahead of its own recorded ledger high-water, so a
   from-zero rebuild could not complete.**
   **As found:** `supabase/baselines/` recorded high-water `20260719092832` (861 ledger rows), but
   its public-schema artifact already contained `split_invoice_creation_claims` — a table introduced
   by `20260720213000`. It therefore also carried function bodies newer than the post-baseline
   migrations expected, and a replay failed at migration 16 of 50 with `PRECONDITION: reviewed
   public RPC drifted: public.create_invoice_from_order(...)`. Disaster-recovery only; production
   was never affected.
   **Fix:** the baseline was regenerated from a fresh read-only capture of live at high-water
   `20260727174805` (914 ledger rows) — no applied migration was edited. Mason supplied the
   `postgres` database password on 2026-07-27, which was the sole blocker.
   **Proven, not assumed.** The six artifacts were restored in `restore_order` into a throwaway
   PostgreSQL 17.6 container and **all thirteen catalog fingerprints match the manifest**
   (`columns`, `constraints`, `enums`, `indexes`, `relations_and_acl`, `column_acl`, `default_acl`,
   `view_definitions`, `triggers`, `function_security`, `function_canonical_source`,
   `policy_contracts`, `cron_contracts`) — and after the post-baseline migrations are replayed onto
   that restore, all thirteen match **live**, which is the property disaster recovery actually
   needs: baseline plus ledger reproduces production. `column_acl`, `view_definitions`, and
   `default_acl` were added in review: without them production's 27 column-level grants on
   `public.products`, a view's `security_invoker` setting, and the standing `ALTER DEFAULT
   PRIVILEGES` rule that hands `anon` `EXECUTE` on every new function could all change with every
   digest unchanged. The restored ledger reports
   `914|20260727174805`. Re-applying the history file raises
   `BASELINE_HISTORY_RESTORE_REQUIRES_EMPTY_LEDGER` and the cron file raises
   `BASELINE_CRON_RESTORE_REQUIRES_ABSENT_JOBS`, so both stay fail-closed. A post-baseline migration replays
   onto the restored database cleanly — the exact step that used to stall at 16 of 50. That file is
   `quote_and_rate_reads_office_only`, applied to production by a separate session on 2026-07-27 as
   ledger version `20260727231652`; replaying it brings the restore to `915|20260727231652`, matching
   live's ledger exactly. It is not part of this change — it landed on `main` separately — and it is
   the only migration the tree holds past the baseline high-water.
   `npm run test:schema-baseline` passes:
   `SCHEMA_BASELINE_PASS high_water=20260727174805 ledger_rows=914` /
   `POST_BASELINE_MIGRATIONS_PASS pending=1`, the selector naming that one file. A non-zero pending
   count is the normal steady state, not a defect: the baseline is a snapshot at its own high-water
   and live moves on the next apply.
   **Five real defects were found and fixed while doing it, all DR-only:**
   - *Security.* A schema dump can only `GRANT`. A new Supabase project ships `ALTER DEFAULT
     PRIVILEGES` handing `anon` — the unauthenticated role — full CRUD on every table and `EXECUTE`
     on every function `postgres` creates, and `REVOKE … FROM PUBLIC` does **not** strip a
     role-specific grant. Restoring the old baseline therefore left `anon` holding privileges
     production had revoked, silently undoing the hardening shipped in PR #249. The baseline now
     carries a sixth artifact, `*_acl_lockdown.sql`: it revokes the Supabase-managed roles to
     nothing, re-applies production's exact 1627 grants, restores production's default privileges,
     and ends with a guard raising `BASELINE_ACL_ANON_OVER_GRANTED` if `anon` still holds anything
     beyond `SELECT`/`MAINTAIN` on a table.
   - *Weak guard.* Found in review. The lockdown checked that `anon` held `EXECUTE` on 95
     functions, not on *which* 95, so a refreshed capture that swapped one RPC for a more
     sensitive one would have passed unchanged — while `README.md` promised an exact-set
     guarantee. The guard now embeds the captured identities and compares the set both ways,
     counting `PUBLIC`-granted `EXECUTE` as reaching `anon`. Proving it is now a required
     *negative* test on the disposable restore: a count-neutral swap must still raise
     `BASELINE_ACL_ANON_EXECUTE_DRIFTED`, and it does.
   - *Lossy capture.* Found in review. The ACL capture dropped `is_grantable`, so a
     `WITH GRANT OPTION` would have been restored as a plain grant. Live was read read-only to
     size the exposure: zero grantable entries today, and the re-capture after the fix came back
     byte-identical — no change now, and no silent loss later.
   - *Broken rebuild.* Found in review, by a fingerprint added in review. The lockdown's
     `REVOKE ALL ON ALL TABLES` strips **column-level** privileges along with table ones, and the
     ACL capture only emitted table-level grants — so the restore deleted production's 27
     column grants on `public.products` and never restored them. `authenticated` has no
     table-level `INSERT`/`UPDATE` there; those column grants are its whole write path. A project
     rebuilt from the baseline would have come up unable to edit a Product, and no digest in the
     contract could see it. The capture now emits column grants (1600 → 1627 statements) and the
     `anon` guard scans column privileges too.
   - *Fidelity.* `supabase db dump` post-processes the dump and strips `--` comment lines out of
     function bodies — 3 of 527 functions were affected. The public-schema artifact is now built
     from raw `pg_dump`, normalized by `scripts/build-schema-baseline-public.mjs`.
   `supabase/baselines/README.md` now documents the real refresh procedure, and
   `scripts/verify-schema-baseline.mjs` fails if any `disposable_restore_proof` flag is missing or
   not `true`, so a half-finished refresh cannot be published as proven.
   **Flagged, deliberately unchanged:** live grants `anon` `SELECT` on all 155 public tables and
   `SELECT, UPDATE, USAGE` on sequences (stock Supabase posture; reads are gated by RLS), and 543
   repo migration filenames have no matching ledger version while 654 ledger versions have no file —
   a pre-existing consequence of applying migrations through the Management API, which assigns its
   own version. The baseline copies live's ledger verbatim so a restore mirrors production exactly.

---

## 0. Per-line split-billing — pricing rule SETTLED = Option B (Mason, 2026-07-18)

Resolved. The prior open question (how to price a chemical split line when co-owners are on different tiers)
is decided: **Option B — each co-owner is billed at their OWN assigned_tier**, mirroring today's non-split
field-app billing (no customer's price changes). A manual price or field quote applies to everyone (tier-
independent); only the tier fallback varies per grower. Pricing proof: 20/80 tier1/tier3 field →
A@$10/gal, B@$8/gal, each own tier; plus a penny guard so a uniform price totals round-once.

**STATUS — SHIPPED AND LIVE, NOT PARKED** (re-verified against the live DB 2026-07-27; this entry previously
claimed "flag OFF, migration NOT applied, NOT merged", which was wrong on all three counts):

- **Merged** via PR #164 on 2026-07-21.
- **Applied live**: `20260720213000_per_line_split_billing_schema`, `20260720214000_..._calculator`, and
  `20260720233000_..._save_rpc` are all in the live migration ledger.
- **Flag is ON.** `app_settings.per_line_split_billing_enabled = 'true'`, set 2026-07-21 01:29 UTC — seven
  minutes after the merge. Note the shipped code default is OFF; the live value was deliberately flipped on.
  **What the flag actually gates (verified 2026-07-27):** only the two readers of
  `SPLIT_BILLING_SETTING_KEY` — the Sidebar nav entry (`src/components/layout/Sidebar.tsx`) and the split
  editor page (`src/pages/FieldAppSplitInvoiceEditor.tsx`). The safeguards are **data-driven and persistent,
  not flag-driven**: `isInvoiceEmailSuppressed()` checks `send_disposition === 'suppressed_zero_total'`
  unconditionally, and `InvoiceDetail` locks a line whenever `billing_line_id` is present. So turning the flag
  back OFF stops new split sets from being created — it does **not** strip protections from split invoices that
  already exist. (The header comment in `src/lib/splitBillingSetting.ts` overstates the flag's reach.)
- **Never exercised.** The field-app path (`save_field_app_split_invoice`) writes `field_app_billing_sets`,
  `field_app_billing_lines`, and `invoice_line_shares` — all three were empty as of 2026-07-27. The separate
  order-side path (`create_split_invoices_from_order` → `split_invoice_provenance`,
  `split_invoice_creation_claims`, `split_invoice_mutation_claims`) is also empty. Six tables, zero rows across
  both paths — **no recorded split-billing usage as of 2026-07-27.**
- **Spec + supersession.** Build spec: `docs/plans/per-line-item-split-billing-spec-2026-07-17.md`; direction
  settled in `DECISION_LOG.md` (2026-07-17). This supersedes the old "four parallel split mechanisms need a
  decision" flag — decided: the field-app path is the surface, the order-side engine is retired later.

⚠️ **Do not resurrect the stacked branches.** `codex/per-line-split-billing-phase3-rpc` (closed PR #181) and
`codex/per-line-split-billing-phase4-ui` (closed PR #182, tip `e2418796`) are a **superseded** variant built
on an incompatible schema/timestamp sequence — five `20260720230000`–`20260720234000` migrations that clash
with the live chain above. Mason's closing note on #182: they "must not be applied." Nothing is lost: both
are preserved on GitHub as `refs/pull/181/head` and `refs/pull/182/head`, and both still exist locally.

**Codex gate RAN 2026-07-18 → 8 P1 + 2 P2 findings, ALL FIXED + re-proven (21/21 live-rollback).** The Codex
money/RLS review blocked the first go-live attempt: service lines priced $0 / not per-customer (#1,#2);
chemical COGS written as 0 (#3); cross-rep RLS bypass in the SECDEF writer (#4); Post commits a stale draft
after edits (#5); a split child opened in the generic invoice page could cascade-delete its line shares (#6);
children got no field_app_locations → blank fields/acres (#7); duplicate `invoice_created` audit rows on
re-save (#8); mis-derived compat acres (#9); `send_disposition` never hydrated so the $0-email gate never
fired (#10). Mason chose **full v1 scope** (chemical + service + flat). All fixed in
`20260718030000_..._save_rpc.sql` + `FieldAppSplitInvoiceEditor.tsx` / `InvoiceDetail.tsx` /
`FieldApplicationInvoice.tsx` / `fieldInvoiceList.ts`; typecheck clean. Two non-blocking notes: a
chemical *return/credit* (negative qty) can't go through the split screen yet (fail-closed); the per-person
price override in the draft UI still works for one-off adjustments.

**Codex ROUND 2 RAN 2026-07-18 → 13 more findings (8 P1 + 5 P2), ALL 13 NOW RESOLVED + re-proven.** A deeper
pass found: flag not enforced server-side (#B); deploy-order coupling in InvoiceDetail preflight (#A); negative
flat credit posted as a charge (#C); malformed override → $0 (#D); source job billable via split AND normal
flow = double-bill (#E); fee cost per-acre vs extended mismatch (#F); per-child COGS rounding overstates group
total (#G); no route to reopen a saved draft (#H); local-date default (#J); micro-pct residual on custom
splits (#K); service name lost on item (#N); Option-B pricing audited as an "override" not a base (#M);
custom-split/override reasons never captured (#L). First 7 (#B/#C/#D/#F/#J/#K/#N) landed in `eb942f86`; the
final 6 (#A/#E/#G/#H/#L/#M) this session. **#H = save-now/post-later:** a new `split-billing/:id` route reopens
a saved set READ-ONLY for review + Post (editable reopen deferred — a re-save re-prices, so rebuilding money
fields is a future, separately-proven enhancement). **#E** consumes the source job (status→invoiced) so it
can't be double-billed. Re-proven in live PG: **PROOFOK 29/29** (adds cogs_group_lr_exact, audited_base_is_own,
reasons_captured, double_bill_second_set_rejected, resave_same_job_allowed). rls-security-reviewer 0/0,
migration-drift 0 blockers; typecheck + lint clean. *(State at the time of this round, since superseded: the
work was then parked with the flag OFF, migrations NOT applied, and PR #164 NOT merged. See the STATUS block
above — it shipped on 2026-07-21 and is live with the flag ON.)*

**Codex ROUND 3 RAN 2026-07-18 → 2 P1 + 4 P2, ALL fixed + PROOFOK 32/32.** A third pass (on the job-consumption
+ reopen work round-2 added) found: source job changeable on re-save → two jobs consumed (P1, now frozen);
service priced/stamped with `current_season()` instead of the job/invoice season (P1, now season-correct);
child invoices lacked `job_id`/`application_date` (P2); unposted group mislabeled "Posted" (P2); negative
micro-pct residual on `33.334×3` (P2); the live-RPC snapshot test inflated to hide the 2 parked RPCs (P2, now
uses the verified queued-bridge at true 438). The live proof ALSO caught 2 runtime bugs the reviews missed:
`v_job.season` on an unassigned record (55000) and a stale `scheduled_date` (live `jobs` uses `job_date`) —
both fixed. New harness note: seeding synthetic products now needs `ALTER TABLE products DISABLE TRIGGER USER`
inside the rolled-back txn (a parallel supplier-pricing project applied live pricing-governance triggers).
*(Round-3 exit criteria, now overtaken by events: "Remaining before flag-on: a CLEAN full re-run of the Codex
gate, then Mason's review + baseline field-app billing cycle." PR #164 merged 2026-07-21 and the flag was
turned on seven minutes later — see the STATUS block above. **The baseline field-app billing cycle still has
not happened** — checked directly rather than inferred from the empty split tables, since an ordinary cycle
would not touch those: live as of 2026-07-27, `field_app_locations` = 0 rows, `field_app_location_shares` = 0,
and of 4 total `jobs` none is `invoiced` and no `invoices` row carries a `job_id`. So no field-application
invoice of any kind has been produced yet, split or not.)*
Owner-facing detail: `docs/plans/per-line-split-billing-BUILD-HANDOFF-2026-07-18.md`.

**Resolved 2026-07-21 — Supplier Pricing Phase 1a rollout gap.** The governed
Product-page and XLSX pricing paths are live, the final lifecycle migration is
applied at `20260721014858`, and production `process-document` v19 is ACTIVE
with JWT enforcement and rejects supplier price/product lists before OCR.

### RESOLVED LIVE — Whole-record lost updates on quote/customer saves

The formerly open whole-record last-write-wins class is closed by live migration
`20260730235031_quote_customer_row_version_guard`. Both save RPCs now require the
loaded row-version token and reject stale editors before rewriting any field.
See **“RESOLVED LIVE — Quote and Customer whole-record saves reject stale
editors”** near the top of this file for the live proof, protected child-write
boundary, and operator reload behavior. The earlier commission-split-specific
guard remains useful defense in depth; it is no longer the only concurrency
boundary.

**Rollout ordering note (corrected 2026-07-30):** the client's no-echo fallback (`nextLoadedSplitSnapshot`, `src/lib/commissionSplitConcurrency.ts`) records the client-sent value as the next baseline when the old RPC returns no split echo. The compatible frontend must still ship first: its extra row-version JSON key is ignored by the old RPC, avoiding an all-user outage. A tab that stays open across the later approved apply can fail closed on its next save or split edit until refresh; that is the intentional residual, not an overwrite. Require the normal browser/PWA refresh during the bounded migration window, then run postflight/live smoke and regenerate generated schema/types afterward.

## 1. Open HIGH findings (dormant on live data)

### July 14 full-gauntlet remediation — LIVE, frontend rolled out (PR #133 merged 2026-07-15)

The three reviewed migrations were applied live on 2026-07-15 and `process-blend-ticket` is v25 ACTIVE with JWT enforcement. The live schema registry, TypeScript types, and 393-name RPC snapshot were regenerated; the queued-RPC exceptions are gone. The post-apply business chain reached `SMOKE_PASS_ROLLBACK`, and all 17 database invariant sweeps have zero unallowlisted violations. **The frontend rollout landed via PR #133 ("Harden gauntlet money and blend workflows", merged 2026-07-15, commit `c4f7b4c5`) — the release path is complete.** What remains under this heading is owner-side data-cleanup decisions (the bullets below), not code.

- Migration `20260714230100` removed the legacy direct-insert path. Tabs still running the old bundle must refresh before another blend upload; tell office users to use the existing “A new version of the app is ready” prompt (or reload).
- **Owner decision — live-data cleanup:** eight empty unposted `SEED` commission batches ($1,500 headers), PO-2026-0008's stale fully-received status/open lines, PO-2026-0015's legacy receipt gap, one explicit E2E zero-item invoice, and five historical completed deliveries without items.
- Reconcile 19 negative inventory rows (live count re-verified 2026-08-08) only from physical counts. Negative stock is intentional discrepancy evidence, not a value to zero-clamp.

The frontend/live-RPC fixture is regenerated and green; both `create_blend_ticket` and `commit_blend_ticket_ocr_result` are present live. Evidence: `docs/audits/gauntlet/2026-07-14-full-gauntlet-codex-only-remediation.md`.

Reload recovery for an uncertain manual/bulk blend-ticket create stores the exact user-scoped customer/header/product snapshot in per-tab `sessionStorage` for at most two hours. It contains ordinary business data, not credentials or service keys; known success/definite failure and closing the tab clear it. On a shared Windows/browser profile, close the CRX tab after use. This bounded retention is the deliberate tradeoff that prevents a network-uncertain retry from creating duplicate operational work.

**Correction to the working assumption going into this pass:** the 5 HIGH findings usually cited from the overnight bug hunt (commission-resurrection on cancel/void, prepay double-spend, blend-ticket over-reset, cross-customer prepay misapplication, field-app save desync) are **NOT open**. All 5 have applied-live fix migrations, confirmed both in `docs/audits/overnight-bug-hunt/LEDGER.json`'s own `appliedLive_2026_06_21` note and independently against live `schema_migrations` in this session. See §6 for the specific migrations. `docs/reference/gotchas.md`'s "Money-Integrity Invariants" section was re-verified against live function bodies and marked RESOLVED on 2026-07-13.

Genuinely still-open items from that same hunt (checked against `LEDGER.json`, none HIGH):

| Item | Severity | Status | Pointer |
|---|---|---|---|
| `forgeable-actor:transfer_job_to_invoice:unbound-performed_by` — `p_performed_by` not bound to `auth.uid()` on job→invoice transfer | MEDIUM (Codex split HIGH/MED, settled MEDIUM) | **RESOLVED** — strict-actor guard verified in the live function body 2026-07-21 (landed via `20260619140000_transfer_job_invoice_machine_fee_strict_actor.sql`, merged from feat/as-applied-invoices) | LEDGER.json line ~357 |
| `concurrency:save_field_app_invoice:no-row-lock` — group-edit branch read status without `FOR UPDATE` | MEDIUM | **RESOLVED** — `20260714224000_field_app_save_post_lock.sql` wraps `save_field_app_invoice` in `FOR UPDATE` row locks; applied live 2026-07-14, verified in the live function body 2026-07-16 | LEDGER.json line ~498 |
| `prepay:apply_remaining_prepayments:status-not-paid` | MEDIUM | moot while bulk-apply is hard-blocked (see §6) | LEDGER.json line ~566 |
| `commissions:commission_pay_picker:blank-order-customer` | MEDIUM | **RESOLVED** — verified on `origin/main` 2026-07-21: `fetchUnpaid` selects FK ids and resolves order #/job #/farm name via lookups (CommissionPayments.tsx) | LEDGER.json line ~833 |
| ~10 further LOW items (doc-count drift, dead-RPC retire candidates, audit-log completeness gaps) | LOW | parked | LEDGER.json `findings` array |

Two items the ledger flagged as **"top build priority" and Codex-rated HIGH-on-severity** turned out to already be fixed by later sessions — confirmed via migration files on disk: `reverse_blend_ticket_approval:billed-ticket-reopen-and-edit` → `20260622080000_blend_ticket_reopen_and_content_lock.sql`; `void_commission_payment:resurrect-cancelled-order` → `20260622070000_void_commission_payment_dead_order_guard.sql`. Both **confirmed applied live** (present by name in `supabase_migrations.schema_migrations`, checked 2026-07-13).

### OPEN 2026-08-09 — two HIGH commission findings from the Section 7 gauntlet refresh (awaiting owner decision)

Source: `docs/audits/gauntlet/2026-08-09-section-07-commissions-splits-payouts-voids-refresh.md` (verdict REMEDIATION REQUIRED, 0 BLOCKER / 2 HIGH). Both were proven against **live** `pg_proc.prosrc`, not just disk. Neither is an access-control defect — RLS, admin-only payout reads, and RPC-only mutations all held. Gauntlet summary rows **3.4** and **3.5**.

| # | Finding | Where | Live risk |
|---|---|---|---|
| 3.4 | **Historical Commission Balance reports are rewritten by later payout activity.** `get_commission_balance_report(date)` filters *earned* by `cm.order_date <= p_as_of_date` but derives paid/outstanding from **current** `cm.status`. | `src/pages/Reports.tsx:281-285`; `supabase/migrations/20260330100000_prelaunch_state_machine_and_security.sql:770-807` | A commission earned in June and paid in July shows as **paid** when the June 30 report is rerun; voiding that July payout flips it back to **outstanding**. Month-end commission liability is not reproducible for accounting or dispute review. Read-only defect — no wrong money moves. |
| 3.5 | **Payout idempotency receipts are keyed to the operation, not the intent.** `useIdempotencyKey` scopes to `[operation, userId]` and deliberately retains the key after an uncertain response; `create_/post_/void_commission_payment` all run the operation-only replay check *before* loading the requested entity. | `src/hooks/useIdempotencyKey.ts:21-40`; `src/pages/CommissionPayments.tsx:302-420`; migrations `20260714180000:70-258`, `20260714230000:285-395`, `20260707060000:1569-1717` | Server posts Payment A, response is lost, admin retries on Payment B → server replays A's cached success and the UI reports success for the wrong payment. Same shape for a changed commission selection or void reason. Does **not** double-pay; it tells the operator a different financial action succeeded when it did not. |

**Owner decision SETTLED (Mason, in-chat 2026-08-09): Option B.** Fix 3.5 (payout idempotency intent-binding) now; **3.4 stays parked** as a known reporting-accuracy defect. Rationale as presented and accepted: neither finding moves money wrongly, but 3.5 can tell an operator a payout succeeded when it did not, while 3.4 never causes a wrong payment and its proper fix (durable dated payout event ledger) is a materially larger build deserving its own session. Do not re-open 3.4 without a fresh owner decision; do not treat 3.4 as unknown — it is recorded here deliberately.

Options as presented:

- **Option A — park both.** No code changes; this entry is the record. Cheapest, but a wrong month-end commission number stays reproducible-wrong and the false-success replay stays live.
- **Option B — fix 3.5 only (recommended by Claude 2026-08-09).** Bind each receipt to the authenticated actor plus a server-derived intent fingerprint (create: sorted commission IDs + method/reference/date/notes; post: payment ID; void: payment ID + normalized reason), reusing the established pattern in `20260803010917_bind_idempotency_to_mutation_intent.sql:16-168`. Identical intent replays once; a mismatched actor or fingerprint fails closed with `IDEMPOTENCY_ACTOR_MISMATCH` / `IDEMPOTENCY_INTENT_MISMATCH`. One migration + rollback-only smokes. Rationale: 3.5 is the only one of the two that can mislead an operator into believing a payout landed.
- **Option C — fix both.** Adds an append-only dated commission payout event ledger (or fail-closed for historical dates) behind `get_commission_balance_report`, plus the 3.4 rollback smoke (earn → report → post after cutoff → void later → prove earlier snapshots unchanged). Materially larger: new durable table, backfill question for existing history, and a report-behavior change Mason would see.

Prevention actions proposed by the report: a static guard requiring any RPC accepting a historical cutoff to reference dated immutable facts or reject unsupported dates (**not built** — belongs with 3.4); a source guard requiring commission payout RPCs and callers to carry an intent-binding marker and tests (**built 2026-08-09**, see below).

### 3.5 BUILT AND PROVEN LOCALLY 2026-08-09 — NOT YET APPLIED LIVE

Option B is implemented on branch `fix/commission-payout-intent-binding` (split off `main` on 2026-08-10; originally built on `ship/harden-actor-binding-sql-reader`). It is **not live**: the migration has never run against production. Treat 3.5 as still open in production until the ledger shows `20260810170000`.

| Piece | File | State |
| --- | --- | --- |
| Migration — renames the three payout bodies to `_<name>_intent_impl_20260809` (money logic never retyped) and creates public wrappers that bind each receipt to `request_actor_id` + a SHA-256 `request_fingerprint`; adds the `check_idempotency_intent` helper | `supabase/migrations/20260810170000_bind_commission_payout_idempotency_to_intent.sql` | Written; proven in a disposable container |
| Rollback-only smoke chain | `scripts/smoke/smoke-commission-payout-intent-binding.sql` (registered in `scripts/smoke/smoke-specs.json` under `create_commission_payment`) | Passing |
| Container proof — network-isolated throwaway PostgreSQL 17, prints `COMMISSION_PAYOUT_INTENT_BINDING_PROOF_PASS` | `scripts/smoke/prove-commission-payout-intent-binding.mjs` | Green |
| Frontend — `getIdempotencyBindingRejection` maps the three refusals to plain-English warnings and retires the dead key in all three handlers | `src/lib/idempotency.ts`, `src/pages/CommissionPayments.tsx` | Done |
| Source guard the report asked for | `src/lib/commissionPayoutIntentBindingMigration.test.ts` | Passing |

Two deliberate departures from the `20260803010917` reference pattern, both documented in the migration header:

1. **The wrapper returns the committed receipt itself on an exact replay** instead of delegating back into the implementation. `idempotency_keys.result` is nullable and the implementation's operation-only `check_idempotency` reads a NULL result as "no receipt" — delegating would have re-executed the payout. A SQL-NULL or JSON-`null` stored result now raises `IDEMPOTENCY_RESULT_INVALID`.
2. **No per-entity scope check before returning the receipt in the error DETAIL.** All three payout RPCs are admin-only, the wrapper re-runs `is_admin()` before any receipt is read, and an admin can already read every payout row.

Mutation-tested (guard broken → test red → restored): the fingerprint comparison, the actor comparison, the legacy-receipt bridge, the frontend refusal branch, and the frontend key reset.

**Both Codex reviews returned DO NOT SHIP on 2026-08-09 (sol and terra, independently). Every confirmed finding is fixed on this branch as of 2026-08-10; the branch is still not live and still needs a clean re-review plus Mason's explicit OK before the migration is applied.** What the reviews caught, and what changed:

- **A dead key trapped the operator.** `IDEMPOTENCY_RESULT_INVALID` and `IDEMPOTENCY_RECEIPT_MISSING` were not classified, so the UI left an unusable key in place and every retry failed the same way forever. They are now a third refusal kind, `'receipt'`, with their own wording, and the key is retired like the other two.
- **The UI asserted something the database cannot prove.** On a pre-migration receipt the database knows only that the key is spent, not that the earlier request differed. The warning no longer claims a different payment was involved.
- **The refresh was not awaited**, so the toast told the admin to check a list that had not reloaded yet.
- **The privilege post-condition checked only `anon` and `authenticated`.** A `service_role` grant could have put an unguarded implementation back on a PostgREST-reachable surface. The `DO $verify$` block now denies all three roles across the receipt helper and all three implementations.
- **The concurrency test proved nothing.** Two `docker exec` sessions never actually overlapped, so deleting the advisory lock kept the proof green. The proof now holds both backends at a barrier and widens the window with a session-gated delay; removing the lock fails with two winners, as it should.
- **Structural tests had a first-occurrence bug**: the ordering check compared against the un-keyed delegation branch, so the binding `UPDATE` could have moved ahead of the payout call unnoticed.

Mutation coverage after the fixes: 7/7 behavioural mutations (advisory lock, result-invalid guard, `service_role` grant, two fingerprint fields, legacy replay, actor stamping) and 8/8 structural mutations go red. Full frontend suite green (4,339 tests).

`src/lib/commissionPayoutGuards.test.ts` needed a rename-aware fix: the stale-selection guards moved into the renamed implementation, so a name-based scan read the new thin wrapper and reported them missing. It now reads the body from before the rename and separately proves the wrapper still calls it — worth remembering for any future migration that renames a guarded function out from under its public name.

---

## 1b. RESOLVED 2026-07-22 — commission-recipient close-out: PR #213 MERGED (after PR #216), all migrations live

Branch `claude/nervous-dubinsky-39a725` (worktree `.claude/worktrees/stoic-heyrovsky-ebaaf6`, PR #213 open): **six migrations ALL APPLIED LIVE and individually proven** (ledger rows 812–817; row 817 = `20260722172533_reuse_guard_covers_revivable_quotes`, closing the round-8 terminal-quote finding) plus the CommissionSplitEditor dropdown frontend. Pipeline green. The Codex push-proof gate (rounds 9–10) still refuses the branch on three design-level residuals of NAME-based split identity: (1) invoiced jobs are revivable via `void_invoice` (job returns to completed, reinvoicing re-resolves names) but the reuse guard's jobs branch covers only scheduled/in_progress/completed; (2) recipient ROLE eligibility is dropdown-only, not enforced in the DB validator/creation path; (3) the save-split vs profile-rename concurrency race. The gate is static-diff-only — it explicitly will not accept live-state supersession evidence for gaps in the reviewed diff.

**Decision (Mason, in-chat 2026-07-22): yield to the parallel id-redesign session** (branch `claude/commission-split-recipient-ids`), which already applied live migration `20260722174029` (recipient ids stamped into splits at save; creation helpers consume ids — finding 3 closed in substance) and has role-eligibility in its charter (finding 2). One DB-writing session at a time: this branch stopped writing migrations on discovering the overlap. **To land:** after the id-redesign branch merges (its diff carries the id-binding + role migrations the gate wants), merge/rebase this branch on main, re-run `node scripts/write-codex-push-proof.mjs`, push, merge PR #213. Hand the id-redesign session finding (1) — invoiced-jobs revival — so its guard/redesign covers it. Until merged, rows 812–817's migration files exist only in this worktree (disk-vs-live drift for other checkouts); registry/fixture on this branch intentionally stop at high-water `20260722172533`.

**LANDED 2026-07-22 (same evening):** PR #216 merged first, then PR #213 merged to main (squash 4d686ece, Codex push-proof round 11 CLEAN on the post-merge HEAD, all checks + CodeRabbit green, prod Vercel deploy success). The section below is retained as history; the only open remainder is the follow-up guard-widening chip described in the residual note.

**Update 2026-07-22 (cross-session, id-redesign session):** finding (1) invoiced-jobs revival is **covered by routing** — the `20260722174029` backfill stamped `recipient_user_id` into every job split with no status filter (postflight: 0 id-less elements), and re-invoicing after `void_invoice` routes through `_insert_commissions_for_job` with id-precedence, so a re-acquired name cannot redirect a revived job's commissions while the original profile is active. **One narrow RESIDUAL remains (guard-scope, this branch's function):** if the recipient profile is *deactivated* and the name re-acquired while the job sits `invoiced` (outside `_guard_recipient_name_reuse()`'s jobs branch), then the invoice is voided and re-invoiced, the id-inactive fallback re-resolves the stored name to the new holder. Fix = extend the guard's jobs branch to include `'invoiced'` (mirroring the `20260722172533` revivable-quotes pattern). Requires deactivation + name reacquisition + void + re-invoice in sequence — accepted as a follow-up migration (task chip spawned 2026-07-22), not a #213 blocker.

**RESOLVED 2026-08-07 (harness-guards audit):** the follow-up shipped the same day it was accepted — migration `20260722184744_reuse_guard_covers_invoiced_jobs` (ledger name `20260722180000_reuse_guard_covers_invoiced_jobs`; name-vs-version gotcha) extended `_guard_recipient_name_reuse()`'s jobs branch to include `invoiced`, verified live in the guard body. No further work needed; the 2026-08-07 incident-vs-guard audit initially flagged this as an open gap and confirmed it already closed.

## 2. Parked migrations (written, not applied)

| File | Purpose | Why parked | What unblocks it |
|---|---|---|---|
| ~~`supabase/migrations/20260730114102_vendor_bill_period_close_lock.sql`~~ (submitted `20260729231031_...`, B7-renamed to the server version) | Serializes governed vendor-bill create/update with accounting-period close using month locks | **APPLIED LIVE 2026-07-30** as Supabase ledger version `20260730114102` — no longer parked. Targeted catalog/ACL/constraint verification, the registered Section 9 rollback-only chain (`ERROR P0001 SMOKE_PASS_ROLLBACK`), and all 20 predicates with 0 non-allowlisted rows passed; raw approved output was 7 rows across 5 predicates. | Done. Residual boundaries remain explicit in §0f: direct authenticated-admin `accounting_periods` writes, no existing-vendor-bill close-completeness gate, and the wider pre-existing non-vendor-bill writer race. |
| ~~`supabase/migrations/20260730124308_close_accounting_period_idempotency_recheck.sql`~~ (submitted `20260730121951_...`, B7-renamed to the server version) | Same-key post-month-lock idempotency defense in depth | **APPLIED LIVE 2026-07-30** as Supabase ledger version `20260730124308` — no longer parked. Exact overload/owner/SECURITY DEFINER/search-path/ACL proof passed; two idempotency reads including the structurally asserted post-lock recheck were observed; fixed-date delivery rollback smoke returned `ERROR P0001 SMOKE_PASS_ROLLBACK`. | Done. Current helper key-lock serialization is behaviorally proven; Sol mutation testing showed that removing this redundant block still passes that proof. Independent post-follow-up all-20 sweep CLEAN: 7 raw/7 allowlisted/0 new rows across 5 predicates. |
| ~~`supabase/migrations/20260726201208_void_vendor_payment_vendor_liveness.sql`~~ (submitted `20260726210000_...`, B7-renamed to the live version) | **APPLIED LIVE 2026-07-26** (server version `20260726201208`) — no longer parked. Section 9 follow-up MEDIUM-1: `void_vendor_payment` now locks the vendor row (`deleted_at IS NULL … FOR UPDATE`) so it serializes with `delete_vendor`; a void against a soft-deleted vendor raises `VENDOR_DELETED`. Gate passed (both charters CLEAN) + Mason's in-chat approval; post-apply live body md5 matches disk exactly. | — | Done. Residual RESOLVED 2026-07-26: Mason approved the Deactivate/Reactivate reframe — `reactivate_vendor` RPC **APPLIED LIVE** (gate CLEAN, submitted `20260726213000`, server version `20260726212043`) + Vendors-page Show Inactive view and Reactivate button, giving `VENDOR_DELETED` a one-click remedy; the PR #236 review then caught (and 2026-07-26 same-day fix `20260726215154_vendors_inactive_admin_select` resolved, gate CLEAN + applied live) an RLS gap that hid inactive vendors from the new view. |
| ~~`supabase/migrations/20260722202622_commission_split_lost_update_guard.sql`~~ (submitted `20260722190000_...`, B7-renamed to the live version) | **APPLIED LIVE 2026-07-22** (server version `20260722202622`) — no longer parked. `save_quote`/`save_customer` reject a split overwrite when the client's `*_expected` snapshot no longer matches the stored value, echo the stored (trigger-enriched) split back, and canonicalize `save_quote`'s actor exception to `ACTOR_MISMATCH`. Proven live on both RPCs (conflict/rejection/matching-expected/omitted-key/actor-mismatch). | — | Done. |
| `supabase/migrations/20260807220323_log_customer_fact_rpc.sql` | `log_customer_fact` RPC: retry-safe, role-gated, actor-pinned CRM fact intake replacing the direct `customer_facts` insert in `CustomerFacts.tsx` | **APPLIED LIVE 2026-08-07** as version 20260807220323 (authored 20260807120000). History row 856. Frontend cutover to the RPC landed in the same change. | Done — both Codex charters CLEAN, postflight ACL assertions passed at apply. |
| `docs/audits/nightly-debug/parked-migrations/PARKED-03-cancel-delivery-scheduled-quick-prebook-leak.md` | Release prebooked inventory when a scheduled quick-delivery is cancelled | — | **RESOLVED, applied live 2026-06-16** (`20260616151122_cancel_delivery_release_prebook_on_quick_cancel`). File header already says so — stale-looking filename, not a stale fix. |
| `docs/audits/nightly-debug/parked-migrations/PARKED-07-seed-admin-security-OWNER-ACTION.md` | Flagged `seed-admin` edge function as an unauthenticated admin-mint endpoint | — | **RESOLVED** — `seed-admin` no longer exists in `supabase/functions/` (confirmed on disk this pass; `docs/reference/gotchas.md` line ~118 notes it was deleted 2026-06-16 as a security cleanup). |
| `scripts/.staging-migrations/SUPERSEDED-20260611080937_idempotency_lookup_operation_scope_sweep.sql` | Idempotency lookup operation-scoping sweep | Filename says SUPERSEDED | Nothing — already replaced, safe to ignore/delete |
| `scripts/.staging-migrations/workflow-fix-parked/u12/*`, `.../u13/*` | Draft patches for Applicator "My Day" (U12) and dispatch-assignment unification (U13) | **Verified superseded and removed locally in this ticket.** `docs/loops/business-workflow-fix-ledger.md` confirms both U12 and U13 **SHIPPED LIVE 2026-07-06/07** under different migration names (`20260707010000`/`20260707011000` for U12, `20260707020000` for U13) — not the deleted draft filenames (`20260706060000`, `20260706100000`). | Do not re-apply the removed drafts. |
| `scripts/.staging-migrations/workflow-waves-parked/SUPERSEDED-dispatch-backfill.sql` (was `PARKED-dispatch-backfill.sql`, renamed 2026-07-29) | One-time backfill of `job_location_dispatches` for legacy-assigned open jobs | **RETIRED 2026-07-29 — no longer parked, DO NOT APPLY.** The legacy population it was written for is gone and the live sync triggers cover the ordinary assignment paths. Verified read-only against live 2026-07-29: its own count query returns 0 rows (same as when parked on 2026-07-10), **no** open assigned job is missing a dispatch row at all (0 across every assignee, not just qualifying ones), and `trg_sync_job_location_dispatch_on_applicator_change` on `jobs` + `trg_sync_job_location_dispatch_on_field_insert` on `job_fields` are both live. It is **not** claimed that a gap can never reopen — see the dispatch trigger-coverage row below. | Nothing — it is not waiting on Mason. Do **not** re-run the count query "just in case" and apply it: this is a business-data write. If a dispatch row is ever genuinely missing, diagnose the trigger, do not resurrect this backfill. |
| Dispatch sync triggers skip a job assigned to a non-qualifying profile, and never re-sync (`20260707020000_assignment_unification.sql`) | A job assigned to a profile that is not (`is_active` **and** `role = 'applicator'`) silently gets no `job_location_dispatches` row, so it never reaches the dispatch board | **OPEN — found by cross-model review 2026-07-29, confirmed read-only against live.** Both sync triggers return early on that condition; nothing in the database stops the assignment (`_enforce_applicator_license` only checks license *expiry*, and `assign_job_applicator` validates the **caller's** role, not the assignee's); and no trigger on `profiles` re-syncs dispatches when a profile is later reactivated or changed to `applicator`. So deactivate → assign → reactivate leaves the job permanently off the board. Live today: **2** open jobs are assigned to an `admin`-role profile (both already have dispatch rows, so **0** rows are currently missing) — the path is reachable, the damage is not present. | Not urgent (no live gap right now), and **not** to be fixed with the retired backfill. The real fix is at the write path: either reject an invalid assignee in `assign_job_applicator`, or add a `profiles` trigger that re-syncs dispatches on an `is_active`/`role` transition. Needs its own scoped session — it changes assignment behavior Mason's team relies on. **Detection guard added 2026-08-07:** sweep predicate `scripts/db-invariant-sweeps/predicates/dispatch-sync-nonqualifying-profile.sql` now finds any open/scheduled job whose `job_fields` lacks a dispatch row because the assignee didn't qualify (verified 0 rows live) — the silent skip is no longer invisible, though the write-path fix above remains unbuilt. |
| `supabase/migrations/20260807215532_profile_role_lock_covers_insert.sql` | Extends `_guard_profile_role_lock` to `BEFORE INSERT OR UPDATE` so a logged-in non-admin cannot re-insert their own `profiles` row with `role = 'admin'` (§0d follow-up; closes the admin self-escalation path) | **APPLIED LIVE 2026-08-07** as version 20260807215532 (authored 20260807153000). Predicate `profile-role-lock-insert-arm.sql` verified 2 rows red → 0 green post-apply. History row 855. | Done — both Codex charters CLEAN; live non-admin escalation-insert probe blocked with PROFILE_INSERT_LOCK at apply. |
| `scripts/.staging-migrations/SUPERSEDED-20260717121000_supplier_pricing_phase1a_cutover.sql` | Historical pre-promotion source for the supplier-pricing enforcement cutover (renamed to the `SUPERSEDED-` convention 2026-07-28 so the fleet counter stops listing it as awaiting apply) | **RESOLVED, applied live 2026-07-18** as `supabase/migrations/20260718190000_supplier_pricing_phase1a_cutover.sql` after the governed RPC frontend was proven | Do not apply the staging artifact; its own md5 preflight would now abort, and forcing it past that would overwrite the live pricing functions with 2026-07-17 bodies. Product-page and worksheet edits remain live through the governed preview/apply RPCs |
| `docs/roadmap/shelved-earmark-engine/*.sql` (3 files: `20260613240000`, `20260613250000`, `20260613280000`) | Booking-prepay "earmark" engine (reserve prepay credits for a specific future booking) | **SHELVED for a full redesign** (Mason's call, 2026-06-14) — the earmark engine assumes a single ledger-based spend path, but the legacy aggregate-spend path (`apply_remaining_prepayments`) bypasses it, causing double-spend + fund-diversion defects (Codex rounds 5-6). See README.md in that folder for the reserved-pool redesign sketch. | **DO NOT APPLY without a fresh architectural pass** — reserved-vs-spendable balance model, not a patch. |
| Per `.claude/commands/parked.md`: also check `node scripts/fleet-status.mjs` output and any `*draft*.sql` under `docs/audits/` for parked drafts in other worktrees | — | — | Not re-run in this pass (read-only doc consolidation, single worktree) — a future agent asked "what's parked" should run it fresh |

---

## 3. Pending owner decisions

From `docs/loops/owner-decisions-2026-07.md` (6 packets, live counts pulled 2026-07-02). **2026-07-16 in-chat outcomes:** packet 3 (junk deletes) — Mason keeps test entities for E2E/Playwright use, un-commingled: the two untagged test customers were renamed with the `[E2E]` prefix (live UPDATE, verified); true-junk deletes (8 gibberish `RTJ Recipe…` blend recipes, zero-link customer rows, vendor `we`, bad emails) remain PENDING explicit line-item approval. Packet 4 (due dates) — **DECIDED: Net 30 default + Net 15 / due-on-receipt / custom-date override**; approved build spec: `docs/plans/invoice-due-dates-net30-spec-2026-07-16.md`. Packet 5 / finding #40 wire-vs-retire — **SETTLED: KEEP** (planned features; do not retire the orphaned RPC, CropPrograms pages, or per-acre tier columns). Packet 6 ("wire" payment method) — **RESOLVED, was stale**: migration `20260702152000_payment_method_wire.sql` is applied live; all four payment_method CHECK constraints already allow `'wire'` (verified live 2026-07-16). Remaining genuinely-open packets: 1 (vendor-name merges) and 2 (category remap).

1. **Vendor/manufacturer name merges** (e.g. "Van Diest" vs "Van Deist") — re-buckets AP spend/rebate history; needs Mason's call on which spelling is canonical.
2. **Category remap** of the 19 live `products.category` values into functional-class + use-timing — re-buckets historical sales reports on rename.
3. **Junk-data deletes** (8 fake blend recipes, 3 "Test Mfg" products, 3 "Test Vendor" products, 1 junk PO vendor, ~5 invalid customer emails) — recommendation is delete-all; needs Mason's approval since it's real-row deletion.
4. **Due-date/aging policy** — chemical-sale invoices get no `due_date` today, so the whole late-AR machine (overdue cron, finance charges, cockpit tile) protects nothing. Unblocks parked migration "A8". Recommendation: Net 30 default, age from `due_date`.
5. **Wire vs. retire** calls on 5 dead/half-wired structures (`ingredient_map` page, CropPrograms/ProgramTracker, per-acre tier price columns, several dead tables incl. a booby-trap legacy `payments` table, and the orphaned `get_customer_delivery_remainders` RPC).
6. **Confirm "wire" as an allowed payment method** — two UIs offer it but no live table's CHECK constraint allows it.

Plus, from the 121-finding business-workflow review (`docs/audits/business-workflow-review-2026-07/`):
- **#40** — `get_customer_delivery_remainders` RPC is orphaned (defined, secured, zero callers). Decision: retire or wire into a per-customer remainders card; see Packet 5 in `docs/loops/owner-decisions-2026-07.md`. No retirement migration is authorized by this cleanup.
- **#107** — Auto-draft-invoice-on-job-completion silently does nothing when an *applicator* (the normal completer) finishes a job — only admin/sales-rep completions trigger it, and unlike a failed draft it logs nothing. Must be decided **before** the (currently off) auto-draft switch is ever flipped on.
- Related open item from the same review (not owner-decision-gated, just unbuilt): **#117** (`auto_draft_skipped` activity-feed row) — **BUILT 2026-07-21** as migration `20260722012359_auto_draft_skipped_activity_row.sql` (submitted 20260721230000; B7-renamed) (complete_job now logs both silent skip cases: non-office completer — the #107 gap — and already-invoiced job); **APPLIED LIVE 2026-07-21**, ledger version `20260722012359`. The #107 POLICY decision itself remains open and unchanged. **Correction 2026-07-16:** #106 and #109, previously listed here as open, actually SHIPPED LIVE 2026-07-06 via `20260707050000_application_record_integrity` (live v20260706175157) — see `docs/loops/business-workflow-fix-ledger.md` Night-2 entry (N2-7) and `docs/reference/migration-history.md` row #639; moved to §6.

~~Migration-apply approval policy is written two ways~~ — **SETTLED by Mason 2026-07-13** as option (b) with a destructive carve-out: armed autopilot + the apply-guard proof gate suffices in a pre-authorized hands-free run; interactive sessions still ask in chat; data-deleting/dropping migrations are never autonomous. Canonical text: `docs/manual/DECISION_LOG.md` (2026-07-13 entry).

Also open: **Sprint D leftovers** (`docs/loops/workflow-waves-ledger.md`) — D1/D2 shipped live 2026-07-10, but D3 is parked in two owner-decision halves: (a) blend-ticket-path commission minting, deliberately dormant until blend billing is actually used; (b) `jobs.commission_split` visibility to assigned applicators — Mason needs to decide between an admin-only side table or RPC-gating.

---

## 4. Deferred/parked feature work

- **CRM adoption + coverage gaps (2026-08-04 audit)** — the July relationship-intelligence build is intact
  and RLS-clean, but live data is empty: 0 interactions, 0 grower facts, 0 documents, 0 customer applicator
  licenses, and 146 of 150 active customers have no assigned sales rep. That data state — not the code — is
  what makes the unassigned-accounts call list, the crop filter, credit limits, statement email, and RUP
  compliance status non-functional today. Open coverage gaps in priority order: customer applicator-license
  visibility on the customer/prep-card/quote surfaces (legal exposure), pre-quote sales pipeline, duplicate-customer
  detection, bulk-import/bulk-assign of `assigned_sales_rep`, and auto-logging outbound email into
  `customer_interactions`. Also still open from the July loop: the **add-fact path is retry-unsafe**
  (direct insert; the interaction path got its idempotent RPC on 2026-07-17, the fact path did not).
  Full detail and recommendations: `docs/audits/2026-08-04-crm-functional-and-coverage-audit.md`.

- ~~**Per-line-item custom split billing (field-app)**~~ — **no longer deferred. SHIPPED 2026-07-21 (PR #164)
  and live with the flag ON; see §0 for the current status and the one remaining gap (it has never been
  used).**
- **EPA label backfill** — ~105 of 204 distinct stored EPA registration numbers point at the wrong product (confirmed, `docs/CHANGELOG.md` 2026-07-10 entry). The in-app `/label-data-quality` tool to fix them shipped 2026-07-10; the actual backfill (doing the data-entry) is still pending — it's a data-entry job, not a code task.
- **OCR REI/PHI auto-fill** — deliberately deferred as a safety trap (label OCR for re-entry-interval/pre-harvest-interval data needs human verification before it can be trusted for compliance).
- **Grower portal §7-§10** — deferred, internal-only direction for now. `docs/ROADMAP.md` line ~57 (A2, "Grower portal v1") and line ~112 (G9, portal MVP) both still say TODO/VISION.
- **Sprint D** — see §3 above (largely resolved; only the 2 D3 owner-decision halves remain).
- **U12/U13 "drafts parked outside repo"** — per session memory this phrase referred to scratchpad copies; the actual repo-tracked drafts in `scripts/.staging-migrations/workflow-fix-parked/` were verified as stale leftovers from an already-shipped feature and removed locally in this ticket (see §2). No live U12/U13 work remains open.
- **Credit-memo "Feature B" / residual-ledger design blocker** — **correction:** this is not part of the credit-memo-apply project (that one shipped, see §6). The residual-ledger design blocker belongs to the **billing-day-money-loop's Feature B** (per-delivery split invoicing for partially-delivered field/acre-allocated orders) — parked at a Codex design-review BLOCKER because naive per-delivery mirroring loses money via independent rounding. Handoff doc: `docs/audits/split-billing-B-perdelivery-design-2026-07-10.md`. Until redesigned, partial allocated deliveries keep today's flag-and-manual-split behavior.
- **Sprint E dispatch backfill** — see §2 (parked, currently a no-op).
- **Blend-ticket commission mint** and **`jobs.commission_split` RLS visibility** — see §3, Sprint D D3.

---

## 4b. Guard-system hardening backlog (from the 2026-07-13 retirement audit; recommendations, not built)

The 2026-07-13 audit implemented the cheap hard-guard fixes (see CHANGELOG). These remaining items were adjudicated PARK — each needs either allowlist design or accepted-residual sign-off, not just code:

- **Supplier Pricing Phase 3C PR containment remains PARKED.** The trusted `pull_request_target` workflow is a future-PR guard and cannot retroactively protect PR #246 because its base predates the workflow. After the introducing PR merges, only the exact `Phase 3C Trusted Base Containment` check may be enforced by `protect-main` or equivalent immutable required-workflow control, followed by live proof; `Phase 3C Candidate Containment (CI)` is deliberately candidate-controlled and must never be selected as the protected check. Until then, local pre-commit/pre-push hooks are the active guard against accidental private-packet commits, while candidate-controlled PR CI remains advisory. Its unauthenticated `refs/pull/<n>/head` fetch depends on this repository remaining public; private-repository use requires read-only authentication.
- **Phase 3C first-push ancestry cap requires maintenance before 4,096 commits.** The checker currently measures 2,128 commits and deliberately fails closed when a brand-new remote ref would traverse more than `MAX_HISTORY_COMMITS = 4_096`. Reassess and raise the bounded cap with measured scan-budget proof well before repository ancestry approaches the limit; otherwise the first push of every new branch will be blocked.
- **Phase 3C byte and candidate scan budgets require measured maintenance.** The measured first-push proof consumed about 1.61 GiB; `MAX_TOTAL_STRUCTURAL_SCAN_BYTES` was raised from 2 GiB (already about 80.5% used) to 3 GiB, leaving about 46% headroom. The same proof used 71,289 of `MAX_STRUCTURAL_SCAN_CANDIDATES = 100,000`. Re-measure and adjust either bound with adversarial memory/time proof before it reaches 80%; a breach intentionally blocks push and CI rather than scanning an unbounded repository.
- **Proof-file self-attestation** — the migration-apply and Codex-push proof JSONs can be written by the same agent that should be gated by them; nothing binds the proof to an actual reviewer run. Partial raise-the-bar option: have the reviewer subagents write the proof themselves. Full closure impractical (accepted residual for a malicious agent; the fix targets honest confusion). The 2026-07-13 hands-free additions (content-bound `codex-review-mig-<name>.json` Codex proof, exact `queryHash` binding on both proofs, required `reviewers` array naming both reviewer subagents, and timestamp freshness bounded to [0, 30 min] so future-dated stamps fail) raise the honest-mistake bar further but remain self-attestable by a deliberately dishonest agent — same accepted residual. Likewise the destructive-SQL classifier is a lexical scanner, not a SQL parser: it is quote-aware and default-keep (five adversarial Codex rounds closed the comment/literal/dollar-quote hiding tricks), but a genuinely novel obfuscation could still slip it — the classifier's job is stopping honest mistakes, and its false positives merely park a migration for the morning.
- **New live-sweep predicates worth writing** (scripts/db-invariant-sweeps/): a `concurrency-hotspot` predicate asserting the named race-prone functions (inventory reservations, prebook, number sequences, balances) contain `FOR UPDATE`/advisory locks; ~~an `audit-log-completeness` predicate asserting each allowlisted money-mutator RPC writes `financial_audit_log`~~ (**BUILT 2026-08-07** — `predicates/audit-log-completeness.sql`, 0 rows live, non-vacuous over 39 money-mutating SECDEF functions); more `fin-*` arithmetic identities per derived-value family — **PARTIALLY BUILT 2026-08-07**: `fin-vendor-bill-balance-identity.sql` (0 rows live) and `fin-po-receipt-identity.sql` (22 March-2026 import-era violations **accepted-and-baselined by Mason 2026-08-07** — each allowlisted per-key with live figures recorded; sweep nets to 0 and any NEW violation still fails); order/quote `total_profit`, `net_margin_pct`, per-line commissions still unwritten.
- ~~**Write-time forgeable-actor hook**~~ — **BUILT 2026-08-07** as `.claude/hooks/actor-binding-check.mjs` (+ test, wired in `.claude/settings.json` and `.codex/hooks.json`): PreToolUse Write|Edit hook flagging SECDEF migration functions with `p_performed_by`/`p_actor%`/`p_user%` params lacking `ACTOR_MISMATCH` binding, at write time instead of post-write sweeps.
- **Edge Functions are exempt from the assert/check ESLint rules** (Deno) and the coverage ratchet's scope leaves ~130 legacy Supabase reads unchecked — known accepted gaps.
- **Invoice-type leaks and direct-URL edit-lock bypasses** (lifecycle class) have no static guard — stays reviewer-checklist territory (`compliance-reviewer`).
- **Shell string-reconstruction bypasses** of the Bash regex guards (quote-splitting, variable substitution) — accepted residual under the honest-mistake threat model; keep widening regexes as concrete shapes appear.
- **worktree-awareness is a session-start snapshot** — no mid-session warning when a sibling merges or applies; accepted perf tradeoff, re-run `git worktree list`/`/fleet` before done-claims.
- **stop-verify PROOF matching is text-based**, not tool-call provenance — a fabricated PROOF line passes; hardening would require binding to transcript tool_use records.
- **npm `--prefix`/`--workspace` forms escape the script-body guard** (Codex round-5 P2, 2026-07-13) — `npm --prefix client run x` yields no script name to the bash-safety-lib extractor, so the resolved-body check silently skips. Correct handling needs value-taking-option parsing AND resolving the *other* package.json the option points at. Accepted residual: CRX is a single-package repo (these forms never occur here), and the guard's threat model is honest mistakes; revisit if the repo ever becomes a workspace/monorepo.
- **Commission name-reuse guard retirement is PARKED (2026-07-22)** — the durable UUID-routing migration (`20260722170000_commission_split_recipient_ids.sql`) deliberately KEEPS `trg_guard_recipient_name_reuse`. Codex push-proof BLOCKER: while any deployed bundle can still send a name-only split (all pre-change bundles; new bundles via the CommissionSplitEditor RPC-failure fallback list), a re-acquired name would be stamped with the NEW holder's UUID at write time — the guard is what makes name-only writes unambiguous. Retirement unblocks when name-only split writes are impossible: id-carrying frontend fully propagated (PWA needs two reloads) AND the DB rejects id-less elements (small follow-up migration flipping the stamp/validator to require `recipient_user_id`, plus removing/id-ing the editor fallback list). Until then the guard's name-reservation friction on profile renames is accepted, as is the related fail-closed friction Codex round 2/3 examined: after an admin renames a profile, commission ROUTING for stored splits is unaffected (the active id wins at creation time), but a SAVE that resends a split still carrying the old display name is REFUSED until the operator re-picks the person — the resend is a name-vs-id mismatch whose name no longer resolves, indistinguishable at write time from a failed reassignment (a silent id-fallback was tried and reverted — Codex round 3 showed it could misroute a genuinely failed reassignment; deactivating a referenced profile fail-closes both paths as intended).
- **Gauntlet V2 Phase 2 remains intentionally open** — Phase 1 makes missing evidence loud but does not manufacture unavailable evidence. The page-render gate still has 44 reasoned, count-ratcheted skips; five E2E files still contain direct production endpoint literals (Playwright now blocks before setup) and additional auth-token storage keys are production-project-specific; staging Supabase/secrets do not exist yet, so E2E stays `if: false`; `db-sweeps:strict` still needs an authenticated execution path in CI; the live-schema suite remains trusted-run-only via `npm run test:schema-live` because ordinary GitHub Actions has no least-privilege credential (the production service-role key must not be added merely to make CI green); Sentry's 30-day collector remains `BLOCKED` by Unauthorized. None of these may be reported as clean until executed evidence exists.

---

## 5. Known technical debt / accepted quirks

- **Offline work recovery database foundation and browser rollout are live; phone/device E2E remains pending** — all four receipt migrations, including the corrective target-row lock, were applied and verified on 2026-07-14, and PR #124's browser rollout landed on `main` before the 2026-07-15 offline verification pass. Browser retention until proven success, distinct cap/backlog handling, a safe device review panel, audited office `already_completed` / `abandoned` resolution, and cross-tab replay protection are now in code. A saved action that lacks an original queue-time target snapshot is intentionally sent to office review rather than deriving a new baseline after reconnect; therefore snapshot conflict coverage is complete only for actions that captured the snapshot when queued. Still deferred: signature/photo persistence, idempotent email/notification replay, operation-specific conflict preconditions, automatic device discovery of an office resolution, and a general duplicate-action policy. Browser storage remains device-local until the phone reconnects and stages its permanent server receipt, so destroying or clearing that storage before reconnection can still lose work. Source: `docs/audits/2026-07-15-offline-stage1b-rollout-verification.md`, `docs/audits/2026-07-14-offline-receipt-browser-office-resolution-proof.md`, and `docs/roadmap/offline-work-stage1b-receipt-design-2026-07-13.md`.
- **Live `schema_migrations` having more entries than files on disk is OLD, pre-existing drift** — do not treat it as a new problem. Only reconcile migrations newer than the point where the current branch diverged from `origin/main`. (Session memory: `project_migration-disk-vs-live-drift`.)
- **Page-render tests pass in isolation but flake in the full `vitest` suite** — fix with `waitFor`/`findAllBy`, not synchronous `getBy`. See `docs/reference/gotchas.md` and session memory `project_page-test-fullsuite-flake`.
- **PWA (installed app) needs two reloads after a production deploy** to pick up a new service-worker chunk — expected behavior, not a bug to chase.
- **Prepay bulk-apply (`apply_remaining_prepayments` / `batch_apply_all_prepayments`) is hard-disabled in production** (`RAISE 'PREPAY_BULK_APPLY_DISABLED'`, migration `20260620200000`) rather than properly fixed — the real fix needs the shelved reserved-pool redesign (§2/§4). Per-invoice `apply_prepay_to_invoice` is unaffected.
- **`commission_payments.total_amount` is a legacy numeric-dollar column** — current posting compares the header and item totals directly in the same numeric-dollar unit; only `financial_audit_log.total_impact_cents` converts the posted total to cents. Converting historical payment headers/items safely is a dedicated money-schema migration, not part of the gauntlet cutover; do not casually retype it while re-emitting posting guards.
- **Renaming or deactivating a profile still referenced by an unfinished quote/job commission split now fails closed at the next validator touch** (quote edit/conversion, job invoicing) with `COMMISSION_SPLIT_INVALID: recipient … does not match exactly one active user` — since migration `20260722134252` (gauntlet §7). This is deliberate (Mason chose reject-at-creation over silent unpayable commissions, 2026-07-22): the fix is to update the affected split to a current active user (or restore the profile), not to weaken the validator. Codex proposed an automatic profile→split reconciliation build; declined as scope creep for a zero-affected-rows preventive guard. Since migrations `20260722144121`/`20260722150432` (same day): profile names are admin-only to change, two active users cannot share a name, and NO profile — admin actions included — may acquire a name still referenced by a split with future money (`COMMISSION_RECIPIENT_NAME_RESERVED`); update the splits first. Durable follow-up (parked task): store profile ids inside splits instead of names, which retires this whole name-identity guard family.
- See `docs/reference/gotchas.md` for the full list of non-obvious schema/RPC quirks (idempotency column names, generated columns, tables without `updated_at`, etc.) — this file does not duplicate that content.

---

## 6. Recently resolved (last ~30 days)

- **2026-07-22** — Gauntlet §7 HIGH (CommissionSplitEditor "Other" free-text recipient → commissions with NULL `recipient_user_id` that no payout batch can ever select) closed with the reject-at-creation option Mason chose. Live migration `20260722134252_reject_unresolvable_commission_recipients` (submitted `20260722124500`): validator now requires every split recipient to resolve to exactly one active profile (SECDEF boolean helper works under admin-or-self profiles RLS), a `BEFORE INSERT OR UPDATE OF recipient_user_id` backstop trigger on `commissions` refuses NULL-recipient rows on every code path, and the new `list_commission_recipients()` RPC feeds the editor dropdown (commission-eligible roles; picked up Clayton Wells, whom the old hardcoded list omitted). Free-text "Other" removed from the UI. Zero live rows were affected; the single legacy NULL row (cancelled, $0, 2026-03-16) is grandfathered. See §5 for the accepted rename/deactivate fail-closed trade-off. Ranked-queue row 14 in `docs/audits/gauntlet/live-foundation-gauntlet-summary.md` is closed by this.
- **2026-07-17** — Money/inventory gauntlet sections 8-15 database remediation is live through `replay_bulk_po_same_request_result` (ledger `20260717032437`). PO numbering is atomic with insertion; active sales reps retain PO create/import/edit authority; vendor bills compare the authoritative line-rounded PO header; an admin-deleted imported PO clears its claim plus cached save results so the unchanged document can be imported again; and a same-key lost-response retry now replays the original `saved` result before different-request document deduplication. Both trusted migration reviewers returned CLEAN; stacked pre/post-apply rollback chains reached `SMOKE_PASS_ROLLBACK`; permanent checks found zero claims, stale save replays, fractional source costs, and PO header mismatches, with public/internal grants correct.
- **2026-07-15** — The 2026-07-14 workflow-review HIGH (deactivated admins retained commission-payout policy access) is closed: all 3 fix migrations applied live — names `20260714185129_fix_commission_admin_policies` / `20260714185130_gate_batch_prepay_admin` / `20260714185631_harden_is_admin_search_path`, re-stamped live versions `20260715134551` / `20260715134618` / `20260715134629`. Verified in live `schema_migrations` 2026-07-16 (match on name, not version — the standard drift gotcha). `migration-history.md` rows 690–692 corrected the same day.
- **2026-07-15/17** — Schema registry and generated TypeScript database types were regenerated from live introspection through high-water `20260717045420` (`bind_bulk_po_claim_to_vendor`). Roadmap tickets T1/N2 remain done.
- **2026-07-06** — Business-workflow findings **#106 + #109** (application-record date/license snapshots; invoice-side season stamping) shipped live via `20260707050000_application_record_integrity` (live v20260706175157). Recorded here 2026-07-16 after this file wrongly carried them as open.
- **2026-07-13** — Automated weekly in-database backup live (`20260713050000_weekly_db_backup.sql`, pg_cron) — snapshots all tables to `backup_snapshots` + a run log.
- **2026-07-12** — Money+Inventory night-hunt batch A-D applied live: `void_invoice` is_active + period guards (`20260712160000`), unbilled-delivery guard now ignores soft-deleted invoices (`20260712170000` + dashboard companion `20260712180000`), `create_order_from_blend_ticket` row-lock race fix (`20260712190000`), `void_payment` overpayment-credit full unwind (`20260712220000`).
- **2026-07-12** — Edge Functions CORS outage (all 7 functions unreachable) fixed and deployed (`66b91855`, later centralized in `1170c2dc`).
- **2026-07-11/12** — Credit-memo apply shipped (5 migrations + frontend, `20260711020000`-`20260711060000`).
- **2026-07-10/11** — ChemMan-parity loop: 10+ build units incl. CSB click-to-adopt USDA field boundaries, print-options dialog, map-based location picker, loader worksheets, field obstacles — all shipped live.
- **2026-07-10** — Business-workflow review finding **#105** (spray-job credit-exposure blind spot) fixed and applied live (`20260712130000` + frontend).
- **2026-07-10** — Label Data Quality screen (`/label-data-quality`) shipped — in-app EPA registration-number check + inline fix.
- **2026-06-21/22** — Overnight bug-hunt Run 1 + Run 2: all 5 originally-HIGH money-correctness findings (commission resurrection, prepay double-spend, blend over-reset, cross-customer prepay misapplication, field-app type-flip) fixed and applied live — see §1 correction above for citations.

---

## Sources this file consolidates (read these for detail, don't recreate their content here)

- `docs/audits/overnight-bug-hunt/LEDGER.json` — full finding-by-finding history
- `docs/reference/gotchas.md` — quirks and invariants (Money-Integrity table marked RESOLVED 2026-07-13)
- `docs/loops/owner-decisions-2026-07.md`, `docs/loops/workflow-waves-ledger.md`, `docs/loops/business-workflow-fix-ledger.md`
- `docs/audits/business-workflow-review-2026-07/findings.json` + `report.md`
- `docs/roadmap/shelved-earmark-engine/README.md`
- `docs/audits/split-billing-B-perdelivery-design-2026-07-10.md`
- `docs/CHANGELOG.md`
- `.claude/commands/parked.md`

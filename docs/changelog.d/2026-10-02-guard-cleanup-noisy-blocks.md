## 2026-10-02 — guard cleanup, part 1: the noisiest non-irreversible blocks become warnings

Mason's decision (DECISION_LOG, 2026-10-02): guards block only what cannot be undone. This change covers the sources of about three-quarters of the 915 blocks recorded in the 14 days before 2026-10-02.

**Changed**

- `review-proof-guard.mjs`: the shell rule for `.husky`, `.github/workflows`, `.claude/hooks`, `.codex/hooks` and `.coderabbit.yaml` now denies only plain writes (a `>`/`>>`/`>|` redirect into the path; `rm`, `mv`, `cp`, `tee`, `install`, `dd`, `patch` and their PowerShell twins, including behind `sudo`/`env`/`xargs`/`npx`/`eval`; `sed -i`/`perl -i`; a git subcommand that rewrites the working tree). Anything else it cannot vouch for as read-only is allowed with a visible warning. 359 denials in 14 days, mostly reads. The proof-file and review-state rules are unchanged.
- `stop-wrap.mjs`: blocks only when a migration was applied to live with no committed source; other loose ends are a non-blocking note (77 blocks).
- `posttooluse-migration.mjs`: returns its checklist as context instead of a PostToolUse `decision: "block"` that could not undo anything (109 "blocking errors").
- `prompt-router.mjs`: unwired `dangerous-phrase-warning`, `codex-gauntlet-reminder`, `agent-pair-review-reminder`, `codex-to-claude-handoff-reminder` and `autopilot-intent-reminder`. Without the last one `OVERNIGHT-INTENT.flag` is never written, so the overnight handshake no longer blocks work. The module files and their own unit tests remain for a follow-up to delete.
- `hold-latch-prompt.mjs`: a Codex `Automation:` + `Automation ID:` turn neither latches nor clears the hold (one left the main checkout's hold stuck from 2026-09-28). A turn opening with `Another Claude session sent a message:` has its subagent report removed non-strictly (closed or truncated) before the usual stripping, so the report's words cannot latch while a stop Mason typed after it still does; such a turn never clears a hold. A subagent hand-back latched it on 2026-10-02 through the strict truncated-report fail-safe.
- Review fixes on PR #874 (Luna, CodeRabbit, Codex GitHub review): output-flag writes (`sort -o`, `git diff --output=`), `env APP=1 rm`, `chmod`, wrappers with options (`sudo -n -u root`, `xargs -0 -r`, `timeout -s KILL 5`), `find -delete/-exec`, a shell launcher's payload (`sh -c`, `bash -lc`, `pwsh -Command`, `cmd /c`), `git checkout-index`, and a `git config` write naming a guarded path (`core.hooksPath /evil/.husky`; the exact `.husky` repair stays allowed) all deny; the backup check ignores future dates and reports a sample with no success as unverified.
- `bash-safety-lib.mjs`: dropped the computed-script-path rule (`node "$F"`), which existed only for the maintenance producer retired on 2026-09-05 (37 blocks). The by-name producer block stays.
- `session-staleness.mjs`: the off-site backup check reads the last 20 runs unfiltered, picks the newest success itself, never moves its cached date backwards, and re-checks an alarming cached answer before warning.
- User-level hooks outside this repo (not part of this PR): `~/.claude/hooks/verify-before-stop.mjs` now stands aside in any project that ships `.claude/hooks/stop-verify.mjs` (203 blocks in CRX), and `~/.claude/hooks/memory-index-size-guard.mjs` warns from 18,000 bytes and blocks only above 22,000.

**Proof observed**

- The read-only command that review-proof-guard refused earlier in the session (`node -e` reading `.claude/settings.json`) ran in the live session. Fed directly to the guard, `rm -f .husky/pre-push`, `cp … .claude/hooks/pr-merge-guard.mjs`, `git checkout main -- .claude/hooks/sql-safety.mjs` and `echo x > .github/workflows/ci.yml` returned BLOCKED, while `sed -n` and a `for` loop over `.claude/hooks` were allowed with a warning and `cat` was allowed.
- The exact stale cache that produced the false alarm (`completed_at` 2026-08-24, freshly fetched) made the old `session-staleness.mjs` print "Last DB backup is 39 days old". The new code re-queried GitHub, found the 2026-10-02 17:25 UTC success, and printed no backup warning.
- The user-level hooks were run with real inputs: verify-before-stop was silent in CRX and blocked in a project without `stop-verify.mjs`; the memory guard allowed at 17,000 bytes, warned at 19,000 and blocked at 23,000.
- The recorded 2026-10-02 hand-back, run through the real hook with its close tag cut off (the shape the strict fail-safe treats as truncated): main's `hold-latch-prompt.mjs` LATCHED, this branch's did not; a bare `stop` latched on both.
- `npm run test:correction-guards`, `npm run test:agent-workflows` and `npm run check:docs` all exited 0.

**Not verified**

- The exact text the harness handed the hook on 2026-10-02 could not be captured; the cut-off replay above reproduces the latch on main, which is the strongest available evidence that this was the mechanism.
- The main checkout's stale `hold.json` (latched 2026-09-28) was not deleted, because the kept review-state rule refuses shell deletes there. It clears on Mason's next typed message in a session started from that checkout.

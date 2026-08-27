## 2026-08-27 — standing delivery authority no longer triggers duplicate approval prompts

The Codex platform was already configured to run routine work without approval prompts, but
three CRX policy layers contradicted that setting: session onboarding required a wait before
multi-file edits, the risky-phrase hook classified auto-push/merge wording like a destructive
action, and armed unattended mode parked every push and PR merge even though the normal push,
review, CI, branch-protection, and merge guards still ran underneath it.

The shared prompt policy now says exactly where Mason's standing authority applies: reads,
edits, tests, commits, feature-branch pushes, protected green-PR merges, and verification proceed
without another confirmation. Armed mode lets those pushes and merges reach their owning guards
instead of denying them early. Force-push/history rewrite, out-of-band deploy, destructive data
actions, secret/auth changes, guard bypasses, direct remote file writes, destructive lifecycle
actions, and every existing migration/production rule remain blocked or gated exactly where
their owning guard requires. Safe preparation continues even when a real hard gate is found.

Regression tests pin both directions: ordinary branch push and protected PR merge are allowed
through the autopilot layer, while force-push variants and the rest of the destructive deny set
remain denied; routine delivery wording cannot demand another Mason confirmation, while a typed
force-push still does; and new-session guidance begins authorized reversible work instead of
waiting for a blanket approval.

Exact-head reviews found and closed the merge races before delivery: allowing armed `--auto`
merges would let an ordinary PR receive a later risky migration/money/guard commit after the
local merge hook returned, and GraphQL could arm the same behavior outside the CLI route. Both
Claude and Codex guards now deny all main-bound auto-merge paths. `land-pr.mjs` disables any
pre-existing auto-merge and prints an immediate merge command pinned to the inspected head SHA.
This adds no Mason approval: the agent waits for checks and performs the guarded merge itself.

A second exact-head review refused the candidate until the suggestion became enforcement. Every
main-bound CLI merge must now carry `--match-head-commit` equal to GitHub's inspected head, REST
merges must carry the same atomic `sha`, and MCP merge tools remain denied because their installed
schemas cannot transmit that precondition. The same review caught `auto deploy` being grouped with
routine commit/push/merge wording; it is again a hard-gated out-of-band production action, while
normal Vercel deployment caused by a reviewed green merge remains part of routine delivery.

The final GitHub review found two more bypass/friction edges before merge. File-backed GraphQL
requests (`--input` or `-F query=@file`) are now denied because the hook cannot inspect whether
their hidden body arms auto-merge. The standard ship command and frontend rollback runbook now
read the PR head and require its literal SHA in `--match-head-commit`, so the documented workflow
matches the enforced guard instead of failing at the last step.

The final exact-head review found one remaining asynchronous path: auto-merge could have been
armed before a later feature-branch push. GitHub would then merge the new commit when its checks
finished without an immediate merge command ever reaching the exact-head gate. Both push guards
now resolve every explicitly named feature destination against open main-bound PRs before the
push, fail closed if GitHub state cannot be proven, and tell the agent to disable auto-merge and
retry. This remains autonomous—the agent performs that recovery itself—and bare/config-directed
feature pushes are refused because their destination cannot be bound to a specific PR.

The next review adversarially demonstrated two parser evasions: a wildcard refspec could update
many PR branches while the lookup queried only `*`, and a shell variable could hide the word
`merge` in a command chained after the push. Feature pushes are now one standalone command with
exactly one literal valid branch destination; wildcard/multi-ref/config-directed forms fail
closed. GitHub CLI actions containing shell expansion, substitutions, splats, or backticks are
also denied by autopilot plus both merge guards. Ordinary literal push and exact-head merge
commands remain unattended and do not ask Mason for another approval.

The following exact-head review removed the last context guess: a compound command could switch
branches before a selectorless merge, making the hook inspect the old branch while the shell
merged the new one. Every merge must now be one standalone literal action that explicitly names
the numeric PR, `owner/repo`, and exact 40-character head SHA. Repository/host environment
overrides are denied. The documented ship, rollback, and `land-pr` commands emit that complete
form, so autonomous delivery remains one agent-owned command with no Mason prompt.

Proof run: focused autopilot, prompt, hold, Claude/Codex merge-guard, and global risky-phrase
tests; full correction-guard and agent-workflow suites; lint, typecheck, build, docs check, sync,
and mutation tests. No business safety rule, branch protection, product model, migration, RPC,
or product-model test was changed.

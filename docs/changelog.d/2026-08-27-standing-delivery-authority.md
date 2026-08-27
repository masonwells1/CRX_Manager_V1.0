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

Proof run: focused autopilot, prompt, hold, Claude/Codex merge-guard, and global risky-phrase
tests; full correction-guard and agent-workflow suites; lint, typecheck, build, docs check, sync,
and mutation tests. No business safety rule, branch protection, product model, migration, RPC,
or product-model test was changed.

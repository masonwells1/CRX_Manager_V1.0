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

A final shell-boundary review closed executable impersonation without adding an owner prompt.
Unattended pushes, branch updates, and merges now invoke the literal absolute trusted `git` or
`gh` executable; bare names, aliases/functions, exported Bash delivery functions, arbitrary
paths, and PATH resolution cannot substitute a different program after inspection. `land-pr.mjs`
prints the platform-correct guarded merge command, so this remains an automatic agent action.

The following exact-head review removed the last context guess: a compound command could switch
branches before a selectorless merge, making the hook inspect the old branch while the shell
merged the new one. Every merge must now be one standalone literal action that explicitly names
the numeric PR, `owner/repo`, and exact 40-character head SHA. Repository/host environment
overrides are denied. The documented ship, rollback, and `land-pr` commands emit that complete
form, so autonomous delivery remains one agent-owned command with no Mason prompt.

The final exact-head review removed GitHub REST merges from the permitted route. A file-backed
REST request body could hide or override a visible SHA field, so REST merges now deny
unconditionally. Autonomous delivery retains the single literal, standalone absolute-CLI `pr merge`
command with an explicit repository, PR number, and `--match-head-commit` SHA.

PowerShell's no-space call operator form (`&gh`) now routes through the same merge parser, and
remote branch/tag deletion is not part of unattended delivery. These close the exact-head review's
last two shell edge cases while preserving automatic ordinary feature pushes and protected merges.

Merge flags are now parsed positionally: cancellation-only `--disable-auto` is explicit and requires
the fixed trusted GitHub CLI, a numeric PR, and the canonical repository, while
mixed auto intent and `--disable-auto` consumed as body text cannot hide a real `--auto` action.
The protected helper boundary also normalizes adjacent shell quotes and escape spellings, so
`land-pr.mjs` cannot be edited or executed outside its exact-HEAD proof gate through a spliced path.
Armed unattended mode cannot edit, patch, or shell-mutate its own approval/delivery guards or
their hook manifests; ordinary product-file edits remain automatic.
Empty-quote-composed GitHub executable or subcommand words also deny before unattended execution.

The integrity boundary also covers every trusted proof producer, landing helper, live-maintenance
executor, and registration surface used by unattended delivery. Before any of those helpers runs,
the hook verifies that the complete boundary is tracked and Git-unchanged from the current
HEAD commit. A locally modified `land-pr.mjs` or `write-codex-push-proof.mjs` is denied instead of
receiving unattended approval; committed exact-HEAD copies remain automatic.

Final GitHub review closed two path-spelling gaps in that boundary. File-tool targets are now
canonicalized before matching, so `./` and `../` cannot disguise a protected helper, and shell
grouping characters such as PowerShell parentheses are recognized as path boundaries. Failure to
resolve the fixed trusted GitHub CLI denies instead of letting the approval hook exit ambiguously.
Inline interpreter write commands that explicitly name protected sources are also denied, while
read-only searches containing the same text remain automatic.
Integrity denials now state the actual recovery, the landing helper distinguishes safety-evidence
failures from real update-branch conflicts, and the rollback runbook passes the required PR number
to `gh pr view`. The Claude/Codex difference for non-main `baseRefOid` handling is documented as
intentional; protected-main exact-base proof remains identical and unchanged.

Feature pushes now resolve their effective push URL and query auto-merge state in that exact
GitHub repository; an alternate remote cannot borrow CRX's result. The unattended form updates
one explicit branch only (`HEAD:refs/heads/<branch>`). Tags, notes, implicit tag propagation,
ambiguous network destinations, and multiple repositories deny, while local test repositories remain available.

The closing exact-head review found that repository identity was still normalized independently
of transport safety: a custom `relay://` helper or cleartext `http://github.com/...` URL could
canonicalize to the protected CRX repository. Feature-push resolution now accepts only GitHub's
documented secure HTTPS and SSH forms before comparing owner/repository identity. Custom helpers,
cleartext and local transports, nonstandard ports, and non-Git SSH users fail closed in both the
Claude and Codex guard paths; normal HTTPS, SSH, and GitHub's port-443 SSH endpoint remain automatic.

That review then demonstrated a separate shell-grouping bypass: a quoted absolute GitHub CLI path
inside POSIX grouping or process substitution was not recognized as a mutation. The shared dynamic
command classifier now recognizes absolute `gh` executables as well as bare `gh` after grouping
normalization. The exact demonstrated API merge/ref-write forms deny in armed autopilot, the Claude
merge guard, and the Codex production guard before any GitHub lookup.

Unquoted shell comment markers in GitHub CLI commands now deny before parsing, so flags written
after `#` cannot be mistaken for the repository, expected head, or auto-merge intent that the shell
actually omits. Quoted hash characters remain ordinary message/body data.

Proof run: focused autopilot, prompt, hold, Claude/Codex merge-guard, and global risky-phrase
tests; full correction-guard and agent-workflow suites; lint, typecheck, build, docs check, sync,
and mutation tests. No business safety rule, branch protection, product model, migration, RPC,
or product-model test was changed.

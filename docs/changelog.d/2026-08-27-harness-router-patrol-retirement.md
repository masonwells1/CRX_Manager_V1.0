## 2026-08-27 — Simplify hook routing and retire Patrol

Replaced seven Claude prompt-hook launches and five PostToolUse launches with one event router per
event. The routers keep the existing rule modules and run only the modules applicable to each tool;
Codex MCP-only and production-action guards now use the same relevant matcher scope as Claude.

Retired the Patrol command, generated skill adapter, runtime, monitor, classifier, renderer, and
dedicated tests. The recurring CRX foundation gauntlet was separately paused and retuned to a
monthly/on-demand read-only audit whose prevention mandate applies only to reproducible
BLOCKER/HIGH recurrences.

No business safety rule, branch-protection setting, product code, migration, RPC, or customer data
was changed. Verification is recorded in the pull request and closeout handoff.

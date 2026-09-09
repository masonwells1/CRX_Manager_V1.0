## 2026-09-05 - Retain approval for review and merge controls

Mason approved the narrower permission setup after independent review rejected
unrestricted native edits to the controls that certify their own changes.

Restore the original 32 native Edit/Write ask entries covering 16 protected path
patterns: hooks, their settings and registrations, Codex configuration, CodeRabbit,
Husky, package scripts, CI workflows, verification scripts, and named review/ledger
scripts. Keep inherited user permission mode, ordinary source editing, explicit MCP
read grants, connector safeguards, and expanded independent-review path coverage.
Existing merge/deploy entries remain unchanged. This supersedes the earlier PR #605
decision to remove those native approval entries; it does not authorize review bypass.

Verification: a fresh installed Claude session in a disposable checkout successfully
wrote/read `src/permission-probe.txt` with the marker `ORDINARY_WRITE_OK`. Its attempt
to write `.claude/hooks/permission-probe.txt` was refused and created no file. The
session used normal inherited settings, with no permission-mode bypass. Direct
comparison confirms all 32 original protected-path ask entries and the original
merge/deploy ask entries are retained. The full agent-workflow suite passes.

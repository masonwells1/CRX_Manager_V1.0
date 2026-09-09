## 2026-09-05 - Inherit the owner's Auto permission mode

A fresh Claude 2.1.251 session on PR #605 attempted a harmless native Write to
`.claude/hooks/permission-probe.txt` in a disposable checkout. Claude refused it
with "Permission to use Write has been denied because Claude Code is running in
don't ask mode." The file was not created. Removing path-specific ask rules alone
does not unlock Claude's built-in protected paths.

Remove the repository's `defaultMode: dontAsk` override so Mason's existing global
Auto mode can review authorized protected-path writes. No bypass mode is enabled.
Explicit ask/deny rules, including merges and production deploys, remain intact.
Other users retain their own chosen mode; this repository does not grant itself
Auto mode. Claude's documented behavior is that protected-path writes go to the
classifier in Auto mode, are denied in dontAsk, and cannot be pre-approved by
settings allow rules: https://code.claude.com/docs/en/permission-modes#protected-paths

This corrects earlier PR notes claiming that removing the ask entries alone makes
native configuration writes work. Auto mode reduces prompts but can still refuse
an action; it is not a promise that every action will be accepted.

Behavioral verification: repeating the same native Write/Read probe in a fresh
Claude session after removing only the mode override created the exact marker
`PERMISSION_PROBE_OK`, with an empty `permission_denials` array. Both probes used
the normal installed CLI and inherited settings, without permission bypass flags.
The disposable checkout kept the probe out of the PR and production.

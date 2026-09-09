## 2026-09-05 - Preserve owner approval after technical checks

Mason reopened the correction pass after independent review of 24caf35a6.
Successful migration proof evaluation now emits no hook permission decision;
it cannot override an approval prompt for a replacement connector. Invalid or
missing technical proofs still deny, and the shared migration rules are unchanged.

Every unidentified UUID connector mutation now requires an exact ask/deny entry.
A saved allow-only entry no longer settles delete_project, sync_env, or a future
non-read tool. Known read behavior and existing merge policy remain unchanged.

Both regression checks failed on the preceding implementation and passed after
the correction. Tests cover successful proof on named and UUID replacement
migration routes and allow-only refusal plus ask/deny delegation for unknown
mutations. Fixtures are isolated; no production migration or data change occurs.

Observed live verification: an installed Claude session attempted the harmless
mcp__permission_probe__write_marker tool, recorded it in permission_denials,
and created no temporary marker. No permission overrides were supplied. This
completes the previously rate-limited unlisted-connector probe.

Validation passed: migration guard (115 assertions), MCP guard (122 assertions),
full agent-workflow suite, and documentation drift check.

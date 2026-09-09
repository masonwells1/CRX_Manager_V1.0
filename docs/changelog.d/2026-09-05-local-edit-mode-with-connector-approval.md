## 2026-09-05 - Automate local edits while requiring unknown connector approval

Independent review of 7db778241 found that inherited Auto mode can approve new
mutating tools on named external connectors, even after Supabase-specific fixes.
Set the repository mode to `acceptEdits`: ordinary local edits remain automatic,
explicitly allowed tools remain available, and unlisted connector tools require
permission instead of Auto classification. Retained guard-file ask rules and
existing merge/deploy approvals continue to apply. This implements Mason's approved
narrower scope without adding another connector-name registry or changing GitHub
merge behavior. It supersedes earlier PR #605 implementation notes about inheriting
Auto; the historical probes still record what those earlier candidates actually did.

A harmless local MCP probe exposed a second cause: migration-apply-guard returned
an explicit allow for all non-migration calls, overriding their permission handling.
It now emits no decision for unrelated calls or malformed payloads. Migration calls
still execute the same proof checks. Regression assertions pin silence rather than
merely absence of a denial for unrelated tools.

Verification: the full agent-workflow suite and documentation drift check passed.
The final live Claude connector-permission probe is pending: Claude returned a
session-limit API error before attempting the tool. Marker absence is not proof
of denial; repeat the bounded local probe before delivery.

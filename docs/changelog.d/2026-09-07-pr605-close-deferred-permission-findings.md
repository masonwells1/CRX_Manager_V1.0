## 2026-09-07 - Close the remaining PR 605 permission findings

Mason requested analysis of every flagged comment and completion through green
checks, CodeRabbit review, and protected merge. This reopens the two previously
deferred permission findings for this PR.

Every tool on an unidentified UUID connector now requires an exact ask/deny
entry. Read-looking prefixes and suffixes do not establish read-only behavior;
the get_and_delete_project regression failed against the preceding hook.
Identified Supabase connectors retain their established exact read allowlist.

The legacy Claude_Preview preview_start tool now requires approval, matching
Claude_Browser. Its server-wide project allow and explicit local allow are removed.
Ordinary source edits and the existing merge process are unchanged.

The saved dependency-command fix from September 6 is preserved and will be
published with this candidate. Main was merged by content before verification.

Verification: the installed Claude session attempted the harmless local
get_and_delete_project fixture and received the intended MCP guard denial;
the marker file was not created. The legacy preview fixture was not exposed
by the installed client, so no live preview-launch denial is claimed. Its
ask placement and removal of both conflicting allows are checked from the
effective tracked settings. No real preview process or production tool ran.

The 140 connector assertions, review-proof guard tests (including the saved
package-manager fix), full agent-workflow suite, 123 migration assertions,
protected-surface parity checks, and documentation drift checks passed.
Connector test helpers now also require normal process exit, so a crash cannot
masquerade as silent permission delegation.

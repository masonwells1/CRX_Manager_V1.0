## 2026-09-12 - Field-application invoice creation season guard (local, not applied)

The fresh whole-branch review of the five CodeRabbit corrections found a HIGH creation
bypass: generic `save_invoice` accepted a caller-supplied season disagreeing with a new
field-application invoice's transaction date. The existing filed-season candidate trigger
guards UPDATE, not INSERT. A public authenticated RPC regression reproduced the bypass
in disposable PostgreSQL and failed with `GENERIC_CREATION_GUARD_MISSING` before the fix.

Compatibility review rejected a universal INSERT guard: job and blend-ticket creators
deliberately carry their source season while using today's invoice date. Preserve that
rejected draft as ignored review history, not a migration or release candidate.

Instead add `20260912165758_refuse_generic_field_invoice_creation.sql`: reemit only the
actual public `save_invoice` wrapper with an early NEW-field-application refusal. Such
invoices must use the dedicated creators, as the current UI already requires. Generic
edits of existing field invoices, job/blend source-season creation, other invoice types,
pricing and all original below-cost/idempotency calls remain unchanged. Pre/postflight pin
the exact function/defaults/owner/body and existing authenticated/service-role access.
Register the new refusal token in the shared RPC codes. No historical row is re-seasoned.

The prover restores the actual applied generic routing body as well as its private writer,
then checks the public entry/routing/writer against September 12 read-only live fingerprints.
This avoids incorrectly treating an older baseline writer's date fallback as live behavior.
Coverage includes bypass/refusal rollback, matching-season generic field refusal, valid
nonfield explicit/inferred seasons and same-key retries, existing field edits, dedicated
job/blend source-season controls, replay, and removal of only the new refusal. That
mutation must restore the byte-identical live wrapper and make the bypass return.

The final extended prover observed all these controls and ended
`PREVIEW_SEASON_PROOF_PASS`, exit 0; the registered public invoice chain also reached
`SMOKE_PASS_ROLLBACK`. Installed public job/blend creators successfully retained prior
source seasons and today's invoice dates. Those creator controls use the replayed baseline
implementations; the public generic entry/routing/writer are specifically live-fingerprint
pinned. Three fresh focused security/drift/compliance reviews report no blocker/high/medium.
They are supporting reviews, not the still-required frozen whole-branch exact-head clearance.

This is NOT production deployment or final review clearance. Both new guard migrations
remain NOT APPLIED; the last committed candidate's exact-head verdict is BLOCKERS.
Fresh verification/reviews, a new frozen candidate, normal push/CI and actual CodeRabbit
re-review remain required. No merge or live apply is authorized.

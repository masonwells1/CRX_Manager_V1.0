# Claude Disposition — Codex Cross-Review of the H1 Quick-Wins Batch (2026-06-11)

**Codex verdict:** NEEDS-WORK (1 blocker + at least 1 required fix; Mason's paste appeared truncated after fix #1 — any further findings to be folded in when provided).
**Packet:** `docs/audits/2026-06-10-codex-b5-license-gates-prompt.md`

## Point-by-point

### Blocker — branch/commit unavailable to Codex
**ACCEPTED (process, not code).** The branch `feat/h1-quick-wins-2026-06-10` existed only in the cloud session workspace; it had deliberately not been pushed (prod-push gate). Codex reviews require the code to be visible. **Action:** branch pushed to origin + draft PR opened (a branch push does not deploy — production only changes on merge to `main`). Re-review SHA provided to Mason.

### Fix #1 (MEDIUM) — holder CHECK allows both `customer_id` AND `profile_id`
**ACCEPTED — verified true and fixed live.** The B5 constraint `(customer_id IS NOT NULL OR profile_id IS NOT NULL)` permitted both-set rows. The UI can never produce one (Compliance.tsx nulls the unselected side on both insert and update), but a direct SQL/PostgREST write could, and such a row would count ambiguously for BOTH a customer's RUP-compliance lookup (filters `customer_id`) and a staff member's job-assignment gate (filters `profile_id`).
**Fix:** migration `20260611190251_applicator_license_holder_xor` (APPLIED LIVE through the full gate — both reviewers clean, proof file, pre-apply probe found 0 both-set rows, rolled-back smoke: both-set→`check_violation`, customer-only PASS, staff-only PASS, B7 rename). New form: `((customer_id IS NOT NULL) <> (profile_id IS NOT NULL))` — total boolean XOR (`IS NOT NULL` never yields NULL, so no NULL loophole; both-NULL also still rejected).

## Open
- Awaiting the remainder of Codex's findings if the paste was truncated, and Codex's re-review against the pushed SHA.

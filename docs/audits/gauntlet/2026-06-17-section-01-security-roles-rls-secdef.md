# CRX Live Foundation Gauntlet - Section 1

Section: Security, roles, route gating, RLS, SECURITY DEFINER RPC access  
Run time: 2026-06-17 02:11 CDT  
Mode: Read-only audit of current repo code plus live Supabase database structure only

## Verdict

SOLID-WITH-FOLLOWUP. No production-wide security blocker was proven. Route gating, RLS coverage, view behavior, and SECURITY DEFINER search paths are structurally clean. One HIGH finding remains: two blend-ticket order-link RPCs can forge audit attribution because they trust caller-supplied `p_performed_by`.

Counts: BLOCKER 0, HIGH 1, MED 0, LOW 0.

## Repo State

Started from `C:\CRX_Manager` on branch `main` at `82ef734`.

Existing uncommitted files, not modified:

- `docs/audits/2026-06-15-codex-to-claude-full-gauntlet-handoff.md`
- `docs/audits/2026-06-16-codex-to-claude-targeted-gauntlet-handoff.md`

Allowed writes performed by this run:

- `docs/audits/gauntlet/live-foundation-gauntlet-index.md`
- `docs/audits/gauntlet/2026-06-17-section-01-security-roles-rls-secdef.md`

## Finding 1 - HIGH - Blend-ticket order-link RPCs allow forged audit actor ids

Evidence:

- Live catalog, `pg_proc`, 2026-06-17: `link_blend_ticket_to_order(p_blend_ticket_id uuid, p_order_id uuid, p_item_mappings jsonb, p_performed_by uuid, p_idempotency_key text)` has `auth_exec = true`, `has_role_gate = true`, `mentions_auth_uid = false`, and `has_actor_mismatch_guard = false`.
- Live catalog, same query: `unlink_blend_ticket_from_order(p_blend_ticket_id uuid, p_performed_by uuid, p_idempotency_key text)` has `auth_exec = true`, `has_role_gate = true`, `mentions_auth_uid = false`, and `has_actor_mismatch_guard = false`.
- Live function body evidence for `link_blend_ticket_to_order`: it inserts `p_performed_by` into `blend_ticket_to_order_items.created_by`, `activity_feed.performed_by`, and `financial_audit_log.actor_user_id`; it derives `actor_role` with `(SELECT role FROM profiles WHERE id = p_performed_by)`.
- Live function body evidence for `unlink_blend_ticket_from_order`: it inserts `p_performed_by` into `activity_feed.performed_by` and `financial_audit_log.actor_user_id`; it also derives `actor_role` from `profiles` by that supplied id.
- Source callers pass the current profile id in the normal UI path: [src/pages/BlendTicketDetail.tsx](C:/CRX_Manager/src/pages/BlendTicketDetail.tsx:573) and [src/pages/BlendTicketDetail.tsx](C:/CRX_Manager/src/pages/BlendTicketDetail.tsx:1354).
- The secure pattern already exists broadly in newer migrations, for example [supabase/migrations/20260609195713_strict_actor_blend_ticket_rpcs.sql](C:/CRX_Manager/supabase/migrations/20260609195713_strict_actor_blend_ticket_rpcs.sql:9) documents the canonical `auth.uid()` / `ACTOR_MISMATCH` block for blend-ticket RPCs.

Plain-English business risk:

An admin or sales rep can call these RPCs directly and claim another employee performed the blend-ticket link or unlink. This does not prove open customer-data access, because the functions still require admin or sales-rep role, but it makes the audit trail unreliable for blend-ticket-to-order changes.

Suggested fix:

Create a new migration that rewrites both RPCs with the canonical strict-actor block:

- `v_actor := auth.uid();`
- reject missing auth with `AUTH_REQUIRED`;
- reject `p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor` with `ACTOR_MISMATCH`;
- use `v_actor` for `created_by`, `activity_feed.performed_by`, and `financial_audit_log.actor_user_id`;
- preserve current idempotency operation strings and return shapes.

Prevention action:

Add a deterministic SQL sweep or unit fixture check that flags every authenticated, mutating SECURITY DEFINER RPC with a `p_performed_by`/`p_*_by` parameter unless the live body contains an `auth.uid()` actor binding plus `ACTOR_MISMATCH` or equivalent mismatch rejection. Include `link_blend_ticket_to_order` and `unlink_blend_ticket_from_order` as regression fixtures.

## Verified Clean Areas

- RLS coverage: live catalog reports 96 public tables, 96 RLS-enabled, 0 RLS-disabled, and 0 RLS-enabled tables without policies.
- Views: live `profile_public_view` no longer grants SELECT to anon; `view_unmigrated_products` is `security_invoker=true`. Runtime `SET LOCAL ROLE anon` showed 0 visible rows for `fields`, `field_polygons`, and `view_unmigrated_products`, while `profile_public_view` SELECT was denied to anon.
- SECURITY DEFINER search paths: live catalog reports 233 public SECURITY DEFINER functions and 0 missing the required `public` plus `pg_temp` search path components. PostGIS functions that also include `extensions` were treated as valid because `docs/reference/gotchas.md` requires that for geometry functions.
- Business RPC overloads: live overload query found only `plpgsql_check` extension helper overloads, not CRX business RPC overload collisions.
- Frontend route gating: [src/components/auth/ProtectedRoute.tsx](C:/CRX_Manager/src/components/auth/ProtectedRoute.tsx:24) redirects when no session exists, [src/components/auth/ProtectedRoute.tsx](C:/CRX_Manager/src/components/auth/ProtectedRoute.tsx:29) redirects when no profile loads, [src/components/auth/ProtectedRoute.tsx](C:/CRX_Manager/src/components/auth/ProtectedRoute.tsx:34) blocks inactive users, [src/components/auth/ProtectedRoute.tsx](C:/CRX_Manager/src/components/auth/ProtectedRoute.tsx:38) enforces route-level roles, and [src/components/auth/ProtectedRoute.tsx](C:/CRX_Manager/src/components/auth/ProtectedRoute.tsx:43) applies page deny-list checks.
- Page-permission coverage: [src/lib/pagePermissions.ts](C:/CRX_Manager/src/lib/pagePermissions.ts:131) denies unknown page keys fail-closed, and [src/lib/pagePermissions.test.ts](C:/CRX_Manager/src/lib/pagePermissions.test.ts:184) verifies every protected `App.tsx` route has a permission entry or explicit exemption.
- Focused verification: `npm test -- src/lib/pagePermissions.test.ts --run` passed 1 file / 30 tests.

## Carryover Notes For Later Sections

- The session staleness hook warned that `.claude/schema-registry.json` is behind 16 newer migration files. This run did not use the stale registry for live security conclusions. Section 5 should audit repo migrations vs schema registry vs live catalog directly.
- Live field policies are broader than `docs/reference/database-schema.md` implies: live `fields_update` is `(is_admin() OR is_sales_rep())`, not assigned-customer-only. This is best handled in section 15 unless a later section proves it is unintended access.

## Next Section

Section 2 is queued next: Money, invoices, payments, AR aging, statements, credits, write-offs, finance charges.

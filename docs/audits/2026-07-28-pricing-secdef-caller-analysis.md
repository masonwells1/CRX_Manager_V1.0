# Pricing SECDEF Caller Analysis

Migration: `supabase/migrations/20260728182141_secdef_pricing_reads_office_only.sql`

Git blob: `416478d0410946c94a83706bd5e69d87a25afbc8`

SHA-256: `127ccff3b9d7a0f754dd7bcc904be6a80f108e133bc8aea6568c0675ad807e30`

Live ledger version: `20260728182141`

The migration was already applied before this audit record was added, so its
body and comments remain immutable. This sidecar is hash-bound to that exact
applied file.

`caller-analysis: compute_application_service_fee :: no browser, Edge Function, or cron RPC callers; its in-database callers execute as SECURITY DEFINER owners and retain access; direct authenticated execution is intentionally removed`

`caller-analysis: get_program_completion :: OfficeCockpit.tsx and ProgramTracker.tsx call as authenticated users; authenticated and service_role EXECUTE are retained in the same migration; only PUBLIC and anon are revoked`

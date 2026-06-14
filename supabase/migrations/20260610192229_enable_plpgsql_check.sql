-- ============================================================================
-- DISK RECOVERY of a live-applied migration (B7-class reconciliation)
-- ----------------------------------------------------------------------------
-- This migration was applied to the live database on 2026-06-10 via the
-- Supabase MCP (schema_migrations: version 20260610192229, name
-- 'enable_plpgsql_check') but its disk file was never committed — found by
-- the 2026-06-11 Codex cross-review (handoff §5) content-level history check.
-- This file restores the auditable rebuild path so the disk migration list
-- matches live 1:1 (same precedent as the 20260530192441 recovery).
--
-- DO NOT RE-APPLY: the version is already recorded live. The body is
-- idempotent (IF NOT EXISTS) so an accidental re-apply or a shadow-DB
-- rebuild both converge to the live state.
--
-- What it does: installs the plpgsql_check extension (live: version 2.7,
-- schema public) — the static analyzer behind the
-- scripts/db-invariant-sweeps plpgsql-check predicate. The extension ships
-- 8 legitimately-overloaded helper functions into public; the overloads
-- sweep predicate excludes extension-owned functions via pg_depend
-- deptype 'e' (scripts/db-invariant-sweeps/predicates/overloads.sql).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS plpgsql_check;

-- Self-verification: extension present
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'plpgsql_check') THEN
    RAISE EXCEPTION 'plpgsql_check extension missing after apply';
  END IF;
END $$;

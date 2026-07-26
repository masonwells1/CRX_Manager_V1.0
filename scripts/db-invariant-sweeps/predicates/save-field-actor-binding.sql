-- predicate (j): save-field-actor-binding
-- Fail-closed standing control for the exact audited
-- save_field(uuid,jsonb,jsonb,uuid,text) body emitted by migration
-- 20260725234503. Any missing signature or body drift is a violation and
-- requires a new security review plus an intentional fingerprint update.
-- SHA-256 was derived in disposable PostgreSQL 17 from pg_proc.prosrc after
-- applying the exact checked-in migration.

WITH exact_signature AS (
  SELECT p.prosrc
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'save_field'
    AND oidvectortypes(p.proargtypes) = 'uuid, jsonb, jsonb, uuid, text'
)
SELECT 'save_field(uuid, jsonb, jsonb, uuid, text)' AS violation_key
WHERE NOT EXISTS (
  SELECT 1
  FROM exact_signature
  WHERE encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') =
        '10a53c6b4c218a3836b0a5269fc558cc214eb8741a2df6669133885919f50ff2'
);

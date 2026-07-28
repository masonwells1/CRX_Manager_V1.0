-- Emit the ACL lockdown body for supabase/baselines/*_acl_lockdown.sql.
--
-- WHY THIS EXISTS
-- A schema dump can only GRANT. It cannot know that the target project already
-- granted more than production does. A new Supabase project ships
-- ALTER DEFAULT PRIVILEGES that give `anon` full CRUD on every table and EXECUTE
-- on every function created by `postgres`, and `REVOKE ... FROM PUBLIC` does not
-- strip a role-specific grant. So restoring the public schema alone leaves the
-- unauthenticated `anon` role holding privileges production revoked, and leaves
-- the default privileges that would re-grant them to every future migration.
--
-- This file reproduces production's exact grants: it revokes the Supabase-managed
-- roles down to nothing, re-grants precisely what live holds, and restores the
-- default privileges that govern objects created after the restore.
--
-- Run with `psql -At -f scripts/schema-baseline-acl.sql` against LIVE and feed the
-- output to scripts/build-schema-baseline-acl.mjs. Output order is deterministic.

-- PUBLIC is captured alongside the named roles: a freshly created function grants
-- EXECUTE to PUBLIC by default, production has kept that on 93 functions, and the
-- lockdown's blanket REVOKE would otherwise strip it and diverge from live.
--
-- Every stream below groups by `is_grantable` as well as grantee, and emits
-- `WITH GRANT OPTION` for the grantable rows. Production currently holds zero
-- grantable entries in `public`, so this changes no output today; without it a
-- future grant option would be re-emitted as a plain grant and the baseline would
-- quietly restore weaker ACLs than live has. Splitting the rows also keeps the
-- output deterministic, which is why `sort_grantable` joins the sort key.
WITH managed(role_name) AS (
  VALUES ('anon'), ('authenticated'), ('service_role'), ('metabase_ro'), ('PUBLIC')
),

-- Existing relations: one GRANT per (relation, grantee) with privileges sorted.
relation_grants AS (
  SELECT
    1 AS sort_group,
    format('%s.%s', n.nspname, c.relname) AS sort_object,
    acl.grantee_name AS sort_grantee,
    acl.is_grantable AS sort_grantable,
    format(
      'GRANT %s ON %s %I.%I TO %s%s;',
      acl.privileges,
      CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      n.nspname, c.relname, acl.grantee_sql,
      CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
    ) AS statement
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee_name,
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee_sql,
      a.is_grantable,
      string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
    FROM aclexplode(c.relacl) a
    GROUP BY a.grantee, a.is_grantable
  ) acl
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
    AND acl.grantee_name IN (SELECT role_name FROM managed)
),

-- Column-level grants. These are NOT redundant with the relation grants above, and
-- omitting them silently breaks a rebuilt project: production gives `authenticated`
-- no table-level INSERT or UPDATE on `public.products`, so 27 column grants are its
-- only write path. `REVOKE ALL ON ALL TABLES` strips column privileges along with
-- table ones, so the reset above removes them and only this block puts them back.
-- Granting the table instead would restore the app and widen access at the same time.
column_grants AS (
  SELECT
    2 AS sort_group,
    format('%s.%s.%s', n.nspname, c.relname, att.attname) AS sort_object,
    acl.grantee_name AS sort_grantee,
    acl.is_grantable AS sort_grantable,
    format(
      'GRANT %s ON TABLE %I.%I TO %s%s;',
      acl.privileges,
      n.nspname, c.relname, acl.grantee_sql,
      CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
    ) AS statement
  FROM pg_attribute att
  JOIN pg_class c ON c.oid = att.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee_name,
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee_sql,
      a.is_grantable,
      string_agg(format('%s(%I)', a.privilege_type, att.attname), ', ' ORDER BY a.privilege_type) AS privileges
    FROM aclexplode(att.attacl) a
    GROUP BY a.grantee, a.is_grantable
  ) acl
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm')
    AND att.attnum > 0
    AND NOT att.attisdropped
    AND att.attacl IS NOT NULL
    AND acl.grantee_name IN (SELECT role_name FROM managed)
),

-- Existing routines: identity arguments keep overloaded names unambiguous.
routine_grants AS (
  SELECT
    3 AS sort_group,
    format('%s.%s(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS sort_object,
    acl.grantee_name AS sort_grantee,
    acl.is_grantable AS sort_grantable,
    format(
      'GRANT %s ON FUNCTION %I.%I(%s) TO %s%s;',
      acl.privileges,
      n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), acl.grantee_sql,
      CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
    ) AS statement
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee_name,
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee_sql,
      a.is_grantable,
      string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
    FROM aclexplode(p.proacl) a
    GROUP BY a.grantee, a.is_grantable
  ) acl
  WHERE n.nspname = 'public'
    AND d.objid IS NULL
    AND p.prokind IN ('f', 'p')
    AND acl.grantee_name IN (SELECT role_name FROM managed)
),

-- Default privileges govern every object a post-baseline migration creates.
-- Only the `postgres` grantor is CRX-owned; the platform manages its own.
default_privileges AS (
  SELECT
    4 AS sort_group,
    format('%s.%s', n.nspname, d.defaclobjtype::text) AS sort_object,
    acl.grantee_name AS sort_grantee,
    acl.is_grantable AS sort_grantable,
    format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT %s ON %s TO %s%s;',
      pg_get_userbyid(d.defaclrole),
      n.nspname,
      acl.privileges,
      CASE d.defaclobjtype
        WHEN 'r' THEN 'TABLES'
        WHEN 'S' THEN 'SEQUENCES'
        WHEN 'f' THEN 'FUNCTIONS'
      END,
      acl.grantee_sql,
      CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
    ) AS statement
  FROM pg_default_acl d
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee_name,
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS grantee_sql,
      a.is_grantable,
      string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
    FROM aclexplode(d.defaclacl) a
    GROUP BY a.grantee, a.is_grantable
  ) acl
  WHERE n.nspname = 'public'
    AND pg_get_userbyid(d.defaclrole) = 'postgres'
    AND d.defaclobjtype IN ('r', 'S', 'f')
    AND acl.grantee_name IN (SELECT role_name FROM managed)
)

SELECT statement
FROM (
  SELECT * FROM relation_grants
  UNION ALL SELECT * FROM column_grants
  UNION ALL SELECT * FROM routine_grants
  UNION ALL SELECT * FROM default_privileges
) s
ORDER BY sort_group, sort_object, sort_grantee, sort_grantable;

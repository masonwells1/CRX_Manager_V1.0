/** One matcher for linked-psql sweeps and captured Supabase MCP results. */
const ACTOR_PREDICATES = new Set(['actor-forgery', 'actor-forgery-fin-audit']);
const DIGEST = /^[a-f0-9]{32}$/;

function contractIndex(rows) {
  if (!Array.isArray(rows)) return null;
  const index = new Map();
  for (const row of rows) {
    if (!row || typeof row.function_key !== 'string' ||
        !DIGEST.test(row.contract_md5 ?? '') || index.has(row.function_key)) return null;
    index.set(row.function_key, row.contract_md5);
  }
  return index;
}

/** Missing, malformed, duplicate, or changed contracts never authorize an exception. */
export function subtractAllowlist(rows, entries, functionContracts = []) {
  if (!Array.isArray(rows) || !Array.isArray(entries)) {
    throw new TypeError('Sweep rows and allowlist entries must be arrays.');
  }
  const contracts = contractIndex(functionContracts);
  return rows.filter((row) => {
    if (!row || typeof row.violation_key !== 'string') {
      throw new TypeError('Predicate output is missing a string violation_key.');
    }
    return !entries.some((entry) => {
      if (entry.violation_key !== row.violation_key) return false;
      const bound = ACTOR_PREDICATES.has(entry.predicate) ||
        Object.hasOwn(entry, 'suspect_param') || Object.hasOwn(entry, 'reviewed_contracts');
      if (!bound) return true; // Unchanged non-actor/data baselines retain their existing contract.
      const reviewed = entry.reviewed_contracts;
      if (typeof entry.suspect_param !== 'string' || entry.suspect_param.length === 0 ||
          row.suspect_param !== entry.suspect_param || !contracts || !reviewed ||
          typeof reviewed !== 'object' || Array.isArray(reviewed)) return false;
      const pins = Object.entries(reviewed);
      // A dependency-only pin or an unpinned identity source is not a reviewed function contract.
      if (!Object.hasOwn(reviewed, `public.${entry.violation_key}`) ||
          !Object.hasOwn(reviewed, 'auth.uid()')) return false;
      return pins.every(([key, digest]) => typeof digest === 'string' &&
        DIGEST.test(digest) && contracts.get(key) === digest);
    });
  });
}

/** Full definition includes body/defaults/volatility/security/search_path; pin owner and ACL too. */
export function functionContractSql(functionKeys) {
  const literals = [...new Set(functionKeys)].sort()
    .map((key) => `'${key.replaceAll("'", "''")}'`).join(', ');
  return `SELECT
  n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS function_key,
  pg_catalog.md5(pg_catalog.jsonb_build_object(
    'definition', pg_catalog.pg_get_functiondef(p.oid),
    'owner', pg_catalog.pg_get_userbyid(p.proowner),
    'data_api_execute', pg_catalog.jsonb_build_object(
      'anon', CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')
        THEN pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') ELSE NULL END,
      'authenticated', CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated')
        THEN pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') ELSE NULL END,
      'service_role', CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
        THEN pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') ELSE NULL END
    ),
    'execute_acl', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
        'grantor', pg_catalog.pg_get_userbyid(a.grantor),
        'grantable', a.is_grantable
      ) ORDER BY (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END),
        pg_catalog.pg_get_userbyid(a.grantor), a.is_grantable)
      FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS a
      WHERE a.privilege_type = 'EXECUTE'
    ), '[]'::jsonb)
  )::text) AS contract_md5
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE p.prokind IN ('f', 'p') AND n.nspname IN ('public', 'auth')
  AND (n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')')
    = ANY(ARRAY[${literals}]::text[])
ORDER BY function_key`;
}

/** Predicate and all its required contracts are read in ONE PostgreSQL statement/snapshot. */
export function buildSweepQuery(predicate, entries) {
  const keys = entries.flatMap((entry) => Object.keys(entry.reviewed_contracts ?? {}));
  const sql = predicate.sql.replace(/;\s*$/, '');
  const contracts = keys.length === 0 ? "'[]'::json" :
    `(SELECT COALESCE(json_agg(c), '[]'::json) FROM (${functionContractSql(keys)}) AS c)`;
  return `SELECT json_build_object(
  'predicate', '${predicate.name.replaceAll("'", "''")}',
  'rows', (SELECT COALESCE(json_agg(v), '[]'::json) FROM (\n${sql}\n) AS v),
  'function_contracts', ${contracts}
) AS sweep_result;`;
}

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

/**
 * Missing, malformed, duplicate, or changed contracts never authorize an exception.
 *
 * `predicateName` is required and every entry must name it. Callers already filter the allowlist
 * by predicate, but matching on `violation_key` alone meant a caller that passed the WHOLE
 * allowlist could let one predicate's reviewed exception clear another predicate's row that
 * happened to share the key. The binding lives here so the guarantee cannot be lost at a call
 * site (CodeRabbit on #774).
 */
export function subtractAllowlist(predicateName, rows, entries, functionContracts = []) {
  if (typeof predicateName !== 'string' || predicateName.length === 0) {
    throw new TypeError('Subtraction requires the predicate whose rows are being adjudicated.');
  }
  if (!Array.isArray(rows) || !Array.isArray(entries)) {
    throw new TypeError('Sweep rows and allowlist entries must be arrays.');
  }
  const contracts = contractIndex(functionContracts);
  return rows.filter((row) => {
    if (!row || typeof row.violation_key !== 'string') {
      throw new TypeError('Predicate output is missing a string violation_key.');
    }
    return !entries.some((entry) => {
      if (entry.predicate !== predicateName) return false;
      if (entry.violation_key !== row.violation_key) return false;
      const bound = ACTOR_PREDICATES.has(entry.predicate) ||
        Object.hasOwn(row, 'suspect_param') ||
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

/**
 * Does this SQL still terminate a statement, ignoring comments and quoted spans?
 *
 * `buildSweepQuery` drops a trailing semicolon and inlines the rest into `FROM (...)`, which only
 * holds for a SINGLE SELECT. A `CREATE OR REPLACE FUNCTION pg_temp…;` prelude, or a comment after
 * the final semicolon (which the trailing-strip regex cannot reach), would otherwise be pasted in
 * and produce invalid SQL at sweep time instead of a clear refusal here.
 *
 * The scan must be comment- and literal-aware: 27 of the 29 shipped predicates contain a semicolon
 * inside explanatory `--` prose, and a bare `includes(';')` would reject almost all of them. Only a
 * semicolon in executable position counts. (CodeRabbit on PR #789.)
 */
export function hasStatementBreak(sql) {
  const text = String(sql ?? '');
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '--') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end + 1;
    } else if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.slice(i, i + 2) === '/*') { depth += 1; i += 2; } else if (text.slice(i, i + 2) === '*/') { depth -= 1; i += 2; } else i += 1;
      }
    } else if (text[i] === "'" || text[i] === '"') {
      const quote = text[i];
      i += 1;
      while (i < text.length) {
        if (text[i] === quote && text[i + 1] === quote) { i += 2; continue; }
        if (text[i] === quote) { i += 1; break; }
        i += 1;
      }
    } else {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const close = text.indexOf(tag, i + tag.length);
        i = close === -1 ? text.length : close + tag.length;
      } else if (text[i] === ';') {
        return true;
      } else i += 1;
    }
  }
  return false;
}

/** Drop leading `--` and block comments so the first real keyword can be read. */
export function stripLeadingComments(sql) {
  let text = String(sql ?? '');
  for (;;) {
    const trimmed = text.replace(/^\s+/, '');
    if (trimmed.startsWith('--')) {
      const end = trimmed.indexOf('\n');
      text = end === -1 ? '' : trimmed.slice(end + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      let depth = 1;
      let i = 2;
      while (i < trimmed.length && depth > 0) {
        if (trimmed.slice(i, i + 2) === '/*') { depth += 1; i += 2; } else if (trimmed.slice(i, i + 2) === '*/') { depth -= 1; i += 2; } else i += 1;
      }
      text = trimmed.slice(i);
      continue;
    }
    return trimmed;
  }
}

/** Predicate and all its required contracts are read in ONE PostgreSQL statement/snapshot. */
export function buildSweepQuery(predicate, entries) {
  const keys = entries.flatMap((entry) => Object.keys(entry.reviewed_contracts ?? {}));
  const sql = predicate.sql.replace(/;\s*$/, '');
  // Refuse anything that is not one SELECT, rather than inlining it into FROM (...) and failing as
  // a syntax error against the live database, where the cause is far less obvious.
  if (hasStatementBreak(sql)) {
    throw new TypeError(
      `Predicate ${predicate.name} is not a single SELECT: it still terminates a statement after the `
      + 'trailing semicolon is removed (a multi-statement prelude, or text after the final `;`). '
      + 'buildSweepQuery inlines the predicate into FROM (...), which only holds for one SELECT.',
    );
  }
  // A single statement is not enough: the runner and README require a SELECT. `VALUES (1)` has no
  // statement break yet yields rows with no violation_key, which would surface downstream as a
  // confusing allowlist failure rather than a bad-predicate error here. All 29 shipped predicates
  // open with SELECT (7) or a WITH prelude (22). (CodeRabbit on PR #790.)
  const firstKeyword = /^\s*(?:\(\s*)?([a-z]+)/i.exec(stripLeadingComments(sql))?.[1]?.toUpperCase();
  if (firstKeyword !== 'SELECT' && firstKeyword !== 'WITH') {
    throw new TypeError(
      `Predicate ${predicate.name} must be a SELECT (optionally with a WITH prelude); it starts with `
      + `${firstKeyword ?? 'nothing recognisable'}. buildSweepQuery inlines it into FROM (...) and the `
      + 'runner expects violation_key rows.',
    );
  }
  const contracts = keys.length === 0 ? "'[]'::json" :
    `(SELECT COALESCE(json_agg(c), '[]'::json) FROM (${functionContractSql(keys)}) AS c)`;
  return `SELECT json_build_object(
  'predicate', '${predicate.name.replaceAll("'", "''")}',
  'rows', (SELECT COALESCE(json_agg(v), '[]'::json) FROM (\n${sql}\n) AS v),
  'function_contracts', ${contracts}
) AS sweep_result;`;
}

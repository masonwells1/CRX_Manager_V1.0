// ACCESS-CHANGE CLASSIFIER for migrations (Mason, 2026-09-26).
//
// Mason's autonomous-landing rule keeps "secrets/auth/billing/permissions
// changes" with him. Sol (HIGH, round 9 on PR #804) found that the apply gate
// only refused DATA deletion, so a reviewed migration that changed who can
// reach what would still apply by itself. Asked where the line is, Mason chose
// (in-chat, 2026-09-26): "Routine auto, widening waits" —
//
//   ROUTINE, applies by itself: the lock-down lines that come with objects this
//   same migration creates or replaces — REVOKE on them from anyone, GRANT on
//   them to `authenticated` or `service_role`, row-level security enabled or
//   forced, and policies on a table this migration creates.
//
//   MASON'S: anything that opens access wider or changes access that already
//   exists — a GRANT to `anon` or PUBLIC; any GRANT or REVOKE on an object this
//   migration did not create (including schema-wide and IN SCHEMA forms); a
//   GRANT to any other role or of role membership; ALTER/DROP POLICY, or a
//   policy on an existing table or aimed at anon/PUBLIC; disabling row-level
//   security; roles, ownership, default privileges, SET ROLE/SESSION
//   AUTHORIZATION, SECURITY LABEL, ALTER FUNCTION ... SECURITY DEFINER; and any
//   apply-time statement that names an object in the `auth`, `storage` or
//   `vault` schema (logins, file access, secrets) other than calling one of
//   their functions (`auth.uid()`).
//
// It reads the SQL exactly the way destructiveMigrationCheck() does: function
// bodies (`AS $$...$$`) are dropped because they do not run at apply time;
// everything else — DO blocks, dynamic SQL in string literals — stays visible;
// comments are removed quote-aware. When in doubt it answers "Mason's": a false
// positive parks a migration for him, a false negative changes production access
// with nobody watching.

import { stripCommentsQuoteAware, stripFunctionBodiesOnly } from "./live-testdata-lib.mjs";

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;
// `postgres` owns every object a migration creates, so granting it (or making
// it the owner) of a new object widens nothing — the house pattern for internal
// helpers does exactly that.
const ROUTINE_GRANTEES = new Set(["authenticated", "service_role", "postgres"]);
const PRIVILEGE = String.raw`(?:all(?:\s+privileges)?|select|insert|update|delete|truncate|references|trigger|usage|execute|create|connect|temp(?:orary)?|maintain|set|alter\s+system)`;
// A real GRANT/REVOKE statement, not the word in prose: a privilege keyword, or a
// role list followed by TO/FROM (role membership). Comments inside a DO block
// stay visible to this reader, so "-- the grant that SHOULD be there" must not
// count; "-- grant execute to anon" still does, which only parks for Mason.
const PRIVILEGE_STATEMENT_RE = new RegExp(
  String.raw`\b(grant|revoke)\s+((?:(?:grant|admin|inherit|set)\s+option\s+for\s+)?(?:${PRIVILEGE}\b|${IDENT}(?:\s*,\s*${IDENT})*\s+(?:to|from)\b).*)$`, "i");
const PROTECTED_SCHEMA_RE = /(?<![A-Za-z0-9_$."])"?(auth|storage|vault)"?\s*\.\s*("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?![A-Za-z0-9_$"])/gi;

// The first reference to an auth/storage/vault object that is not one of the
// two harmless forms: a function CALL (`auth.uid()` — the name immediately
// followed by "(" and not the target of INTO/TABLE/ON/FROM/JOIN/UPDATE), or a
// foreign key to it (`REFERENCES auth.users(id)`). `INSERT INTO storage.buckets
// (...)` is neither.
function protectedSchemaReference(statement) {
  for (const match of statement.matchAll(PROTECTED_SCHEMA_RE)) {
    const before = statement.slice(0, match.index);
    const after = statement.slice(match.index + match[0].length);
    if (/\breferences\s*$/i.test(before)) continue;
    // vault's functions CREATE and UPDATE secrets, so only auth/storage calls
    // (auth.uid(), storage.foldername()) are exempt.
    if (after.startsWith("(") && match[1].toLowerCase() !== "vault"
      && !/\b(?:into|table|on|from|join|update|only)\s*$/i.test(before)) continue;
    return match;
  }
  return null;
}

// `public.Foo` / `"Foo"` / `foo` → a comparable key: unquoted parts fold to lower
// case (Postgres does), quoted parts keep their case, and the `public.` schema
// is implied.
function objectKey(raw) {
  const parts = String(raw || "").trim().split(/\s*\.\s*/).map((part) =>
    /^".*"$/.test(part) ? part.slice(1, -1) : part.toLowerCase());
  if (parts.length === 2 && parts[0] === "public") parts.shift();
  return parts.join(".");
}

// Inner text of the parenthesised list that opens at `open` (index of "(").
function parenBody(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

// Number of input arguments in a function signature list — OUT parameters are
// not part of the signature Postgres matches a GRANT against.
function inputArity(list) {
  if (list === null) return null;
  const params = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { params.push(current); current = ""; continue; }
    current += ch;
  }
  params.push(current);
  return params.map((param) => param.trim()).filter(Boolean).filter((param) => !/^out\b/i.test(param)).length;
}

// Empty every single-quoted string literal ('...' and E'...'), keeping the
// quotes. Text inside a literal only runs if it is EXECUTEd as dynamic SQL, and
// that case is caught separately (any dynamic EXECUTE is Mason's), so prose in a
// RAISE message such as "changed owner to %" no longer reads as a statement.
function blankStringLiterals(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const escape = (ch === "e" || ch === "E") && text[i + 1] === "'" && !/[A-Za-z0-9_$]/.test(text[i - 1] || "");
    if (ch === "'" || escape) {
      let j = i + (escape ? 2 : 1);
      while (j < text.length) {
        if (escape && text[j] === "\\") { j += 2; continue; }
        if (text[j] === "'" && text[j + 1] === "'") { j += 2; continue; }
        if (text[j] === "'") break;
        j++;
      }
      out += escape ? "E''" : "''";
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      const j = text.indexOf('"', i + 1);
      const end = j === -1 ? text.length : j + 1;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function splitStatements(text) {
  return text.split(";").map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function createdObjects(statements) {
  const tables = new Set();
  const functions = new Map(); // key → Set of input arities
  const other = new Set();
  const tableRe = new RegExp(String.raw`^create\s+(?:(?:global|local)\s+)?(?:unlogged\s+|temp(?:orary)?\s+)?table\s+(if\s+not\s+exists\s+)?(${QNAME})`, "i");
  const fnRe = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(${QNAME})\s*\(`, "i");
  const otherRe = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?(?:(?:materialized\s+)?view|sequence)\s+(if\s+not\s+exists\s+)?(${QNAME})`, "i");
  for (const statement of statements) {
    let m;
    // IF NOT EXISTS may leave an OLDER object in place, and grants would then
    // change its existing access — so it does not count as created here.
    if ((m = tableRe.exec(statement)) && !m[1]) tables.add(objectKey(m[2]));
    if ((m = fnRe.exec(statement))) {
      const key = objectKey(m[1]);
      const arity = inputArity(parenBody(statement, m.index + m[0].length - 1));
      if (!functions.has(key)) functions.set(key, new Set());
      functions.get(key).add(arity);
    }
    if ((m = otherRe.exec(statement)) && !m[1]) other.add(objectKey(m[2]));
  }
  return { tables, functions, other };
}

// Every object a GRANT/REVOKE names, or null when its ON clause is not a plain
// list of named tables/functions (ALL ... IN SCHEMA, SCHEMA, DATABASE, ...).
function privilegeTargets(onClause) {
  const clause = onClause.trim();
  if (/^all\s+\w+\s+in\s+schema\b/i.test(clause)) return null;
  const kind = /^(function|procedure|routine)\s+/i.exec(clause);
  const tableKind = /^(?:table|sequence)\s+/i.exec(clause);
  const plainTable = !kind && !tableKind && !/^(?:schema|database|domain|type|language|large\s+object|foreign|tablespace|parameter|all)\b/i.test(clause);
  if (!kind && !tableKind && !plainTable) return null;
  const body = clause.slice((kind || tableKind)?.[0].length || 0);
  const targets = [];
  let i = 0;
  const nameRe = new RegExp(String.raw`^\s*(${QNAME})\s*`, "i");
  while (i < body.length) {
    const m = nameRe.exec(body.slice(i));
    if (!m) return null;
    i += m[0].length;
    let arity;
    if (body[i] === "(") {
      const list = parenBody(body, i);
      if (list === null) return null;
      arity = inputArity(list);
      i += list.length + 2;
    }
    targets.push({ key: objectKey(m[1]), kind: kind ? "function" : "relation", arity });
    const rest = body.slice(i).match(/^\s*,/);
    if (!rest) break;
    i += rest[0].length;
  }
  return body.slice(i).trim() ? null : targets;
}

function isCreatedHere(target, created) {
  if (target.kind === "function") {
    const arities = created.functions.get(target.key);
    if (!arities) return false;
    return target.arity === undefined || arities.has(target.arity);
  }
  if (created.tables.has(target.key) || created.other.has(target.key)) return true;
  // The sequence behind a serial/identity column of a table created here
  // (`<table>_<column>_seq`) is created with it.
  const sequence = /^(.+)_[a-z0-9_]+_seq$/.exec(target.key);
  return Boolean(sequence) && [...created.tables].some((table) => target.key.startsWith(`${table}_`));
}

function grantees(list) {
  return list.split(",").map((role) => role.trim().replace(/^group\s+/i, "").replace(/^"|"$/g, "").toLowerCase()).filter(Boolean);
}

export function accessChangeCheck(sql) {
  let text;
  try {
    text = stripCommentsQuoteAware(stripFunctionBodiesOnly(String(sql || "")), { intoDollarBodies: true });
  } catch {
    return { changesAccess: true, reason: "the SQL could not be read for access changes" };
  }
  const statements = splitStatements(blankStringLiterals(text));
  const created = createdObjects(statements);
  const hit = (reason) => ({ changesAccess: true, reason });

  for (const statement of statements) {
    // Dynamic SQL run at apply time (EXECUTE inside a DO block) can do anything,
    // including grants this reader cannot see in a string or variable. Not the
    // privilege name (`GRANT EXECUTE ON`) or trigger syntax (`EXECUTE FUNCTION`).
    if (/\bexecute\b(?!\s+(?:on|function|procedure)\b)(?!\s*,)/i.test(statement)
      && !/^(?:grant|revoke)\b/i.test(statement)) {
      return hit("it runs dynamic SQL at apply time, which could change access in ways this check cannot read");
    }
    const schema = protectedSchemaReference(statement);
    if (schema) return hit(`it touches ${schema[1].toLowerCase()}.${schema[2].replace(/"/g, "")} (logins, file access or secrets)`);

    if (/\b(?:create|alter|drop)\s+(?:role|user|group)\b/i.test(statement)) return hit("it creates, changes or drops a database role");
    if (/\balter\s+default\s+privileges\b/i.test(statement)) return hit("it changes default privileges");
    if (/\bowner\s+to\b/i.test(statement)) {
      // Routine only as exactly `ALTER <kind> <object created here>[(args)] OWNER
      // TO postgres` — no other action riding in the same statement.
      const head = new RegExp(String.raw`^alter\s+(function|procedure|routine|table|(?:materialized\s+)?view|sequence)\s+(?:if\s+exists\s+)?(${QNAME})\s*`, "i").exec(statement);
      let routine = false;
      if (head) {
        let rest = statement.slice(head[0].length);
        let arity;
        if (rest.startsWith("(")) {
          const list = parenBody(statement, head[0].length);
          arity = list === null ? null : inputArity(list);
          rest = list === null ? "" : statement.slice(head[0].length + list.length + 2);
        }
        const target = { key: objectKey(head[2]), kind: /^(?:function|procedure|routine)$/i.test(head[1]) ? "function" : "relation", arity };
        routine = /^\s*owner\s+to\s+"?postgres"?\s*$/i.test(rest) && arity !== null && isCreatedHere(target, created);
      }
      if (!routine) return hit("it changes an object's owner");
      continue;
    }
    if (/\bset\s+(?:local\s+|session\s+)?(?:role|session\s+authorization)\b/i.test(statement)) return hit("it switches the database role it runs as");
    if (/\bsecurity\s+label\b/i.test(statement)) return hit("it sets a security label");
    if (/\balter\s+(?:function|procedure|routine)\b.*\bsecurity\s+definer\b/i.test(statement)) return hit("it makes an existing function run with elevated rights");
    if (/\b(?:disable|no\s+force)\s+row\s+level\s+security\b/i.test(statement)) return hit("it turns off row-level security");
    if (/\b(?:alter|drop)\s+policy\b/i.test(statement)) return hit("it changes or removes an existing access policy");

    const policy = new RegExp(String.raw`\bcreate\s+policy\s+${IDENT}\s+on\s+(${QNAME})(.*)$`, "i").exec(statement);
    if (policy) {
      if (!created.tables.has(objectKey(policy[1]))) return hit(`it adds an access policy to the existing table ${objectKey(policy[1])}`);
      const to = /\bto\s+(.+?)(?:\s+(?:using|with\s+check)\b|$)/i.exec(policy[2]);
      // No TO clause means TO PUBLIC (Sol HIGH, round 10), so the roles must be
      // named, and only the routine ones.
      if (!to) return hit("it adds a policy with no TO clause, which PostgreSQL applies to PUBLIC");
      const policyRoles = grantees(to[1]);
      if (policyRoles.some((role) => role === "anon" || role === "public")) return hit("it adds a policy for anonymous or PUBLIC access");
      if (policyRoles.some((role) => !ROUTINE_GRANTEES.has(role))) return hit(`it adds a policy for the role(s) ${policyRoles.filter((role) => !ROUTINE_GRANTEES.has(role)).join(", ")}`);
      continue;
    }

    // Not anchored: a GRANT run as dynamic SQL inside a DO block
    // (`DO $$ BEGIN EXECUTE 'GRANT ...'`) executes at apply time too.
    const privilege = PRIVILEGE_STATEMENT_RE.exec(statement);
    if (!privilege) continue;
    const verb = privilege[1].toLowerCase();
    const body = privilege[2];
    const onMatch = /\bon\b(.*?)\b(to|from)\b(.*)$/i.exec(body);
    if (!onMatch) return hit(`it ${verb === "grant" ? "grants" : "revokes"} role membership`);
    if (verb === "grant") {
      const roles = grantees(onMatch[3].replace(/\bwith\s+(?:grant|admin)\s+option\b.*$/i, "").replace(/\bgranted\s+by\b.*$/i, ""));
      if (roles.some((role) => role === "anon" || role === "public")) return hit("it grants access to anonymous users or PUBLIC");
      if (roles.some((role) => !ROUTINE_GRANTEES.has(role))) return hit(`it grants access to the role(s) ${roles.filter((role) => !ROUTINE_GRANTEES.has(role)).join(", ")}`);
      if (/\bwith\s+grant\s+option\b/i.test(onMatch[3])) return hit("it lets the grantee pass access on (WITH GRANT OPTION)");
    }
    const targets = privilegeTargets(onMatch[1]);
    if (!targets) return hit(`it ${verb === "grant" ? "grants" : "revokes"} access schema-wide or on a non-table object`);
    const existing = targets.find((target) => !isCreatedHere(target, created));
    if (existing) return hit(`it ${verb === "grant" ? "grants" : "revokes"} access on ${existing.key}, which this migration did not create`);
  }
  return { changesAccess: false };
}

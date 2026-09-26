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
//
// A REPLACED object is not a new one (Sol HIGH #2, round 10). CREATE OR REPLACE
// keeps an existing object's grants, and DROP + CREATE hands it Supabase's
// defaults again, so for anything that already existed the question is whether
// any role ends the migration with access it did not have before. That earlier
// access is rebuilt from the migration history (see priorFromHistory); without
// the history it is unknown, which counts as Mason's.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
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

// ── PRIOR ACCESS OF A REPLACED OBJECT (Sol HIGH #2, round 10) ────────────────
//
// Each object's access is a map of "role|privilege" → true / false / null, where
// null means "cannot be worked out". Only these roles are modelled; a GRANT to any
// other role is already Mason's.
const TABLE_PRIVILEGES = ["select", "insert", "update", "delete", "truncate", "references", "trigger", "maintain"];
const SEQUENCE_PRIVILEGES = ["usage", "select", "update"];
const KIND_PRIVILEGES = { function: ["execute"], table: TABLE_PRIVILEGES, sequence: SEQUENCE_PRIVILEGES };
const MODELLED_ROLES = ["public", "anon", "authenticated", "service_role", "postgres", "metabase_ro"];
// What a NEW object in `public` gets, read from live pg_default_acl on
// 2026-09-26, plus the built-in PUBLIC EXECUTE on functions (a per-schema default
// adds to it, it does not replace it). "table" covers views too. `metabase_ro`'s
// default read was set outside the migrations at an unknown date, so an object
// older than it is modelled as having that read — the one known way this model
// can overstate earlier access.
const DEFAULT_GRANTS = {
  function: { public: ["execute"], anon: ["execute"], authenticated: ["execute"], service_role: ["execute"], postgres: ["execute"] },
  table: { postgres: TABLE_PRIVILEGES, authenticated: TABLE_PRIVILEGES, service_role: TABLE_PRIVILEGES, anon: ["select", "maintain"], metabase_ro: ["select"] },
  sequence: { postgres: SEQUENCE_PRIVILEGES, anon: SEQUENCE_PRIVILEGES, authenticated: SEQUENCE_PRIVILEGES, service_role: SEQUENCE_PRIVILEGES },
};
// The one ALTER DEFAULT PRIVILEGES in the history that the defaults above already
// absorb: it removed anon's table writes, and the same file revoked them from
// every existing table, so objects older than it converge on today's defaults.
// Any OTHER one means objects created before it started from defaults this
// model does not know.
const ABSORBED_DEFAULT_PRIVILEGES_FILE = "20260526151856_execute_full_codebase_ultra_review.sql";
const DYNAMIC_SQL_RE = /\bexecute\b(?!\s+(?:on|function|procedure)\b)(?!\s*,)/i;
// Cheap raw-text test for history files that must be read even when they never
// name the object: schema-wide grants, grants in dynamic SQL, default privileges.
const HISTORY_ALWAYS_RE = /\bin\s+schema\b|['$]\s*(?:grant|revoke)\b|\bdefault\s+privileges\b/i;

const slot = (role, privilege) => `${role}|${privilege}`;

function freshState(kind, fill) {
  const state = new Map();
  for (const role of MODELLED_ROLES) {
    for (const privilege of KIND_PRIVILEGES[kind]) {
      state.set(slot(role, privilege), fill === "unknown" ? null : (DEFAULT_GRANTS[kind][role] || []).includes(privilege));
    }
  }
  return state;
}

// A role holds a privilege if it or PUBLIC does.
function effective(state, role, privilege) {
  const own = state.get(slot(role, privilege));
  if (role === "public") return own;
  const everyone = state.get(slot("public", privilege));
  if (own === true || everyone === true) return true;
  if (own === false && everyone === false) return false;
  return null;
}

// Split on commas outside parentheses.
function topLevelItems(list) {
  const items = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { items.push(current); current = ""; continue; }
    current += ch;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

const TYPE_ALIASES = {
  int: "integer", int4: "integer", int8: "bigint", int2: "smallint", bool: "boolean", float8: "double precision",
  float4: "real", varchar: "character varying", timestamptz: "timestamp with time zone", decimal: "numeric", char: "character",
};
const TYPE_WORDS = new Set(["double", "character", "char", "varchar", "timestamp", "timestamptz", "time", "bit", "interval",
  "national", "numeric", "decimal", "int", "integer", "int2", "int4", "int8", "bigint", "smallint", "text", "uuid", "boolean",
  "bool", "jsonb", "json", "date", "real", "float", "float4", "float8", "setof", "bytea", "inet", "anyelement", "record"]);

// The input TYPES of a parameter list, normalised enough to tell two overloads
// with the same number of arguments apart. A normalisation miss only makes two
// spellings of one signature look like two overloads, which reads as "unknown".
function signature(list) {
  if (list === null) return null;
  const types = [];
  for (const raw of topLevelItems(list)) {
    let param = raw.replace(/\s+(?:default\b|=)[\s\S]*$/i, "").replace(/"/g, "").replace(/\s+/g, " ").trim().toLowerCase();
    const mode = /^(in|out|inout|variadic)\s+/.exec(param);
    if (mode?.[1] === "out") continue;
    if (mode) param = param.slice(mode[0].length);
    const tokens = param.split(" ");
    if (tokens.length > 1 && !TYPE_WORDS.has(tokens[0]) && !tokens[0].includes(".")) tokens.shift();
    const type = tokens.join(" ").replace(/\s*\([^)]*\)/g, "").replace(/^public\./, "");
    const array = /(\[\])+$/.exec(type)?.[0] || "";
    const base = type.slice(0, type.length - array.length);
    types.push((TYPE_ALIASES[base] || base) + array);
  }
  return types.join(",");
}

// `name[(args)][, name[(args)]...]` → [{key, arity}] and whatever follows, or null.
function nameList(body) {
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
    targets.push({ key: objectKey(m[1]), arity });
    const comma = body.slice(i).match(/^\s*,/);
    if (!comma) break;
    i += comma[0].length;
  }
  return { targets, rest: body.slice(i).trim() };
}

function privilegeList(head) {
  const privileges = [];
  for (const item of topLevelItems(head)) {
    const m = /^([a-z][a-z ]*?)\s*(\([^)]*\))?$/i.exec(item);
    if (!m) return null;
    const name = m[1].toLowerCase().replace(/\s+/g, " ");
    privileges.push({ name: name === "all privileges" ? "all" : name, columns: Boolean(m[2]) });
  }
  return privileges.length ? privileges : null;
}

// One statement → the event this model cares about, or null.
const CREATE_FUNCTION_RE = new RegExp(String.raw`^create\s+(or\s+replace\s+)?(?:function|procedure)\s+(${QNAME})\s*\(`, "i");
const CREATE_TABLE_RE = new RegExp(String.raw`^create\s+(?:(?:global|local)\s+)?(unlogged\s+|temp(?:orary)?\s+)?table\s+(if\s+not\s+exists\s+)?(${QNAME})`, "i");
const CREATE_RELATION_RE = new RegExp(String.raw`^create\s+(or\s+replace\s+)?(temp(?:orary)?\s+)?(?:recursive\s+)?((?:materialized\s+)?view|sequence)\s+(if\s+not\s+exists\s+)?(${QNAME})`, "i");
const DROP_RE = /^drop\s+(function|procedure|routine|table|(?:materialized\s+)?view|sequence)\s+(?:if\s+exists\s+)?(.*)$/i;
const ALTER_NAME_RE = new RegExp(String.raw`^alter\s+(function|procedure|routine|table|(?:materialized\s+)?view|sequence)\s+(?:if\s+exists\s+)?(${QNAME})\s*`, "i");
const eventKind = (word) => (/^(?:function|procedure|routine)$/i.test(word) ? "function" : /^sequence$/i.test(word) ? "sequence" : "table");

function privilegeEvent(statement) {
  const privilege = PRIVILEGE_STATEMENT_RE.exec(statement);
  if (!privilege) return null;
  const verb = privilege[1].toLowerCase();
  const body = privilege[2];
  const onMatch = /\bon\b(.*?)\b(to|from)\b(.*)$/i.exec(body);
  if (!onMatch) return null;
  const head = body.slice(0, onMatch.index).trim();
  // REVOKE GRANT OPTION FOR ... leaves the privilege itself in place.
  if (/^(?:grant|admin|inherit|set)\s+option\s+for\b/i.test(head)) return null;
  const roles = grantees(onMatch[3]
    .replace(/\bwith\s+(?:grant|admin)\s+option\b.*$/i, "")
    .replace(/\bgranted\s+by\b.*$/i, "")
    .replace(/\b(?:cascade|restrict)\s*$/i, ""));
  const event = { type: "privilege", verb, privileges: privilegeList(head), roles, certain: true };
  const wide = /^\s*all\s+(tables|sequences|functions|procedures|routines)\s+in\s+schema\s+(.+?)\s*$/i.exec(onMatch[1]);
  if (wide) {
    if (!wide[2].split(",").map((schema) => objectKey(schema)).includes("public")) return null;
    return { ...event, schemaWide: /^tables$/i.test(wide[1]) ? "table" : /^sequences$/i.test(wide[1]) ? "sequence" : "function" };
  }
  const targets = privilegeTargets(onMatch[1]);
  return targets ? { ...event, targets } : null;
}

function statementEvent(statement) {
  let m;
  if ((m = CREATE_FUNCTION_RE.exec(statement))) {
    const list = parenBody(statement, m.index + m[0].length - 1);
    return { type: "create", kind: "function", key: objectKey(m[2]), arity: inputArity(list), sig: signature(list), orReplace: Boolean(m[1]) };
  }
  if ((m = CREATE_TABLE_RE.exec(statement))) {
    if (/^temp/i.test(m[1] || "")) return null;
    return { type: "create", kind: "table", key: objectKey(m[3]), orReplace: false, ifNotExists: Boolean(m[2]) };
  }
  if ((m = CREATE_RELATION_RE.exec(statement))) {
    if (m[2]) return null;
    return { type: "create", kind: eventKind(m[3]), key: objectKey(m[5]), orReplace: Boolean(m[1]), ifNotExists: Boolean(m[4]) };
  }
  if ((m = DROP_RE.exec(statement))) {
    const list = nameList(m[2]);
    if (!list) return null;
    return { type: "drop", kind: eventKind(m[1]), targets: list.targets, cascade: /\bcascade\b/i.test(list.rest) };
  }
  if ((m = ALTER_NAME_RE.exec(statement))) {
    let rest = statement.slice(m[0].length);
    let arity;
    if (rest.startsWith("(")) {
      const list = parenBody(statement, m[0].length);
      if (list === null) return null;
      arity = inputArity(list);
      rest = statement.slice(m[0].length + list.length + 2);
    }
    const from = { key: objectKey(m[2]), arity };
    const schema = from.key.includes(".") ? from.key.split(".")[0] : "";
    const bare = from.key.split(".").pop();
    const rename = new RegExp(String.raw`^\s*rename\s+to\s+(${IDENT})\s*$`, "i").exec(rest);
    if (rename) return { type: "rename", kind: eventKind(m[1]), from, to: objectKey(schema ? `${schema}.${rename[1]}` : rename[1]) };
    const move = new RegExp(String.raw`^\s*set\s+schema\s+(${IDENT})\s*$`, "i").exec(rest);
    if (move) return { type: "rename", kind: eventKind(m[1]), from, to: objectKey(`${move[1]}.${bare}`) };
  }
  return privilegeEvent(statement);
}

// 0 = not this object, 1 = this object, 2 = possibly this object.
function sameObject(obj, kind, target) {
  if (target.key !== obj.key || (kind === "function") !== (obj.kind === "function")) return 0;
  if (obj.kind !== "function" || target.arity === undefined) return 1;
  if (target.arity === null) return 2;
  return target.arity === obj.arity ? 1 : 0;
}

function applyPrivilege(obj, event, certain, touched) {
  const kindPrivileges = KIND_PRIVILEGES[obj.kind];
  const listed = event.privileges
    ? event.privileges.flatMap((p) => (p.name === "all" ? kindPrivileges.map((name) => ({ name, columns: p.columns })) : [p]))
      .filter((p) => kindPrivileges.includes(p.name))
    : kindPrivileges.map((name) => ({ name, columns: false }));
  const roles = event.roles ? event.roles.filter((role) => MODELLED_ROLES.includes(role)) : MODELLED_ROLES;
  for (const role of roles) {
    for (const { name, columns } of listed) {
      const key = slot(role, name);
      const current = obj.state.get(key);
      let next;
      if (event.verb === "grant") {
        // A column grant opens part of the object: count it as "maybe".
        next = certain && !columns ? true : current === true ? true : null;
      } else {
        if (columns) continue; // a column revoke leaves the object-level privilege alone
        next = certain ? false : current === false ? false : null;
      }
      obj.state.set(key, next);
      touched?.add(key);
    }
  }
}

function touchAll(obj, touched) {
  if (touched) for (const key of obj.state.keys()) touched.add(key);
}

// Advance one tracked object by one event. `ctx.fill` is what a fresh create
// starts from; `ctx.cascadeSeen` means an earlier DROP ... CASCADE in the same
// file may have removed the object behind a later CREATE OR REPLACE.
function step(obj, event, ctx) {
  if (!event) return;
  if (event.type === "drop" && event.cascade) ctx.cascadeSeen = true;
  if (event.type === "create") {
    if (!sameObject(obj, event.kind, event)) return;
    // exists === null ("maybe") is treated as present: a replace then keeps the
    // unknown access rather than inventing defaults.
    const present = obj.exists !== false;
    if (obj.kind === "function" && present && event.sig && obj.sig && event.sig !== obj.sig) {
      // Same name and argument count, different types: a second overload that
      // this model cannot keep apart from the first.
      obj.ambiguous = true;
      return;
    }
    if (present && (event.ifNotExists || (event.orReplace && !ctx.cascadeSeen))) return;
    if (present && event.orReplace) {
      // It may or may not have been dropped by the cascade: keep only what the
      // old access and a fresh object's defaults agree on.
      const fresh = freshState(obj.kind, ctx.fill);
      for (const [key, value] of obj.state) obj.state.set(key, value === fresh.get(key) ? value : null);
      touchAll(obj, ctx.touched);
      return;
    }
    obj.exists = true;
    obj.sig = event.sig || null;
    obj.state = freshState(obj.kind, ctx.fill);
    touchAll(obj, ctx.touched);
    return;
  }
  if (event.type === "drop") {
    if (event.targets.some((target) => sameObject(obj, event.kind, target) === 1)) {
      obj.exists = false;
      obj.sig = null;
      obj.state = null;
    } else if (obj.exists !== false && event.targets.some((target) => sameObject(obj, event.kind, target) === 2)) {
      obj.exists = null;
      obj.state = freshState(obj.kind, "unknown");
      touchAll(obj, ctx.touched);
    }
    return;
  }
  if (event.type === "rename") {
    if (sameObject(obj, event.kind, event.from)) {
      obj.exists = false;
      obj.sig = null;
      obj.state = null;
    } else if (event.to === obj.key && (event.kind === "function") === (obj.kind === "function")) {
      // Something else now answers to this name, with access this model did not follow.
      obj.exists = true;
      obj.sig = null;
      obj.state = freshState(obj.kind, "unknown");
      touchAll(obj, ctx.touched);
    }
    return;
  }
  if (event.type === "privilege" && obj.exists !== false) {
    if (event.schemaWide) {
      if (event.schemaWide === obj.kind) applyPrivilege(obj, event, event.certain, ctx.touched);
      return;
    }
    // Dynamic SQL names no object: it may have reached any of them.
    if (!event.targets) {
      applyPrivilege(obj, event, false, ctx.touched);
      return;
    }
    const match = Math.max(0, ...event.targets.map((target) => sameObject(obj, target.kind, target)));
    if (match) applyPrivilege(obj, event, event.certain && match === 1, ctx.touched);
  }
}

// GRANT/REVOKE text inside string literals of a file that runs dynamic SQL.
// Each counts as "maybe" for every object that exists at the end of that file.
function dynamicPrivilegeEvents(text) {
  const events = [];
  const re = new RegExp(String.raw`(?:'|\$[A-Za-z_]*\$)\s*(grant|revoke)\b([^'$]*)`, "gi");
  for (const m of text.matchAll(re)) {
    const rest = m[2];
    // Prose such as 'REVOKE verification failed' is not a statement.
    if (rest.trim() && !new RegExp(String.raw`^\s*(?:${PRIVILEGE}|%[sIL])(?![A-Za-z0-9_])`, "i").test(rest)) continue;
    const to = /\b(?:to|from)\s+(.+)$/i.exec(rest);
    let roles = null;
    if (to && !/%/.test(to[1])) {
      roles = grantees(to[1].replace(/\b(?:cascade|restrict)\s*$/i, "").replace(/\bwith\s+grant\s+option\b.*$/i, ""));
      if (!roles.length) roles = null;
    }
    events.push({ type: "privilege", verb: m[1].toLowerCase(), privileges: null, roles, certain: false });
  }
  return events;
}

function parseHistoryFile(text) {
  let stripped;
  try {
    stripped = stripCommentsQuoteAware(stripFunctionBodiesOnly(text), { intoDollarBodies: true });
  } catch {
    return { error: true };
  }
  const statements = splitStatements(blankStringLiterals(stripped));
  const dynamic = statements.some((statement) => DYNAMIC_SQL_RE.test(statement) && !/^(?:grant|revoke)\b/i.test(statement));
  return {
    events: statements.map(statementEvent).filter(Boolean),
    dynamicEvents: dynamic ? dynamicPrivilegeEvents(stripped) : [],
    defaultPrivileges: statements.some((statement) => /\balter\s+default\s+privileges\b/i.test(statement)),
  };
}

const bareName = (key) => key.split(".").pop().toLowerCase();

// Rebuild each object's access as of just before this migration, walking the
// earlier migration files in order. Only files that name one of the objects are
// parsed, plus the few that change access without naming anything; the apply
// hook runs inside a 15-second budget and a killed hook ALLOWS.
function priorFromHistory(objects, history) {
  const tracked = objects.map((obj) => ({ ...obj, exists: false, state: null, sig: null, ambiguous: false }));
  const names = [...new Set(tracked.map((obj) => bareName(obj.key)))];
  const files = [];
  history.forEach((file, index) => {
    const lower = String(file.text || "").toLowerCase();
    const named = names.filter((name) => lower.includes(name));
    if (!named.length && !HISTORY_ALWAYS_RE.test(lower)) return;
    files.push({ index, name: file.name, named, ...parseHistoryFile(String(file.text || "")) });
  });
  const lastDefaultChange = Math.max(-1, ...files
    .filter((file) => file.defaultPrivileges && path.basename(String(file.name)) !== ABSORBED_DEFAULT_PRIVILEGES_FILE)
    .map((file) => file.index));
  for (const file of files) {
    if (file.error) {
      // Unreadable: whatever it did to these objects is unknown.
      for (const obj of tracked) {
        if (file.named.includes(bareName(obj.key))) obj.exists = null;
        if (obj.exists !== false) obj.state = freshState(obj.kind, "unknown");
      }
      continue;
    }
    const ctx = { fill: file.index <= lastDefaultChange ? "unknown" : "defaults", cascadeSeen: false, touched: null };
    for (const event of file.events) for (const obj of tracked) step(obj, event, ctx);
    for (const event of file.dynamicEvents) for (const obj of tracked) step(obj, event, ctx);
  }
  return tracked.map((obj) => (obj.ambiguous
    ? { exists: null, state: freshState(obj.kind, "unknown") }
    : { exists: obj.exists, state: obj.state || (obj.exists === false ? null : freshState(obj.kind, "unknown")) }));
}

const ROLE_LABELS = { public: "PUBLIC (everyone, logged-out visitors included)", anon: "anon (logged-out visitors)" };

// The first role that ends this migration with access to an object that existed
// before it, where that access was not already there.
function replacedObjectWidening(statements, history) {
  const events = statements.map(statementEvent);
  const candidates = [];
  events.forEach((event, index) => {
    if (event?.type !== "create") return;
    if (candidates.some((c) => c.kind === event.kind && c.key === event.key && c.arity === event.arity)) return;
    candidates.push({ kind: event.kind, key: event.key, arity: event.arity, firstCreate: index });
  });
  if (!candidates.length) return null;
  const prior = Array.isArray(history) ? priorFromHistory(candidates, history) : null;
  for (const [n, candidate] of candidates.entries()) {
    let pre;
    if (candidate.kind === "function" && candidate.arity === null) {
      pre = { exists: null, state: freshState(candidate.kind, "unknown") };
    } else if (prior) {
      pre = prior[n];
    } else {
      // No history: a replace, or a re-create after a drop in this file, may be
      // an existing object whose earlier access nobody can check here.
      const create = events[candidate.firstCreate];
      const droppedFirst = events.slice(0, candidate.firstCreate).some((event) =>
        event?.type === "drop" && event.targets.some((target) => sameObject(candidate, event.kind, target)));
      pre = create.orReplace || droppedFirst ? { exists: null, state: freshState(candidate.kind, "unknown") } : { exists: false, state: null };
    }
    if (pre.exists === false) continue; // brand new: Mason's rule makes its lock-down routine
    const obj = { ...candidate, exists: true, sig: null, ambiguous: false, state: new Map(pre.state) };
    const ctx = { fill: "defaults", cascadeSeen: false, touched: new Set() };
    for (const event of events) step(obj, event, ctx);
    if (obj.ambiguous) obj.state = freshState(obj.kind, "unknown");
    for (const privilege of KIND_PRIVILEGES[obj.kind]) {
      for (const role of MODELLED_ROLES) {
        // A role is in question when its own access changed, or PUBLIC's changed
        // to anything but "no" (a revoke from PUBLIC widens nobody).
        const viaPublic = ctx.touched.has(slot("public", privilege)) && obj.state?.get(slot("public", privilege)) !== false;
        if (!ctx.touched.has(slot(role, privilege)) && !viaPublic) continue;
        const after = obj.exists === false ? false : effective(obj.state, role, privilege);
        const before = effective(pre.state, role, privilege);
        if (after === false || before === true) continue;
        const who = ROLE_LABELS[role] || role;
        const what = `${privilege.toUpperCase()} on ${obj.key}`;
        if (before === false) return `it gives ${who} ${what}, which it did not have before (the object already existed)`;
        return `it gives ${who} ${what}, an existing object whose earlier access ${prior ? "the migration history cannot confirm" : "cannot be checked without the migration history"}`;
      }
    }
  }
  return null;
}

// Every migration file in `dir` that sorts before `currentName`, oldest first,
// as [{name, text}] — the history accessChangeCheck() rebuilds earlier access from.
export function readMigrationHistory(dir, currentName) {
  const current = `${path.basename(String(currentName || "")).replace(/\.sql$/i, "")}.sql`;
  return readdirSync(dir)
    .filter((name) => /\.sql$/i.test(name) && name < current)
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), "utf8") }));
}

// `history`: the earlier migration files from readMigrationHistory(). Leave it
// out when there is none (the daily summary sees only a PR's added lines); any
// grant on an object that may already exist then counts as Mason's.
export function accessChangeCheck(sql, { history } = {}) {
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
  const widened = replacedObjectWidening(statements, history);
  if (widened) return hit(widened);
  return { changesAccess: false };
}

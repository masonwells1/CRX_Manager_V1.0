#!/usr/bin/env node
// Is this migration safe to wrap in an explicit BEGIN…COMMIT?
//
// WHY (CodeRabbit Major + Codex P2 on PR #460). scripts/apply-migration-file.mjs
// wraps the migration and its ledger INSERT in ONE transaction so they commit
// together or not at all. That guarantee is only real if the migration does not
// manage its own transactions and contains nothing that cannot run inside a
// transaction block. The first revision merely DOCUMENTED that precondition in a
// comment and checked the one target migration by hand — nothing re-checked it,
// so the next caller silently inherited a promise the code did not keep:
//
//   * a top-level COMMIT ends the outer transaction early, so the ledger INSERT
//     commits separately — a later failure leaves the schema changed with no
//     schema_migrations row (or the row with no migration);
//   * CREATE INDEX CONCURRENTLY (and friends) fail outright inside an explicit
//     transaction block, so the apply dies mid-way for a confusing reason.
//
// Both are cheap to detect, so they are detected. Fail closed: anything this
// module cannot classify is refused rather than wrapped.

// NOT reusing live-testdata-lib's stripDollarQuoted: that one deliberately strips
// only DO bodies and keeps CREATE FUNCTION bodies VISIBLE, because for destructive
// detection an over-kept body can only cause a false PARK. Here the direction is
// reversed — a PL/pgSQL body's BEGIN/END is ordinary block syntax, and treating it
// as transaction control refuses every legitimate migration. (Proven immediately:
// the 162KB draw-down migration was rejected for "a top-level END" that was really
// a function body's END.) Wrappability is a question about TOP-LEVEL statements, so
// it needs a true top-level skeleton: comments, string literals, quoted identifiers
// and every dollar-quoted span removed.

/**
 * Reduce SQL to its top-level statement skeleton.
 * @returns {string|null} null when the text cannot be tokenized (unterminated
 *   dollar-quote), which callers must treat as "cannot classify" → refuse.
 */
export function topLevelSkeleton(sql) {
  const s = String(sql ?? "");
  const n = s.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const ch = s[i];
    if (ch === "-" && s[i + 1] === "-") {
      while (i < n && s[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      let depth = 1; // PostgreSQL block comments nest
      i += 2;
      while (i < n && depth > 0) {
        if (s[i] === "/" && s[i + 1] === "*") { depth++; i += 2; continue; }
        if (s[i] === "*" && s[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      if (depth > 0) return null; // unterminated comment — cannot classify
      out += " ";
      continue;
    }
    if (ch === "'") {
      i++;
      let closed = false;
      while (i < n) {
        if (s[i] === "'" && s[i + 1] === "'") { i += 2; continue; }
        if (s[i] === "'") { i++; closed = true; break; }
        i++;
      }
      if (!closed) return null;
      out += " 'lit' ";
      continue;
    }
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < n) {
        if (s[i] === '"' && s[i + 1] === '"') { i += 2; continue; }
        if (s[i] === '"') { i++; closed = true; break; }
        i++;
      }
      if (!closed) return null;
      out += ' "ident" ';
      continue;
    }
    if (ch === "$") {
      // $tag$ … $tag$ or $$ … $$. `$1` positional parameters do not match.
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const close = s.indexOf(tag, i + tag.length);
        if (close === -1) return null; // unterminated body — cannot classify
        i = close + tag.length;
        out += " $body$ ";
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// Transaction control at STATEMENT level. `BEGIN` is deliberately absent as a
// bare word: in PL/pgSQL it opens a block, not a transaction, and those bodies
// are dollar-quoted away before this runs — but `BEGIN;`/`BEGIN TRANSACTION`
// as its own statement IS transaction control, so it is matched with its
// terminator/keyword rather than by name alone.
const TXN_CONTROL = [
  { re: /(?:^|;)\s*commit\s*(?:;|$)/i, what: "a top-level COMMIT" },
  { re: /(?:^|;)\s*commit\s+(?:transaction|work|prepared)\b/i, what: "a top-level COMMIT" },
  { re: /(?:^|;)\s*rollback\s*(?:;|$)/i, what: "a top-level ROLLBACK" },
  { re: /(?:^|;)\s*rollback\s+(?:transaction|work|prepared|to\b)/i, what: "a top-level ROLLBACK" },
  { re: /(?:^|;)\s*begin\s*(?:;|$)/i, what: "a top-level BEGIN" },
  { re: /(?:^|;)\s*begin\s+(?:transaction|work|isolation\b|read\b|deferrable\b|not\b)/i, what: "a top-level BEGIN" },
  { re: /(?:^|;)\s*start\s+transaction\b/i, what: "a top-level START TRANSACTION" },
  { re: /(?:^|;)\s*(?:savepoint|release\s+savepoint)\b/i, what: "a SAVEPOINT" },
  { re: /(?:^|;)\s*(?:end)\s*(?:;|$)/i, what: "a top-level END (transaction commit)" },
  { re: /(?:^|;)\s*prepare\s+transaction\b/i, what: "PREPARE TRANSACTION" },
  { re: /(?:^|;)\s*set\s+transaction\b/i, what: "SET TRANSACTION" },
];

// Statements PostgreSQL refuses to run inside an explicit transaction block.
const NON_TRANSACTIONAL = [
  { re: /\bcreate\s+(?:unique\s+)?index\s+concurrently\b/i, what: "CREATE INDEX CONCURRENTLY" },
  { re: /\bdrop\s+index\s+concurrently\b/i, what: "DROP INDEX CONCURRENTLY" },
  { re: /\breindex\b[^;]*\bconcurrently\b/i, what: "REINDEX … CONCURRENTLY" },
  { re: /(?:^|;)\s*vacuum\b/i, what: "VACUUM" },
  { re: /(?:^|;)\s*create\s+database\b/i, what: "CREATE DATABASE" },
  { re: /(?:^|;)\s*drop\s+database\b/i, what: "DROP DATABASE" },
  { re: /(?:^|;)\s*create\s+tablespace\b/i, what: "CREATE TABLESPACE" },
  { re: /(?:^|;)\s*drop\s+tablespace\b/i, what: "DROP TABLESPACE" },
  { re: /(?:^|;)\s*alter\s+system\b/i, what: "ALTER SYSTEM" },
  { re: /(?:^|;)\s*cluster\b/i, what: "CLUSTER" },
];
// DELIBERATELY NOT LISTED, and both were removed after review rather than left
// as harmless over-refusals — a wrong entry here rejects a legitimate migration
// and hands the operator a misleading reason:
//   * ALTER TYPE … ADD VALUE — transaction-safe since PostgreSQL 12; only USING
//     the new value must wait for commit. Verified against this project's live
//     server: PostgreSQL 17.6 (server_version_num 170006). The blanket rule also
//     gave impossible advice ("split it into its own migration"), since the split
//     file hit the same pattern. If a migration does use the new value in the same
//     transaction PostgreSQL raises, and the wrapper's transaction rolls the whole
//     thing back — the safe failure. (Codex P2, PR #460 round 3.)
//   * DROP OWNED — destructive, but perfectly transactional. Destruction is the
//     destructive-content gate's job, not this one; classifying it here stated a
//     transaction restriction that does not exist.

/**
 * @param {string} sql the migration text
 * @returns {{wrappable: boolean, reason?: string}}
 */
export function checkWrappable(sql) {
  const text = String(sql ?? "");
  if (!text.trim()) return { wrappable: false, reason: "the migration is empty" };

  // Cannot classify → cannot promise atomicity → refuse.
  let scanned;
  try {
    scanned = topLevelSkeleton(text);
  } catch (err) {
    return { wrappable: false, reason: `the SQL could not be parsed for transaction control (${err?.message || err})` };
  }
  if (scanned === null) {
    return {
      wrappable: false,
      reason: "the SQL could not be tokenized (an unterminated string, comment, or dollar-quoted body), so whether it " +
        "manages its own transactions is UNKNOWN. An unknown answer is not a pass.",
    };
  }

  // `text.trim()` above only catches a truly blank file. A comment-only or
  // semicolon-only migration is non-blank yet carries NO statements: it would
  // sail through every rule below, be wrapped, and commit a schema_migrations row
  // recording a migration that changed nothing. Refuse it as the no-op it is
  // (CodeRabbit, PR #460 round 2).
  if (!scanned.replace(/[;\s]/g, "")) {
    return {
      wrappable: false,
      reason: "it contains no SQL statements (comments and/or bare semicolons only). Applying it would record a " +
        "schema_migrations row for a migration that changes nothing.",
    };
  }

  for (const { re, what } of TXN_CONTROL) {
    if (re.test(scanned)) {
      return {
        wrappable: false,
        reason: `it contains ${what}. This path wraps the migration and its ledger row in ONE transaction so they ` +
          `commit together; a migration that manages its own transactions breaks that guarantee and can leave the ` +
          `schema changed with no schema_migrations row.`,
      };
    }
  }
  for (const { re, what } of NON_TRANSACTIONAL) {
    if (re.test(scanned)) {
      return {
        wrappable: false,
        reason: `it contains ${what}, which PostgreSQL cannot run inside an explicit transaction block. ` +
          `The wrapped apply would fail part-way through.`,
      };
    }
  }
  return { wrappable: true };
}

/** Throws with an operator-facing message when the migration must not be wrapped. */
export function assertWrappable(sql, migName) {
  const verdict = checkWrappable(sql);
  if (verdict.wrappable) return;
  const err = new Error(
    `NOT WRAPPABLE: migration "${migName || "(unnamed)"}" cannot use the file-bytes apply path because ` +
    `${verdict.reason}\n\n` +
    `Apply it through the normal reviewed path instead, or split the non-transactional statement into its own ` +
    `migration. Do NOT remove this check to get past it — the atomicity promise printed by this script depends on it.`);
  err.notWrappable = true;
  throw err;
}

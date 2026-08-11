/**
 * A small Postgres source lexer, shared by the migration-scanning test suites.
 *
 * Several tests protect money guards by reading the SQL that defines a payout
 * RPC and asserting the guard is still in it. Those tests are only as sound as
 * their reading of the source: a plain text search cannot tell live SQL from a
 * commented-out copy, from a string literal that merely quotes it, or from a
 * definition written `public."create_commission_payment"` instead of
 * `public.create_commission_payment`. Each of those confusions has a direction
 * that leaves the suite green over an unguarded production body.
 *
 * This module exists so there is exactly ONE such reader. It used to live
 * inside commissionPayoutGuards.test.ts while a second, weaker scan sat in
 * commissionPayoutIntentBindingMigration.test.ts; the two drifted, and the
 * weaker one missed forms the stronger one already handled.
 *
 * It is test infrastructure — nothing in the running application imports it.
 */

export type Span = { start: number; end: number; kind: 'body' | 'string' };
/** A "quoted identifier" run. Not blanked — see lexSql. */
export type Ident = { start: number; end: number };

export type Lexed = { masked: string; spans: Span[]; idents: Ident[] };

/**
 * A character Postgres allows in an unquoted identifier. `\w` is not this: it
 * omits `$`, and it omits the letters-with-diacriticals and non-Latin letters
 * Postgres accepts. Used to decide where an identifier ends, which is what
 * separates a real `E'…'` prefix from the tail of a name ending in `e`.
 */
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/;

/**
 * The dollar-quote tag opening at `i`, or null. `$1` is a parameter, not a tag.
 *
 * A tag is identifier characters, so restricting it to ASCII would read
 * `$é$…$é$` as CODE and let text hidden in a literal be scanned as live SQL —
 * the unsafe direction. Accept any run without a `$` or whitespace that does
 * not start with a digit. That is slightly wider than Postgres, and the excess
 * is the safe direction: over-blanking can only hide a definition, and every
 * scan built on this treats a definition it cannot find as a failure.
 */
export function dollarTagAt(sql: string, i: number): string | null {
  if (sql[i] !== '$') return null;
  let j = i + 1;
  if (j < sql.length && !/[0-9$\s]/.test(sql[j])) {
    j += 1;
    while (j < sql.length && !/[$\s]/.test(sql[j])) j += 1;
  }
  return sql[j] === '$' ? sql.slice(i, j + 1) : null;
}

/**
 * Lexes the file once so a scan reads SQL rather than text.
 *
 * Returns a MASK the same length as the input — every offset found in the mask
 * indexes straight back into the original — with two substitutions:
 *
 *  - Comments become spaces, everywhere. Postgres treats a comment exactly as
 *    whitespace, so a block comment sitting between CREATE and OR REPLACE still
 *    leaves a real definition that a whitespace-only regex walks straight past;
 *    and, in the other direction, a commented-out copy of a guarded definition
 *    must not be able to stand in as the file's "last definition" while the live
 *    one below it dropped the guard.
 *  - Single-quoted literals OUTSIDE a function body become spaces, so a string
 *    containing the text of a definition cannot impersonate one. Literals INSIDE
 *    a body are kept by default: the guards under test raise their error codes
 *    as string literals, and blanking those would blind the assertions. Pass
 *    `blankBodyLiterals` for the code-only view — see codeOnly().
 *
 * `spans` records where the dollar-quoted bodies and the blanked top-level
 * literals are, so a definition's body can be bounded to its own statement.
 *
 * `idents` records double-quoted identifiers OUTSIDE a body. They are recorded
 * rather than blanked, because blanking them would hide a real definition
 * written as `CREATE FUNCTION "post_commission_payment"(...)` — the unsafe
 * direction. Recording them lets a scan refuse to read SQL keywords out of
 * them: `"as"` is a perfectly legal column name, and a `\bAS\b` that matched
 * inside one would anchor the body on whatever literal came next instead of on
 * the real body, reporting a guard that the live function does not have.
 */
export function lexSql(
  sql: string,
  { blankBodyLiterals = false }: { blankBodyLiterals?: boolean } = {},
): Lexed {
  const out = sql.split('');
  const spans: Span[] = [];
  const idents: Ident[] = [];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };

  const openTags: string[] = [];
  const bodyStarts: number[] = [];
  let i = 0;
  while (i < sql.length) {
    const inBody = openTags.length > 0;

    if (sql[i] === '-' && sql[i + 1] === '-') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      blank(i, end);
      i = end;
      continue;
    }

    if (sql[i] === '/' && sql[i + 1] === '*') {
      // Postgres block comments nest, unlike C's.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth += 1; j += 2; } else if (sql[j] === '*' && sql[j + 1] === '/') { depth -= 1; j += 2; } else j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === "'") {
      const escaped = i > 0 && /[Ee]/.test(sql[i - 1]) && !IDENT_CHAR.test(sql[i - 2] ?? ' ');
      let j = i + 1;
      while (j < sql.length) {
        if (escaped && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      if (!inBody || blankBodyLiterals) {
        spans.push({ start: i, end: j, kind: 'string' });
        blank(i, j);
      }
      i = j;
      continue;
    }

    if (sql[i] === '"' && (!inBody || blankBodyLiterals)) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') { j += 1; break; }
        j += 1;
      }
      if (inBody) {
        // A quoted identifier inside a body is a NAME — `AS "FOR UPDATE OF c"`
        // is an alias, not the lock it reads like. In the code-only view it is
        // blanked for the same reason a literal is: an assertion about
        // executable SQL must not be satisfiable by text that only spells it.
        blank(i, j);
      } else {
        idents.push({ start: i, end: j });
      }
      i = j;
      continue;
    }

    const tag = dollarTagAt(sql, i);
    if (tag) {
      if (inBody && openTags[openTags.length - 1] === tag) {
        openTags.pop();
        const start = bodyStarts.pop()!;
        spans.push({ start, end: i + tag.length, kind: 'body' });
        // A dollar quote nested INSIDE a body is a string literal, not a body:
        // `RAISE NOTICE $msg$FOR UPDATE$msg$` is text the function prints, not
        // SQL it runs. Blank it in the code-only view for the same reason
        // single-quoted literals are blanked there.
        if (blankBodyLiterals && openTags.length > 0) blank(start, i + tag.length);
      } else {
        openTags.push(tag);
        bodyStarts.push(i);
      }
      i += tag.length;
      continue;
    }

    i += 1;
  }

  spans.sort((a, b) => a.start - b.start);
  idents.sort((a, b) => a.start - b.start);
  return { masked: out.join(''), spans, idents };
}

// ~900 migration files are rescanned once per protected RPC per test; lexing
// each file once instead of nine times keeps the suite inside its timeout.
const lexCache = new Map<string, Lexed>();
export function lexed(sql: string): Lexed {
  let hit = lexCache.get(sql);
  if (!hit) {
    hit = lexSql(sql);
    lexCache.set(sql, hit);
  }
  return hit;
}

/**
 * The same source with its string literals blanked as well.
 *
 * lexSql() deliberately KEEPS literals inside a body, because the guards raise
 * their error codes as literals and the assertions look for them. The cost is
 * that a body could satisfy a code assertion from inside a string:
 * `RAISE NOTICE 'FOR UPDATE OF c'` reads exactly like the lock it is supposed
 * to prove. Assertions about executable SQL run against this view instead;
 * assertions about an error code keep using the full body.
 *
 * This view also blanks quoted identifiers INSIDE a body, which the default
 * view deliberately does not: `AS "FOR UPDATE OF c"` is an alias a hostile or
 * careless author could leave behind after deleting the real lock, and it reads
 * identically to one. Blanking is the safe direction here — over-blanking can
 * only make a code assertion fail.
 */
export function codeOnly(definition: string): string {
  return lexSql(definition, { blankBodyLiterals: true }).masked;
}

/**
 * Matches a CREATE FUNCTION header for `functionName`, in every form Postgres
 * ends up treating as the same public function.
 *
 * Run this against a LEXED mask, never raw source — the `\s+` between keywords
 * is only whitespace-equivalent to a comment once comments have been blanked.
 *
 *  - `OR REPLACE` optional: a plain `CREATE FUNCTION` of the same signature is
 *    still a definition (it errors at apply time if one already exists, but a
 *    scan that cannot see it reports the wrong number of definitions).
 *  - Schema qualifier optional: an unqualified name resolves through
 *    search_path, and for this repo's migrations that is public.
 *  - Either half may be quoted: `public."create_commission_payment"` is the
 *    same function, and a scan that misses it misses a redefinition.
 */
export function functionHeaderPattern(functionName: string): RegExp {
  return new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:(?:public|"public")\s*\.\s*)?(?:${functionName}|"${functionName}")\s*\(`,
    'gi',
  );
}

#!/usr/bin/env node
// Apply a migration to live from its FILE BYTES, through the same gate the MCP
// `apply_migration` tool goes through.
//
// WHY THIS EXISTS (2026-08-24)
//   `mcp__supabase__apply_migration` takes `{project_id, name, query}` — a pasted
//   string, no file path. The apply gate binds the reviewer proof to
//   sha256(transmitted query), and scripts/write-apply-proofs.mjs pins that hash
//   to the on-disk file (CRLF→LF normalized). Those two facts are good: together
//   they guarantee the SQL that runs is the SQL that was reviewed.
//
//   But they made a large migration unappliable. 20260816120000_draw_down_split_
//   order_lines_by_price_tier.sql is 162,022 bytes / 2,891 lines; no single tool
//   call can re-emit that byte-exact, so the hash never matched and the change
//   could not reach live at all — blocked by its own size, not by any finding.
//
//   This script is a SECOND DOOR WITH THE SAME LOCK. It reads the file, asks
//   .claude/hooks/migration-apply-lib.mjs (the identical rule book the PreToolUse
//   hook consults) for a verdict, and transmits only on "allow". Because the file
//   is both what gets hashed and what gets sent, the content binding finally works
//   in our favour instead of against us.
//
// WHAT THIS IS NOT
//   It is NOT the raw management-API channel documented for read-only
//   BEGIN..ROLLBACK proof bundles. That channel POSTs SQL with no gate at all.
//   Every transmission here is downstream of evaluateMigrationApply(), and there
//   is deliberately no code path to fetch() that skips it.
//
// USAGE
//   Dry run (evaluates the gate, transmits nothing) — always do this first:
//     node scripts/apply-migration-file.mjs supabase/migrations/<file>.sql
//
//   Real apply (requires an explicit flag AND a token in the environment):
//     SUPABASE_ACCESS_TOKEN=... node scripts/apply-migration-file.mjs <file>.sql --confirm
//
//   Flags:
//     --confirm            actually transmit. Without it this is a dry run.
//     (no --name flag: the ledger name is derived from the filename — see LEDGER NAME)
//     --created-by <who>   ledger created_by (default: the CRX ledger convention)
//
//   There is deliberately NO --project flag; the target is pinned to CRX
//   production. See TARGET below.
//
// AUTHORIZATION
//   Passing the gate is a FLOOR, not authorization. In an ordinary interactive
//   session Mason's explicit in-chat OK is still required before running this with
//   --confirm; only a pre-authorized hands-free run with autopilot armed may skip
//   the per-migration ask (settled 2026-07-13), and destructive migrations never
//   apply autonomously at all. That policy is enforced inside the rule book.

import { readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  evaluateMigrationApply,
  resolveMigrationSource,
  MIGRATION_SOURCE_SUBDIR,
  CRX_PRODUCTION_REF,
} from "../.claude/hooks/migration-apply-lib.mjs";
import { assertWrappable } from "../.claude/hooks/migration-wrappability-lib.mjs";

// Every existing ledger row carries this; apply_migration fills it from the
// authenticated Supabase account, and the personal access token this script uses
// belongs to that same account. Recorded explicitly so a row written through this
// door is indistinguishable from one written through the MCP tool.
const DEFAULT_CREATED_BY = "mason@croprxsolutions.com";

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) die(1, `apply-migration-file: ${flag} needs a value.`);
  return v;
}

const argv = process.argv.slice(2);

// ── REMOVED FLAGS ARE REJECTED FIRST, IN EVERY SPELLING ────────────────────
// `argv.includes("--name")` only matched a standalone token, so `--name=alias`
// slipped through; and the check used to run AFTER file resolution, so
// `--name alias` with no file reported a path error instead of the refusal
// (CodeRabbit, PR #470). Both flags are now matched as `^--flag(=|$)` and refused
// before anything else is resolved. Why each was removed is documented at TARGET
// and LEDGER NAME below.
const rejectedFlag = (flag, why) => {
  if (argv.some((a) => new RegExp(`^${flag}(?:=|$)`).test(a))) die(1, why);
};
rejectedFlag("--project",
  "apply-migration-file: --project is not supported. The target is pinned to CRX production " +
  `(${CRX_PRODUCTION_REF}).\n` +
  "The applied-migration snapshot, the reviewer/Codex proofs, and the autopilot authorization flag are all " +
  "checkout-wide and assume a single project; pointing this script elsewhere would let a foreign ledger " +
  "overwrite the snapshot production ordering is judged against. If another target is ever genuinely needed, " +
  "scope those three things to the project ref FIRST — do not re-add the flag on its own.");
rejectedFlag("--name",
  "apply-migration-file: --name is not supported. The ledger name is derived from the migration filename.\n" +
  "A caller-supplied name can carry a timestamp that disagrees with the file: the reviewer proof still matches " +
  "by substring while the ordering gate reads the supplied stamp, so stale SQL can be presented as the newest " +
  "migration. Rename the FILE if the ledger name must change.");

const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const filePath = positional[0];
if (!filePath) {
  die(1,
    "apply-migration-file: no migration file given.\n" +
    "  node scripts/apply-migration-file.mjs supabase/migrations/<file>.sql [--confirm]");
}

const confirm = argv.includes("--confirm");
const createdBy = flagValue(argv, "--created-by") || DEFAULT_CREATED_BY;

// ── TARGET: pinned, not a parameter ────────────────────────────────────────
// This started life with a `--project <ref>` flag. Codex (P1, PR #460 round 4)
// showed that flag was unsound, because three things around it are checkout-wide
// and assume a SINGLE project:
//   * `applied-migrations.json` is one file per checkout, not per project. Apply
//     to another ref and this script would overwrite the shared snapshot with THAT
//     project's ledger — so the next production apply would be judged against a
//     foreign high-water mark and could replay a migration production already
//     superseded.
//   * the reviewer proof and the Codex proof are minted against CRX content and
//     carry no project binding, so they would silently authorize a different target.
//   * the AUTOPILOT.on flag is authorization for THIS project.
// Parameterizing the ref quietly broke every one of those assumers. Restricting is
// the honest fix; binding snapshot + proofs + authorization per-ref would be a much
// larger change and nothing needs it — this repo has one production project.
// (The `--project` refusal itself fires earlier, with the other removed flags, so
// it cannot be reached by a spelling that slips past this point.)
const projectId = CRX_PRODUCTION_REF;

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const absFile = path.resolve(process.cwd(), filePath);
if (!existsSync(absFile)) die(1, `apply-migration-file: no such file — ${absFile}`);

// CRLF→LF so the transmitted string is byte-identical to what
// scripts/write-apply-proofs.mjs hashed. This single line is what makes the
// content binding satisfiable for a file of any size.
const sql = readFileSync(absFile, "utf8").replace(/\r\n/g, "\n");
if (!sql.trim()) die(1, `apply-migration-file: ${absFile} is empty.`);

// ── LEDGER NAME: derived from the file, never supplied ─────────────────────
// This had a `--name <name>` flag. Codex (P1, PR #460 round 5) showed it defeats
// the ordering gate: pass `--name 99999999999999_alias_20260101000000_old_migration`
// and the reviewer proof for `20260101000000_old_migration` STILL matches (the gate
// matches proof-to-name by substring), while checkMigrationOrdering reads the FIRST
// 14-digit stamp — 99999999999999 — and concludes the stale SQL is newer than
// everything applied. That is precisely the out-of-order replay the gate exists to
// stop. The name is caller-controlled input that two separate checks trusted, so it
// is now derived from the file being applied and cannot disagree with it.
const migName = path.basename(absFile).replace(/\.sql$/i, "");

// Removing the flag was only HALF the fix, and half a fix is the same bug. The
// FILENAME is caller-controlled too: Codex (P1, PR #470) copied an old reviewed
// migration to `99999999999999_alias_<old-name>.sql` and reproduced the whole
// replay against a snapshot whose high-water was 20270101000000 — the reviewer
// proof still matched (names compare by SUBSTRING, and the alias CONTAINS the
// original name), the queryHash still matched (the SQL is unchanged), and the
// ordering check read the alias's FIRST stamp, 99999999999999, as newest. The
// real script exited 0.
//
// The mechanism, not the spelling, is the problem: a name that embeds another
// migration's name inherits its proof while presenting a different ordering
// timestamp. So the ledger name must be CANONICAL — exactly one 14-digit stamp,
// at the very start, and none anywhere else. An alias needs a second stamp to
// carry the original name, so this rejects the attack by construction while every
// real repository migration (`<stamp>_snake_case_words`) passes unchanged.
const CANONICAL_MIGRATION_NAME = /^\d{14}_[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const stampCount = (migName.match(/\d{14}/g) || []).length;
if (!CANONICAL_MIGRATION_NAME.test(migName) || stampCount !== 1) {
  die(1,
    `apply-migration-file: "${migName}" is not a canonical migration name.\n` +
    `Required: exactly one 14-digit timestamp, at the start, followed by an underscore and a ` +
    `descriptive suffix — e.g. 20260816120000_draw_down_split_order_lines_by_price_tier. ` +
    `Found ${stampCount} timestamp(s).\n\n` +
    `A name that embeds ANOTHER migration's name inherits that migration's reviewer proof (names are ` +
    `matched by substring) while presenting its own leading timestamp to the ordering gate — which is how ` +
    `stale SQL gets replayed as the newest migration. Apply the migration under its real filename.`);
}
// ── SOURCE PROVENANCE ──────────────────────────────────────────────────────
// The canonical-name rule above constrains what the file is CALLED. It says
// nothing about WHERE it lives, so this door would happily read a parked or
// REJECTED draft out of scripts/.staging-migrations/ — or anywhere else on disk —
// as long as its filename looked right.
//
// The gate below refuses that on its own (the rule lives in the shared rule book,
// so both doors inherit it and neither can drift laxer). This check is the same
// rule asked EARLY, through the SAME exported function, purely so the operator
// gets a refusal that names the file they passed instead of one that talks about
// a name lookup. It is not a second implementation.
{
  const source = resolveMigrationSource({
    name: migName,
    query: sql,
    projectDir,
    cwd: process.cwd(),
  });
  if (!source.ok) {
    die(2,
      `NOT A PERMITTED MIGRATION SOURCE: ${absFile}\n\n` +
      `A live apply may only transmit the content of a migration this repository holds at\n` +
      (source.searched.length
        ? source.searched.map((f) => `  ${f}\n`).join("")
        : `  <checkout>/${MIGRATION_SOURCE_SUBDIR}/${migName}.sql\n`) +
      `\nThis is an allowlist: one permitted directory, one filename inside it derived from the ` +
      `migration name.\nParked, superseded and REJECTED drafts under scripts/.staging-migrations/ are ` +
      `deliberately outside it — that is what parking a migration means — and so is anything in a temp or ` +
      `scratch directory.\n\n` +
      (source.code === "content-differs"
        ? `A file with this name exists in the permitted directory, but its content differs from the file ` +
          `you passed. Apply the repository file, not a copy.\n`
        : source.code === "escapes-dir"
        ? `The permitted path resolves outside the permitted directory (a link pointing elsewhere).\n`
        : `To ship this migration, move it into supabase/migrations/ as a tracked change and take it ` +
          `through review.\n`));
  }
}

const queryHash = createHash("sha256").update(sql).digest("hex");

console.log(`migration : ${migName}`);
console.log(`file      : ${absFile}`);
console.log(`bytes     : ${Buffer.byteLength(sql, "utf8")} (LF-normalized)`);
console.log(`queryHash : ${queryHash}`);
console.log(`project   : ${projectId}`);
console.log("");

// ── PRECONDITION FOR THIS DOOR ─────────────────────────────────────────────
// Checked BEFORE the gate so a dry run reports it immediately, and enforced in
// code rather than documented in a comment: this path wraps the migration and
// its ledger row in one transaction, and that promise is only real if the
// migration does not manage its own transactions and contains nothing that
// cannot run inside a transaction block.
try {
  assertWrappable(sql, migName);
} catch (err) {
  if (err?.notWrappable) die(2, err.message);
  die(2, `NOT WRAPPABLE: could not establish whether "${migName}" is safe to wrap (${err?.message || err}). Refusing.`);
}
console.log("Wrappability: no transaction control, nothing non-transactional — safe to wrap.");
console.log("");

// ── THE GATE ───────────────────────────────────────────────────────────────
// Identical rule book to the PreToolUse hook. A throw here is a refusal, never
// a pass: the gate being in an unknown state is exactly when not to transmit.
let verdict;
try {
  verdict = evaluateMigrationApply({
    name: migName,
    query: sql,
    projectId,
    projectDir,
    cwd: process.cwd(),
    // The proof must name THIS migration exactly. Substring matching is what let an
    // aliased filename inherit another migration's proof; see the note in the lib.
    requireExactProofName: true,
  });
} catch (err) {
  die(2,
    `APPLY GATE ERROR: the gate evaluation itself failed (${err?.message || err}).\n` +
    `Refusing to transmit. Fix .claude/hooks/migration-apply-lib.mjs — do NOT route around ` +
    `this by POSTing the file through another channel.`);
}

if (verdict?.decision !== "allow") {
  die(2, `APPLY GATE REFUSED\n\n${verdict?.reason || "(no reason returned — treating as refusal)"}`);
}

console.log("APPLY GATE PASSED — ordering, autopilot state, destructive-content, reviewer proof and Codex gate all satisfied.");

if (!confirm) {
  console.log("");
  console.log("DRY RUN — nothing was transmitted. Re-run with --confirm to apply for real.");
  console.log("Remember: the gate is a floor, not authorization. Interactive sessions still need Mason's in-chat OK.");
  process.exit(0);
}

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  die(1,
    "apply-migration-file: SUPABASE_ACCESS_TOKEN is not set, so there is no way to reach the\n" +
    "management API. Supply it for this one run; do not write it to a file.");
}

// ── LEDGER PARITY ──────────────────────────────────────────────────────────
// apply_migration records the migration in supabase_migrations.schema_migrations
// as it applies it. If this door skipped that, the ordering preflight would go
// blind for every FUTURE apply — the guard would compare against a ledger missing
// the very migration that just ran. Verified against live rows (2026-08-24):
// `statements` holds the whole migration as ONE element, `version` is a 14-digit
// UTC stamp assigned at apply time, `idempotency_key` is NULL.
const now = new Date();
const version =
  now.getUTCFullYear().toString() +
  String(now.getUTCMonth() + 1).padStart(2, "0") +
  String(now.getUTCDate()).padStart(2, "0") +
  String(now.getUTCHours()).padStart(2, "0") +
  String(now.getUTCMinutes()).padStart(2, "0") +
  String(now.getUTCSeconds()).padStart(2, "0");

// Dollar-quote the payload so no escaping of the migration body is needed. The
// tag is derived from the content hash and asserted absent — a tag collision
// would end the literal early and change what runs, so it fails closed.
const tag = `crx_apply_${queryHash.slice(0, 12)}`;
const dq = `$${tag}$`;
if (sql.includes(dq) || migName.includes(dq) || createdBy.includes(dq)) {
  die(2, `apply-migration-file: dollar-quote tag ${dq} collides with the payload. Refusing to transmit.`);
}

// One transaction: the migration and its ledger row commit together or not at all.
const wrapped =
  `BEGIN;\n${sql}\n;\n` +
  `INSERT INTO supabase_migrations.schema_migrations (version, name, statements, created_by)\n` +
  `VALUES (${dq}${version}${dq}, ${dq}${migName}${dq}, ARRAY[${dq}${sql}${dq}], ${dq}${createdBy}${dq});\n` +
  `COMMIT;`;

// ── INVALIDATE THE SNAPSHOT BEFORE TRANSMITTING ────────────────────────────
// The ordering preflight judges the NEXT apply against applied-migrations.json,
// and it accepts that file while it is under 24h old. Once this transmission is
// in flight the snapshot is provably out of date — it cannot contain the row this
// apply is about to write — yet it stays "fresh" by the clock. Codex exercised
// exactly that hole (apply 200, ledger re-read 503): the script exited 0, the old
// snapshot survived, and the next apply could then pass the ordering gate for a
// migration OLDER than the one just applied — the replay class the guard exists
// to stop.
//
// So it is deleted BEFORE the fetch, not repaired afterwards. An apply is the real
// invalidator, not elapsed time — the same reasoning as the PostToolUse
// applied-snapshot-invalidate hook, which removes it after EVERY apply, successful
// or not. Ordering here matters: delete-then-apply cannot leave a stale snapshot no
// matter how the apply, the network, or this process ends. The cost when an apply
// fails is regenerating a cache file, and the guard tells the operator how.
const snapshotPath = path.join(projectDir, ".claude", "session-state", "applied-migrations.json");
try {
  if (existsSync(snapshotPath)) {
    rmSync(snapshotPath);
    console.log("Invalidated the applied-migration snapshot (an apply is about to run).");
  }
} catch (err) {
  die(2,
    `apply-migration-file: could not invalidate the applied-migration snapshot at ${snapshotPath} ` +
    `(${err?.message || err}). Refusing to transmit — leaving a stale snapshot in place would let the ` +
    `NEXT apply replay a migration older than this one.`);
}

console.log("");
console.log(`Transmitting ${Buffer.byteLength(wrapped, "utf8")} bytes (migration + ledger row, one transaction)…`);

const res = await fetch(`https://api.supabase.com/v1/projects/${projectId}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: wrapped }),
});

const bodyText = await res.text();
if (!res.ok) {
  die(3,
    `APPLY FAILED — HTTP ${res.status}\n${bodyText}\n\n` +
    `The statements ran inside a single transaction, so a failure here means nothing was ` +
    `committed. Verify with a read-only ledger query before retrying.`);
}

console.log(`APPLY OK — HTTP ${res.status}`);
console.log(bodyText.slice(0, 2000));

// ── SNAPSHOT REFRESH ───────────────────────────────────────────────────────
// The ordering guard refuses a snapshot older than 24h and, more importantly, one
// that predates this apply. Forgetting this step is a known recurring failure, so
// the door that applies is the door that refreshes.
console.log("");
console.log("Refreshing the applied-migration snapshot…");
const ledgerRes = await fetch(`https://api.supabase.com/v1/projects/${projectId}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    query: "select version, name from supabase_migrations.schema_migrations order by version;",
  }),
});
if (!ledgerRes.ok) {
  // Non-zero, not a warning-and-exit-0: the apply COMMITTED and the snapshot is
  // already gone, so the next apply will correctly block on missing evidence —
  // but the operator must know this run did not finish cleanly.
  die(4,
    `APPLY COMMITTED, SNAPSHOT NOT REBUILT — the ledger re-read failed (HTTP ${ledgerRes.status}).\n` +
    `The migration IS applied. The applied-migration snapshot was invalidated before transmission and ` +
    `has not been rebuilt, so the next apply will refuse until you regenerate it:\n` +
    `  select version, name from supabase_migrations.schema_migrations order by version;\n` +
    `  node scripts/refresh-applied-migrations.mjs < rows.json`);
}
const refresh = spawnSync(process.execPath, [path.join(projectDir, "scripts", "refresh-applied-migrations.mjs")], {
  input: await ledgerRes.text(),
  encoding: "utf8",
  cwd: projectDir,
  env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
});
process.stdout.write(refresh.stdout || "");
if (refresh.status !== 0) {
  console.error(refresh.stderr || "");
  die(4,
    `APPLY COMMITTED, SNAPSHOT NOT REBUILT — scripts/refresh-applied-migrations.mjs exited ` +
    `${refresh.status}.\nThe migration IS applied. The snapshot was invalidated before transmission and ` +
    `has not been rebuilt, so the next apply will refuse until you regenerate it.`);
}

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findWindowsShellVariableHooks } from "./windows-hook-command.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const checks = [];

function record(ok, name, note = "") {
  checks.push({ ok, name, note });
}

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

const agents = read("AGENTS.md");
const claude = read("CLAUDE.md");
const settings = JSON.parse(read(".claude/settings.json"));
const codexHooksText = read(".codex/hooks.json");
const codexHooks = JSON.parse(codexHooksText);
const gitignore = read(".gitignore");
// Git may materialize Markdown with CRLF on Windows even when the canonical
// repository text is LF. Compare content, not checkout-specific line endings.
const migrationDriftReviewer = read(".claude/agents/migration-drift-reviewer.md")
  .replace(/\r\n/g, "\n");
const migrationOrderingLib = read(".claude/hooks/migration-ordering-lib.mjs")
  .replace(/\r\n/g, "\n");
const migrationHistory = read("docs/reference/migration-history.md")
  .replace(/\r\n/g, "\n");
const migrationStampCheck = migrationDriftReviewer.match(
  /### CHECK 6 — Migration filename version-stamp mismatch([\s\S]*?)(?=\n### CHECK 7)/
)?.[1] || "";
const canonicalMigrationStampCheck = `
This is the B7 pattern from 2026-05-26.
1. Extract the timestamp prefix from each filename: \`<YYYYMMDDHHMMSS>_<description>.sql\`.
2. You CANNOT call Supabase MCP (your tools are Read/Grep/Glob/Bash). Do NOT attempt the Supabase MCP \`list_migrations\` tool. Compare the on-disk filename timestamps against each other for ordering sanity, then look for a current orchestrator-recorded \`list_migrations\` preflight in \`docs/reference/migration-history.md\` or the task evidence. Before apply, the disk timestamp must be **strictly greater than the current live effective ordering high-water**. Supabase MCP assigns a fresh live version at apply time, so the pre-apply filename is NOT expected to equal that future value.
3. Build the effective ordering stamp **row by row**, matching the deterministic apply guard: use the 14-digit timestamp embedded in that ledger row's \`name\` when present; only when the row's \`name\` has no 14-digit timestamp, use its 14-digit \`version\` as the conservative fallback. The fallback prevents a timestamp-less legacy name from disappearing from the comparison. Do NOT compare against a bare \`max(version)\` or \`.claude/schema-registry.json\`'s \`_meta.migrations_high_water\`: those version-only figures discard the ledger names, so they cannot tell which rows legitimately need the fallback and can emit a false **HIGH** when the newest applied row has an authored name stamp. \`.claude/hooks/migration-ordering-lib.mjs\` and \`scripts/refresh-applied-migrations.mjs\` are the executable sources for this row-by-row rule; \`docs/reference/migration-history.md\` explains the same calculation in plain English.
4. If no current live effective ordering high-water evidence derived from both \`name\` and fallback \`version\` is available, emit a **HIGH** finding telling the orchestrator to run Supabase MCP \`list_migrations\` and calculate it row by row. If evidence shows the filename is not greater, emit **HIGH** and require a fresh filename. If current evidence proves it is greater, this check is clean.
5. Always note the post-apply B7 reconciliation requirement: after a successful MCP apply, read the new ledger row's \`version\` and \`name\`, normalize the live name and disk basename with the repository's migration-ordering convention, and update migration history before commit. If the normalized live \`name\` already matches the authored disk basename, keep the disk filename; a differing apply-time \`version\` alone does **not** require a rename. Rename to the MCP-assigned version only when the live \`name\` does not preserve the authored basename, so disk and ledger would otherwise remain unmatched. This is a post-apply obligation, not a pre-apply finding.
`;
function hasImpossiblePreApplyEquality(text) {
  return text.split(/(?<=[.!?])\s+/).some((sentence) => {
    const withoutDirectlyNegatedComparison = sentence.replace(
      /\b(?:(?:not|is not) expected to|must not|not required to)\s+(?:be\s+)?(?:equal|match)\b|\bdoes not match\b|\bnot equal\b/gi,
      ""
    );
    return /(?:before apply(?:ing)?|pre-apply)/i.test(sentence)
      && /(?:equal|match)/i.test(withoutDirectlyNegatedComparison)
      && /(?:Supabase|MCP|future)/i.test(sentence);
  });
}
const impossiblePreApplyEquality = hasImpossiblePreApplyEquality(migrationStampCheck);
const adversarialEqualityRules = [
  "Before applying, require the disk filename to equal the version Supabase will assign.",
  "Before applying, a second review is not required, but the disk filename must equal the future Supabase version.",
];
const validNegativeEqualityRule = "Supabase MCP assigns a fresh live version at apply time, so the pre-apply filename is NOT expected to equal that future value.";

record(agents.split(/\r?\n/).length <= 140, "AGENTS.md stays lean", `${agents.split(/\r?\n/).length} lines`);
record(claude.split(/\r?\n/).length <= 90, "CLAUDE.md stays lean", `${claude.split(/\r?\n/).length} lines`);
record(claude.trimStart().startsWith("@AGENTS.md"), "CLAUDE.md imports AGENTS.md first");
record(!/\b\d{2,5}\s+(?:migrations|pages|edge functions?)\b/i.test(agents), "AGENTS.md has no volatile project counts");
record(!/\b\d{2,5}\s+(?:migrations|pages|edge functions?)\b/i.test(claude), "CLAUDE.md has no volatile project counts");
record(/AGENTS\.md.*canonical shared (?:project )?contract/i.test(claude), "CLAUDE.md declares AGENTS.md canonical");
record(/explicit approval in the current conversation/i.test(agents), "AGENTS.md defines current-conversation approval gates");
record(migrationStampCheck.trim() === canonicalMigrationStampCheck.trim(), "migration drift reviewer B7 check matches the canonical fail-closed contract");
record(/Before apply, the disk timestamp must be \*\*strictly greater than the current live effective ordering high-water\*\*/i.test(migrationStampCheck), "migration drift reviewer checks disk timestamp above live effective ordering high-water");
record(/If no current live effective ordering high-water evidence derived from both `name` and fallback `version` is available, emit a \*\*HIGH\*\*/i.test(migrationStampCheck), "migration drift reviewer fails closed when row-by-row live evidence is missing");
record(/If evidence shows the filename is not greater, emit \*\*HIGH\*\* and require a fresh filename/i.test(migrationStampCheck), "migration drift reviewer rejects stale or colliding timestamps");
record(/NOT expected to equal that future value/i.test(migrationStampCheck), "migration drift reviewer rejects unknowable pre-apply equality");
// Added 2026-08-24 after CHECK 6 used a bare max(version) and emitted a false
// HIGH, then tightened after exact-SHA review caught the opposite edge case:
// timestamp-less legacy names still need their row's version as a conservative
// fallback. Pin both halves of the deterministic row-by-row rule.
record(/use the 14-digit timestamp embedded in that ledger row's `name` when present/i.test(migrationStampCheck), "migration drift reviewer prefers each ledger row's authored name stamp");
record(/only when the row's `name` has no 14-digit timestamp, use its 14-digit `version` as the conservative fallback/i.test(migrationStampCheck), "migration drift reviewer preserves the version fallback for timestamp-less names");
record(/Do NOT compare against a bare `max\(version\)` or `.claude\/schema-registry\.json`'s `_meta\.migrations_high_water`/i.test(migrationStampCheck), "migration drift reviewer rejects version-only aggregate ordering evidence");
record(/migration-ordering-lib\.mjs` and `scripts\/refresh-applied-migrations\.mjs` are the executable sources/i.test(migrationStampCheck), "migration drift reviewer cites the executable row-by-row ordering sources");
record(!/session-staleness\.mjs[\s\S]*document the same row-by-row rule/i.test(migrationStampCheck), "migration drift reviewer does not miscite the schema-registry staleness heuristic");
record(/synthesizes `<version>_<name>`[\s\S]*effective stamp/i.test(migrationOrderingLib), "migration ordering library documents the timestamp-less-name fallback");
record(/derives an effective stamp row by row:[\s\S]*otherwise use that row's 14-digit `version`/i.test(migrationHistory), "migration history documents the row-by-row effective ordering high-water");
record(/A bare `max\(version\)` is never the ordering high-water/i.test(migrationHistory), "migration history rejects version-only aggregate ordering evidence");
record(!impossiblePreApplyEquality, "migration drift reviewer contains no affirmative pre-apply future-version equality rule");
record(adversarialEqualityRules.every(hasImpossiblePreApplyEquality), "migration drift reviewer equality detector rejects adversarial affirmative rules");
record(!hasImpossiblePreApplyEquality(validNegativeEqualityRule), "migration drift reviewer equality detector permits direct negation");
record(/after a successful MCP apply, read the new ledger row's `version` and `name`/i.test(migrationStampCheck), "migration drift reviewer requires a fresh post-apply ledger read");
record(/If the normalized live `name` already matches the authored disk basename, keep the disk filename/i.test(migrationStampCheck), "migration drift reviewer preserves an authored filename that matches the live name");
record(/a differing apply-time `version` alone does \*\*not\*\* require a rename/i.test(migrationStampCheck), "migration drift reviewer does not manufacture drift from version-name divergence");
record(/Rename to the MCP-assigned version only when the live `name` does not preserve the authored basename/i.test(migrationStampCheck), "migration drift reviewer retains the conditional B7 rename fallback");

// Added 2026-09-04 after an exact-SHA gpt-5.6-sol review (HIGH-1) caught the
// rewritten CHECK 2 letting a live overload COUNT settle the question. A count
// cannot tell f(integer) from f(text): live holds f(integer), the migration adds
// f(text) with no DROP FUNCTION, the pre-apply count reads 1, and applying leaves
// 2 overloads — the exact collision this check exists to prevent. Pin the
// identity-signature requirement AND the worked example, then mutation-test the
// detector against the weaker draft so a silent regression fails here.
// The charter hard-wraps its prose, so match against whitespace-flattened text.
const overloadCollisionCheck = migrationDriftReviewer.match(
  /### CHECK 2 — Function overload collision([\s\S]*?)(?=\n### CHECK 3)/
)?.[1] || "";
const overloadCollisionFlat = overloadCollisionCheck.replace(/\s+/g, " ");
// The exact-text assertions below are the PRIMARY guard: they pin the required
// sentences verbatim, so any rewrite that removes them fails regardless of how it
// is phrased. This detector is a secondary net for a rewrite that keeps the pinned
// text and appends a weaker rule beside it. Split on clause boundaries (`;` and
// `:` as well as sentence enders) and require the negation to sit in the SAME
// clause and BEFORE the verb — a sentence-wide negation test fails open on
// "Do not consult history; a live count of 1 clears this finding", where the `not`
// belongs to a different clause entirely (Codex, 2026-09-04).
function clearsOverloadFindingOnCount(text) {
  const CLEARS = /\b(?:clear|clears|cleared|outranks?|overrides?|satisfies|satisfy|suffices|sufficient|settles?|settle|proves?|closes?|close|answers?|establishes?)\b/i;
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?;:])\s+|(?<=[;:])/)
    .some((clause) => {
      const verb = clause.match(CLEARS);
      if (!verb || !/\b(?:count|counts|pronargs)\b/i.test(clause)) return false;
      const beforeVerb = clause.slice(0, verb.index);
      return !/\b(?:not|never|cannot|nor|no)\b/i.test(beforeVerb);
    });
}
// Sample 1 is verbatim the weaker draft the first review rejected; 2 and 3 are the
// same defect reworded; 4 is the bypass the second review demonstrated, where the
// negation belongs to a preceding clause. All must trip the detector, or it cannot
// fire and the assertion below is worthless.
const adversarialCountRules = [
  "A live `pg_proc` count supplied by the orchestrator outranks the historical text.",
  "If the live overload count is 1, that clears this finding.",
  "A `pronargs` reading from the live catalog satisfies the evidence requirement.",
  "Do not consult history; a live overload count of 1 clears this finding.",
];
const validCountRejection = "Count-only evidence, `pronargs`, or candidate-authored prose asserting \"exactly one overload\" NEVER clears this finding.";
record(overloadCollisionFlat.trim().length > 0, "migration drift reviewer CHECK 2 block is extractable");
record(/A COUNT IS NOT EVIDENCE — it cannot clear this finding/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 states a count cannot clear the overload finding");
record(/live holds `f\(integer\)`; the migration adds `f\(text\)` without a `DROP FUNCTION`\. The pre-apply count is \*\*1\*\*, yet applying produces \*\*2\*\* overloads/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 keeps the f(integer)/f(text) worked example");
record(/`pronargs` is a count and is subject to the same defect/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 rejects pronargs as overload evidence");
record(/one row per live overload carrying the schema and the signature as SEPARATE columns: `nspname` from a joined `pg_namespace`, plus `oid::regprocedure::text`/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 requires per-overload namespace and signature columns");
record(/`regprocedure` renders \*\*search_path-dependently\*\*/.test(overloadCollisionFlat) && /do NOT call that text schema-qualified/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 does not claim regprocedure text is schema-qualified");
record(/compute the expected POST-migration signature set for that name \*\*in that schema\*\*, and require it to hold \*\*exactly one\*\* signature/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 requires a post-migration set of exactly one signature");
record(/the set would hold MORE THAN ONE signature → \*\*BLOCKER\*\*, whether this migration adds the extra overload or live already carried it/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 blocks a surviving pre-existing overload, not only an added one");
record(/"Must return exactly 1 row\. If >1, consolidate before adding more\."/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 cites the SAFE_DEVELOPMENT_RULES exactly-one-row rule");
record(/Count-only evidence, `pronargs`, or candidate-authored prose asserting "exactly one overload" NEVER acquits\./.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 refuses count-only and prose acquittals");
record(/If history holds a prior `CREATE OR REPLACE FUNCTION <name>` with DIFFERENT argument types AND this migration does not first `DROP FUNCTION` the old one, severity = \*\*BLOCKER\*\*/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 retains the original differing-argument BLOCKER");
// Operability, found by the third exact-SHA proof: write-apply-proofs.mjs runs this
// charter sandboxed with only the charter text and the migration path, so a rule that
// DEMANDS live catalog evidence to reach any verdict makes every function migration
// fail forever. History must decide the default; live evidence only acquits.
record(/The local history search is the DETECTOR, and it alone decides the default verdict/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 decides its default verdict from local history alone");
record(/If history holds exactly one authored signature for the name \(or none\), there is no multiplicity to resolve and this check is \*\*clean\*\* — do not ask for live evidence you do not need/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 clears the unambiguous case without live evidence");
record(/If no live evidence is supplied, the step-2 BLOCKER STANDS\.\*\* Do not emit a HIGH asking the run to fetch evidence it cannot fetch, and never read its absence as clean/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 keeps an unacquitted BLOCKER instead of a HIGH it cannot satisfy");
record(/`scripts\/write-apply-proofs\.mjs` executes this charter with only the charter text and the migration path/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 names the sandboxed runner that cannot supply live evidence");
record(/The acquitting evidence must therefore carry `proargtypes` \(the canonical input-type OID vector\), or types rendered under a controlled, explicitly stated search_path/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 compares argument types by canonical OID, not rendered text");
record(/`regprocedure` renders the ARGUMENT TYPES search_path-dependently too/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 warns that argument-type rendering is also path-dependent");
record(/Neither does evidence with no timestamp or no project binding/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 rejects unbound or undated live evidence");
record(/Answer this check with a SMALL, BOUNDED number of local `Grep`\/`Bash` searches/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 keeps the bounded local-search method");
record(/do NOT use any remote\/GitHub file-reading tool \(`fetch_blob` or similar\) to enumerate history/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 forbids remote per-file history enumeration");
record(!clearsOverloadFindingOnCount(overloadCollisionCheck), "migration drift reviewer CHECK 2 contains no count-clears-the-finding rule");
record(adversarialCountRules.every(clearsOverloadFindingOnCount), "migration drift reviewer count detector rejects adversarial count-only rules");
record(!clearsOverloadFindingOnCount(validCountRejection), "migration drift reviewer count detector permits the count rejection wording");

const allow = new Set(settings.permissions?.allow || []);
const ask = new Set(settings.permissions?.ask || []);
// Mason's decision 2026-07-11 (re-affirming 2026-07-05): no permission popups for
// push / SQL / migrations — the deterministic hooks (codex-push-guard,
// live-testdata-guard DDL block, migration-apply-guard proof file) are the real
// gate, plus his explicit OK in chat per AGENTS.md. These must be auto-allowed
// so the popup never returns, and must never fall into ask/deny silently.
const hookGated = [
  "Bash(git push:*)",
  "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__execute_sql",
  "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__apply_migration",
  "mcp__supabase__execute_sql",
  "mcp__supabase__apply_migration",
  "mcp__claude_ai_Supabase__execute_sql",
  "mcp__claude_ai_Supabase__apply_migration",
];
for (const permission of hookGated) {
  record(allow.has(permission), `${permission} is auto-allowed (deterministic hook is the gate)`);
  record(!ask.has(permission), `${permission} does not prompt`);
}
// Edge-function deploys have no deterministic hook backstop — they keep the popup.
const mustAsk = [
  "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__deploy_edge_function",
  "mcp__supabase__deploy_edge_function",
  "mcp__claude_ai_Supabase__deploy_edge_function",
];
for (const permission of mustAsk) {
  record(!allow.has(permission), `${permission} is not auto-allowed`);
  record(ask.has(permission), `${permission} requires approval`);
}

const allHooks = Object.values(codexHooks.hooks || {})
  .flatMap((entries) => entries)
  .flatMap((entry) => entry.hooks || [])
  .filter((hook) => hook.type === "command");
record(!/C:\\\\CRX_Manager/i.test(codexHooksText), ".codex/hooks.json has no hard-coded checkout path");
record(allHooks.length > 0 && allHooks.every((hook) => hook.command && hook.commandWindows), "every Codex command hook has POSIX and Windows commands", `${allHooks.length} hooks`);
// A `commandWindows` string is run through a PowerShell parent, which expands
// any `$…` before the inner PowerShell parses it — the 2026-07-28 fail-open.
// Rationale and the full list of rejected forms: scripts/windows-hook-command.mjs.
const windowsVarHooks = findWindowsShellVariableHooks(allHooks);
record(windowsVarHooks.length === 0, "no Codex Windows hook command interpolates a shell variable", windowsVarHooks.length ? `${windowsVarHooks.length} hook(s) use a $variable` : `${allHooks.length} hooks clean`);
record(codexHooksText.includes(".claude/hooks/sql-safety.mjs"), "Codex invokes shared Claude hook sources");
record(codexHooksText.includes("production-action-guard.mjs"), "Codex production action guard is registered");
record(codexHooksText.includes("review-proof-guard.mjs"), "Codex review proof guard is registered");
record(!gitignore.split(/\r?\n/).some((line) => line.trim() === ".agents/" || line.trim() === ".codex/"), "tracked agent configuration is not blanket-ignored");
// Scope to the [mcp_servers.supabase] url line, parsed line-by-line so a
// commented heading, a commented url, a backup_url key, or a url in a later
// TOML table can never satisfy the check; the read_only flag is matched at
// query-parameter boundaries so read_only=false0 / other_read_only=false fail.
let codexSupabaseUrl = "";
{
  let inSupabase = false;
  for (const line of read(".codex/config.toml").split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (heading) { inSupabase = heading[1].trim() === "mcp_servers.supabase"; continue; }
    if (!inSupabase) continue;
    const url = line.match(/^\s*url\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
    if (url) { codexSupabaseUrl = url[1]; break; }
  }
}
record(
  /[?&]read_only=false(?:&|$)/.test(codexSupabaseUrl) && !/[?&]read_only=true(?:&|$)/.test(codexSupabaseUrl),
  "Codex Supabase MCP url declares write access (Mason approved 2026-08-14)",
);

const sync = spawnSync(process.execPath, [path.join(ROOT, "scripts", "sync-agent-workflows.mjs"), "--check"], {
  cwd: ROOT,
  encoding: "utf8",
});
record(sync.status === 0, "Codex workflow adapters match Claude sources", (sync.stdout || sync.stderr).trim().split(/\r?\n/)[0] || "no output");

console.log("check-agent-guidance");
for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name}${item.note ? ` - ${item.note}` : ""}`);
const failed = checks.filter((item) => !item.ok);
if (failed.length > 0) {
  console.log(`FAIL - ${failed.length} agent guidance check(s) failed.`);
  process.exit(1);
}
console.log("PASS - shared agent guidance and deterministic guards are aligned.");

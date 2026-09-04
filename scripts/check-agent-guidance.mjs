#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
const cursorRules = read(".cursorrules");
const claudeModelTuning = read("docs/reference/claude-model-tuning.md");
const codingGuidelines = read("docs/reference/coding-guidelines.md");
const safeDevelopmentRules = read("docs/workflows/SAFE_DEVELOPMENT_RULES.md");
const shipWorkflow = read(".claude/commands/ship.md");
const routingTable = agents.match(/## Start and Route([\s\S]*?)## Engineering Principles/)?.[1] || "";
const routedGuidance = [...new Set(
  [...routingTable.matchAll(/`([^`]+\.(?:md|json))`/g)].map((match) => match[1]),
)];
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

record(agents.split(/\r?\n/).length <= 90, "AGENTS.md stays lean", `${agents.split(/\r?\n/).length} lines`);
record(Buffer.byteLength(agents, "utf8") <= 12000, "AGENTS.md stays within the startup-context budget", `${Buffer.byteLength(agents, "utf8")} bytes`);
record(claude.split(/\r?\n/).length <= 60, "CLAUDE.md stays lean", `${claude.split(/\r?\n/).length} lines`);
record(Buffer.byteLength(claude, "utf8") <= 6000, "CLAUDE.md stays within the startup-context budget", `${Buffer.byteLength(claude, "utf8")} bytes`);
record(cursorRules.split(/\r?\n/).length <= 15, ".cursorrules stays a lean AGENTS.md router", `${cursorRules.split(/\r?\n/).length} lines`);
record(/AGENTS\.md.*canonical shared contract/i.test(cursorRules), ".cursorrules delegates shared policy to AGENTS.md");
record(!/\b\d{2,5}\s+(?:tables|migrations|pages|tests?|edge functions?)\b/i.test(cursorRules), ".cursorrules has no volatile project counts");
record(claude.trimStart().startsWith("@AGENTS.md"), "CLAUDE.md imports AGENTS.md first");
record(/## Owner Communication/.test(agents), "AGENTS.md defines the owner communication contract");
record(/cannot safely review code or diffs/i.test(agents), "AGENTS.md acknowledges Mason cannot review code or diffs");
record(/never have to nudge[\s\S]*Keep moving through authorized work/i.test(agents), "owner communication keeps authorized work moving without nudges");
record(/what failed, what it means, and what (?:the agent is|you are) trying next/i.test(agents), "owner communication makes failures explicit");
record(/NEEDS MASON - ACTION REQUIRED[\s\S]*NEEDS MASON - DECISION REQUIRED/i.test(agents), "owner communication makes genuine stops unmistakable");
record(/Codex proceeds after a short plan[\s\S]*Claude retains its global pre-code approval checkpoint/i.test(agents), "tool-specific plan authority stays explicit");
record(/Before presenting findings as current, confirm the checkout is not behind `origin\/main`/i.test(agents), "reviews and audits require a current checkout");
record(/simplest complete implementation/i.test(agents), "AGENTS.md requires simple, complete implementations");
record(/clarity, not cleverness/i.test(agents), "AGENTS.md favors readable code over clever compression");
record(/## CRX Hard Rules/.test(agents), "AGENTS.md retains the CRX hard-rule section");
record(/New tables require Row Level Security and policies in the same migration/i.test(agents), "AGENTS.md retains new-table RLS requirements");
record(/Mutating RPCs must accept and enforce `p_idempotency_key text DEFAULT NULL`/i.test(agents), "AGENTS.md retains mutating-RPC idempotency requirements");
record(/Money must resolve to exact whole cents/i.test(agents), "AGENTS.md retains exact-money requirements");
record(/Use `src\/lib\/db\.ts` as the only Supabase client[\s\S]*assertRpcResult\(\)[\s\S]*checkMutationResult\(\)/i.test(agents), "AGENTS.md retains Supabase client and result-check requirements");
record(/never use `--no-verify`[\s\S]*never push directly to `main`/i.test(agents), "AGENTS.md retains protected-delivery bans");
record(/Mason explicitly pre-authorized[\s\S]*unexpired autopilot arm flag[\s\S]*migration-apply-guard proof[\s\S]*Codex verdict[\s\S]*never permits destructive migrations/i.test(agents), "AGENTS.md retains hands-free migration conditions");
record(/## Safety and Protected Delivery[\s\S]*\.claude\/commands\/ship\.md/.test(agents), "AGENTS.md routes volatile delivery mechanics to the ship workflow");
record(/docs\/workflows\/SAFE_DEVELOPMENT_RULES\.md/.test(agents), "AGENTS.md routes detailed engineering rules on demand");
record(/docs\/workflows\/AGENT_COLLABORATION\.md/.test(agents), "AGENTS.md routes collaboration details on demand");
record(/Delegation, agent collaboration, or agent-surface changes/i.test(agents), "AGENTS.md routes delegation guidance on demand");
record(/docs\/reference\/claude-model-tuning\.md/.test(claude), "CLAUDE.md routes model tuning on demand");
const missingGuidance = routedGuidance.filter((relative) => !existsSync(path.join(ROOT, relative)));
record(routedGuidance.length >= 15 && missingGuidance.length === 0, "every path in the AGENTS.md routing table resolves", missingGuidance.join(", "));
record(existsSync(path.join(ROOT, ".agents/skills/graphify/SKILL.md")), "AGENTS.md graphify route resolves to the Codex adapter");
record(!/\b\d{2,5}\s+(?:migrations|pages|edge functions?)\b/i.test(agents), "AGENTS.md has no volatile project counts");
record(!/\b\d{2,5}\s+(?:migrations|pages|edge functions?)\b/i.test(claude), "CLAUDE.md has no volatile project counts");
record(/AGENTS\.md.*canonical shared (?:project )?contract/i.test(claude), "CLAUDE.md declares AGENTS.md canonical");
record(/explicit approval in the current conversation/i.test(agents), "AGENTS.md defines current-conversation approval gates");
const alwaysLoadedGuidance = `${agents}\n${claude}\n${cursorRules}`;
record(!/^\s*(?:[-*+]\s+)?(?:FINAL_VERDICT|OPUS5_VERDICT|VERDICT):/im.test(alwaysLoadedGuidance), "always-loaded guidance contains no review-proof verdict label");
record(/Reviewer prompts must request every correctness, safety, and scope finding/i.test(claudeModelTuning), "Claude reviewer prompts retain the uncapped-finding default");
record(/Fable 5 remains provisional but binding[\s\S]*must not treat this guidance as Opus-only or skip it/i.test(claudeModelTuning), "Claude model tuning remains binding for Fable 5 until superseded");
record(/DECISION_LOG\.md[\s\S]*settled design choice[\s\S]*KNOWN_ISSUES\.md[\s\S]*problem is new/i.test(codingGuidelines), "every code change checks settled decisions and known issues");
record(/^Read this before any multi-file, data, money, security, permission, production, migration, or customer-facing change\./m.test(safeDevelopmentRules), "safe-development trigger matches the lean routing table");
record(/mergeStateStatus[\s\S]*known-stale protection sub-resource/i.test(shipWorkflow), "ship workflow uses behavioral PR mergeability evidence");
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

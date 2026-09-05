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

function readChecked(relative) {
  if (!existsSync(path.join(ROOT, relative))) {
    record(false, `${relative} exists`);
    return "";
  }
  return read(relative);
}

const agents = read("AGENTS.md");
const claude = read("CLAUDE.md");
const cursorRules = readChecked(".cursorrules");
const claudeModelTuning = readChecked("docs/reference/claude-model-tuning.md");
const codingGuidelines = readChecked("docs/reference/coding-guidelines.md");
const sqlCanonicalPatterns = readChecked("docs/reference/sql-canonical-patterns.md");
const safeDevelopmentRules = readChecked("docs/workflows/SAFE_DEVELOPMENT_RULES.md");
const quoteToDelivery = readChecked("docs/workflows/QUOTE_TO_DELIVERY.md");
const qaTesting = readChecked("docs/reference/qa-testing.md");
const agentGuardrails = readChecked("docs/reference/agent-guardrails.md");
const wholeCodebaseAudit = readChecked(".claude/workflows/whole-codebase-audit.js");
const preflightWorkflow = readChecked(".claude/commands/preflight.md");
const lifecycleAuditPrompts = [
  wholeCodebaseAudit,
  readChecked(".claude/workflows/overnight-bug-hunt.js"),
  readChecked(".claude/workflows/money-inventory-hunt.js"),
];
const shipWorkflow = readChecked(".claude/commands/ship.md");
const routingTable = agents.match(/## Start and Route([\s\S]*?)## Engineering Principles/)?.[1] || "";
const protectedDelivery = agents.match(/## Safety and Protected Delivery([\s\S]*?)## Verification and Closeout/)?.[1] || "";
const routedGuidance = [...new Set(
  [...routingTable.matchAll(/`([^`]+\.(?:md|json))`/g)].map((match) => match[1]),
)];
const requiredRouteRows = [
  ["First session or unfamiliar area", ["docs/manual/AGENT_ONBOARDING.md", "docs/manual/ARCHITECTURE.md"]],
  ["Any code change", ["docs/reference/coding-guidelines.md", "docs/reference/gotchas.md", "docs/workflows/SAFE_DEVELOPMENT_RULES.md"]],
  ["Database, migration, or RLS", ["docs/workflows/DATABASE_CHANGE_CHECKLIST.md", "docs/workflows/RLS_SECURITY_GUIDE.md", ".claude/schema-registry.json"]],
  ["Quote-to-cash or inventory", ["docs/workflows/QUOTE_TO_DELIVERY.md", "docs/workflows/INVENTORY_RULES.md"]],
  ["Frontend/UI", ["docs/workflows/UI_PATTERNS.md"]],
  ["Delegation, agent collaboration, or agent-surface changes", ["docs/workflows/AGENT_COLLABORATION.md", "docs/reference/agent-guardrails.md"]],
  ["Push, PR finalization, merge, or release", [".claude/commands/ship.md"]],
  ["Settled decisions, known problems, or current status", ["docs/manual/DECISION_LOG.md", "docs/manual/KNOWN_ISSUES.md", "docs/manual/CURRENT_STATE.md"]],
  ["Mason asks how the system or agent process works", ["docs/manual/OWNER_PLAYBOOK.md"]],
];
const routingRows = new Map(
  [...routingTable.matchAll(/^\|\s*([^|\r\n]+?)\s*\|\s*([^|\r\n]+?)\s*\|\s*$/gm)]
    .map((match) => [match[1].trim(), match[2]]),
);
const missingRequiredRoutes = requiredRouteRows.flatMap(([task, paths]) => {
  const row = routingRows.get(task) || "";
  return paths.filter((relative) => !row.includes(`\`${relative}\``)).map((relative) => `${task} -> ${relative}`);
});
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
record(/Deliver what was asked at the scope intended[\s\S]*rather than quietly narrowing, widening, or transforming it/i.test(agents), "shared contract prevents silent scope changes");
record(/Before presenting findings as current, confirm the checkout is not behind `origin\/main`/i.test(agents), "reviews and audits require a current checkout");
record(/simplest complete implementation/i.test(agents), "AGENTS.md requires simple, complete implementations");
record(/clarity, not cleverness/i.test(agents), "AGENTS.md favors readable code over clever compression");
record(/## CRX Hard Rules/.test(agents), "AGENTS.md retains the CRX hard-rule section");
record(/New tables require Row Level Security and policies in the same migration/i.test(agents), "AGENTS.md retains new-table RLS requirements");
record(/Mutating RPCs must accept and enforce `p_idempotency_key text DEFAULT NULL`/i.test(agents), "AGENTS.md retains mutating-RPC idempotency requirements");
record(/Money must resolve to exact whole cents/i.test(agents), "AGENTS.md retains exact-money requirements");
record(/Use `src\/lib\/db\.ts` as the only Supabase client[\s\S]*assertRpcResult\(\)[\s\S]*checkMutationResult\(\)/i.test(agents), "AGENTS.md retains Supabase client and result-check requirements");
record(/never use `--no-verify`[\s\S]*never push directly to `main`/i.test(agents), "AGENTS.md retains protected-delivery bans");
const migrationExceptionChecks = [
  ["Mason pre-authorizes the hands-free run", /hands-free run Mason explicitly pre-authorized/i],
  ["the autopilot arm is unexpired", /unexpired autopilot arm flag/i],
  ["migration-apply-guard proof is fresh", /fresh migration-apply-guard proof/i],
  ["the Codex verdict is fresh", /fresh Codex verdict/i],
  ["destructive migrations remain prohibited", /never permits destructive migrations/i],
];
for (const [name, pattern] of migrationExceptionChecks) {
  record(pattern.test(protectedDelivery), `AGENTS.md hands-free exception requires ${name}`);
}
record(/## Safety and Protected Delivery[\s\S]*\.claude\/commands\/ship\.md/.test(agents), "AGENTS.md routes volatile delivery mechanics to the ship workflow");
record(/docs\/workflows\/SAFE_DEVELOPMENT_RULES\.md/.test(agents), "AGENTS.md routes detailed engineering rules on demand");
record(/docs\/workflows\/AGENT_COLLABORATION\.md/.test(agents), "AGENTS.md routes collaboration details on demand");
record(/Delegation, agent collaboration, or agent-surface changes/i.test(agents), "AGENTS.md routes delegation guidance on demand");
record(/docs\/reference\/claude-model-tuning\.md/.test(claude), "CLAUDE.md routes model tuning on demand");
const missingGuidance = routedGuidance.filter((relative) => !existsSync(path.join(ROOT, relative)));
record(missingRequiredRoutes.length === 0, "AGENTS.md retains every required task/path route", missingRequiredRoutes.join(", "));
record(missingGuidance.length === 0, "every path in the AGENTS.md routing table resolves", missingGuidance.join(", "));
record(
  existsSync(path.join(ROOT, ".claude/skills/graphify/SKILL.md")) &&
    existsSync(path.join(ROOT, ".agents/skills/graphify/SKILL.md")),
  "AGENTS.md graphify route resolves for Claude and Codex",
);
record(!/\b\d{2,5}\s+(?:migrations|pages|edge functions?)\b/i.test(agents), "AGENTS.md has no volatile project counts");
record(!/\b\d{2,5}\s+(?:migrations|pages|edge functions?)\b/i.test(claude), "CLAUDE.md has no volatile project counts");
record(/AGENTS\.md.*canonical shared (?:project )?contract/i.test(claude), "CLAUDE.md declares AGENTS.md canonical");
record(/explicit approval in the current conversation/i.test(protectedDelivery), "AGENTS.md defines current-conversation approval gates");
const protectedActionChecks = [
  ["force-pushing", /force-pushing/i],
  ["applying a live migration", /applying a live migration/i],
  ["changing live data", /changing live data/i],
  ["deploying an Edge Function", /deploying an Edge Function/i],
  ["out-of-band production changes", /out-of-band production change/i],
  ["deleting data", /deleting data/i],
  ["changing secrets", /changing secrets/i],
  ["authentication changes", /authentication/i],
  ["permission changes", /permissions/i],
  ["billing changes", /billing/i],
  ["domain changes", /domains/i],
  ["ownership changes", /ownership/i],
];
for (const [name, pattern] of protectedActionChecks) {
  record(pattern.test(protectedDelivery), `AGENTS.md requires current approval before ${name}`);
}
const alwaysLoadedGuidance = `${agents}\n${claude}\n${cursorRules}`;
record(!/VERDICT\s*:/i.test(alwaysLoadedGuidance), "always-loaded guidance contains no review-proof verdict label");
record(/Reviewer prompts must request every correctness, safety, and scope finding/i.test(claudeModelTuning), "Claude reviewer prompts retain the uncapped-finding default");
record(/Never lower effort on a money, RLS, or migration path to save tokens/i.test(claudeModelTuning), "Claude tuning preserves the high-risk effort floor");
record(/Fable 5 remains provisional but binding[\s\S]*must not treat this guidance as Opus-only or skip it/i.test(claudeModelTuning), "Claude model tuning remains binding for Fable 5 until superseded");
record(
  /normal helper use requires no exemption marker/i.test(sqlCanonicalPatterns) &&
    !/When using helpers,\s+add[^\n]*idempotency-body-check:\s*exempt/i.test(sqlCanonicalPatterns),
  "canonical SQL guidance does not disable idempotency checks for normal helper use",
);
record(
  lifecycleAuditPrompts.every((prompt) => /For all nine entities, compare every status written by current source against the live CHECK constraints in pg_constraint/i.test(prompt)),
  "every lifecycle audit compares all nine entities with live CHECK constraints",
);
record(
  /enum: \['VERIFIED', 'REFUTED', 'UNVERIFIED'\]/.test(wholeCodebaseAudit)
    && /Uncertainty is UNVERIFIED, never REFUTED or FALSE_POSITIVE/.test(wholeCodebaseAudit)
    && /review\.executionStatus === 'VERIFIED'/.test(wholeCodebaseAudit)
    && /isNonEmptyString\(review\.evidenceSummary\)/.test(wholeCodebaseAudit)
    && /unverified: unverified\.length/.test(wholeCodebaseAudit),
  "whole-codebase audit preserves incomplete evidence as UNVERIFIED",
);
record(
  /closed_by_application/.test(quoteToDelivery) && /closed_short/.test(quoteToDelivery),
  "quote workflow documents every live terminal status",
);
record(
  /_enforce_quote_status_transition\(\)` is authoritative/.test(quoteToDelivery)
    && /`draft` \| `sent`, `cancelled`/.test(quoteToDelivery)
    && /closed_short` has an additional safety condition[\s\S]*BOOKING_HAS_ACTIVE_JOBS/.test(quoteToDelivery)
    && /\*\*cancelled\*\*: Quote was cancelled/.test(quoteToDelivery),
  "quote workflow preserves the authoritative transition map and terminal descriptions",
);
record(
  /under `tests\/e2e\/`/.test(qaTesting) && /docs\/reference\/qa-testing\.md/.test(codingGuidelines),
  "QA reference points to the real E2E directory and is reachable from routed guidance",
);
record(
  /Audit the 7 Edge Functions in supabase\/functions \(create-user, epa-lookup, process-blend-ticket, process-document, reset-user-password, send-email, setup-blend-tickets-storage\)/.test(wholeCodebaseAudit)
    && /Hunt EDGE FUNCTIONS \(7 in supabase\/functions: create-user, epa-lookup, process-blend-ticket, process-document, reset-user-password, send-email, setup-blend-tickets-storage\)/.test(lifecycleAuditPrompts[1]),
  "whole-codebase and overnight edge-function audits include epa-lookup",
);
record(
  /\.claude\/commands\|skills\|hooks\|workflows\|agents\|settings\.json/.test(agentGuardrails),
  "ledger guardrail lists every Claude agent-surface directory",
);
record(/`… \\\| sl`/.test(agentGuardrails), "agent-guardrails table escapes its shell-pipe example");
record(/DECISION_LOG\.md[\s\S]*settled design choice[\s\S]*KNOWN_ISSUES\.md[\s\S]*problem is new/i.test(codingGuidelines), "every code change checks settled decisions and known issues");
record(/^Read this before any multi-file, data, money, security, permission, production, migration, or customer-facing change\./m.test(safeDevelopmentRules), "safe-development trigger matches the lean routing table");
record(
  /LEDGER_REQUIRED=true[\s\S]*new `supabase\/migrations\/\*\.sql` file[\s\S]*If `LEDGER_REQUIRED` is true/.test(preflightWorkflow)
    && /docs\/reference\/migration-history\.md/.test(preflightWorkflow),
  "preflight ledger guidance matches migration and agent-surface enforcement",
);
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

// Added 2026-09-04. CHECK 2's METHOD paragraph is the whole of this branch's
// charter change: the local search is mandatory, and remote per-file history
// enumeration is forbidden because two real runs died after 598 and 751
// fetch_blob calls with no verdict at all.
//
// REVISED 2026-09-04 after CodeRabbit on PR #594. The method was first written
// as a SINGLE name-level pass ("ideally ONE grep -rnoiE"), which cannot answer
// the rule it is attached to: -o prints only the matched name, discarding the
// argument list and any preceding DROP FUNCTION, and steps 2-3 consume exactly
// those. It also said "do NOT read migration files one at a time", which
// outlawed the follow-up read that recovers them. The method is now two-phase —
// A discovers candidates, B reads their full declarations — so pin BOTH phases
// AND the sentence that denies phase A the verdict. Pinning phase A alone would
// be satisfied by the very defect this revision fixes.
//
// DEFERRED (Mason, 2026-09-04): the overload-EVIDENCE question — what live
// catalog proof may acquit a history-detected collision, and how the sandboxed
// proof runner could ever supply it — is a separate task with its own plan.
// See docs/manual/KNOWN_ISSUES.md.
// The charter hard-wraps its prose, so match against whitespace-flattened text.
const overloadCollisionCheck = migrationDriftReviewer.match(
  /### CHECK 2 — Function overload collision([\s\S]*?)(?=\n### CHECK 3)/
)?.[1] || "";
const overloadCollisionFlat = overloadCollisionCheck.replace(/\s+/g, " ");
record(overloadCollisionFlat.trim().length > 0, "migration drift reviewer CHECK 2 block is extractable");
record(/Answer this check in TWO bounded local phases/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 keeps the two-phase bounded local method");
record(/PHASE A — discovery\.\* ONE local `grep -rniE` over `supabase\/migrations\/` covering every function name in this migration at once/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 keeps the one-pass discovery phase");
record(/\*\*A name-level match does NOT decide this check\*\*/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 denies the discovery pass the verdict");
record(/`-o` in particular prints only the matched text, discarding both the argument list and any preceding `DROP FUNCTION`/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 names why a name-only grep is insufficient");
record(/Clearing CHECK 2 on phase A alone is a false clean/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 labels a phase-A-only clear a false clean");
record(/PHASE B — read the candidates\.\* For every file phase A named, read the full `CREATE OR REPLACE FUNCTION` declaration: its complete argument list, and whether a `DROP FUNCTION` for that name precedes it in the same migration/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 requires reading each candidate's full declaration");
record(/Phase B is bounded by the NUMBER OF MATCHES/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 keeps phase B bounded by match count");
record(/forbids walking the corpus, never reading the specific files phase A identified/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 scopes the prohibition to corpus walking, not candidate reads");
record(/do NOT use any remote\/GitHub file-reading tool \(`fetch_blob` or similar\) to enumerate history/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 forbids remote per-file history enumeration");
record(/the local one-pass grep answered PHASE A in 0\.17 s, where the per-file remote walk died twice — after 598 and 751 fetches — with no verdict at all/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 keeps the measurement that justifies the method");
record(/If a previous definition with DIFFERENT argument types exists AND the new migration does NOT first `DROP FUNCTION` the old one, severity = \*\*BLOCKER\*\*/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 retains the differing-argument BLOCKER");
record(/Postgres allows multiple overloads; the bug is when the caller expects to resolve to one but hits the other/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 retains the caller-resolution rationale");

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

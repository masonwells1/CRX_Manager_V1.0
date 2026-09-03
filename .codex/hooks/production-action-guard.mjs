#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  contentIsRisky,
  extractPatchDestinations,
  gitPushCwd,
  isGitPush,
  mainPushSource,
  proofSearchDirs,
  proofValid,
  pullRequestReviewBlocked,
  pushContextIsAmbiguous,
  pushIsForced,
  pushTargetsCurrentHead,
  pushUsesBulkMode,
  reviewProofPathMentioned,
  reviewStateDirectoryMentioned,
  riskyFiles,
} from "../../.claude/hooks/codex-push-lib.mjs";
import { stripCommentsQuoteAware } from "../../.claude/hooks/live-testdata-lib.mjs";
import {
  CODEX_THREADS_QUERY,
  CODEX_THREAD_PAGE_SIZE,
  codexBotFindingsDenial,
  collectCodexThreads,
  evaluateCodexBotReview,
} from "../../.claude/hooks/codex-bot-review-lib.mjs";

// Sol HIGH finding (2026-08-14, write-scope review): with the Supabase connector
// write-enabled, ANY mutating Supabase tool Codex can reach is a route to
// production schema/data changes that bypasses the migration gates. Supabase
// tools are therefore governed by an EXACT read-only allowlist — a tool this
// guard has never heard of fails closed instead of failing open. execute_sql is
// the one deliberate exception: it passes through to the content gate below,
// which only admits clearly read-only SQL.
// CodeRabbit follow-up: the app connector's MCP prefix is a UUID, not the
// literal `supabase` server name, so the allowlist matches that known UUID
// too. If the connector is ever re-created under a new UUID, its known
// leaves stay covered by the suffix blocklist and the execute_sql content
// gate below; add the new UUID here so unknown leaves fail closed again.
// Codex-review follow-up: the built-in codex_apps/supabase channel (the one
// actually serving Codex traffic per docs/manual/KNOWN_ISSUES.md) normalizes
// to app-style names with a SINGLE underscore (mcp__codex_apps__supabase_<leaf>),
// so `_{1,2}` accepts both naming forms — same dual-form handling as
// GITHUB_TOOL below.
const SUPABASE_TOOL_RE = /(?:^|__)(?:supabase|50e15046-cf2c-49da-b8df-ceef27768f63)_{1,2}([a-z0-9_]+)$/i;
const SUPABASE_READ_ONLY_TOOLS = new Set([
  "generate_typescript_types", "get_advisors", "get_cost", "get_edge_function",
  "get_logs", "get_organization", "get_project", "get_project_url",
  "get_publishable_keys", "list_branches", "list_edge_functions",
  "list_extensions", "list_migrations", "list_organizations", "list_projects",
  "list_tables", "query_logs", "search_docs",
]);
// Defense-in-depth for connectors whose MCP prefix is NOT the literal
// `supabase` server name (e.g. UUID-named app connectors): the known mutating
// lifecycle leaves stay blocked by suffix regardless of prefix. Mirrors the
// branch/project lifecycle deny set in .claude/hooks/autopilot-lib.mjs.
const LIVE_TOOL_ACTIONS = /(?:apply_migration|deploy_edge_function|delete_branch|merge_branch|reset_branch|rebase_branch|create_branch|create_project|pause_project|restore_project|confirm_cost)$/i;
const GITHUB_MERGE_TOOL = /merge_pull_request$/i;
// Both MCP naming (mcp__github__create_file) and app naming
// (mcp__codex_apps__github_create_file) — Codex round-5.
const GITHUB_TOOL = /(?:^|__)github_{1,2}/i;
const NODE_REPL_TOOL = /(?:^|__)node[_-]?repl(?:__|$)/i;
// `codex-bot-review-lib` joined this list 2026-09-02 (PR #563, Codex HIGH on
// that PR's own exact-head review). Both merge guards IMPORT it at startup, so
// it is in the same trust class as codex-push-lib: code that runs before the
// guard sees a single byte of input. Leaving it off the list meant an
// apply_patch at that path returned blocked:false while the identical patch
// against production-action-guard.mjs returned blocked:true — and because the
// module executes at import time, an allowed edit could keep its exports intact
// while terminating or subverting the hook at startup. Silent completion means
// ALLOW, so that would bypass every production-action restriction, not merely
// the Codex App review check this PR added.
const PROTECTED_HARNESS_SOURCE = String.raw`(?:\.claude[\\/]hooks[\\/](?:codex-push-(?:guard|lib)|codex-bot-review-lib|review-proof-guard|live-testdata-lib)\.mjs|\.codex[\\/]hooks[\\/](?:production-action-guard|codex-hook-adapter)\.mjs|scripts[\\/](?:run-claude-review|write-codex-push-proof|write-apply-proofs|overnight-codex-gate|apply-live-testdata-maintenance-20260812)\.mjs|package\.json|\.claude[\\/]settings\.json|\.codex[\\/]hooks\.json)`;
const PROTECTED_HARNESS_PATH_RE = new RegExp(String.raw`(?:^|[\\/])${PROTECTED_HARNESS_SOURCE}$`, "i");
const PROTECTED_HARNESS_FRAGMENT_RE = new RegExp(`(?<![\\w.-])${PROTECTED_HARNESS_SOURCE}(?![\\w.-])`, "i");
const MAINTENANCE_PRODUCER = "scripts/apply-live-testdata-maintenance-20260812.mjs";
export function maintenanceProducerCommandMentioned(command) {
  const compact = String(command || "")
    .toLowerCase()
    .replace(/[\s\\/"'`^]/g, "");
  return compact.includes("apply-live-testdata-maintenance-20260812.mjs");
}

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

// Resolve `.` and `..` segments and unify separators WITHOUT touching disk, so
// a protected path cannot be spelled around.
//
// Codex HIGH, PR #563 round 2: `.claude/hooks/codex-bot-review-lib.mjs` was
// blocked while `.claude/hooks/../hooks/codex-bot-review-lib.mjs` — the same
// file, confirmed with Resolve-Path — was ALLOWED, through Write, a realistic
// apply_patch payload, and PowerShell. The matcher compared raw strings, so any
// dot-segment detour defeated it. This was never specific to the module that
// review was about: every entry in PROTECTED_HARNESS_SOURCE had the same hole.
//
// Purely textual on purpose. The guard must reach the same verdict whether or
// not the path exists yet, and a filesystem resolve would also follow symlinks
// into a different answer than the one the tool will actually write to.
export function canonicalizeGuardPath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  // A Windows drive prefix is DROPPED, not preserved. `C:.claude/hooks/x.mjs`
  // is drive-relative — no slash after the colon — so keeping the prefix left
  // `.claude` preceded by `:`, which the protected-path anchor (`^` or a
  // separator) never matches. Codex round 3 wrote to exactly that spelling and
  // was allowed. Dropping the drive is deliberately over-inclusive: a path on
  // another drive that happens to end in a protected suffix is refused. For a
  // deny-guard that is the safe direction, and no legitimate workflow needs to
  // write a harness file through a drive-qualified alias.
  const driveMatch = /^([A-Za-z]:)(\/?)/.exec(raw);
  const rooted = driveMatch ? driveMatch[2] === "/" : raw.startsWith("/");
  const body = driveMatch ? raw.slice(driveMatch[0].length) : raw;
  const segments = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Above a rooted path there is nowhere to go, so drop it. In a relative
      // path a leading `..` is meaningful and is kept.
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!rooted) segments.push("..");
      continue;
    }
    // Windows IGNORES trailing periods and spaces in a path segment: the Win32
    // path normalizer strips them before the file system sees the name, so
    // `.claude./hooks/x.mjs`, `.claude/hooks./x.mjs` and `.claude/hooks/x.mjs.`
    // all open `.claude/hooks/x.mjs` (probe-confirmed with Get-Item on every
    // spelling, 2026-09-03). Codex round 7 wrote through exactly those aliases
    // and was allowed, because this canonicalizer only knew about `.`/`..` and
    // drive prefixes. Windows trims only ONE trailing period from an interior
    // segment but every trailing period and space from the last; stripping all
    // of them from every segment is deliberately over-inclusive, which is the
    // safe direction for a deny-guard. A segment that is NOTHING but periods
    // and spaces (`...`, `.. `, `. .`) is dropped outright: Windows refuses to
    // resolve those at all (probe-confirmed), and on POSIX they are literal
    // names, never a parent hop — so dropping one can only shorten the path
    // toward a protected suffix, again the deny direction. The exact `.`/`..`
    // spellings are handled ABOVE this line and never reach the strip.
    const trimmed = segment.replace(/[. ]+$/, "");
    if (trimmed === "") continue;
    segments.push(trimmed);
  }
  return (rooted ? "/" : "") + segments.join("/");
}

function protectedHarnessPathMentioned(value) {
  const raw = String(value || "").trim();
  // Test the raw spelling first so behaviour is unchanged for ordinary paths,
  // then the canonical one so detours cannot buy a different answer.
  return PROTECTED_HARNESS_PATH_RE.test(raw) || PROTECTED_HARNESS_PATH_RE.test(canonicalizeGuardPath(raw));
}

// Does any argument of this command resolve to a protected harness file?
//
// The first cut sniffed for a literal `../` next to a protected basename. Codex
// round 3 walked straight past it with an interior `./`
// (`Set-Content .claude/hooks/./codex-push-lib.mjs`) and with a Windows
// drive-relative alias (`C:.claude/hooks/…`) — because enumerating the spellings
// of "somewhere else" never terminates.
//
// So this matches the SHAPE instead: split the command into candidate path
// tokens, canonicalize each one, and test the result against the protected-path
// matcher. `./`, `../`, `C:`-relative, backslashes, and any combination all
// collapse to the same canonical string, so one rule covers spellings nobody has
// thought of yet.
// Characters the shell DELETES while building a word — it does not break the
// word at them. Round 3 treated them as separators, which is the same class of
// error as the earlier spelling checks: a quote or backtick dropped into the
// middle of a path split one protected token into two harmless ones, while
// PowerShell rejoined them and wrote the protected file. Codex round 4 proved
// it with Resolve-Path on two forms, both allowed at the time — a backtick
// escape and an empty double-quoted string, each spliced into the middle of
// `.claude/hooks/codex-push-lib.mjs`.
//
// Codex round 8 (SEC-002) added cmd.exe's caret: `echo x > codex-push-^lib.mjs`
// under `cmd /c` drops the `^` and writes the protected file. The set is the
// UNION of every shell's word-building no-ops — PowerShell's backtick, cmd's
// caret, and the quotes all three share — because the guard cannot know which
// interpreter will run the text. A literal caret in a PowerShell path is a
// different file that this over-blocks, which is the safe direction.
const SHELL_WORD_NOOP_RE = /[`"'^]/g;
// A POSIX shell (Git Bash on this box) deletes an unquoted backslash and keeps
// the next character, so `codex-push-\lib.mjs` opens `codex-push-lib.mjs`. The
// backslash is ALSO Windows' separator, so it cannot join the no-op set above —
// `.claude\hooks\x` must still read as a path. It gets its own view instead:
// with every backslash deleted, the POSIX escape collapses while a
// backslash-separated Windows path merely stops matching in THIS view and is
// still caught by the two views that keep it.
const POSIX_ESCAPE_RE = /\\/g;

function commandPathTokens(command) {
  const raw = String(command || "");
  // Three views of the same command. The first splits on quotes so a quoted
  // path is examined rather than skipped; the second REMOVES shell no-op
  // characters so an intra-word splice collapses back to the path the shell
  // will actually open; the third additionally deletes backslashes for the
  // POSIX-escape case. All are needed: no view alone covers the others' cases.
  const dequoted = raw.replace(SHELL_WORD_NOOP_RE, "");
  const views = [raw, dequoted, dequoted.replace(POSIX_ESCAPE_RE, "")];
  const tokens = [];
  for (const view of views) {
    for (const token of view.split(/[\s"'`,;()|&<>]+/)) {
      if (!token) continue;
      // `-Path=x`, `--file=x`, `Path:x` — keep the value, drop the flag name.
      const value = token.replace(/^[-/]{1,2}[A-Za-z][\w-]*[:=]/, "");
      if (value) tokens.push(value);
    }
  }
  return tokens;
}
export function commandTouchesProtectedHarnessPath(command) {
  return commandPathTokens(command).some((token) =>
    PROTECTED_HARNESS_PATH_RE.test(canonicalizeGuardPath(token)));
}

// The mutating verbs the shell-mutation gate recognises. Kept as one source so
// the computed-text check below and `shellMutatesPath` cannot drift apart.
const SHELL_MUTATION_RE = /(?:>|\b(?:set-content|add-content|out-file|new-item|set-item|clear-item|clear-content|set-itemproperty|new-itemproperty|remove-itemproperty|rename-itemproperty|clear-itemproperty|set-acl|remove-item|move-item|copy-item|rename-item|ac|clc|cli|clp|cpi|mi|ni|ri|ren|rni|sc|si|sp|sac|rm|mv|cp|del|erase|sed\s+-i|perl\s+-pi|apply_patch)\b)/i;
// Text that builds a value at run time rather than spelling it: a parenthesised
// (sub)expression, a `$` variable or `$(…)`/`${…}`, Join-Path, and the -f / -join
// string operators. Deliberately broad — the point is to refuse the SHAPE of a
// computed destination, not to recognise particular constructions.
const COMPUTED_TEXT_RE = /\(|\$[A-Za-z_{(]|\bjoin-path\b|\s-f\s|\s-join\b/i;

// The first MUTATING segment of `command` whose text is computed, or "" when
// none is. Segments are the same pipeline/chain units the merge and push gates
// use, so a variable in a harmless later stage does not condemn an earlier
// redirect. Codex round 9 (HIGH): `Set-Content (".claude/hooks/codex-bot-review-"
// + "lib.mjs")` and `Copy-Item evil.mjs (Join-Path ".claude/hooks"
// "codex-bot-review-lib.mjs")` both returned blocked:false, because no literal
// token in either spells the protected file.
export function mutatingSegmentWithComputedText(command) {
  const segments = String(command || "").split(/(?:&&|\|\|?|;|\r?\n)/).map((s) => s.trim()).filter(Boolean);
  for (const segment of segments) {
    if (SHELL_MUTATION_RE.test(segment) && COMPUTED_TEXT_RE.test(segment)) return segment;
  }
  return "";
}

// scripts/apply-migration-file.mjs mutates the LIVE database. It was added
// 2026-08-24 as a gated door for migrations too large to transmit through
// apply_migration, and Codex's review of that PR caught that the new spelling
// reached production while every OTHER migration path was blocked here (P1).
// Blocked outright rather than only on `--confirm`: matching a flag invites
// quoting games, and Codex has no need for even the dry run.
// Matched across quote-stripped and backslash-dropped views so `apply"-"migration-file`
// and `apply\-migration-file` — which the shell runs identically — cannot slip past.
const LIVE_APPLY_SCRIPT_RE = /apply-migration-file(?:\.mjs)?\b/i;
function liveApplyScriptMentioned(command) {
  const base = String(command || "").replace(/[\\`]\r?\n/g, "");
  const views = [
    base,
    base.replace(/["']/g, ""),
    base.replace(/\\(.)/g, "$1"),
    base.replace(/["']/g, "").replace(/\\(.)/g, "$1"),
  ];
  return views.some((v) => LIVE_APPLY_SCRIPT_RE.test(v));
}

// The literal matcher above loses to a computed argument: `S=scripts/apply-migration-file.mjs; node $S`
// never spells the name (CodeRabbit, PR #460 round 2 — the same class documented in
// review-proof-guard, where a target hidden entirely from the command text defeats
// any string matcher). A denylist cannot be completed by enumeration, so this
// inverts: when a Node-family interpreter is invoked and ANY part of the command
// is shell-expanded, the script it will run is statically unresolvable and the
// command is refused. Codex has no need to launch an interpreter through an
// expansion — `node -e`/`node -`/`| node` are already denied above — so the cost
// is a clear error telling the operator to spell the path literally.
// HONEST RESIDUAL: an interpreter that writes-then-runs a file, or any indirection
// where no interpreter appears in the command text, is still outside what a
// command-text guard can catch. The durable boundary stays the apply gate itself
// plus Mason's in-chat approval, not this string match.
const NODE_INTERPRETER_RE = /(?:^|[\s"'`\\/;&|(])(?:node|npx|tsx|ts-node|bun|deno)(?:\.exe)?["']?(?:\s|$)/i;
const SHELL_EXPANSION_RE = /\$\{[^}]*\}|\$\(|`|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|\$env:/i;
function interpreterArgumentIsUnresolvable(command) {
  const text = String(command || "");
  if (!NODE_INTERPRETER_RE.test(text)) return false;
  return SHELL_EXPANSION_RE.test(text);
}

function usesDynamicProcessEval(command) {
  const text = String(command || "");
  return /(?:^|[\s"'\\/])node(?:\.exe)?["']?\s+(?:(?:--[a-z-]+(?:=[^\s]+)?|-{1,2}[a-z-]+)\s+)*(?:-e|--eval|-p|--print)(?:\s|=|$)/i.test(text) ||
    /(?:^|[|;&]\s*)node(?:\.exe)?["']?\s*(?:-|$)/i.test(text) ||
    /\|\s*(?:"[^"]*[\\/]node(?:\.exe)?"|'[^']*[\\/]node(?:\.exe)?'|(?:\S*[\\/])?node(?:\.exe)?)\s*(?:-|$)/i.test(text);
}

function denied(reason) {
  return { blocked: true, reason };
}

export function isClearlyReadOnlySql(sql) {
  // Comment stripping MUST be quote-aware (Codex round-4): naive comment
  // removal first lets `SELECT '--'; DELETE …` hide the mutation inside what
  // looks like a comment. stripCommentsQuoteAware (shared, 5 adversarial
  // rounds on the migration guard) removes comments while leaving '…', "…",
  // and $tag$…$tag$ contents intact; string literals are then blanked.
  const withoutComments = stripCommentsQuoteAware(String(sql || ""));
  const value = normalize(
    withoutComments
      .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''")
      .replace(/'(?:''|[^'])*'/g, "''")
  );
  const statement = value.replace(/;+\s*$/, "");
  if (statement.includes(";")) return false;
  if (!/^(?:select|with|explain|show)\b/i.test(value)) return false;
  // `into` covers PostgreSQL's `SELECT ... INTO new_table`, which CREATES and
  // populates a table from inside a statement that begins with SELECT — the
  // one write form the leading-keyword check alone cannot see (Codex P1,
  // 2026-08-14). String literals are blanked before this test, and bare
  // `into` is a reserved word, so it cannot appear in read-only SELECTs.
  if (/\b(?:insert|update|delete|merge|truncate|alter|drop|create|grant|revoke|comment|vacuum|reindex|cluster|refresh|call|copy|set|reset|notify|listen|unlisten|lock|discard|execute|perform|into)\b/i.test(value)) {
    return false;
  }

  // SELECT can invoke mutating SECURITY DEFINER RPCs. Allow only a narrow set
  // of known read-only PostgreSQL built-ins; every application/custom function
  // call fails closed and must use a purpose-built read-only connector/tool.
  const readOnlyFunctions = new Set([
    "abs", "age", "array_agg", "array_length", "avg", "cardinality", "ceil", "ceiling",
    "char_length", "coalesce", "col_description", "concat", "concat_ws", "count",
    "current_setting", "date_part", "date_trunc", "extract", "floor", "format", "greatest",
    "json_agg", "json_array_length", "json_build_object", "json_object_agg", "json_typeof",
    "jsonb_agg", "jsonb_array_length", "jsonb_build_object", "jsonb_object_agg", "jsonb_typeof",
    "least", "length", "lower", "ltrim", "max", "min", "now", "nullif", "obj_description",
    "pg_get_constraintdef", "pg_get_expr", "pg_get_functiondef", "pg_get_indexdef", "pg_get_viewdef",
    "pg_typeof", "quote_ident", "quote_literal", "regexp_match", "regexp_matches", "regexp_replace",
    "round", "rtrim", "split_part", "sqrt", "string_agg", "substring", "sum", "to_char", "to_date",
    "to_json", "to_jsonb", "to_regclass", "to_regprocedure", "trim", "upper", "version",
  ]);
  const structuralWords = new Set([
    "and", "as", "by", "case", "else", "exists", "filter", "from", "group",
    "having", "in", "join", "not", "on", "or", "order", "over", "select",
    "then", "values", "when", "where",
  ]);
  if (/"(?:[^"]|"")+"\s*\(/.test(value)) return false;
  const functionRe = /\b(?:([a-z_][\w$]*)\.)?([a-z_][\w$]*)\s*\(/gi;
  let match;
  while ((match = functionRe.exec(value)) !== null) {
    const schema = String(match[1] || "").toLowerCase();
    const name = String(match[2] || "").toLowerCase();
    if (structuralWords.has(name)) continue;
    if (schema === "auth" && name === "uid") continue;
    if (!readOnlyFunctions.has(name)) return false;
  }
  return true;
}

function defaultRunGit(args, cwd) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function defaultRunGh(args, cwd) {
  const candidates = process.platform === "win32"
    ? ["gh", "C:\\Program Files\\GitHub CLI\\gh.exe"]
    : ["gh"];
  let lastError;
  for (const executable of candidates) {
    try {
      return execFileSync(executable, args, {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("GitHub CLI is unavailable");
}

function proofRequirement(headSha, riskDescription, detail, baseSha) {
  // State the EXACT expected base. On a PR merge that base is GitHub's baseRefOid,
  // not local origin/main, so generic "<origin/main at review time>" guidance would
  // send the operator round a fetch-then-review loop, producing a proof this gate
  // rejects without ever saying which base it wanted.
  const expectedBase = baseSha || "<origin/main at review time>";
  // write-codex-push-proof.mjs derives base_sha from LOCAL origin/main and never
  // fetches. If that ref is stale, the wrapper mints a proof naming the old base
  // while this gate expects `expectedBase` — so following the guidance would loop
  // forever, rejected every time. Require the fetch first (Codex P2, 2026-07-25).
  const fetchFirst = baseSha
    ? `FIRST run \`git fetch origin main\` so local origin/main equals ${baseSha} — ` +
      `the review wrapper reads its base from that ref and will otherwise mint a proof bound to a stale base. Then `
    : "";
  return denied(
    `CODEX PRODUCTION GATE: ${riskDescription}\n\n` +
    `${detail}\n\n` +
    `${fetchFirst}run the exact-SHA adversarial gate with ` +
    `node scripts/write-codex-push-proof.mjs. It invokes gpt-5.6-sol at high reasoning in a read-only, ephemeral session. ` +
    `Only an unambiguous terminal CODEX_PROOF_VERDICT: CLEAN writes .claude/session-state/codex-review-<SHA>.json. ` +
    `Required JSON: ` +
    `{\"codex_ran\":true,\"verdict\":\"clean\",\"model\":\"gpt-5.6-sol\",\"reasoning_effort\":\"high\",` +
    `\"head_sha\":\"${headSha || "<exact pushed SHA>"}\",\"base_sha\":\"${expectedBase}\",` +
    `\"timestamp\":\"<ISO-8601, 0-30 minutes old>\"}. ` +
    `The proof is bound to both the exact pushed SHA and that exact base; future-dated, stale, base-moved, malformed, or BOM-corrupted proof is refused.`
  );
}

function gateMainChange({ repoDir, sourceRef, sourceSha, nowMs, runGit, authoritativeBaseSha }) {
  let headSha = sourceSha || "";
  let baseSha = "";
  try {
    // Resolve the exact base this change is gated against so the Sol proof can
    // be required to match the SAME base it was reviewed on; a moved base (e.g. a
    // sibling merge) forces a fresh review.
    //
    // For a PR merge the caller supplies GitHub's CURRENT baseRefOid. Local
    // origin/main is NOT authoritative there: on a stale checkout it can be behind
    // GitHub's real main, which would gate a risky merge on a proof — and on a
    // risk diff — computed against a base the change will never land on. Claude's
    // pr-merge-guard.mjs binds to baseRefOid for exactly this reason (Codex P1,
    // 2026-07-25; docs/research/2026-07-25-opus5-harness-review.md §1.1a).
    baseSha = authoritativeBaseSha
      ? String(authoritativeBaseSha).trim()
      : runGit(["rev-parse", "--verify", "--quiet", "origin/main"], repoDir);
    if (!baseSha) throw new Error("empty base SHA");
    if (authoritativeBaseSha) {
      // `rev-parse --verify <value>^{commit}` also resolves REF NAMES, so an
      // abbreviated or symbolic value from a changed `gh` output shape would
      // silently resolve to something local instead of failing closed — quietly
      // defeating the point of binding to GitHub's base. Require a full commit id.
      if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
        return denied(
          `CODEX PRODUCTION GATE: GitHub reported an unusable base commit ` +
          `(${baseSha.slice(0, 20)}); the merge cannot be bound to a real base commit ` +
          `and is denied (fail closed).`
        );
      }
      // The object must exist locally or every diff below is meaningless. Fail
      // closed with actionable guidance rather than an opaque git error.
      try {
        baseSha = runGit(["rev-parse", "--verify", `${baseSha}^{commit}`], repoDir);
      } catch {
        return denied(
          `CODEX PRODUCTION GATE: GitHub's current base commit ${String(authoritativeBaseSha).slice(0, 12)} ` +
          `is not present in this checkout, so the main-bound diff cannot be inspected against the base the ` +
          `merge will actually land on (fail closed). Run \`git fetch origin main\` and retry.`
        );
      }
    }
    if (!headSha) {
      const ref = sourceRef === "HEAD" ? "HEAD" : sourceRef;
      headSha = runGit(["rev-parse", "--verify", `${ref}^{commit}`], repoDir);
    } else {
      headSha = runGit(["rev-parse", "--verify", `${headSha}^{commit}`], repoDir);
    }
  } catch (error) {
    return denied(
      `CODEX PRODUCTION GATE: could not resolve the base branch or the exact ref being sent to main, so the operation is denied (fail closed). ${error?.message || error}`
    );
  }

  let changedFiles;
  try {
    // Diff against the resolved baseSha, never the literal `origin/main` ref:
    // on a PR merge that ref may be stale, which would misclassify a risky diff
    // as ordinary and skip the proof requirement entirely.
    //
    // NOTE the three-dot semantics: `A...B` is merge-base(A,B)..B, so this only
    // genuinely diffs "against baseSha" when baseSha is an ancestor of headSha.
    // The risky path enforces that ancestry below; without it a head that is
    // BEHIND the real base produces the identical diff either way, and changes
    // living only on the base stay invisible (Codex P1 #2, 2026-07-25).
    changedFiles = runGit(["diff", "--name-only", `${baseSha}...${headSha}`], repoDir)
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
  } catch (error) {
    return denied(
      `CODEX PRODUCTION GATE: could not inspect ${baseSha}...${headSha}, so the operation is denied (fail closed). ${error?.message || error}`
    );
  }

  const risky = riskyFiles(changedFiles);
  let contentFlagged = false;
  if (risky.length === 0) {
    try {
      contentFlagged = contentIsRisky(runGit(["diff", `${baseSha}...${headSha}`], repoDir));
    } catch (error) {
      return denied(
        `CODEX PRODUCTION GATE: could not inspect the full diff for money/security risk, so the operation is denied (fail closed). ${error?.message || error}`
      );
    }
  }

  if (risky.length === 0 && !contentFlagged) return { blocked: false };

  // The change is risky, so a Sol proof is about to be demanded. That proof is
  // only meaningful if the reviewed diff actually covers what will land on main.
  // When the head does not contain GitHub's current base, the merge result also
  // includes base-only commits that no review in this flow ever saw — and
  // `write-codex-push-proof.mjs` hands Sol the same merge-base
  // patch. Branch protection does not require up-to-date heads, so enforce it
  // here for risky merges rather than assuming it.
  if (authoritativeBaseSha) {
    let headContainsBase = false;
    try {
      runGit(["merge-base", "--is-ancestor", baseSha, headSha], repoDir);
      headContainsBase = true;
    } catch {
      headContainsBase = false;
    }
    if (!headContainsBase) {
      return denied(
        `CODEX PRODUCTION GATE: this pull request is risky and its head ${headSha.slice(0, 12)} does not ` +
        `contain the base it will merge onto (${baseSha.slice(0, 12)}), so the reviewed diff cannot cover ` +
        `everything the merge lands (fail closed). Update the branch first — merge origin/main into it (or ` +
        `rebase onto it) and push — then re-run the review so the proof covers the real merge result.`
      );
    }
  }

  const riskDescription = risky.length > 0
    ? `the main-bound diff changes ${risky.length} risky file(s): ${risky.slice(0, 6).join(", ")}${risky.length > 6 ? ", ..." : ""}`
    : "the main-bound diff contains money or financial-audit identifiers even though its paths look ordinary";
  const proofPath = path.join(repoDir, ".claude", "session-state", `codex-review-${headSha}.json`);
  if (!existsSync(proofPath)) {
    return proofRequirement(headSha, riskDescription, `Missing required Sol high-effort proof: ${proofPath}`, baseSha);
  }

  let proof;
  try {
    proof = JSON.parse(readFileSync(proofPath, "utf8"));
  } catch (error) {
    return proofRequirement(headSha, riskDescription, `Sol proof could not be parsed: ${error?.message || error}`, baseSha);
  }
  if (!proofValid(proof, headSha, nowMs, baseSha)) {
    return proofRequirement(
      headSha,
      riskDescription,
      `Sol proof is stale, future-dated, bound to a different HEAD or to a base other than ${baseSha}, lacks the required gpt-5.6-sol/high identity, has the wrong verdict/ran key, or is otherwise invalid.`,
      baseSha
    );
  }

  return { blocked: false };
}

function gateMaintenanceProducerExecution({ command, repoDir, nowMs, runGit }) {
  if (!maintenanceProducerCommandMentioned(command)) return { blocked: false };

  let headSha;
  let baseSha;
  let headBlob;
  let worktreeBlob;
  let status;
  try {
    headSha = runGit(["rev-parse", "HEAD"], repoDir);
    baseSha = runGit(["rev-parse", "origin/main"], repoDir);
    status = runGit(["status", "--porcelain", "--untracked-files=all", "--", MAINTENANCE_PRODUCER], repoDir);
    headBlob = runGit(["rev-parse", `HEAD:${MAINTENANCE_PRODUCER}`], repoDir);
    worktreeBlob = runGit(["hash-object", `--path=${MAINTENANCE_PRODUCER}`, MAINTENANCE_PRODUCER], repoDir);
  } catch (error) {
    return denied(`CODEX PRODUCTION GATE: cannot bind the maintenance producer to the current committed HEAD: ${error?.message || error}`);
  }
  if (status || headBlob !== worktreeBlob) {
    return denied("CODEX PRODUCTION GATE: the maintenance producer differs from its exact committed HEAD blob. Commit it, obtain a fresh exact-head review, and retry.");
  }

  const proofPath = path.join(repoDir, ".claude", "session-state", `codex-review-${headSha}.json`);
  let proof;
  try {
    proof = JSON.parse(readFileSync(proofPath, "utf8"));
  } catch (error) {
    return proofRequirement(headSha, "execution of the protected maintenance producer", `Missing or unreadable exact-head proof: ${proofPath}`, baseSha);
  }
  if (!proofValid(proof, headSha, nowMs, baseSha)) {
    return proofRequirement(headSha, "execution of the protected maintenance producer", "The exact-head Sol-high proof is stale or does not match the current HEAD/base.", baseSha);
  }
  return { blocked: false };
}

function shellWords(value) {
  return String(value || "").match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) => {
    if ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))) {
      return word.slice(1, -1);
    }
    return word;
  }) || [];
}

function ghMergeRequest(command) {
  // Global flags may sit between `gh`, `pr`, and `merge` (`gh -R o/r pr merge`,
  // `gh pr -R o/r merge` — Codex round-4). Require the gh binary, then scan the
  // segment's words for `pr` followed later by `merge`; parse flags across the
  // whole segment. Over-matching (e.g. `gh pr view merge-notes`) only routes a
  // read through the gate, which fails safe.
  const text = String(command || "");
  if (!/(?:^|\s)(?:"[^"]*[\\/]gh\.exe"|\S*[\\/]gh(?:\.exe)?|gh(?:\.exe)?)(?:\s|$)/i.test(text)) return null;
  const words = shellWords(text);
  const prIndex = words.findIndex((word) => word.toLowerCase() === "pr");
  if (prIndex === -1) return null;
  const mergeIndex = words.findIndex((word, index) => index > prIndex && word.toLowerCase() === "merge");
  if (mergeIndex === -1) return null;
  // Lowercase: membership is tested against the normalized flag name below.
  const valueFlags = new Set(["--repo", "-r", "--match-head-commit", "--subject", "--body"]);
  let selector = "";
  let repo = "";
  let admin = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    // Flag NAMES are matched with quotes and backslashes removed: the shell
    // concatenates `--ad""min` and `--ad\min` into `--admin` before gh sees
    // them, so comparing the raw word misses a flag gh honours (Codex bot P1 on
    // PR #541). Values keep their original case; only the name is lowercased.
    const stripped = word.replace(/["'\\]/g, "");
    const lower = stripped.toLowerCase();
    if (lower.startsWith("--repo=")) {
      repo = stripped.slice("--repo=".length);
      continue;
    }
    // `--admin` merges with administrator privileges, skipping main's required
    // review. Mason turned "Include administrators" OFF on 2026-09-01 so HE can
    // clear a stuck review by hand; that bypass travels with the same admin
    // token Codex runs on, so the gate refuses the flag. Only an explicit
    // ParseBool FALSE stands down — an unparseable value is treated as a bypass
    // request and denied, which costs nothing because gh rejects it too.
    if (lower === "--admin") {
      admin = true;
      continue;
    }
    if (lower.startsWith("--admin=")) {
      const value = lower.slice("--admin=".length);
      admin = !(value === "0" || value === "f" || value === "false");
      continue;
    }
    if (valueFlags.has(lower)) {
      const value = words[index + 1] || "";
      if (lower === "--repo" || lower === "-r") repo = value;
      index += 1;
      continue;
    }
    if (index > mergeIndex && !stripped.startsWith("-") && !selector) selector = stripped;
  }
  return { selector, repo, admin };
}

function ghApiMergeRequest(command) {
  const text = String(command || "");
  if (!/(?:^|\s)(?:"[^"]*[\\/]gh\.exe"|\S*[\\/]gh(?:\.exe)?|gh(?:\.exe)?)\s+api\b/i.test(text)) {
    return null;
  }
  if (/\sapi\s+graphql\b/i.test(text) && /\bmergePullRequest\b/i.test(text)) {
    return { unsupportedGraphql: true };
  }
  const words = shellWords(command);
  let method = "GET";
  let endpoint = "";
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-X" || word === "--method") {
      method = String(words[index + 1] || "").toUpperCase();
      index += 1;
      continue;
    }
    if (word.startsWith("--method=")) {
      method = word.slice("--method=".length).toUpperCase();
      continue;
    }
    if (/^-X\S+/i.test(word)) {
      method = word.slice(2).toUpperCase();
      continue;
    }
    const normalizedEndpoint = word
      .replace(/^https:\/\/api\.github\.com\//i, "")
      .replace(/^\//, "");
    if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/i.test(normalizedEndpoint)) {
      endpoint = normalizedEndpoint;
    }
  }
  if (method !== "PUT" || !endpoint) return null;
  const match = endpoint.match(/^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/i);
  return match ? { selector: match[3], repo: `${match[1]}/${match[2]}` } : null;
}

function ghApiMutates(command) {
  const text = String(command || "");
  if (!/(?:^|\s)(?:"[^"]*[\\/]gh\.exe"|\S*[\\/]gh(?:\.exe)?|gh(?:\.exe)?)\s+api\b/i.test(text)) {
    return false;
  }
  if (/\sapi\s+graphql\b/i.test(text) && /\bmutation\b/i.test(text)) return true;
  const words = shellWords(text);
  let method = "GET";
  let methodExplicit = false;
  let hasFields = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-X" || word === "--method") {
      method = String(words[index + 1] || "").toUpperCase();
      methodExplicit = true;
      index += 1;
    } else if (word.startsWith("--method=")) {
      method = word.slice("--method=".length).toUpperCase();
      methodExplicit = true;
    } else if (/^-X\S+/i.test(word)) {
      method = word.slice(2).toUpperCase();
      methodExplicit = true;
    } else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(word) ||
               /^(?:--field|--raw-field|--input)=/.test(word) ||
               /^-[fF]\S/.test(word)) {
      // The /^-[fF]\S/ arm catches gh's attached short-value form
      // (`-fquery=...`, `-Fbase=main`) — Codex round-5.
      hasFields = true;
    }
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) return true;
  return !methodExplicit && hasFields; // gh defaults field-bearing API calls to POST
}

function githubToolIsReadOnly(toolName) {
  // App-style names keep a `github_` prefix on the leaf
  // (mcp__codex_apps__github_get_file) — strip it before classifying
  // (Codex round-5).
  const leaf = (String(toolName || "").split("__").pop() || "").replace(/^github_/i, "");
  return /^(?:get|list|search|read|resolve|download|check)_/i.test(leaf) ||
    /_(?:read|get|list|search)$/i.test(leaf);
}

function mcpMergeRequest(toolInput) {
  // Key spellings differ per connector: the GitHub MCP uses pull_number/owner/repo,
  // the Codex GitHub app uses pr_number/repository_full_name (Codex review 2026-07-13).
  const selector = toolInput.pull_number ?? toolInput.pullNumber ?? toolInput.pullRequestNumber ??
    toolInput.pr_number ?? toolInput.prNumber ?? toolInput.number ?? "";
  const owner = toolInput.owner ?? toolInput.organization ?? "";
  const repository = toolInput.repo ?? toolInput.repository ?? toolInput.repoName ??
    toolInput.repository_full_name ?? toolInput.repositoryFullName ?? toolInput.full_name ?? "";
  const repo = String(repository).includes("/") ? String(repository) : (owner && repository ? `${owner}/${repository}` : "");
  return { selector: String(selector), repo };
}

function resolvePullRequest({ request, repoDir, runGh }) {
  const args = ["pr", "view"];
  if (request.selector) args.push(request.selector);
  // baseRefOid is GitHub's CURRENT tip of the base branch — the commit the merge
  // will actually land on. Without it the gate falls back to local origin/main,
  // which can be stale (Codex P1, 2026-07-25).
  args.push("--json", "baseRefName,baseRefOid,headRefName,headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup,autoMergeRequest");
  if (request.repo) args.push("--repo", request.repo);
  const data = JSON.parse(runGh(args, repoDir));
  // baseRefOid is required only for main-bound merges; gatePullRequestMerge
  // enforces it after the base check so a PR onto another branch is not
  // needlessly failed closed.
  if (!data?.baseRefName || !data?.headRefOid) throw new Error("GitHub did not return baseRefName and headRefOid");
  return data;
}

// GitHub's own review verdict, from `gh pr view --json reviewDecision`. Until
// 2026-09-01 nothing could merge into main without an approval, so a CLEAN
// mergeStateStatus stood in for "somebody approved this". Mason's manual
// override — branch protection's "Include administrators" turned OFF so he can
// clear a stuck review by hand — removed that floor for anyone with admin
// rights, which is the token Codex runs on. So the approval is read directly.
//
// APPROVED is head-bound only because main's protection sets
// dismiss_stale_reviews AND require_last_push_approval (verified live
// 2026-09-01): a new commit dismisses every approval, so APPROVED cannot be
// describing an older head. If stale-review dismissal is ever turned off, this
// check must be joined by one that an APPROVED review's commit_id equals
// headRefOid. Mirrors pullRequestApproved() in .claude/hooks/codex-push-lib.mjs.
export function pullRequestApproved(pullRequest) {
  return String(pullRequest?.reviewDecision || "").toUpperCase() === "APPROVED";
}

export function pullRequestChecksGreen(pullRequest) {
  if (String(pullRequest?.mergeStateStatus || "").toUpperCase() !== "CLEAN") return false;
  const checks = pullRequest?.statusCheckRollup;
  if (!Array.isArray(checks) || checks.length === 0) return false;
  return checks.every((check) => {
    if (check?.__typename === "StatusContext") {
      return String(check.state || "").toUpperCase() === "SUCCESS";
    }
    if (check?.__typename === "CheckRun") {
      const status = String(check.status || "").toUpperCase();
      const conclusion = String(check.conclusion || "").toUpperCase();
      return status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion);
    }
    return false;
  });
}

function gatePullRequestMerge({ request, repoDir, nowMs, runGit, runGh }) {
  let pullRequest;
  try {
    pullRequest = resolvePullRequest({ request, repoDir, runGh });
  } catch (error) {
    return denied(
      `CODEX PRODUCTION GATE: could not determine the pull request's base branch and exact head SHA, so the merge is denied (fail closed). ${error?.message || error}`
    );
  }
  const base = normalize(pullRequest.baseRefName).toLowerCase();
  if (base === "master" || base === "production") {
    return denied(`CODEX PRODUCTION GATE: merges to protected branch ${base} remain blocked.`);
  }
  if (base !== "main") return { blocked: false };
  if (!pullRequest.baseRefOid) {
    return denied(
      "CODEX PRODUCTION GATE: GitHub did not report this pull request's current base commit (baseRefOid), " +
      "so the merge cannot be bound to the base it will actually land on and is denied (fail closed)."
    );
  }
  // The Codex GitHub App's review is read at the ALLOW point below, not here.
  // It is advisory, fail-open, and costs up to four gh calls against a
  // 15-SECOND hook budget (.codex/hooks.json) — four capped-at-10s calls can
  // outlive the hook on their own. A PreToolUse hook killed mid-call emits
  // nothing, and emitting nothing does NOT deny, so running it here would let a
  // slow GitHub starve every hard denial below it: CHANGES_REQUESTED, the green
  // pipeline, the risky-diff classification and the exact-SHA proof. Codex round
  // 6 found this; PR #502 established the class. See codexAppAdvisory().

  // Main's PR #560 migrated this gate from "no approval" to "an active
  // objection", matching the Claude side. Taking main's predicate: the denial
  // text below already describes CHANGES_REQUESTED, so keeping !approved here
  // would guard a message that does not match its condition.
  if (pullRequestReviewBlocked(pullRequest)) {
    return denied(
      "CODEX PRODUCTION GATE: GitHub reports reviewDecision=CHANGES_REQUESTED — a reviewer has open " +
      "objections on this pull request. Mason removed main's required-approval rule on 2026-09-02, which " +
      "did not authorize merging over a review that asked for changes. Fix every real finding and push it; " +
      "a genuine nitpick may be dismissed with a one-line reason in the thread. Merge only after that."
    );
  }
  if (!pullRequestChecksGreen(pullRequest)) {
    return denied(
      "CODEX PRODUCTION GATE: this pull request is not merge-ready with a fully green GitHub pipeline. Wait until mergeStateStatus is CLEAN and every reported check is completed successfully, neutral, or skipped."
    );
  }
  const mainVerdict = gateMainChange({
    repoDir,
    sourceSha: pullRequest.headRefOid,
    // Bind the proof AND the risk diff to GitHub's real base, not local origin/main.
    authoritativeBaseSha: pullRequest.baseRefOid,
    nowMs,
    runGit,
  });
  if (mainVerdict.blocked) return mainVerdict;

  // ALLOW point for THIS merge. Every hard denial above — objection, green
  // pipeline, risky-diff classification and the exact-SHA proof — has had its
  // chance. The advisory lookup is NOT run here (Codex round 8, SEC-001): a
  // command can carry several merges, and an advisory for the first one that
  // ran before the second one's hard checks could exhaust the hook budget
  // before those checks did — a killed hook denies nothing, so the second
  // merge would proceed with failed CI, an objection, or no proof. The caller
  // collects this request and runs every advisory only after EVERY merge in
  // the command has cleared its hard gates, under one shared deadline.
  return { blocked: false, advisoryRequest: request };
}

// The Codex GitHub App's own review — mirror of pr-merge-guard.mjs.
//
// Wiring it on only one side would mean a merge driven from Codex skips a gate a
// merge driven from Claude gets, which is exactly the asymmetry AGENTS.md forbids
// leaving undeclared.
//
// Returns a denial verdict, or null when nothing blocks. Fails OPEN on any
// error: see the header of codex-bot-review-lib.mjs for why this one predicate
// does not fail closed like its neighbours here. The 5s budget is deliberately a
// third of the hook's 15s so the notices below can still be written.
const CODEX_ADVISORY_BUDGET_MS = 5_000;

// `deadlineMs` is SHARED across every merge in one command (Codex round 8,
// SEC-001): the caller computes it once and passes the same value to each
// deferred lookup, so N chained merges spend one budget between them rather
// than N budgets in series.
function codexAppAdvisory({ request, repoDir, runGh, deadlineMs = Date.now() + CODEX_ADVISORY_BUDGET_MS }) {
  let codexVerdict = null;
  try {
    const metaArgs = ["pr", "view"];
    if (request.selector) metaArgs.push(String(request.selector));
    metaArgs.push("--json", "number,url");
    if (request.repo) metaArgs.push("--repo", request.repo);
    const meta = JSON.parse(runGh(metaArgs, repoDir));
    const slug = String(meta?.url || "").match(/[/]([^/]+)[/]([^/]+)[/]pull[/]/);
    if (slug && Number.isInteger(meta?.number)) {
      const node = collectCodexThreads((cursor) => {
        const args = [
          "api", "graphql",
          "-f", `query=${CODEX_THREADS_QUERY}`,
          "-F", `owner=${slug[1]}`,
          "-F", `name=${slug[2]}`,
          "-F", `number=${meta.number}`,
          "-F", `first=${CODEX_THREAD_PAGE_SIZE}`,
        ];
        // Omit `after` on the first page — see the Claude-side note.
        if (cursor) args.push("-F", `after=${cursor}`);
        return JSON.parse(runGh(args, repoDir))?.data?.repository?.pullRequest;
      }, { deadlineMs });
      if (node.headRefOid) codexVerdict = evaluateCodexBotReview(node);
    }
  } catch {
    codexVerdict = null; // never a deny
  }
  if (codexVerdict?.status === "findings-at-head") {
    return denied(codexBotFindingsDenial("CODEX PRODUCTION GATE", request.selector, codexVerdict.unresolvedAtHead));
  }
  // Say what happened on every non-blocking path. Failing open SILENTLY is
  // indistinguishable from "the reviewer had nothing to say" (CRX-REV-003 on
  // this PR's own Codex review) — the Claude guard already prints these, and a
  // one-sided silence is exactly the drift AGENTS.md forbids.
  if (!codexVerdict) {
    process.stderr.write(
      "CODEX REVIEW NOTICE: could not read the Codex GitHub App's review threads for this PR, so its " +
      "findings were NOT checked. Merging anyway (this gate fails open by design). Read them by hand: " +
      `gh pr view ${request.selector || "<number>"} --comments\n`,
    );
  } else if (codexVerdict.status === "stale") {
    process.stderr.write(
      `CODEX REVIEW NOTICE: the Codex GitHub App has ${codexVerdict.codexThreads} comment thread(s) on this ` +
      "PR, none of them unresolved against the exact commit being merged. Nothing blocks, but if you have " +
      "not read them, do: " +
      `gh pr view ${request.selector || "<number>"} --comments\n`,
    );
  } else if (codexVerdict.status === "none") {
    process.stderr.write(
      "CODEX REVIEW NOTICE: the Codex GitHub App has left no review comments on this PR. If it never ran, " +
      "comment `@codex review` and read the result before merging anything non-trivial.\n",
    );
  }
  return null;
}

export function evaluateProductionAction({
  toolName = "",
  toolInput = {},
  branch = "",
  repoDir = process.cwd(),
  nowMs = Date.now(),
  runGit = defaultRunGit,
  runGh = defaultRunGh,
} = {}) {
  const name = String(toolName);
  const baseRepoDir = path.resolve(repoDir);
  const requestedWorkingDir = toolInput.workdir ?? toolInput.cwd ?? "";
  const actionRepoDir = requestedWorkingDir
    ? path.resolve(baseRepoDir, String(requestedWorkingDir))
    : baseRepoDir;

  const pathCandidates = [
    toolInput.file_path,
    toolInput.filePath,
    toolInput.path,
    toolInput.target,
    toolInput.source,
    toolInput.destination,
  ];
  // Classify patch payloads by their DESTINATION headers, not the whole body —
  // documentation patches legitimately mention guard/proof paths in prose
  // (Codex round-5 false positive).
  const patchDestinations = [toolInput.patch, toolInput.diff, toolInput.input, toolInput.changes]
    .flatMap((payloadText) => extractPatchDestinations(payloadText));
  if ([...pathCandidates, ...patchDestinations].some((candidate) => reviewProofPathMentioned(candidate))) {
    return denied("CODEX PRODUCTION GATE: review proof files are wrapper-owned and cannot be written, edited, moved, or deleted directly.");
  }
  const mutatingFileTool = /(?:write|edit|delete|move|rename|patch|replace|create|update)/i.test(name);
  if (mutatingFileTool && (
    [...pathCandidates, ...patchDestinations].some((candidate) => protectedHarnessPathMentioned(candidate))
  )) {
    return denied("CODEX PRODUCTION GATE: the production/review harness is a security boundary and cannot be changed through a direct file-write tool. Use the reviewed maintenance workflow with Mason's approval.");
  }

  if (NODE_REPL_TOOL.test(name)) {
    return denied("CODEX PRODUCTION GATE: node_repl is disabled in this repository because it can launch uninspected git/GitHub write processes outside the production guard.");
  }

  if (LIVE_TOOL_ACTIONS.test(name)) {
    return denied("Live migrations, edge-function deployments, and Supabase branch/project lifecycle mutations remain outside Codex's standing authorization.");
  }

  const supabaseTool = SUPABASE_TOOL_RE.exec(name);
  if (supabaseTool) {
    const leaf = supabaseTool[1].toLowerCase();
    if (leaf !== "execute_sql" && !SUPABASE_READ_ONLY_TOOLS.has(leaf)) {
      return denied(
        `CODEX PRODUCTION GATE: Supabase tool "${leaf}" is not on the exact read-only allowlist and is denied (fail closed). ` +
        "With the connector write-enabled, every mutating or unrecognized Supabase tool is blocked so production schema and data " +
        "changes can only travel the reviewed migration path."
      );
    }
  }

  if (/execute_sql$/i.test(name)) {
    const sql = toolInput.query ?? toolInput.sql ?? "";
    if (!isClearlyReadOnlySql(sql)) {
      return denied("Codex only permits clearly read-only SQL. Live data and schema changes remain blocked.");
    }
  }

  if (GITHUB_MERGE_TOOL.test(name)) {
    const request = mcpMergeRequest(toolInput);
    if (!request.selector) {
      return denied(
        "CODEX PRODUCTION GATE: could not determine WHICH pull request this merge tool targets from its inputs, so the merge is denied (fail closed) — the guard must never verify one PR while the tool merges another."
      );
    }
    const result = gatePullRequestMerge({
      request,
      repoDir: actionRepoDir,
      nowMs,
      runGit,
      runGh,
    });
    if (result.blocked) return result;
    // The connector merges exactly ONE pull request per call, so there is no
    // later segment for the advisory to starve: this IS the command's allow
    // point, and the deferred lookup runs here. Codex round 9 found this path
    // returning the deferred request untouched after round 8 moved the lookup
    // out of the per-merge gate — a merge driven through the connector skipped
    // the check a shell merge got, the asymmetry AGENTS.md forbids.
    if (result.advisoryRequest) {
      const advisory = codexAppAdvisory({ request: result.advisoryRequest, repoDir: actionRepoDir, runGh });
      if (advisory) return advisory;
    }
    return { blocked: false };
  }

  if (GITHUB_TOOL.test(name) && !githubToolIsReadOnly(name)) {
    return denied("CODEX PRODUCTION GATE: direct GitHub write tools are blocked because they bypass the reviewed git push and Husky pipeline. Use a normal feature-branch commit/push workflow.");
  }

  const command = String(toolInput.command ?? toolInput.cmd ?? "").trim();
  if (!command) return { blocked: false };

  if (reviewProofPathMentioned(command)) {
    return denied("CODEX PRODUCTION GATE: direct shell access to review proof files is blocked. Run the real review wrapper instead.");
  }
  const changesDirectory = /(?:^|[;&|\r\n()]|\s)(?:cd(?:\s+\/d)?|chdir|pushd|set-location)\s+/i.test(command);
  if ((changesDirectory && reviewStateDirectoryMentioned(command)) || reviewStateDirectoryMentioned(actionRepoDir)) {
    return denied("CODEX PRODUCTION GATE: the wrapper-owned review state directory cannot be used as an interactive shell working directory.");
  }
  if (liveApplyScriptMentioned(command)) {
    return denied(
      "CODEX PRODUCTION GATE: scripts/apply-migration-file.mjs applies a migration to the LIVE database and is " +
      "blocked, exactly like the MCP apply_migration and Supabase CLI migration paths. Its internal gate checks " +
      "review evidence but cannot verify Mason's required in-chat approval, so it is not an alternative spelling " +
      "for the reviewed migration path. Live migrations remain outside Codex's standing authorization.");
  }
  if (interpreterArgumentIsUnresolvable(command)) {
    return denied(
      "CODEX PRODUCTION GATE: a Node-family interpreter invoked with a shell-expanded argument is blocked — the " +
      "script it would run cannot be resolved from the command text, so a live-apply path such as " +
      "scripts/apply-migration-file.mjs can hide behind `$VAR`, `${VAR}`, `$(…)` or a backtick. Spell the script " +
      "path literally so the gate can see what will run.");
  }
  if (usesDynamicProcessEval(command)) {
    return denied("CODEX PRODUCTION GATE: Node eval/print modes are blocked because generated code can hide uninspected git or GitHub writes. Put ordinary diagnostic code in a reviewed script instead.");
  }
  const maintenanceProducerGate = gateMaintenanceProducerExecution({ command, repoDir: actionRepoDir, nowMs, runGit });
  if (maintenanceProducerGate.blocked) return maintenanceProducerGate;

  if (/[\r\n]/.test(command) && PROTECTED_HARNESS_FRAGMENT_RE.test(command)) {
    return denied("CODEX PRODUCTION GATE: multiline shell commands that reference the production/review harness are blocked.");
  }
  const shellMutatesPath = SHELL_MUTATION_RE.test(command);
  if (shellMutatesPath && PROTECTED_HARNESS_FRAGMENT_RE.test(command)) {
    return denied("CODEX PRODUCTION GATE: direct shell mutation of the production/review harness is blocked. Use the reviewed maintenance workflow with Mason's approval.");
  }
  // The fragment match above compares raw text, so `.claude/hooks/../hooks/<f>`
  // reaches the same file without ever spelling the protected path (Codex HIGH,
  // PR #563 round 2). A command is not one path and cannot simply be
  // canonicalized, so a mutating command that carries a dot-segment AND names a
  // protected file is refused rather than gated.
  if (shellMutatesPath && commandTouchesProtectedHarnessPath(command)) {
    return denied(
      "CODEX PRODUCTION GATE: an argument of this mutating command resolves to a protected harness file " +
      "once `.`/`..` segments and drive-relative prefixes are canonicalized, even though it is not spelled " +
      "that way. Use the reviewed maintenance workflow with Mason's approval."
    );
  }
  // A destination the guard cannot READ cannot be gated (Codex round 9). Every
  // check above examines literal tokens; a path assembled at run time —
  // `(".claude/hooks/codex-bot-review-" + "lib.mjs")`, `(Join-Path ".claude/hooks"
  // "x.mjs")`, `$dest`, `-f` formatting — has no literal token to examine and
  // walked straight past all of them. Enumerating the ways PowerShell can build
  // a string is the losing half of that trade (rounds 2, 3, 4, 7, 8 were each
  // one more spelling), so the SHAPE is refused instead: a mutating shell
  // segment whose text carries a computed expression is denied outright, the
  // same stance this guard already takes on shell-expanded interpreter
  // arguments and on merge segments carrying a command substitution. Spell the
  // destination literally and the segment is gated normally. Scoped to the
  // MUTATING segment so `npm test 2>&1 | Where-Object { $_ -match "x" }` — a
  // redirect in one stage and a variable in another — is not caught.
  const computedSegment = mutatingSegmentWithComputedText(command);
  if (computedSegment) {
    return denied(
      "CODEX PRODUCTION GATE: this mutating shell command builds a path or argument at run time " +
      `(a parenthesised expression, a \`$\` variable, Join-Path, or the -f/-join operators) in: ${computedSegment}. ` +
      "The guard cannot read a computed destination, so it is refused rather than gated. Spell the " +
      "destination path literally and run the command again."
    );
  }
  if (isGitPush(command) && pushContextIsAmbiguous(command)) {
    return denied("CODEX PRODUCTION GATE: directory-changing or GIT_DIR/GIT_WORK_TREE-prefixed pushes cannot be bound safely to the inspected worktree. Use `git -C <repo> push`.");
  }
  const suppliedEnv = toolInput.env && typeof toolInput.env === "object" ? toolInput.env : {};
  if (isGitPush(command) && Object.keys(suppliedEnv).some((key) => /^(?:GIT_DIR|GIT_WORK_TREE)$/i.test(key))) {
    return denied("CODEX PRODUCTION GATE: pushes with GIT_DIR/GIT_WORK_TREE tool environment overrides are denied. Use `git -C <repo> push`.");
  }

  // Split on single `|` too (Codex round-4): `git push a | git push b` runs
  // BOTH pushes in a shell pipeline, so every pipeline stage is a segment.
  const commandSegments = command.split(/(?:&&|\|\|?|;|\r?\n)/).map((segment) => segment.trim()).filter(Boolean);
  // Merge requests that cleared every hard gate; their advisory lookups run
  // together at the very end, after the push segments too (Codex round 8).
  const deferredAdvisories = [];
  for (const segment of commandSegments) {
    const ghRequest = ghMergeRequest(segment) || ghApiMergeRequest(segment);
    // ── raw merge transports (Codex proof on PR #541, 2026-09-01) ───────────
    // Every gh-shaped route below requires the `gh` binary in the command text.
    // That was survivable while GitHub itself refused an unapproved merge — a
    // raw REST call simply got a 405 — but Mason's admin override removed that
    // backstop, so an agent holding his admin credential can now merge through
    // any transport. Denied by DESTINATION rather than by tool: enumerating
    // curl, wget, Invoke-RestMethod, and fetch is the losing half of that trade.
    //
    // Scanned BEFORE the gh routes dispatch, because a recognized outer
    // `gh pr merge` used to reach `continue` first and shield a raw merge hidden
    // in a command substitution (Codex bot P1 on PR #541). Counting occurrences
    // keeps the ONE endpoint a `gh api ... /merge` request legitimately names
    // from denying its own gated route.
    const endpointMentions = segment.match(/\/pulls\/[^\s/]+\/merge\b/gi) || [];
    if (endpointMentions.length > (ghApiMergeRequest(segment)?.selector ? 1 : 0)) {
      return denied(
        "CODEX PRODUCTION GATE: raw GitHub REST merge calls (curl/wget/Invoke-RestMethod/fetch against " +
        ".../pulls/<n>/merge) are denied because the guard cannot resolve and verify the PR's base, head, " +
        "and checks for them. Use `gh pr merge <number>` so the gate can verify the merge."
      );
    }
    if (/\bmergePullRequest\b/i.test(segment)) {
      return denied(
        "CODEX PRODUCTION GATE: GraphQL mergePullRequest mutations are denied — whatever transport carries " +
        "them — because the guard cannot resolve and verify the PR's base, head, and checks for them. " +
        "Use `gh pr merge <number>` so the gate can verify the merge."
      );
    }
    // A merge segment carrying a command substitution is unresolvable, so it is
    // refused rather than gated: the substitution can hold a second
    // `gh pr merge` — `gh pr merge 1 --body "$(gh pr merge 2 --admin)"` runs the
    // INNER merge first while the parser records only the outer request (Codex
    // bot P1 on PR #541). Same stance this guard already takes on interpreter
    // arguments: a shell-expanded command is not statically knowable.
    if (ghRequest && /\$\(|`|\$\{/.test(segment)) {
      return denied(
        "CODEX PRODUCTION GATE: this merge command contains a command substitution, so what it will " +
        "actually run is not statically knowable — a substitution can carry a second merge, or flags the " +
        "parser never sees. Run the merge as its own plain command, with the PR number and flags spelled out."
      );
    }
    if (ghRequest?.unsupportedGraphql) {
      return denied("CODEX PRODUCTION GATE: GraphQL mergePullRequest mutations are denied because the guard cannot safely resolve and verify their PR head/checks. Use `gh pr merge <number>` instead.");
    }
    if (ghRequest?.admin) {
      // Denied before the PR is resolved: there is no base branch and no diff
      // for which an agent asking GitHub to skip the review is the right move.
      return denied(
        "CODEX PRODUCTION GATE: `--admin` merges with administrator privileges, skipping main's required " +
        "review. That override exists for Mason to use by hand on the PR page — an agent may never use it, " +
        "whatever the diff or the deadline. Get a real approval instead, or hand the PR to Mason and say " +
        "why it is stuck."
      );
    }
    if (ghRequest) {
      const result = gatePullRequestMerge({
        request: ghRequest,
        repoDir: actionRepoDir,
        nowMs,
        runGit,
        runGh,
      });
      if (result.blocked) return result;
      // Cleared every hard gate. Its advisory lookup is DEFERRED until every
      // merge in this command has done the same (Codex round 8, SEC-001).
      if (result.advisoryRequest) deferredAdvisories.push(result.advisoryRequest);
      continue;
    }
    if (ghApiMutates(segment)) {
      return denied("CODEX PRODUCTION GATE: unrecognized mutating `gh api` calls are blocked because they can bypass the reviewed branch/push workflow.");
    }
  }

  for (const segment of commandSegments.filter((part) => isGitPush(part))) {
    if (/--git-dir|--work-tree/i.test(segment)) {
      return denied("CODEX PRODUCTION GATE: pushes using explicit --git-dir/--work-tree contexts are denied because the guard cannot safely bind them to the inspected worktree. Use `git -C <repo> push` instead.");
    }
    if (pushUsesBulkMode(segment)) {
      return denied("CODEX PRODUCTION GATE: bulk push modes (`--all`/`--branches`/`--mirror`/`--prune`) can alter multiple remote refs and are always denied. Push one explicit branch/refspec instead.");
    }
    if (pushIsForced(segment)) {
      return denied("CODEX PRODUCTION GATE: force-pushing any branch rewrites shared history and requires Mason's explicit approval.");
    }
    const pushRepoDir = gitPushCwd(segment, actionRepoDir);
    let currentBranch = requestedWorkingDir ? "" : normalize(branch).toLowerCase();
    if (!currentBranch || pushRepoDir !== actionRepoDir) {
      try {
        currentBranch = normalize(runGit(["rev-parse", "--abbrev-ref", "HEAD"], pushRepoDir)).toLowerCase();
      } catch (error) {
        return denied(`CODEX PRODUCTION GATE: could not determine the push branch, so the push is denied (fail closed). ${error?.message || error}`);
      }
    }

    if (/\bgit\b[^\r\n;&|]*\bpush\b[^\r\n;&|]*(?:\s|:)(master|production)(?:\s|$)/i.test(segment) ||
        ((currentBranch === "master" || currentBranch === "production") && /\bgit\b[^\r\n;&|]*\bpush\b/i.test(segment))) {
      return denied("CODEX PRODUCTION GATE: pushes to master/production remain blocked.");
    }

    const sourceRef = mainPushSource(segment, currentBranch);
    if (sourceRef === "DELETE") {
      return denied("CODEX PRODUCTION GATE: `git push origin :main` deletes the production branch and is always denied.");
    }
    if (sourceRef) {
      const result = gateMainChange({ repoDir: pushRepoDir, sourceRef, nowMs, runGit });
      if (result.blocked) return result;
    }
  }

  const productionDeploy =
    /\bvercel\b[^\r\n]*(?:--prod|--production)(?:\s|$)/i.test(command) ||
    /\bsupabase\s+functions\s+deploy\b/i.test(command) ||
    /\bsupabase\s+(?:db\s+push|migration\s+up)\b/i.test(command) ||
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?deploy\b/i.test(command);
  if (productionDeploy) {
    return denied("Production deployments, edge-function deploys, and live migration commands remain blocked for Codex.");
  }

  // ALLOW point for the whole command. Every merge and push segment above has
  // cleared its hard gates, so the advisory, fail-open Codex App lookups can
  // spend what is left of the hook budget here without being able to starve
  // any of them — including a LATER merge's gates, which is what running the
  // advisory inside the loop allowed (Codex round 8, SEC-001). One deadline is
  // shared by every lookup so N merges cannot multiply the budget.
  const advisoryDeadlineMs = Date.now() + CODEX_ADVISORY_BUDGET_MS;
  for (const request of deferredAdvisories) {
    const advisory = codexAppAdvisory({ request, repoDir: actionRepoDir, runGh, deadlineMs: advisoryDeadlineMs });
    if (advisory) return advisory;
  }
  return { blocked: false };
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
}

function writeDenial(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  }));
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    writeDenial(`CODEX PRODUCTION GATE: hook input could not be parsed, so the action is denied (fail closed). ${error?.message || error}`);
    return;
  }
  const result = evaluateProductionAction({
    toolName: payload.tool_name ?? payload.toolName ?? "",
    toolInput: payload.tool_input ?? payload.toolInput ?? {},
    repoDir: process.env.CODEX_PROJECT_DIR || process.cwd(),
  });
  // Codex treats allow payloads as noisy/failed hook output. Silence means allow.
  if (!result.blocked) return;
  writeDenial(result.reason);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    writeDenial(`CODEX PRODUCTION GATE: unexpected guard failure; action denied. ${error?.message || error}`);
  });
}

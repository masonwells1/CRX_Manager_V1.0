#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  activeProtectedAutoMergePrNumbers,
  branchNameIsProtected,
  CODEX_MERGE_EVIDENCE_BUDGET_MS,
  coderabbitReviewGate,
  commandStartsWithGitHubCli,
  deliveryExecutableIsTrusted,
  destinationLooksLikeUrl,
  directGitHubApiWriter,
  contentIsRisky,
  createEvidenceBudget,
  extractPatchDestinations,
  featurePushDestinations,
  fixedGitExecutable,
  GUARDED_REPO_PATH,
  gitPushCwd,
  ghApiMergeRequest,
  ghApiMutates,
  ghCliCommandIsUnknownOrAlias,
  ghPrBaseRetargets,
  ghUpdateBranchRequest,
  ghMergeRequest,
  githubCliCommandIsDynamic,
  githubContextEnvironmentOverrideNames,
  githubMutationEnvironmentOverrideNames,
  githubMutationUnsafeAmbientEnvironmentNames,
  githubRepositoryContextOverrideMentioned,
  githubRepositoryIsGuarded,
  isGitPush,
  mainPushSource,
  mergeRequestHasExplicitContext,
  mcpMergeRequest,
  proofSearchDirs,
  proofValid,
  pullRequestChecksGreen,
  pushDestinationToken,
  pushGitHubRepository,
  pushUrlsAreLocalPaths,
  pushContextIsAmbiguous,
  pushIsForced,
  pushUsesBulkMode,
  pushUsesConfigEnv,
  pushUsesInlineConfig,
  reviewProofPathMentioned,
  reviewStateDirectoryMentioned,
  riskyFiles,
  structuredPushEnvironmentOverrideNames,
  trustedGitHubCliInvocation,
  updateBranchRequestHasExplicitContext,
} from "../../.claude/hooks/codex-push-lib.mjs";
import { stripCommentsQuoteAware } from "../../.claude/hooks/live-testdata-lib.mjs";

export { pullRequestChecksGreen };

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
const PROTECTED_HARNESS_SOURCE = String.raw`(?:\.claude[\\/]hooks[\\/](?:codex-push-(?:guard|lib)|review-proof-guard|live-testdata-lib)\.mjs|\.codex[\\/]hooks[\\/](?:production-action-guard|codex-hook-adapter)\.mjs|scripts[\\/](?:run-claude-review|write-codex-push-proof|write-apply-proofs|overnight-codex-gate|apply-live-testdata-maintenance-20260812)\.mjs|package\.json|\.claude[\\/]settings\.json|\.codex[\\/]hooks\.json)`;
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

function protectedHarnessPathMentioned(value) {
  return PROTECTED_HARNESS_PATH_RE.test(String(value || "").trim());
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
  return execFileSync(fixedGitExecutable(), args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function defaultRunGh(args, cwd, options = {}) {
  const invocation = trustedGitHubCliInvocation(args);
  return execFileSync(invocation.executable, invocation.args, {
    cwd,
    env: invocation.env,
    encoding: "utf8",
    timeout: Math.max(1, Math.min(5_000, Number(options.timeoutMs) || 5_000)),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
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

function githubToolIsReadOnly(toolName) {
  // App-style names keep a `github_` prefix on the leaf
  // (mcp__codex_apps__github_get_file) — strip it before classifying
  // (Codex round-5).
  const leaf = (String(toolName || "").split("__").pop() || "").replace(/^github_/i, "");
  return /^(?:get|list|search|read|resolve|download|check)_/i.test(leaf) ||
    /_(?:read|get|list|search)$/i.test(leaf);
}

function resolvePullRequest({ request, repoDir, runGh }) {
  const args = ["pr", "view"];
  if (request.selector) args.push(request.selector);
  // baseRefOid is GitHub's CURRENT tip of the base branch — the commit the merge
  // will actually land on. Without it the gate falls back to local origin/main,
  // which can be stale (Codex P1, 2026-07-25).
  args.push("--json", "baseRefName,baseRefOid,headRefName,headRefOid,mergeStateStatus,statusCheckRollup,autoMergeRequest");
  if (request.repo) args.push("--repo", request.repo);
  const data = JSON.parse(runGh(args, repoDir));
  // baseRefOid is required only for main-bound merges; gatePullRequestMerge
  // enforces it after the base check so a PR onto another branch is not
  // needlessly failed closed.
  if (!data?.baseRefName || !data?.headRefOid) throw new Error("GitHub did not return baseRefName and headRefOid");
  return data;
}

function gatePullRequestMerge({ request, repoDir, nowMs, runGit, runGh }) {
  if (!mergeRequestHasExplicitContext(request)) {
    return denied("CODEX PRODUCTION GATE: every merge must explicitly name one numeric PR, `--repo owner/repo`, and the exact 40-character `--match-head-commit` SHA in one standalone command. Selectorless/current-branch context and merge tools without an atomic head field are denied.");
  }
  let pullRequest;
  try {
    pullRequest = resolvePullRequest({ request, repoDir, runGh });
  } catch (error) {
    return denied(
      `CODEX PRODUCTION GATE: could not determine the pull request's base branch and exact head SHA, so the merge is denied (fail closed). ${error?.message || error}`
    );
  }
  if (!githubRepositoryIsGuarded(request.repo)) {
    return denied("CODEX PRODUCTION GATE: unattended merges are restricted to masonwells1/CRX_Manager_V1.0. Use a separate explicitly authorized workflow for any other repository.");
  }
  if (request.auto) {
    return denied("CODEX PRODUCTION GATE: `--auto` is denied for every PR regardless of its current base because a later base retarget or head mutation could bypass the exact-head reviewed merge path. Wait for checks, then perform one immediate guarded merge without `--auto`.");
  }
  const base = normalize(pullRequest.baseRefName).toLowerCase();
  if (!["main", "master", "production"].includes(base)) {
    const destinationBranch = normalize(pullRequest.baseRefName);
    let armed;
    try {
      armed = activeProtectedAutoMergePrNumbers(runGh([
        "pr", "list", "--repo", request.repo, "--state", "open", "--head", destinationBranch,
        "--json", "number,autoMergeRequest,baseRefName",
      ], repoDir));
    } catch (error) {
      return denied(`CODEX PRODUCTION GATE: could not prove auto-merge is disabled before mutating remote branch ${destinationBranch}, so the merge is denied (fail closed). ${error?.message || error}`);
    }
    if (armed.length > 0) {
      return denied(`CODEX PRODUCTION GATE: remote branch ${destinationBranch} feeds an armed protected-branch PR (${armed.join(", ")}). Run gh pr merge ${armed[0]} --disable-auto first, then retry; no Mason approval is required.`);
    }
  }
  if (base === "master" || base === "production") {
    return denied(`CODEX PRODUCTION GATE: merges to protected branch ${base} remain blocked.`);
  }
  if (base !== "main") return { blocked: false };
  const requestedHead = normalize(request.matchHead);
  const actualHead = normalize(pullRequest.headRefOid);
  if (request.atomicHeadMatch === false) {
    return denied(
      "CODEX PRODUCTION GATE: this merge tool cannot atomically require GitHub to merge the inspected head SHA. " +
      "Use one standalone `gh pr merge <n> --repo <owner/repo> --squash --match-head-commit <head-sha>` command instead; no extra Mason approval is required."
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(requestedHead) || requestedHead.toLowerCase() !== actualHead.toLowerCase()) {
    return denied(
      `CODEX PRODUCTION GATE: the merge must include --match-head-commit ${actualHead} so GitHub cannot land a different commit after inspection. ` +
      "Refresh the PR, then retry the immediate merge with that exact SHA; no extra Mason approval is required."
    );
  }
  if (!pullRequest.baseRefOid) {
    return denied(
      "CODEX PRODUCTION GATE: GitHub did not report this pull request's current base commit (baseRefOid), " +
      "so the merge cannot be bound to the base it will actually land on and is denied (fail closed)."
    );
  }
  if (!pullRequestChecksGreen(pullRequest)) {
    return denied(
      "CODEX PRODUCTION GATE: this pull request is not merge-ready with a fully green GitHub pipeline. Wait until mergeStateStatus is CLEAN and every reported check is completed successfully, neutral, or skipped."
    );
  }
  let coderabbit;
  try {
    const readPages = (endpoint) => {
      const pages = JSON.parse(runGh(["api", endpoint, "--paginate", "--slurp"], repoDir));
      if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error("GitHub returned malformed paginated evidence");
      return pages.flat();
    };
    const repo = request.repo;
    const number = request.selector;
    const head = pullRequest.headRefOid;
    coderabbit = coderabbitReviewGate({
      statuses: readPages(`repos/${repo}/commits/${head}/statuses`),
      reviews: readPages(`repos/${repo}/pulls/${number}/reviews`),
      comments: readPages(`repos/${repo}/issues/${number}/comments`),
      headSha: head,
    });
  } catch (error) {
    return denied(`CODEX PRODUCTION GATE: CodeRabbit's exact-head review could not be verified, so the merge is denied (fail closed). ${error?.message || error}`);
  }
  if (!coderabbit.ok) {
    return denied(`CODEX PRODUCTION GATE: CodeRabbit has not completed the mandatory latest-head review: ${coderabbit.reason}. Wait for or re-request the review, resolve any real findings, and retry the same exact-head merge; no extra Mason approval is required.`);
  }
  return gateMainChange({
    repoDir,
    sourceSha: pullRequest.headRefOid,
    // Bind the proof AND the risk diff to GitHub's real base, not local origin/main.
    authoritativeBaseSha: pullRequest.baseRefOid,
    nowMs,
    runGit,
  });
}

function gatePullRequestUpdateBranch({ request, repoDir, runGh }) {
  if (!updateBranchRequestHasExplicitContext(request)) {
    return denied("CODEX PRODUCTION GATE: `gh pr update-branch` must explicitly name one numeric PR and `--repo owner/repo` in one standalone command.");
  }
  if (request.rebase) {
    return denied("CODEX PRODUCTION GATE: `gh pr update-branch --rebase` rewrites shared remote history and requires Mason's explicit history-rewrite approval. Use the merge-based update without --rebase for unattended delivery.");
  }
  let pullRequest;
  try {
    pullRequest = resolvePullRequest({ request, repoDir, runGh });
  } catch (error) {
    return denied(`CODEX PRODUCTION GATE: could not resolve the PR head branch before updating it, so the action is denied (fail closed). ${error?.message || error}`);
  }
  if (!githubRepositoryIsGuarded(request.repo)) {
    return denied("CODEX PRODUCTION GATE: unattended branch updates are restricted to masonwells1/CRX_Manager_V1.0. Use a separate explicitly authorized workflow for any other repository.");
  }
  const destinationBranch = normalize(pullRequest.headRefName);
  if (!destinationBranch) return denied("CODEX PRODUCTION GATE: GitHub did not report the PR head branch, so update-branch is denied (fail closed).");
  if (branchNameIsProtected(destinationBranch)) {
    return denied(`CODEX PRODUCTION GATE: update-branch cannot mutate protected head branch ${destinationBranch}. Protected branches change only through the exact-head reviewed merge path.`);
  }
  let armed;
  try {
    armed = activeProtectedAutoMergePrNumbers(runGh([
      "pr", "list", "--repo", request.repo, "--state", "open", "--head", destinationBranch,
      "--json", "number,autoMergeRequest,baseRefName",
    ], repoDir));
  } catch (error) {
    return denied(`CODEX PRODUCTION GATE: could not prove auto-merge is disabled before updating remote branch ${destinationBranch}, so the action is denied (fail closed). ${error?.message || error}`);
  }
  if (armed.length > 0) {
    return denied(`CODEX PRODUCTION GATE: remote branch ${destinationBranch} feeds an armed protected-branch PR (${armed.join(", ")}). Run gh pr merge ${armed[0]} --disable-auto first, then retry; no Mason approval is required.`);
  }
  return { blocked: false };
}

export function evaluateProductionAction({
  toolName = "",
  toolInput = {},
  branch = "",
  repoDir = process.cwd(),
  nowMs = Date.now(),
  runGit = defaultRunGit,
  runGh = defaultRunGh,
  wallClock = Date.now,
} = {}) {
  const name = String(toolName);
  const baseRepoDir = path.resolve(repoDir);
  const requestedWorkingDir = toolInput.workdir ?? toolInput.cwd ?? "";
  const actionRepoDir = requestedWorkingDir
    ? path.resolve(baseRepoDir, String(requestedWorkingDir))
    : baseRepoDir;
  const unbudgetedRunGh = runGh;
  const githubEvidenceBudget = createEvidenceBudget(CODEX_MERGE_EVIDENCE_BUDGET_MS, wallClock);
  runGh = (args, cwd) => githubEvidenceBudget.run((remainingMs) =>
    unbudgetedRunGh(args, cwd, { timeoutMs: Math.max(1, Math.min(3_000, remainingMs)) }));

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
    return gatePullRequestMerge({
      request,
      repoDir: actionRepoDir,
      nowMs,
      runGit,
      runGh,
    });
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
  const shellMutatesPath = /(?:>|\b(?:set-content|add-content|out-file|new-item|set-item|clear-item|clear-content|set-itemproperty|new-itemproperty|remove-itemproperty|rename-itemproperty|clear-itemproperty|set-acl|remove-item|move-item|copy-item|rename-item|ac|clc|cli|clp|cpi|mi|ni|ri|ren|rni|sc|si|sp|sac|rm|mv|cp|del|erase|sed\s+-i|perl\s+-pi|apply_patch)\b)/i.test(command);
  if (shellMutatesPath && PROTECTED_HARNESS_FRAGMENT_RE.test(command)) {
    return denied("CODEX PRODUCTION GATE: direct shell mutation of the production/review harness is blocked. Use the reviewed maintenance workflow with Mason's approval.");
  }
  if (isGitPush(command) && pushContextIsAmbiguous(command)) {
    return denied("CODEX PRODUCTION GATE: directory-changing or GIT_DIR/GIT_WORK_TREE-prefixed pushes cannot be bound safely to the inspected worktree. Use `git -C <repo> push`.");
  }
  const suppliedEnv = toolInput.env && typeof toolInput.env === "object" ? toolInput.env : {};
  const mutationEnv = githubMutationEnvironmentOverrideNames(command, suppliedEnv);
  if (mutationEnv.length > 0) {
    return denied(`CODEX PRODUCTION GATE: GitHub mutations cannot carry tool-level environment overrides (${mutationEnv.join(", ")}) because the shell could execute a different command than the guard inspected. Use the normal environment.`);
  }
  const unsafeAmbientEnv = githubMutationUnsafeAmbientEnvironmentNames(command, process.env);
  if (unsafeAmbientEnv.length > 0) {
    return denied(`CODEX PRODUCTION GATE: GitHub mutations are denied while unsafe shell/network environment variables are active (${unsafeAmbientEnv.join(", ")}). Clear them before using the canonical guarded merge command.`);
  }
  const githubContextEnv = githubContextEnvironmentOverrideNames(suppliedEnv);
  if (githubContextEnv.length > 0) {
    return denied(`CODEX PRODUCTION GATE: structured GitHub context overrides are denied (${githubContextEnv.join(", ")}) because the executed host/repository/configuration could differ from the sanitized inspection. Use an explicit --repo owner/repo with the normal environment.`);
  }
  if (isGitPush(command) && Object.keys(suppliedEnv).some((key) => /^(?:GIT_DIR|GIT_WORK_TREE)$/i.test(key))) {
    return denied("CODEX PRODUCTION GATE: pushes with GIT_DIR/GIT_WORK_TREE tool environment overrides are denied. Use `git -C <repo> push`.");
  }
  const structuredPushEnv = structuredPushEnvironmentOverrideNames(command, suppliedEnv);
  if (structuredPushEnv.length > 0) {
    return denied(`CODEX PRODUCTION GATE: this push supplies structured environment overrides (${structuredPushEnv.join(", ")}) that cannot be bound to the inspected Git process. Remove tool-level env overrides; only GIT_TERMINAL_PROMPT=0/1 and the exact documented SSH keepalive command are accepted.`);
  }

  // Split on single `|` too (Codex round-4): `git push a | git push b` runs
  // BOTH pushes in a shell pipeline, so every pipeline stage is a segment.
  const commandSegments = command.split(/(?:&&|\|\|?|;|\r?\n)/).map((segment) => segment.trim()).filter(Boolean);
  const executionEnv = { ...process.env, ...suppliedEnv };
  for (const segment of commandSegments) {
    if (ghCliCommandIsUnknownOrAlias(segment)) {
      return denied("CODEX PRODUCTION GATE: GitHub CLI aliases and unknown top-level commands are denied because they can hide API writes from the exact-head parser. Use a known built-in `gh` command spelled literally.");
    }
    if (ghPrBaseRetargets(segment)) {
      return denied("CODEX PRODUCTION GATE: `gh pr edit --base` is denied because an already-armed auto-merge could be redirected into a protected branch without an exact-head reviewed merge command.");
    }
    if (commandStartsWithGitHubCli(segment) && !deliveryExecutableIsTrusted(segment, "gh", { cwd: actionRepoDir, env: executionEnv })) {
      return denied("CODEX PRODUCTION GATE: this GitHub command does not resolve to the trusted GitHub CLI used for inspection. Remove arbitrary executable paths, current-directory shadows, or PATH overrides and use the normal GitHub CLI installation.");
    }
  }
  if (githubCliCommandIsDynamic(command)) {
    return denied("CODEX PRODUCTION GATE: GitHub CLI commands containing shell-expanded variables, substitutions, splats, or backticks are denied because a merge or auto-merge action could be hidden from the exact-head parser. Spell the complete `gh` command literally.");
  }
  if (githubRepositoryContextOverrideMentioned(command)) {
    return denied("CODEX PRODUCTION GATE: GH_REPO/GH_HOST/GH_CONFIG_DIR/GITHUB_API_URL overrides are denied for merges because they can make the guard inspect a different repository or host than the command executes. Use an explicit `--repo owner/repo`.");
  }
  const pushSegments = commandSegments.filter((part) => isGitPush(part));
  if (pushSegments.some((segment) => pushUsesInlineConfig(segment))) {
    return denied("CODEX PRODUCTION GATE: pushes carrying inline Git configuration (`git -c ...` / `--config-env`) are denied because the override can redirect the push away from the repository this guard inspected. Use `git -C <repo> push` without inline configuration.");
  }
  if (pushSegments.length > 0 && (pushUsesConfigEnv(command) || Object.keys(suppliedEnv).some((key) => /^GIT_CONFIG(?:_|$)/i.test(key)))) {
    return denied("CODEX PRODUCTION GATE: feature pushes that name or supply GIT_CONFIG* environment overrides are denied because those variables can redirect the push away from the repository this guard inspected. Remove the override and use the repository's normal Git configuration.");
  }
  if (pushSegments.some((segment) => !deliveryExecutableIsTrusted(segment, "git", { cwd: actionRepoDir, env: executionEnv }))) {
    return denied("CODEX PRODUCTION GATE: this push does not resolve to the trusted Git executable used for inspection. Remove arbitrary executable paths, current-directory shadows, or PATH overrides and run the normal Git installation.");
  }
  if (pushSegments.length > 0 && (pushSegments.length !== 1 || commandSegments.length !== 1)) {
    return denied("CODEX PRODUCTION GATE: a feature push must be one standalone command. Chaining a push with another shell action could arm auto-merge after the pre-push GitHub check, so run `git -C <repo> push <remote> <single-refspec>` by itself.");
  }
  for (const segment of commandSegments) {
    const updateRequest = ghUpdateBranchRequest(segment);
    if (updateRequest?.unsupportedSyntax) {
      return denied("CODEX PRODUCTION GATE: noncanonical `gh pr update-branch` syntax is denied. Use one literal `gh pr update-branch <number> --repo <owner/repo> [--rebase]` command.");
    }
    const ghRequest = ghMergeRequest(segment) || ghApiMergeRequest(segment);
    if (ghRequest?.unsupportedGraphql) {
      return denied("CODEX PRODUCTION GATE: GraphQL merge/auto-merge mutations are denied because the guard cannot safely resolve and verify their exact PR head/checks. Use `gh pr merge <number> --match-head-commit <head-sha>` instead.");
    }
    if (ghRequest?.unsupportedRest) {
      return denied("CODEX PRODUCTION GATE: GitHub REST merge calls are denied because file-backed request bodies can hide or override the expected head SHA. Use one standalone `gh pr merge <number> --repo <owner/repo> --match-head-commit <head-sha>` command instead.");
    }
    if (ghRequest?.unsupportedSyntax) {
      return denied("CODEX PRODUCTION GATE: noncanonical `gh pr merge` syntax is denied. Use exactly one literal `gh pr merge <number> --repo <owner/repo> --squash [--delete-branch] --match-head-commit <head-sha>` command, or `gh pr merge <number> --disable-auto` only to cancel auto-merge.");
    }
    if (ghRequest?.unsupportedAutoFlags) {
      return denied("CODEX PRODUCTION GATE: mixed `--auto` and `--disable-auto` intent is denied. Use `--disable-auto` alone to cancel, or run one immediate exact-head merge without `--auto` after checks finish.");
    }
    if (ghRequest) {
      if (commandSegments.length !== 1) {
        return denied("CODEX PRODUCTION GATE: a merge must be one standalone command so directory, branch, repository, and PR context cannot change after inspection.");
      }
      if (!mergeRequestHasExplicitContext(ghRequest)) {
        return denied("CODEX PRODUCTION GATE: every merge must explicitly name one numeric PR, `--repo owner/repo`, and the exact 40-character `--match-head-commit` SHA in one standalone command. Selectorless/current-branch context is denied.");
      }
      const result = gatePullRequestMerge({
        request: ghRequest,
        repoDir: actionRepoDir,
        nowMs,
        runGit,
        runGh,
      });
      if (result.blocked) return result;
      continue;
    }
    if (updateRequest) {
      if (commandSegments.length !== 1) return denied("CODEX PRODUCTION GATE: `gh pr update-branch` must be one standalone command so its destination branch cannot change after inspection.");
      const result = gatePullRequestUpdateBranch({ request: updateRequest, repoDir: actionRepoDir, runGh });
      if (result.blocked) return result;
      continue;
    }
    if (directGitHubApiWriter(segment)) {
      return denied("CODEX PRODUCTION GATE: direct GitHub REST/GraphQL clients are denied because their repository, mutation body, and exact PR head cannot be bound to the trusted merge evidence path. Use the canonical guarded `gh pr` workflow.");
    }
    if (ghApiMutates(segment)) {
      return denied("CODEX PRODUCTION GATE: unrecognized mutating `gh api` calls are blocked because they can bypass the reviewed branch/push workflow.");
    }
  }

  for (const segment of pushSegments) {
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
      return denied("CODEX PRODUCTION GATE: direct pushes to main are denied unconditionally. Push one explicit feature branch and land it through the reviewed, green pull-request path; no extra Mason approval is required for that protected delivery.");
    } else {
      let featureBranches;
      try {
        featureBranches = featurePushDestinations(segment, branch);
      } catch (error) {
        return denied(
          `CODEX PRODUCTION GATE: could not determine the exact remote feature branch for the auto-merge check, ` +
          `so the push is denied (fail closed). ${error?.message || error}`,
        );
      }
      for (const featureBranch of featureBranches) {
        let pushRepository;
        let destinationIsLocal = false;
        try {
          const destinationToken = pushDestinationToken(segment);
          const destinationUrls = destinationLooksLikeUrl(destinationToken)
            ? [destinationToken]
            : String(runGit(["remote", "get-url", "--push", "--all", destinationToken], pushRepoDir) || "")
                .split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
          pushRepository = pushGitHubRepository(destinationUrls);
          destinationIsLocal = pushUrlsAreLocalPaths(destinationUrls);
          if (destinationIsLocal) {
            return denied("CODEX PRODUCTION GATE: unattended feature pushes to local-looking paths are denied because Git url.*.insteadOf rules can silently rewrite them to the production GitHub repository. Push the explicit verified CRX GitHub upstream instead.");
          }
          if (!pushRepository) {
            throw new Error("destination is not one exact GitHub repository or local repository path");
          }
          if (pushRepository && pushRepository !== GUARDED_REPO_PATH) {
            throw new Error(`network destination ${pushRepository} is outside the protected CRX upstream repository`);
          }
        } catch (error) {
          return denied(
            `CODEX PRODUCTION GATE: unattended feature pushes must resolve to the exact CRX GitHub repository before auto-merge state is checked. ${error?.message || error}`,
          );
        }
        let activeAutoMergePrs;
        try {
          activeAutoMergePrs = activeProtectedAutoMergePrNumbers(runGh([
            "pr", "list",
            "--repo", `github.com/${pushRepository}`,
            "--state", "open",
            "--head", featureBranch,
            "--json", "number,autoMergeRequest,baseRefName",
          ], pushRepoDir));
        } catch (error) {
          return denied(
            `CODEX PRODUCTION GATE: could not prove auto-merge is disabled for the open main-bound PR on branch ${featureBranch}, ` +
            `so the feature push is denied (fail closed). ${error?.message || error}`,
          );
        }
        if (activeAutoMergePrs.length > 0) {
          return denied(
            `CODEX PRODUCTION GATE: auto-merge is already armed on PR ${activeAutoMergePrs.map((number) => `#${number}`).join(", ")} ` +
            `for branch ${featureBranch}. A later push could then merge without an exact-head review. ` +
            `Run \`gh pr merge ${activeAutoMergePrs[0]} --disable-auto\`, verify auto-merge is off, and retry this push.`,
          );
        }
      }
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

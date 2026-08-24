#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  coderabbitVerdict,
  contentIsRisky,
  extractPatchDestinations,
  gitPushCwd,
  isGitPush,
  mainPushSource,
  proofSearchDirs,
  proofValid,
  pushContextIsAmbiguous,
  pushIsForced,
  pushTargetsCurrentHead,
  pushUsesBulkMode,
  reviewProofPathMentioned,
  reviewStateDirectoryMentioned,
  riskyFiles,
} from "../../.claude/hooks/codex-push-lib.mjs";
import { stripCommentsQuoteAware } from "../../.claude/hooks/live-testdata-lib.mjs";

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
  const valueFlags = new Set(["--repo", "-R", "--match-head-commit", "--subject", "--body"]);
  let selector = "";
  let repo = "";
  // Captured, not just skipped — the merge gate requires it to equal GitHub's
  // current headRefOid so review evidence and the merged SHA cannot diverge.
  // Kept identical to ghMergeRequest in codex-push-lib.mjs: a merge gate Claude
  // obeys and Codex does not is a bypass, not an asymmetry. (Codex, High, #441.)
  let matchHeadCommit = "";
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.startsWith("--repo=")) {
      repo = word.slice("--repo=".length);
      continue;
    }
    if (word.toLowerCase().startsWith("--match-head-commit=")) {
      matchHeadCommit = word.slice("--match-head-commit=".length);
      continue;
    }
    if (valueFlags.has(word)) {
      const value = words[index + 1] || "";
      if (word === "--repo" || word === "-R") repo = value;
      if (word === "--match-head-commit") matchHeadCommit = value;
      index += 1;
      continue;
    }
    if (index > mergeIndex && !word.startsWith("-") && !selector) selector = word;
  }
  return { selector, repo, matchHeadCommit, isGhCli: true };
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
  return match ? { selector: match[3], repo: `${match[1]}/${match[2]}`, matchHeadCommit: "", isGhCli: false } : null;
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
  return { selector: String(selector), repo, matchHeadCommit: "", isGhCli: false };
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

// Reads the two endpoints CodeRabbit binds evidence to and returns null when the
// head is proven reviewed, otherwise a reason string. Every unresolvable input
// fails closed. The predicates themselves live in codex-push-lib.mjs so both
// guards share one implementation.
function coderabbitMergeVerdict({ request, headSha, runGh }) {
  const number = String(request?.selector || "").replace(/^#/, "");
  if (!/^\d+$/.test(number)) {
    return "the pull request number needed to read its CodeRabbit review could not be resolved";
  }
  const repo = request?.repo ? String(request.repo) : "{owner}/{repo}";
  try {
    const api = (endpoint) => JSON.parse(runGh(["api", "--paginate", `repos/${repo}/${endpoint}`]));
    const reviews = api(`pulls/${number}/reviews`);
    const comments = api(`issues/${number}/comments`);
    // Newest `pending` status = start of THIS head's review cycle. The oldest
    // reaches into a previous attempt (blocking a clean retry forever); the
    // newest status is the cycle's completion (missing a failure posted just
    // before it). Statuses come back newest-first.
    const pending = api(`commits/${headSha}/statuses`).filter(
      (s) => s?.context === "CodeRabbit" && s?.state === "pending",
    );
    return coderabbitVerdict({
      reviews,
      comments,
      headSha,
      cycleStartIso: pending.length > 0 ? String(pending[0].created_at || "") : "",
    });
  } catch (error) {
    return `this pull request's CodeRabbit review could not be read from the GitHub API (${error?.message || error})`;
  }
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
  if (!pullRequestChecksGreen(pullRequest)) {
    return denied(
      "CODEX PRODUCTION GATE: this pull request is not merge-ready with a fully green GitHub pipeline. Wait until mergeStateStatus is CLEAN and every reported check is completed successfully, neutral, or skipped."
    );
  }

  // ── one SHA, bound through verification and the merge ──────────────────────
  // Mirrors .claude/hooks/pr-merge-guard.mjs exactly. A merge gate Claude obeys
  // and Codex does not is a bypass, not a deliberate asymmetry. (Codex, High,
  // PR #441 — raised five rounds running before it was enforced anywhere.)
  const headSha = normalize(pullRequest.headRefOid);
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    return denied(
      "CODEX PRODUCTION GATE: GitHub did not report a usable headRefOid, so the merge cannot be bound to a reviewed commit (fail closed)."
    );
  }
  if (!request?.isGhCli) {
    return denied(
      "CODEX PRODUCTION GATE: merges into main must go through `gh pr merge` so the landing can be pinned " +
      `with \`--match-head-commit ${headSha}\`. The MCP merge tool and the REST endpoint cannot pin the head, ` +
      "so a commit pushed between this check and the merge would land unreviewed."
    );
  }
  const pinned = normalize(request?.matchHeadCommit);
  if (!pinned) {
    return denied(
      "CODEX PRODUCTION GATE: merges into main must pass `--match-head-commit` so GitHub refuses the merge " +
      `if the branch moves after this check. Re-run as:\n  gh pr merge ${request?.selector || "<number>"} --squash --match-head-commit ${headSha}`
    );
  }
  if (pinned.toLowerCase() !== headSha.toLowerCase()) {
    return denied(
      `CODEX PRODUCTION GATE: \`--match-head-commit ${pinned}\` does not equal this pull request's current head ` +
      `(${headSha}). Review evidence is bound to the current head, so merging a different SHA would land ` +
      `content that was never verified.\n  gh pr merge ${request?.selector || "<number>"} --squash --match-head-commit ${headSha}`
    );
  }

  // ── CodeRabbit must have reviewed THIS EXACT head ──────────────────────────
  const notReviewed = coderabbitMergeVerdict({ request, headSha, runGh });
  if (notReviewed) {
    return denied(
      `CODEX PRODUCTION GATE: ${notReviewed}.\n\n` +
      "A green `CodeRabbit` status check is NOT proof the head was reviewed — a paused branch emits a no-op " +
      '"Review completed" success within seconds of a push with no review behind it. Comment ' +
      "`@coderabbitai review`, wait for it to finish, read it, then re-read the head and merge pinned to it."
    );
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
  if (isGitPush(command) && Object.keys(suppliedEnv).some((key) => /^(?:GIT_DIR|GIT_WORK_TREE)$/i.test(key))) {
    return denied("CODEX PRODUCTION GATE: pushes with GIT_DIR/GIT_WORK_TREE tool environment overrides are denied. Use `git -C <repo> push`.");
  }

  // Split on single `|` too (Codex round-4): `git push a | git push b` runs
  // BOTH pushes in a shell pipeline, so every pipeline stage is a segment.
  const commandSegments = command.split(/(?:&&|\|\|?|;|\r?\n)/).map((segment) => segment.trim()).filter(Boolean);
  for (const segment of commandSegments) {
    const ghRequest = ghMergeRequest(segment) || ghApiMergeRequest(segment);
    if (ghRequest?.unsupportedGraphql) {
      return denied("CODEX PRODUCTION GATE: GraphQL mergePullRequest mutations are denied because the guard cannot safely resolve and verify their PR head/checks. Use `gh pr merge <number>` instead.");
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

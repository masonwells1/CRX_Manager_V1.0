#!/usr/bin/env node
// Tests for sol-exempt-lib.mjs — which pull requests may merge into main without
// the final Sol review (Mason, 2026-10-07). Three parts:
//
//   1. THE CONTRACT. contractFailures() runs every case and returns what broke,
//      instead of throwing at the first one, so the same contract can be run
//      against the real module and against deliberately loosened copies of it.
//   2. DOC PARITY. docs/reference/sol-exempt-paths.md must list exactly what the
//      module lists.
//   3. MUTATION CHECK. Each mutant widens the exemption or loosens one check. The
//      contract must fail for every one; a mutant it passes is a hole the tests
//      would not catch.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as realLib from "./sol-exempt-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const LIB_PATH = path.join(__dirname, "sol-exempt-lib.mjs");
let pass = 0;
function ok(value, message) { assert.ok(value, message); pass++; }
function eq(actual, expected, message) { assert.deepEqual(actual, expected, message); pass++; }

const BASE = "b".repeat(40);
const HEAD = "a".repeat(40);
const modified = (filename) => ({ filename, previous_filename: null, status: "modified" });
const DOCS_ONLY = [
  modified("docs/plans/2026-10-02-sol-skip-for-low-risk-changes.md"),
  modified("docs/changelog.d/2026-10-07-sol-exempt-docs-only.md"),
  modified("docs/manual/DECISION_LOG.md"),
  modified("docs/manual/CURRENT_STATE.md"),
  modified("docs/reference/gotchas.md"),
  modified("docs/reports/a.md"),
  modified("docs/audits/2026-10/finding.md"),
  modified("docs/handoffs/README.md"),
  modified("docs/research/x_y-z.v2.md"),
  { filename: "docs/plans/old-plan.md", previous_filename: null, status: "removed" },
];
// Each of these, added to a docs-only pull request, must bring Sol back.
const NEVER_EXEMPT = [
  // the proposal's never-eligible list
  "src/App.tsx",
  "src/notes.md",
  "supabase/migrations/20261007000000_x.sql",
  "supabase/README.md",
  "scripts/land-pr.mjs",
  "scripts/README.md",
  ".github/workflows/ci.yml",
  ".github/pull_request_template.md",
  ".claude/hooks/pr-merge-guard.mjs",
  ".claude/hooks/sol-exempt-lib.mjs",
  ".claude/commands/ship.md",
  ".codex/hooks/production-action-guard.mjs",
  ".agents/skills/ship/SKILL.md",
  ".husky/pre-push",
  ".coderabbit.yaml",
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "package-lock.json",
  "docs/workflows/SAFE_DEVELOPMENT_RULES.md",
  "docs/reference/agent-guardrails.md",
  "docs/reference/codex-model-tuning.md",
  "docs/manual/OWNER_PLAYBOOK.md",
  // stricter than the proposal
  "docs/reference/claude-model-tuning.md",
  "docs/reference/sol-exempt-paths.md",
  "docs/reference/migration-history.md",
  // agent instructions and package manifests in ANY folder
  "docs/plans/CLAUDE.md",
  "docs/manual/AGENTS.md",
  "docs/reports/claude.local.md",
  "docs/audits/agents.override.md",
  "docs/plans/GEMINI.md",
  "docs/research/agent.md",
  "docs/plans/package.json",
  // case spellings Windows checks out over a never-eligible file
  "docs/reference/Agent-Guardrails.md",
  "docs/manual/owner_playbook.md",
  "docs/Workflows/X.md",
  "Docs/workflows/X.md",
  "docs/plans/Claude.md",
];
// Not never-eligible, but still not documentation on the allow-list.
const NOT_ON_ALLOW_LIST = [
  "README.md",
  "docs/CHANGELOG.md",
  "docs/runbooks/restore.md",
  "docs/archive/2026-spring/x.md",
  "docs/loops/x.md",
  "Docs/plans/a.md",
  "docs/Plans/a.md",
  // other file types inside eligible folders
  "docs/audits/2026-09/workflow.mjs",
  "docs/audits/draft-migration.sql",
  "docs/reports/data.json",
  "docs/plans/a.MD",
  "docs/plans/a.md.bak",
  "docs/plans/a",
  // spellings that are not one plain path
  "docs/plans/../reference/agent-guardrails.md",
  "docs/plans/./a.md",
  "docs/plans//a.md",
  "/docs/plans/a.md",
  "docs\\plans\\a.md",
  "docs/plans/a.md.",
  "docs/plans/a .md",
  "docs/plans/a.md ",
  "docs/plans/.hidden.md",
  "docs/plans/x./a.md",
  "docs/reference./agent-guardrails.md",
  "docs/plans/AGENT~1.md",
  "docs/plans/a.md::$DATA",
  "docs/plans/é.md",
  "",
];

function compareAnswer(overrides = {}) {
  return { status: "ahead", ahead_by: 2, behind_by: 0, merge_base: BASE, head: HEAD, files: DOCS_ONLY, ...overrides };
}
// Git's view of a path at a commit. PLAIN is mode 100644, a regular file.
const PLAIN = { mode: 0o100644, type: "blob" };
const SYMLINK = { mode: 0o120000, type: "blob" };
const SUBMODULE = { mode: 0o160000, type: "commit" };
const EXECUTABLE = { mode: 0o100755, type: "blob" };
const FOLDER = { mode: 0o040000, type: "tree" };
const MISSING = "missing";
// Answers the GraphQL tree lookup the way GitHub does: for each requested
// `<sha>:<folder>`, the entries of that folder AT THAT COMMIT. HEAD holds every
// file the comparison adds or keeps; BASE holds every deleted file and every old
// name. Any other commit finds nothing. `kinds` overrides a path's git kind.
function treeAnswer(args, answer, kinds) {
  const entries = Array.isArray(answer?.files) ? answer.files.filter((f) => f && typeof f.filename === "string") : [];
  const atHead = entries.filter((f) => String(f.status).toLowerCase() !== "removed").map((f) => f.filename);
  const atBase = [
    ...entries.filter((f) => String(f.status).toLowerCase() === "removed").map((f) => f.filename),
    ...entries.map((f) => f.previous_filename).filter((f) => typeof f === "string" && f),
  ];
  const repository = {};
  args.forEach((arg, i) => {
    const match = args[i - 1] === "-f" && /^e(\d+)=([^:]+):(.*)$/.exec(String(arg));
    if (!match) return;
    const [, index, sha, folder] = match;
    const files = sha === HEAD ? atHead : sha === BASE ? atBase : null;
    repository[`d${index}`] = files === null ? null : {
      entries: files
        .filter((file) => file.slice(0, file.lastIndexOf("/")) === folder && kinds[file] !== MISSING)
        .map((file) => ({ name: file.slice(file.lastIndexOf("/") + 1), ...(kinds[file] || PLAIN) })),
    };
  });
  return { data: { repository } };
}
function fakeGh(answer, calls = [], kinds = {}) {
  return (args) => {
    calls.push(args);
    if (answer instanceof Error) throw answer;
    if (args[1] === "graphql") {
      if (kinds instanceof Error) throw kinds;
      return JSON.stringify(treeAnswer(args, answer, kinds));
    }
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  };
}

// Returns every way `lib` breaks the contract; [] means it holds.
function contractFailures(lib) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  // A throw is a broken contract too: inside a hook it can mean no decision at all.
  const exempt = (files) => {
    try { return lib.classifySolExemption(files).exempt === true; } catch (error) {
      failures.push(`classifySolExemption threw: ${error?.message || error}`);
      return true;
    }
  };

  check(exempt(DOCS_ONLY), "a docs-only pull request is exempt");
  check(exempt([modified("docs/plans/a.md")]), "a single docs file is exempt");
  for (const file of NEVER_EXEMPT) {
    check(!exempt([...DOCS_ONLY, modified(file)]), `adding ${file} brings Sol back`);
    check(/never exempt/.test(String(lib.solExemptPathProblem(file))), `${file} is refused by a NEVER rule, not only by the allow-list`);
  }
  for (const file of NOT_ON_ALLOW_LIST) {
    check(!exempt([...DOCS_ONLY, modified(file)]), `adding ${JSON.stringify(file)} brings Sol back`);
  }
  for (const file of DOCS_ONLY) check(lib.solExemptPathProblem(file.filename) === null, `${file.filename} is exempt on its own`);

  // renames and copies: both names must be exempt
  check(!exempt([{ filename: "docs/plans/moved.md", previous_filename: "src/moved.ts", status: "renamed" }]),
    "a rename from src/ into docs/ needs Sol");
  check(!exempt([{ filename: ".claude/hooks/x.md", previous_filename: "docs/plans/x.md", status: "renamed" }]),
    "a rename from docs/ into .claude/ needs Sol");
  check(!exempt([{ filename: "docs/plans/guard.md", previous_filename: ".claude/hooks/pr-merge-guard.mjs", status: "renamed" }]),
    "renaming a hook into a docs file needs Sol (the hook disappears)");
  check(!exempt([{ filename: "docs/plans/rules.md", previous_filename: "docs/workflows/RULES.md", status: "renamed" }]),
    "moving a rule document out of docs/workflows needs Sol");
  check(!exempt([{ filename: "docs/plans/copy.md", previous_filename: "AGENTS.md", status: "copied" }]),
    "a copy is judged by its source too");
  check(!exempt([{ filename: "docs/plans/moved.md", status: "renamed" }]),
    "a rename with no old name needs Sol (fail closed)");
  check(!exempt([{ filename: "docs/plans/moved.md", previous_filename: "", status: "renamed" }]),
    "a rename with an empty old name needs Sol");
  check(!exempt([{ filename: "docs/plans/moved.md", previous_filename: "src/x.ts", status: "modified" }]),
    "an old name is checked even when the status does not say renamed");
  check(exempt([{ filename: "docs/reports/moved.md", previous_filename: "docs/plans/moved.md", status: "renamed" }]),
    "a rename between two documentation folders stays exempt");

  // unreadable or possibly incomplete lists
  check(!exempt([]), "an empty file list needs Sol");
  check(!exempt(null), "a missing file list needs Sol");
  check(!exempt("docs/plans/a.md"), "a file list that is not a list needs Sol");
  check(!exempt([null]), "an unreadable entry needs Sol");
  check(!exempt([{ status: "modified" }]), "an entry with no file name needs Sol");
  check(!exempt([{ filename: 42, status: "modified" }]), "a non-text file name needs Sol");
  const many = (count) => Array.from({ length: count }, (_, i) => modified(`docs/changelog.d/entry-${i}.md`));
  check(exempt(many(249)), "249 documentation files are a complete list and exempt");
  check(!exempt(many(250)), "250 files may be truncated, so they need Sol");
  check(!exempt(many(300)), "GitHub's 300-file cap needs Sol");

  // the GitHub comparison
  const viaGitHub = (answer, extra = {}, kinds = {}) => {
    try { return lib.solExemptionOnGitHub({ baseSha: BASE, headSha: HEAD, gh: fakeGh(answer, [], kinds), ...extra }).exempt === true; } catch (error) {
      failures.push(`solExemptionOnGitHub threw: ${error?.message || error}`);
      return true;
    }
  };
  check(viaGitHub(compareAnswer()), "a clean base..head comparison of docs files is exempt");
  check(!viaGitHub(compareAnswer({ files: [...DOCS_ONLY, modified(".claude/hooks/pr-merge-guard.mjs")] })),
    "a hook in GitHub's file list needs Sol");
  check(!viaGitHub(new Error("HTTP 502")), "a failed GitHub call needs Sol");
  check(!viaGitHub("not json"), "an unreadable answer needs Sol");
  check(!viaGitHub("null"), "a null answer needs Sol");
  check(!viaGitHub("[]"), "a list where an object was expected needs Sol");
  check(!viaGitHub(compareAnswer({ status: "diverged", behind_by: 3 })), "a head behind its base needs Sol");
  check(!viaGitHub(compareAnswer({ behind_by: 1 })), "behind_by 1 needs Sol even if status says ahead");
  check(!viaGitHub(compareAnswer({ behind_by: "0" })), "behind_by must be the number 0");
  check(!viaGitHub(compareAnswer({ status: "identical", ahead_by: 0 })), "an identical comparison needs Sol");
  check(!viaGitHub(compareAnswer({ status: "behind" })), "status behind needs Sol");
  check(!viaGitHub(compareAnswer({ ahead_by: 0 })), "ahead_by 0 needs Sol");
  check(!viaGitHub(compareAnswer({ merge_base: "c".repeat(40) })), "a comparison that does not start at the base needs Sol");
  check(!viaGitHub(compareAnswer({ merge_base: undefined })), "a comparison with no merge base needs Sol");
  check(!viaGitHub(compareAnswer({ files: null })), "a comparison with no file list needs Sol");
  check(!viaGitHub(compareAnswer({ files: many(300) })), "a truncated comparison needs Sol");
  check(!viaGitHub(compareAnswer({ files: [] })), "a comparison with no files needs Sol");
  // The pull-request JSON the merge guards' tests feed every gh call is not a
  // comparison; reading it as one must not exempt anything.
  check(!viaGitHub({ baseRefName: "main", headRefOid: HEAD, baseRefOid: BASE, reviewDecision: "APPROVED" }),
    "a pull-request view answer is not a comparison");
  check(!viaGitHub(compareAnswer(), { baseSha: "main" }), "a base that is not a full commit id needs Sol");
  check(!viaGitHub(compareAnswer(), { headSha: HEAD.slice(0, 12) }), "an abbreviated head needs Sol");
  check(!viaGitHub(compareAnswer(), { repo: "a/b/c/d" }), "an unreadable repository needs Sol");
  check(viaGitHub(compareAnswer(), { baseSha: BASE.toUpperCase() }), "commit ids compare without regard to case");

  // the answer is bound to the head that was asked about (Luna, round 1)
  check(!viaGitHub(compareAnswer({ head: "c".repeat(40) })), "a comparison ending at another commit needs Sol");
  check(!viaGitHub(compareAnswer({ head: null })), "a comparison with no newest commit needs Sol");

  // only the statuses a plain edit produces (Luna, round 1)
  for (const status of [undefined, "", "changed", "unchanged", "typechange", "RENAMED-ish"]) {
    check(!exempt([modified("docs/plans/a.md"), { filename: "docs/plans/b.md", previous_filename: null, status }]),
      `a change with status ${JSON.stringify(status)} needs Sol`);
  }
  check(exempt([{ filename: "docs/plans/a.md", previous_filename: null, status: "ADDED" }]), "status is read without regard to case");

  // every surviving file must be a plain file at the head (Luna, round 1): GitHub's
  // comparison does not say whether a path is a symlink or a submodule
  const NOTE = "docs/plans/2026-10-02-sol-skip-for-low-risk-changes.md";
  check(!viaGitHub(compareAnswer(), {}, { [NOTE]: SYMLINK }), "a symlink named like a docs file needs Sol");
  check(!viaGitHub(compareAnswer(), {}, { [NOTE]: SUBMODULE }), "a submodule named like a docs file needs Sol");
  check(!viaGitHub(compareAnswer(), {}, { [NOTE]: EXECUTABLE }), "an executable docs file needs Sol");
  check(!viaGitHub(compareAnswer(), {}, { [NOTE]: FOLDER }), "a folder named like a docs file needs Sol");
  check(!viaGitHub(compareAnswer(), {}, { [NOTE]: { mode: "33188", type: "blob" } }), "a mode that is not the number 100644 needs Sol");
  check(!viaGitHub(compareAnswer(), {}, { [NOTE]: MISSING }), "a changed file GitHub cannot show at the head needs Sol");
  check(!viaGitHub(compareAnswer(), {}, new Error("GraphQL: rate limited")), "a failed file-kind lookup needs Sol");
  check(!viaGitHub(compareAnswer({ files: [{ filename: NOTE, previous_filename: "docs/plans/old.md", status: "renamed" }] }), {}, { [NOTE]: SYMLINK }),
    "a renamed file is checked at its new name too");
  const kindCalls = [];
  lib.solExemptionOnGitHub({ baseSha: BASE, headSha: HEAD, repo: "masonwells1/CRX_Manager_V1.0", gh: fakeGh(compareAnswer(), kindCalls) });
  const kindCall = kindCalls.find((args) => args[1] === "graphql") || [];
  const folderArgs = kindCall.filter((arg) => /^e\d+=/.test(String(arg))).map((arg) => String(arg).replace(/^e\d+=/, ""));
  check(folderArgs.length > 0 && folderArgs.every((arg) => arg.startsWith(`${HEAD}:docs/`) || arg.startsWith(`${BASE}:docs/`)),
    "the file-kind lookup reads folders only at the exact head and base");
  check(folderArgs.includes(`${HEAD}:docs/plans`) && folderArgs.includes(`${HEAD}:docs/research`),
    "an added or kept file's folder is read at the head");
  check(folderArgs.includes(`${BASE}:docs/plans`), "a deleted file's folder is read at the base, where the file still exists");
  check(kindCall.includes("owner=masonwells1") && kindCall.includes("name=CRX_Manager_V1.0"), "in the pull request's repository");
  const removalOnly = compareAnswer({ files: [{ filename: "docs/plans/old.md", previous_filename: null, status: "removed" }] });
  check(viaGitHub(removalOnly), "a pull request that only deletes a plain documentation file is exempt");
  check(!viaGitHub(removalOnly, {}, { "docs/plans/old.md": SYMLINK }), "deleting a symlink named like a docs file needs Sol (Luna, round 2)");
  check(!viaGitHub(removalOnly, {}, { "docs/plans/old.md": SUBMODULE }), "deleting a submodule named like a docs file needs Sol");
  check(!viaGitHub(compareAnswer({ files: [{ filename: "docs/plans/new.md", previous_filename: "docs/plans/old.md", status: "renamed" }] }), {}, { "docs/plans/old.md": SYMLINK }),
    "renaming a symlink into a plain-looking name needs Sol (the old name is read at the base)");
  check(viaGitHub(compareAnswer(), { baseSha: BASE.toUpperCase(), headSha: HEAD.toUpperCase() }),
    "upper-case commit ids are read as the same commits");

  // what the guard asks GitHub
  const calls = [];
  lib.solExemptionOnGitHub({ baseSha: BASE, headSha: HEAD, repo: "masonwells1/CRX_Manager_V1.0", gh: fakeGh(compareAnswer(), calls) });
  check(calls.length === 2 && calls[1]?.[1] === "graphql", "two GitHub calls: the comparison, then the file-kind lookup");
  check(calls[0]?.[0] === "api" && calls[0]?.[1] === `repos/masonwells1/CRX_Manager_V1.0/compare/${BASE}...${HEAD}`,
    "it asks GitHub's compare API for base...head of the pull request's repository");
  check(calls[0]?.[2] === "--jq" && /\.files/.test(String(calls[0]?.[3])) && /merge_base_commit\.sha/.test(String(calls[0]?.[3])),
    "and projects the files and the merge base");
  const unusedCalls = [];
  lib.solExemptionOnGitHub({ baseSha: "main", headSha: HEAD, gh: fakeGh(compareAnswer(), unusedCalls) });
  check(unusedCalls.length === 0, "an unusable base is refused without asking GitHub");
  let threw = false;
  try { lib.solExemptionOnGitHub({ baseSha: BASE, headSha: HEAD, gh: () => { throw new TypeError("boom"); } }); } catch { threw = true; }
  check(!threw, "a throwing gh never escapes (a throw inside a hook can mean ALLOW)");
  return failures;
}

// ── 1. the real module holds the contract ────────────────────────────────────
const realFailures = contractFailures(realLib);
eq(realFailures, [], "sol-exempt-lib.mjs holds the documentation-only contract");

// The reason a docs-only PR is exempt is stated, and a refusal names the file.
eq(realLib.classifySolExemption([modified("docs/plans/a.md")]).fileCount, 1, "an exemption reports how many files it covered");
ok(/\.claude\/hooks\/pr-merge-guard\.mjs/.test(realLib.classifySolExemption([...DOCS_ONLY, modified(".claude/hooks/pr-merge-guard.mjs")]).reason),
  "a refusal names the file that needs Sol");

// ── 2. the readable copy lists exactly what the module lists ────────────────
const doc = readFileSync(path.join(REPO_ROOT, "docs", "reference", "sol-exempt-paths.md"), "utf8");
function docList(marker) {
  const match = doc.match(new RegExp(`<!-- sol-exempt:${marker} -->([\\s\\S]*?)<!-- /sol-exempt:${marker} -->`));
  ok(match, `docs/reference/sol-exempt-paths.md has the ${marker} block`);
  return [...match[1].matchAll(/^- `([^`]+)`\s*$/gm)].map((m) => m[1]).sort();
}
eq(docList("eligible"), [...realLib.SOL_EXEMPT_PREFIXES].sort(), "the doc's eligible folders match SOL_EXEMPT_PREFIXES");
eq(docList("never-paths"), [...realLib.SOL_NEVER_EXEMPT_PATHS].sort(), "the doc's never-eligible paths match SOL_NEVER_EXEMPT_PATHS");
eq(docList("never-names"), [...realLib.SOL_NEVER_EXEMPT_NAMES].sort(), "the doc's never-eligible names match SOL_NEVER_EXEMPT_NAMES");
ok(doc.includes(String(realLib.SOL_EXEMPT_MAX_FILES)), "the doc states the file-count limit");

// The approved proposal's lists are a floor: nothing it made never-eligible may
// leave the module, and nothing it left out may be added to the allow-list.
for (const entry of ["src/", "supabase/", "scripts/", ".github/", ".claude/", ".codex/", ".agents/", ".husky/",
  ".coderabbit.yaml", "docs/workflows/", "docs/manual/OWNER_PLAYBOOK.md", "docs/reference/agent-guardrails.md",
  "docs/reference/codex-model-tuning.md"]) {
  ok(realLib.SOL_NEVER_EXEMPT_PATHS.includes(entry), `the proposal's never-eligible ${entry} is still listed`);
}
for (const entry of ["AGENTS.md", "CLAUDE.md", "package.json", "package-lock.json"]) {
  ok(realLib.SOL_NEVER_EXEMPT_NAMES.includes(entry), `the proposal's never-eligible ${entry} is still listed`);
}
const PROPOSAL_ELIGIBLE = ["docs/changelog.d/", "docs/manual/", "docs/reference/", "docs/plans/", "docs/reports/",
  "docs/audits/", "docs/handoffs/", "docs/research/"];
ok(realLib.SOL_EXEMPT_PREFIXES.every((prefix) => PROPOSAL_ELIGIBLE.includes(prefix)),
  "the allow-list is no wider than the folders Mason approved");

// ── 3. mutation check: every widening or loosening is caught ─────────────────
const source = readFileSync(LIB_PATH, "utf8");
const pushLibUrl = pathToFileURL(path.join(__dirname, "codex-push-lib.mjs")).href;
const MUTANTS = [
  ["allow-list widened to all of docs/", `  "docs/changelog.d/",\n`, `  "docs/",\n  "docs/changelog.d/",\n`],
  ["allow-list gains an unapproved folder", `  "docs/research/",\n`, `  "docs/research/",\n  "docs/runbooks/",\n`],
  ["allow-list gains the repository root", `  "docs/research/",\n`, `  "docs/research/",\n  "",\n`],
  ["never path dropped: agent-guardrails.md", `  "docs/reference/agent-guardrails.md",\n`, ""],
  ["never path dropped: OWNER_PLAYBOOK.md", `  "docs/manual/OWNER_PLAYBOOK.md",\n`, ""],
  ["never path dropped: codex-model-tuning.md", `  "docs/reference/codex-model-tuning.md",\n`, ""],
  ["never path dropped: sol-exempt-paths.md", `  "docs/reference/sol-exempt-paths.md",\n`, ""],
  ["never path dropped: migration-history.md", `  "docs/reference/migration-history.md",\n`, ""],
  ["never path dropped: claude-model-tuning.md", `  "docs/reference/claude-model-tuning.md",\n`, ""],
  ["never path dropped: .claude/", `  ".claude/",\n`, ""],
  ["never path dropped: docs/workflows/", `  "docs/workflows/",\n`, ""],
  ["never path dropped: src/", `  "src/",\n`, ""],
  ["never name dropped: CLAUDE.md", `  "CLAUDE.md",\n`, ""],
  ["never name dropped: AGENTS.md", `  "AGENTS.md",\n`, ""],
  ["never name dropped: GEMINI.md", `  "GEMINI.md",\n`, ""],
  ["never name dropped: package.json", `  "package.json",\n`, ""],
  ["never rules made case-sensitive", "const lower = name.toLowerCase();", "const lower = name;"],
  ["never names checked at the root only", "const base = lower.slice(lower.lastIndexOf(\"/\") + 1);", "const base = lower;"],
  ["never paths stop matching folders", `rule.endsWith("/") ? lower.startsWith(rule) : lower === rule`, "lower === rule"],
  ["any file type accepted", "\\\\.md$`", "\\\\.[A-Za-z0-9]+$`"],
  ["path spelling unchecked", "if (!PLAIN_MARKDOWN_PATH_RE.test(name)) {", "if (!name.endsWith(\".md\")) {"],
  ["dot segments allowed", `const SEGMENT = "[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?";`, `const SEGMENT = "[A-Za-z0-9._-]+";`],
  ["allow-list matched without regard to case", "SOL_EXEMPT_PREFIXES.some((prefix) => name.startsWith(prefix))",
    "SOL_EXEMPT_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()))"],
  ["renamed file's old name ignored", "names.push(entry.previous_filename);", "void 0;"],
  // (Skipping only the "no old name" refusal is an EQUIVALENT mutant, not a hole:
  // the missing name is then refused as unreadable one line later.)
  ["old name checked only when GitHub says renamed", `if (status === "renamed" || status === "copied" || (entry.previous_filename !== undefined && entry.previous_filename !== null)) {`,
    `if (status === "renamed") {`],
  ["truncation limit removed", "if (files.length >= SOL_EXEMPT_MAX_FILES) {", "if (false) {"],
  ["truncation limit raised to GitHub's cap", "export const SOL_EXEMPT_MAX_FILES = 250;", "export const SOL_EXEMPT_MAX_FILES = 301;"],
  ["empty file list accepted", "if (files.length === 0) return", "if (false) return"],
  ["unreadable entry accepted", `if (entry === null || typeof entry !== "object") return`, `if (false) return`],
  ["comparison status unchecked", `answer.status !== "ahead" || `, ""],
  ["head behind its base accepted", "answer.behind_by !== 0", "false"],
  ["empty comparison accepted", "answer.ahead_by < 1", "false"],
  ["merge base unchecked", `if (String(answer.merge_base || "").toLowerCase() !== String(baseSha).toLowerCase()) {`, "if (false) {"],
  ["GitHub failure read as exempt", "return { exempt: false, reason: `GitHub's file list could not be read", "return { exempt: true, reason: `GitHub's file list could not be read"],
  // Luna round 1: status, head binding and file kind.
  ["change status unchecked", "if (!SOL_EXEMPT_STATUSES.includes(status)) {", "if (false) {"],
  ["typechange status accepted", `["added", "modified", "removed", "renamed", "copied"]`, `["added", "modified", "removed", "renamed", "copied", "changed"]`],
  ["comparison not bound to the head", `if (String(answer.head || "").toLowerCase() !== String(headSha).toLowerCase()) {`, "if (false) {"],
  ["file-kind lookup skipped", "const problem = treeProblem({ files: answer.files, baseSha, headSha, repoPath, gh });", "const problem = null;"],
  ["file kind unchecked", `if (entry.type !== "blob" || entry.mode !== PLAIN_FILE_MODE) {`, "if (false) {"],
  ["symlinks accepted (type checked, mode not)", `entry.type !== "blob" || entry.mode !== PLAIN_FILE_MODE`, `entry.type !== "blob"`],
  ["executables accepted", "const PLAIN_FILE_MODE = 0o100644;", "const PLAIN_FILE_MODE = 0o100755;"],
  ["file missing at the head accepted", "if (!entry) return", "if (!entry) continue; if (false) return"],
  ["failed file-kind lookup read as fine", "return `GitHub could not confirm what kind", "return null; void `GitHub could not confirm what kind"],
  ["file kinds read at the wrong commit", "{ commit: removed ? baseSha : headSha, file: entry.filename }", "{ commit: \"HEAD\", file: entry.filename }"],
  ["deleted files read at the head", "{ commit: removed ? baseSha : headSha, file: entry.filename }", "{ commit: headSha, file: entry.filename }"],
  ["old names not kind-checked", "lookups.push({ commit: baseSha, file: entry.previous_filename });", "void 0;"],
  ["deleted files not kind-checked", "{ commit: removed ? baseSha : headSha, file: entry.filename }", "...(removed ? [] : [{ commit: headSha, file: entry.filename }])"],
  ["base commit id unchecked", `if (!SHA_RE.test(String(rawBase || "")) || !SHA_RE.test(String(rawHead || ""))) {`, "if (false) {"],
];
const mutantDir = mkdtempSync(path.join(tmpdir(), "sol-exempt-mutants-"));
try {
  const importLine = `import { ghApiRepoPath } from "./codex-push-lib.mjs";`;
  ok(source.includes(importLine), "the module imports codex-push-lib as the mutation harness expects");
  for (const [index, [name, find, replace]] of MUTANTS.entries()) {
    ok(source.includes(find), `mutant "${name}": its target text is present in sol-exempt-lib.mjs`);
    const mutated = source
      // Function replacements: a `$` in the text must not act as a replace pattern.
      .replace(importLine, () => `import { ghApiRepoPath } from ${JSON.stringify(pushLibUrl)};`)
      .replace(find, () => replace);
    ok(mutated !== source, `mutant "${name}" changes the module`);
    const file = path.join(mutantDir, `mutant-${index}.mjs`);
    writeFileSync(file, mutated, "utf8");
    const mutant = await import(pathToFileURL(file).href);
    const failures = contractFailures(mutant);
    ok(failures.length > 0, `mutant "${name}" is caught by the contract (it passed every case — the tests have a hole)`);
  }
} finally {
  rmSync(mutantDir, { recursive: true, force: true });
}

console.log(`sol-exempt-lib: ${pass} assertions passed (${MUTANTS.length} mutants caught)`);

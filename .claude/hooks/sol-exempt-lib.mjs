// SOL EXEMPTION for documentation-only pull requests (Mason, 2026-10-07; the
// proposal and decision are PR #870 and docs/plans/2026-10-02-sol-skip-for-low-risk-changes.md).
//
// Every merge into main needs a fresh exact-SHA Sol proof (AGENTS.md), EXCEPT a
// pull request whose every changed file is plain documentation named below. Both
// merge guards ask this module — .claude/hooks/pr-merge-guard.mjs and
// .codex/hooks/production-action-guard.mjs — and only at the point where the Sol
// proof would otherwise be demanded: CodeRabbit APPROVED on the exact head, every
// check green, the `--match-head-commit` pin and the head containing its base are
// all checked BEFORE this, and none of them is relaxed by it.
//
// ALLOW-LIST, not deny-list. A path is exempt only when it sits under one of the
// SOL_EXEMPT_PREFIXES, is a plain `.md` file, and matches nothing in the never
// lists. A new folder under docs/ needs Sol until someone adds it here on purpose.
// The never lists are checked as well, so widening the allow-list by mistake still
// cannot exempt a rule-defining document.
//
// FAIL CLOSED. Every uncertainty answers "Sol required": a GitHub call that fails
// or returns something unexpected, a comparison that is not exactly base..head, a
// file list that may be truncated, an empty file list, a rename or copy whose old
// name is not itself exempt, an unusual path spelling.
//
// The human-readable copy is docs/reference/sol-exempt-paths.md.
// sol-exempt-lib.test.mjs fails if the two lists drift apart, and it mutation-checks
// that widening any list or loosening any check here makes the tests fail.

import { ghApiRepoPath } from "./codex-push-lib.mjs";

// Folders whose plain `.md` files are documentation. Case-sensitive, from the repo root.
export const SOL_EXEMPT_PREFIXES = Object.freeze([
  "docs/changelog.d/",
  "docs/manual/",
  "docs/reference/",
  "docs/plans/",
  "docs/reports/",
  "docs/audits/",
  "docs/handoffs/",
  "docs/research/",
]);

// Never exempt, from the repo root: a folder (ending in "/") or one exact file.
// Compared case-insensitively, because on Windows `docs/Reference/Agent-Guardrails.md`
// checks out over `docs/reference/agent-guardrails.md`.
export const SOL_NEVER_EXEMPT_PATHS = Object.freeze([
  "src/",
  "supabase/",
  "scripts/",
  ".github/",
  ".claude/",
  ".codex/",
  ".agents/",
  ".husky/",
  ".coderabbit.yaml",
  "docs/workflows/",
  "docs/manual/OWNER_PLAYBOOK.md",
  "docs/reference/agent-guardrails.md",
  "docs/reference/codex-model-tuning.md",
  // Stricter than the proposal. The model-tuning sibling sets reviewer models and
  // prompts like codex-model-tuning.md does; this module's own readable copy is a
  // rule-defining document; migration-history.md is a ledger that hooks and the
  // migration review packet read, not only prose.
  "docs/reference/claude-model-tuning.md",
  "docs/reference/sol-exempt-paths.md",
  "docs/reference/migration-history.md",
]);

// Never exempt in ANY folder, compared case-insensitively. Claude Code and Codex
// both load a nested CLAUDE.md / AGENTS.md as instructions for that folder, so
// `docs/plans/CLAUDE.md` is agent configuration, not documentation. GEMINI.md and
// AGENT.md are the same kind of file for other agents.
export const SOL_NEVER_EXEMPT_NAMES = Object.freeze([
  "AGENTS.md",
  "AGENTS.override.md",
  "AGENT.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "GEMINI.md",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
]);

// GitHub's compare API lists at most 300 changed files and says nothing when it
// stops. A list this long or longer may be incomplete, so it needs Sol.
export const SOL_EXEMPT_MAX_FILES = 250;

// One path segment: starts and ends with a letter, digit, `_` or `-`, so no `.`/`..`
// segment, no hidden file, no trailing dot or space that Windows would strip.
const SEGMENT = "[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?";
const PLAIN_MARKDOWN_PATH_RE = new RegExp(`^(?:${SEGMENT}/)*${SEGMENT}\\.md$`);
const SHA_RE = /^[0-9a-f]{40}$/i;

// null when `file` is an exempt documentation path, otherwise why it needs Sol.
export function solExemptPathProblem(file) {
  const name = typeof file === "string" ? file : "";
  if (!name) return "a changed file has no readable name";
  const lower = name.toLowerCase();
  for (const entry of SOL_NEVER_EXEMPT_PATHS) {
    const rule = entry.toLowerCase();
    if (rule.endsWith("/") ? lower.startsWith(rule) : lower === rule) {
      return `${name} is never exempt (${entry})`;
    }
  }
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (SOL_NEVER_EXEMPT_NAMES.some((entry) => entry.toLowerCase() === base)) {
    return `${name} is never exempt (${base} anywhere in the tree)`;
  }
  if (!PLAIN_MARKDOWN_PATH_RE.test(name)) {
    return `${name} is not a plainly named .md file`;
  }
  if (!SOL_EXEMPT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return `${name} is outside the documentation folders`;
  }
  return null;
}

export const SOL_EXEMPT_STATUSES = Object.freeze(["added", "modified", "removed", "renamed", "copied"]);

// Classify GitHub compare `files` entries. Every name an entry carries is checked:
// a rename or copy is exempt only when BOTH its new and its old name are, so moving
// a file across the boundary in either direction needs Sol.
export function classifySolExemption(files) {
  if (!Array.isArray(files)) return { exempt: false, reason: "GitHub did not return the list of changed files" };
  if (files.length === 0) return { exempt: false, reason: "GitHub reported no changed files, so nothing can be shown to be documentation" };
  if (files.length >= SOL_EXEMPT_MAX_FILES) {
    return { exempt: false, reason: `${files.length} changed files is at or past the ${SOL_EXEMPT_MAX_FILES}-file limit, so the list may be truncated` };
  }
  for (const entry of files) {
    if (entry === null || typeof entry !== "object") return { exempt: false, reason: "a changed-file entry is unreadable" };
    const names = [entry.filename];
    const status = String(entry.status || "").toLowerCase();
    // Only the statuses a plain text edit produces. GitHub's `changed` means the
    // file's KIND changed (a file became a symlink, say); a missing or unknown
    // status is not something this check understands.
    if (!SOL_EXEMPT_STATUSES.includes(status)) {
      return { exempt: false, reason: `${entry.filename || "a file"} has change status "${entry.status}", which is not a plain edit` };
    }
    if (status === "renamed" || status === "copied" || (entry.previous_filename !== undefined && entry.previous_filename !== null)) {
      if (typeof entry.previous_filename !== "string" || !entry.previous_filename) {
        return { exempt: false, reason: `${entry.filename || "a file"} was ${status || "moved"} but GitHub did not say from where` };
      }
      names.push(entry.previous_filename);
    }
    for (const name of names) {
      const problem = solExemptPathProblem(name);
      if (problem) return { exempt: false, reason: problem };
    }
  }
  return { exempt: true, reason: `all ${files.length} changed file(s) are documentation on the allow-list`, fileCount: files.length };
}

// Projection of GitHub's compare answer: patches can run to megabytes, and only
// these fields decide the exemption. `head` is the newest commit in the
// comparison (GitHub keeps the newest last even when it shortens the list), so
// the answer can be bound to the head that was asked about.
export const SOL_EXEMPT_COMPARE_JQ =
  "{status: .status, ahead_by: .ahead_by, behind_by: .behind_by, merge_base: .merge_base_commit.sha, " +
  "head: (if (.commits | type) == \"array\" and (.commits | length) > 0 then .commits[-1].sha else null end), " +
  "files: (if (.files | type) == \"array\" then [.files[] | {filename, previous_filename, status}] else null end)}";

// A plain, non-executable file in git (mode 100644). A symlink is 120000, a
// submodule 160000 (type "commit"), an executable 100755: none of them is
// documentation, and GitHub's comparison does not say which one a path is.
const PLAIN_FILE_MODE = 0o100644;

// One GraphQL query listing every folder that holds a changed file, at the commit
// where that file exists. Paths travel as variables, never as query text.
export function solExemptTreeQuery(folderCount) {
  const variables = Array.from({ length: folderCount }, (_, i) => `$e${i}: String!`).join(", ");
  const fields = Array.from({ length: folderCount }, (_, i) =>
    `d${i}: object(expression: $e${i}) { ... on Tree { entries { name mode type } } }`).join(" ");
  return `query($owner: String!, $name: String!, ${variables}) { repository(owner: $owner, name: $name) { ${fields} } }`;
}

// null when every changed file is a plain file where it exists, otherwise why
// not. A file the pull request adds or keeps is read at the head; a deleted file,
// and the old name of a rename or copy, at the base, so deleting or moving a
// symlink or submodule needs Sol too.
function treeProblem({ files, baseSha, headSha, repoPath, gh }) {
  const lookups = [];
  for (const entry of files) {
    const removed = String(entry.status).toLowerCase() === "removed";
    lookups.push({ commit: removed ? baseSha : headSha, file: entry.filename });
    if (typeof entry.previous_filename === "string" && entry.previous_filename) {
      lookups.push({ commit: baseSha, file: entry.previous_filename });
    }
  }
  const folderOf = ({ commit, file }) => `${commit}:${file.slice(0, file.lastIndexOf("/"))}`;
  const expressions = [...new Set(lookups.map(folderOf))];
  const [, owner, name] = repoPath.split("/");
  const args = ["api", "graphql", "-f", `query=${solExemptTreeQuery(expressions.length)}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
  expressions.forEach((expression, i) => args.push("-f", `e${i}=${expression}`));
  let repository;
  try {
    repository = JSON.parse(String(gh(args)))?.data?.repository;
  } catch (error) {
    return `GitHub could not confirm what kind of files changed (${String(error?.message || error).split(/\r?\n/)[0].slice(0, 160)})`;
  }
  for (const lookup of lookups) {
    const entries = repository?.[`d${expressions.indexOf(folderOf(lookup))}`]?.entries;
    const leaf = lookup.file.slice(lookup.file.lastIndexOf("/") + 1);
    const where = lookup.commit === headSha ? "the head" : "the base";
    const entry = Array.isArray(entries) ? entries.find((candidate) => candidate?.name === leaf) : undefined;
    if (!entry) return `GitHub did not show ${lookup.file} at ${where} (${lookup.commit.slice(0, 12)})`;
    if (entry.type !== "blob" || entry.mode !== PLAIN_FILE_MODE) {
      return `${lookup.file} is not a plain file at ${where} (git type ${entry.type}, mode ${Number(entry.mode).toString(8)})`;
    }
  }
  return null;
}

// Asks GitHub which files `baseSha...headSha` changes, whether that is exactly the
// pull request's own diff, and whether each file is a plain file at that head.
// `gh(args)` runs the GitHub CLI and returns stdout; each guard passes its
// budgeted runner. Never throws: any failure is "Sol required".
export function solExemptionOnGitHub({ baseSha: rawBase, headSha: rawHead, repo, gh }) {
  const repoPath = ghApiRepoPath(repo);
  if (!repoPath) return { exempt: false, reason: "the pull request's repository could not be read" };
  if (!SHA_RE.test(String(rawBase || "")) || !SHA_RE.test(String(rawHead || ""))) {
    return { exempt: false, reason: "the base or head is not a full commit id" };
  }
  const baseSha = String(rawBase).toLowerCase();
  const headSha = String(rawHead).toLowerCase();
  let answer;
  try {
    answer = JSON.parse(String(gh(["api", `${repoPath}/compare/${baseSha}...${headSha}`, "--jq", SOL_EXEMPT_COMPARE_JQ])));
  } catch (error) {
    return { exempt: false, reason: `GitHub's file list could not be read (${String(error?.message || error).split(/\r?\n/)[0].slice(0, 160)})` };
  }
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
    return { exempt: false, reason: "GitHub's comparison answer is unreadable" };
  }
  // Exactly base..head: the head is ahead of the base, not behind it, and the
  // comparison starts AT the base. Anything else is not this pull request's diff.
  if (answer.status !== "ahead" || answer.behind_by !== 0 || !Number.isInteger(answer.ahead_by) || answer.ahead_by < 1) {
    return { exempt: false, reason: `GitHub's comparison is not a clean base..head diff (status ${answer.status}, behind by ${answer.behind_by})` };
  }
  if (String(answer.merge_base || "").toLowerCase() !== String(baseSha).toLowerCase()) {
    return { exempt: false, reason: "GitHub's comparison does not start at the pull request's base" };
  }
  if (String(answer.head || "").toLowerCase() !== String(headSha).toLowerCase()) {
    return { exempt: false, reason: "GitHub's comparison does not end at the pull request's head" };
  }
  try {
    const verdict = classifySolExemption(answer.files);
    if (!verdict.exempt) return verdict;
    const problem = treeProblem({ files: answer.files, baseSha, headSha, repoPath, gh });
    return problem ? { exempt: false, reason: problem } : verdict;
  } catch (error) {
    return { exempt: false, reason: `GitHub's file list could not be classified (${String(error?.message || error).slice(0, 160)})` };
  }
}

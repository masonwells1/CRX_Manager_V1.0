// Protected-surface parity: the three by-name lists that gate the review/merge/
// apply machinery must agree, and every tracked entry under .claude/ and .codex/
// must be decided — protected, or deliberately open with a written reason.
//
//   1. .claude/settings.json `permissions.ask` — the ONLY gate for the four native
//      editors (review-proof-guard exempts Write/Edit/MultiEdit/NotebookEdit).
//   2. review-proof-guard.mjs ENFORCEMENT_SURFACE_RE (shell writers) and its
//      path-field twin (MCP write_file/move_file/…) — the hard deny that holds in
//      every permission mode, including bypass sessions where `ask` is honoured by
//      nothing.
//   3. codex-push-lib.mjs RISKY_PATH_RES — a diff touching one of these needs the
//      exact-SHA independent review before it can merge.
//
// PR #605 produced twelve review rounds and every one had the same shape: a path
// named in one list and missing from another (MultiEdit/NotebookEdit; the
// .claude/agents charters; write-apply-proofs-lib.mjs; .claude/launch.json; …).
// Manual agreement does not hold, so this test makes the disagreement a CI failure.
// It deliberately does NOT refactor the three lists into one constant: the settings
// file is JSON the permission resolver reads, the hook regex judges command text,
// and the risky set judges diff paths — three consumers, three shapes.
//
// Run:  node .claude/hooks/protected-surface-parity.test.mjs
//       PROTECTED_SURFACE_ROOT=<other checkout> node .claude/hooks/protected-surface-parity.test.mjs
// The second form judges another checkout's three lists (used to prove this test
// FAILS on the pre-fix tree, e.g. 02b342610, where the hook lacked the charters).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.PROTECTED_SURFACE_ROOT || path.join(here, "..", ".."));
const rel = (...p) => path.join(ROOT, ...p);

const EDITORS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

// Tracked top-level entries under .claude/ and .codex/ that are DELIBERATELY outside
// the protected set. An entry in neither bucket fails the test: decide it.
// The rule for the protected bucket: a proof or gate producer READS it from the
// working tree at decision time (charters, the minter and its helper, the schema
// registry four PreToolUse hooks consult, the caller graph the grant guard trusts),
// or CI/husky EXECUTES it (the two .test.mjs files under .claude/workflows and the
// command/skill files check-agent-workflows.mjs and check-agent-guidance.mjs read
// by name, all inside `npm run test:agent-workflows` — package.json:57, ci.yml:468,
// .husky/pre-commit:43), or a tool EXECUTES it (launch.json), or it REGISTERS the
// guards (settings, hooks manifests, husky, workflows, package.json scripts).
//
// This map is EMPTY as of PR #605 round thirteen: every tracked top-level entry is
// protected. It stays because the mechanism, not its current contents, is the point —
// a new entry under .claude/ or .codex/ fails this test until someone either protects
// it or records here, in writing, why it is deliberately open. Mason's 2026-09-03
// ruling against a blanket `.claude/**` ask is what keeps the list by-name; this test
// is what keeps a by-name list honest.
const OPEN_BY_DECISION = new Map([]);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function gitLsFiles() {
  const r = spawnSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ls-files failed in ${ROOT}: ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter(Boolean).map((p) => p.replace(/\\/g, "/"));
}

// Claude Code permission-rule glob → anchored RegExp on a repo-relative path.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 1;
      } else {
        re += "[^/]*";
      }
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}

// One concrete path that the pattern must cover, for the real-hook probes.
function samplePath(glob) {
  return glob.replace(/\*\*/g, "probe-dir/probe-file.mjs").replace(/\*/g, "probe");
}

function extractRegex(src, label, anchor) {
  const m = src.match(anchor);
  assert.ok(m, `could not locate the ${label} literal in review-proof-guard.mjs — update the anchor in this test`);
  return new RegExp(m[1], m[2]);
}

function runGuard(payload) {
  return spawnSync(process.execPath, [rel(".claude", "hooks", "review-proof-guard.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: ROOT,
  });
}

const failures = [];
const fail = (msg) => failures.push(msg);

// ---- 1. settings.json: every protected pattern names all four native editors ----
const settings = readJson(rel(".claude", "settings.json"));
const askEntries = settings?.permissions?.ask || [];
const editorsByPattern = new Map();
for (const entry of askEntries) {
  const m = /^(Edit|Write|MultiEdit|NotebookEdit)\((.+)\)$/.exec(entry);
  if (!m) continue;
  if (!editorsByPattern.has(m[2])) editorsByPattern.set(m[2], new Set());
  editorsByPattern.get(m[2]).add(m[1]);
}
assert.ok(editorsByPattern.size > 0, "settings.json has no native-editor ask entries — the protected set is empty");
for (const [pattern, editors] of editorsByPattern) {
  const missing = EDITORS.filter((e) => !editors.has(e));
  if (missing.length) fail(`settings ask: "${pattern}" names ${[...editors].join("/")} but not ${missing.join("/")} — every exempted native editor must be listed`);
}
const patterns = [...editorsByPattern.keys()];
const patternRes = patterns.map((p) => ({ pattern: p, re: globToRegExp(p) }));
const settingsProtects = (p) => patternRes.some(({ re }) => re.test(p));

// ---- 2. the hook's two regexes and the risky-path set ----
const guardSrc = readFileSync(rel(".claude", "hooks", "review-proof-guard.mjs"), "utf8");
const shellRe = extractRegex(
  guardSrc,
  "ENFORCEMENT_SURFACE_RE",
  // The literal carries a raw `/` inside a character class, so match lazily up to
  // the `/flags;` that ends its line.
  /const ENFORCEMENT_SURFACE_RE =\s*\/(.+?)\/([a-z]*);[ \t]*$/m,
);
const pathRe = extractRegex(
  guardSrc,
  "path-field enforcement regex",
  /return \/(\(\?:\^\|\\\/\)\(\?:\\\.husky.+?)\/([a-z]*)\s*\n\s*\.test\(/,
);
const { riskyFiles } = await import(pathToFileURL(rel(".claude", "hooks", "codex-push-lib.mjs")).href);
assert.equal(typeof riskyFiles, "function", "codex-push-lib.mjs must export riskyFiles");

const shellHits = (p) => shellRe.test(` ${p}`);
const pathHits = (p) => pathRe.test(`/${p}`);
const isRisky = (p) => riskyFiles([p]).length > 0;

// ---- 3. corpus: every tracked path plus one sample per pattern, both directions ----
const tracked = gitLsFiles();
const samples = patterns.map(samplePath);
const corpus = [...new Set([...tracked, ...samples])];
assert.ok(tracked.length > 100, `git ls-files returned only ${tracked.length} paths — wrong ROOT?`);

for (const p of corpus) {
  const s = settingsProtects(p);
  const h = shellHits(p);
  const f = pathHits(p);
  const r = isRisky(p);
  if (s) {
    if (!h) fail(`"${p}" is native-editor protected (settings ask) but a shell write to it is NOT denied by review-proof-guard ENFORCEMENT_SURFACE_RE`);
    if (!f) fail(`"${p}" is native-editor protected (settings ask) but an MCP path-field write to it is NOT denied by review-proof-guard`);
    if (!r) fail(`"${p}" is native-editor protected (settings ask) but is NOT in codex-push-lib RISKY_PATH_RES, so its diff can merge without the exact-SHA review`);
  } else if (h || f) {
    fail(`"${p}" is hard-denied for shell/path-field writers by review-proof-guard but has no settings ask entry — native Edit/Write/MultiEdit/NotebookEdit rewrite it silently under acceptEdits`);
  }
}

// ---- 4. the real hook, one sample per pattern: deny writes, stay silent on reads ----
for (const sample of samples) {
  const shell = runGuard({ tool_name: "Bash", tool_input: { command: `printf x > ${sample}` } });
  if (!/"permissionDecision":"deny"/.test(shell.stdout)) fail(`real hook: Bash \`printf x > ${sample}\` was NOT denied (stdout: ${shell.stdout.slice(0, 120) || "<silent>"})`);
  const copy = runGuard({ tool_name: "Bash", tool_input: { command: `cp /tmp/evil ${sample}` } });
  if (!/"permissionDecision":"deny"/.test(copy.stdout)) fail(`real hook: Bash \`cp /tmp/evil ${sample}\` was NOT denied`);
  const field = runGuard({ tool_name: "mcp__filesystem__write_file", tool_input: { path: sample } });
  if (!/"permissionDecision":"deny"/.test(field.stdout)) fail(`real hook: mcp__filesystem__write_file path=${sample} was NOT denied`);
  const read = runGuard({ tool_name: "Bash", tool_input: { command: `cat ${sample}` } });
  // PR #605 F5 (found by hand, same species as CodeRabbit F4): silent must also mean exit 0,
  // otherwise a crashed guard (empty stdout, non-zero status) reads as a clean allow here.
  if (read.status !== 0) fail(`real hook: reading ${sample} with cat exited ${read.status} (stderr: ${(read.stderr || "").slice(0, 120)})`);
  if (read.stdout !== "") fail(`real hook: reading ${sample} with cat was NOT silent (stdout: ${read.stdout.slice(0, 120)})`);
}

// ---- 5. every tracked top-level entry under .claude/ and .codex/ is decided ----
const topLevel = new Set();
for (const p of tracked) {
  const m = /^(\.claude|\.codex)\/([^/]+)/.exec(p);
  if (m) topLevel.add(`${m[1]}/${m[2]}`);
}
for (const entry of topLevel) {
  const isDir = tracked.some((p) => p.startsWith(`${entry}/`));
  const probe = isDir ? `${entry}/probe-dir/probe-file.mjs` : entry;
  const protectedEntry = settingsProtects(probe) && (!isDir || settingsProtects(`${entry}/probe-file.md`));
  const open = OPEN_BY_DECISION.has(entry);
  if (protectedEntry && open) fail(`"${entry}" is both settings-protected and listed in OPEN_BY_DECISION — remove one`);
  if (!protectedEntry && !open) {
    fail(
      `"${entry}" is in neither bucket: add it to the protected set (settings ask × ${EDITORS.length} editors, review-proof-guard shell + path-field patterns, RISKY_PATH_RES) or record it in OPEN_BY_DECISION with the reason it is deliberately open`,
    );
  }
}
for (const [entry, reason] of OPEN_BY_DECISION) {
  if (!topLevel.has(entry)) fail(`OPEN_BY_DECISION names "${entry}" but no tracked file lives there — stale entry`);
  if (!reason || reason.length < 20) fail(`OPEN_BY_DECISION "${entry}" needs a written reason`);
}

if (failures.length) {
  console.error(`protected-surface-parity: ${failures.length} divergence(s) in ${ROOT}\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log(
  `protected-surface-parity ok: ${patterns.length} patterns × ${EDITORS.length} editors = ${patterns.length * EDITORS.length} ask entries; ` +
    `${tracked.length} tracked paths agree across settings ask / review-proof-guard / RISKY_PATH_RES; ` +
    `${topLevel.size} top-level .claude|.codex entries decided (${OPEN_BY_DECISION.size} deliberately open)`,
);

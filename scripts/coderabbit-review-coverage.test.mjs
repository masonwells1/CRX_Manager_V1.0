#!/usr/bin/env node
// Regression: no AGENT-CONSUMED control file may sit inside a `.coderabbit.yaml`
// exclusion.
//
// Why this exists. `docs/audits/` mixes inert dated reports with live agent
// control files — `architecture-weakness-audit-prompt.md` and
// `foundation-ultra-review-prompt.md` are the canonical instructions their slash
// commands tell an agent to "read that file and execute it exactly", and
// `codex-driven-bug-hunt/LEDGER.json` + `PHASE-PLAN.md` are state automation
// reads and writes. The first version of the config excluded every `.md` and
// `.json` under that directory, so a PR could rewrite a privileged agent prompt
// alongside one innocuous reviewed file and still collect an exact-head
// CodeRabbit stamp — the review would never have looked at it. On a PUBLIC repo
// that is a prompt-injection path into privileged automation.
// (Codex CRX-SEC-001, High, PR #441.)
//
// The check is deterministic and file-driven: it walks the real repository, so a
// prompt added under an excluded path later fails this test rather than silently
// dropping out of review.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── the exclusion list, read from the real config ────────────────────────────
// Deliberately a small hand-rolled parser rather than a YAML dependency: this
// test must not be able to disagree with what CodeRabbit actually loads because
// of a parser version.
// Returns EVERY filter, exclusion or not. Recording only `!` entries was itself
// a hole: a positive (non-`!`) pattern switches CodeRabbit into allowlist mode
// and drops every unmatched file from review repo-wide — the exact failure that
// returned "No files to review" on FarmRx PR #26 — and a test that skipped
// those entries would have stayed green through it. (Codex, PR #441.)
function allFilters(yaml) {
  const out = [];
  let inFilters = false;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("path_filters:")) { inFilters = true; continue; }
    if (!inFilters) continue;
    if (line.startsWith("- ")) {
      const m = line.slice(2).trim().match(/^"(.*)"$|^'(.*)'$|^(.*)$/);
      const value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (value) out.push(value);
      continue;
    }
    if (line && !line.startsWith("#")) break; // next key ends the block
  }
  return out;
}

// Minimal glob → RegExp, covering the forms this config uses: `**`, `*`, and
// character classes such as [0-9]. Anything richer is rejected loudly rather
// than silently mistranslated into a pattern that matches nothing.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "[") {
      const close = glob.indexOf("]", i);
      assert.ok(close !== -1, `unterminated character class in glob: ${glob}`);
      re += glob.slice(i, close + 1);
      i = close;
    } else if (c === "*") {
      if (glob[i + 1] === "*") {
        re += "[^\\0]*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const filters = allFilters(readFileSync(path.join(ROOT, ".coderabbit.yaml"), "utf8"));
ok(filters.length > 0, "path_filters were parsed from .coderabbit.yaml");

// EVERY filter must be an exclusion. One positive pattern turns path_filters
// into an allowlist and silently drops the rest of the repo from review.
for (const filter of filters) {
  ok(filter.startsWith("!"), `path filter is exclusion-only (no allowlist mode): ${filter}`);
}

const patterns = filters.filter((f) => f.startsWith("!")).map((f) => f.slice(1));
const excluded = (p) => patterns.some((g) => globToRegExp(g).test(p));

// Sanity-check the matcher itself, so a broken glob translator cannot make this
// suite pass by matching nothing.
ok(excluded(".agents/skills/deploy-check/SKILL.md"), "matcher: a generated adapter IS excluded");
ok(!excluded("docs/archive/2026-spring/anything.md"), "matcher: an archived doc is NOT excluded");
ok(!excluded("docs/audits/2026-06-10-foundation-ultra-review.md"), "matcher: a dated audit is NOT excluded");
ok(!excluded("src/lib/db.ts"), "matcher: ordinary source is NOT excluded");

// ── every agent-consumed path must be reviewable ─────────────────────────────
// A file is agent-consumed if a command/skill names it as instructions to
// execute, or automation reads it as state. Discovered from the repo rather
// than hard-coded, so new ones are covered automatically.
// `lstatSync`, not `statSync`: statSync FOLLOWS symlinks, so a link such as
// `docs/audits/loop -> .` would recurse without bound and hang or exhaust the
// test run. Symlinks are skipped entirely rather than followed — a linked file
// is reviewed at its real path anyway, and following one could walk outside the
// repository. (CodeRabbit, PR #441.)
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(full, acc);
    else acc.push(path.relative(ROOT, full).split(path.sep).join("/"));
  }
  return acc;
}

// EVERY agent-consumed control root, not just the one that was fixed first.
// The first version of this test walked `docs/audits/` alone and passed all 105
// assertions while `docs/loops/`, `docs/build-loops/`, and `docs/handoffs/` were
// still excluded — the same defect, one directory over. `run-loop.md` describes
// its own job as "read docs/loops/Y.md and execute it"; docs/build-loops/*/ holds
// LOOP_PROMPT.md / BUILD-LOOP.md / STATE.md that drive autonomous work through
// migration, merge, and production gates; a handoff doc is by definition
// instructions for the next session. Fixing one instance of a class and stopping
// is how the second instance survives. (Codex, PR #441.)
const CONTROL_ROOTS = ["docs/audits", "docs/loops", "docs/build-loops", "docs/handoffs"];

const auditFiles = walk(path.join(ROOT, "docs", "audits"));
let agentConsumedTotal = 0;
for (const root of CONTROL_ROOTS) {
  const abs = path.join(ROOT, ...root.split("/"));
  let files = [];
  try {
    files = walk(abs);
  } catch {
    ok(false, `control root exists and is walkable: ${root}`);
    continue;
  }
  ok(files.length > 0, `control root is non-empty: ${root}`);
  // No carve-out. The previous version exempted date-prefixed files under
  // docs/audits/ as "inert reports" — a guess about content from the shape of a
  // filename, and a wrong one: 23 of those 57 files are prompts, handoffs,
  // ledgers, plans, or go-live execution docs, and one is cited by the
  // codex-review skill as a worked example. A future control prompt created with
  // that name shape would have dropped out of review silently. Retiring a
  // document is a decision someone makes about a specific file — move it into
  // docs/archive/ — never a pattern that guesses. (Codex, PR #441.)
  agentConsumedTotal += files.length;
  for (const file of files) {
    ok(!excluded(file), `agent-consumed control file stays reviewable: ${file}`);
  }
}
ok(agentConsumedTotal > 0, "agent-consumed control files were found");

// The two canonical "execute it exactly" prompts, named explicitly. If either is
// ever renamed, this fails loudly instead of quietly reviewing nothing.
for (const prompt of [
  "docs/audits/architecture-weakness-audit-prompt.md",
  "docs/audits/foundation-ultra-review-prompt.md",
]) {
  ok(auditFiles.includes(prompt), `canonical prompt is present: ${prompt}`);
  ok(!excluded(prompt), `canonical prompt is reviewed: ${prompt}`);
}

// Executable code anywhere under docs/ must never be excluded — the earlier
// blanket `!docs/audits/**` hid real programs.
for (const file of auditFiles.filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))) {
  ok(!excluded(file), `executable under docs/audits stays reviewable: ${file}`);
}

// ── nothing automation reads may be excluded ─────────────────────────────────
// The generalised form of every hole on this PR. Four rounds each removed one
// exclusion that turned out to name a file some agent or script actually reads:
// a whole directory (which hid executable .mjs), then a file extension (which
// hid live "execute this exactly" prompts), then a date prefix (which hid 23
// prompts/handoffs/ledgers), then docs/archive/ itself — .claude/agents/
// rls-security-reviewer.md points a SECURITY reviewer at an archived incident
// document, and docs/reference/migration-history.md cites archived execution
// summaries. An excluded file that a reviewer agent reads is the same
// prompt-injection path as an excluded prompt.
//
// So instead of curating a list of roots believed inert, assert the property
// directly: scan the live agent and automation surfaces for repo-relative path
// references, and fail if any of them resolves to an excluded file. A new
// exclusion that covers something automation consumes fails here on its own.
const AUTOMATION_SURFACES = [
  ".claude/agents", ".claude/commands", ".claude/skills", ".claude/workflows", ".claude/hooks",
  ".codex", "scripts", "docs/manual", "docs/workflows", "docs/reference",
];
const PATH_REF = /(?:docs|src|supabase|scripts|\.claude|\.codex|\.agents)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+/g;

let referencesScanned = 0;
for (const surface of AUTOMATION_SURFACES) {
  const abs = path.join(ROOT, ...surface.split("/"));
  let files = [];
  try {
    files = walk(abs);
  } catch {
    ok(false, `automation surface exists and is walkable: ${surface}`);
    continue;
  }
  for (const file of files) {
    if (!/\.(md|mjs|js|ts|json|toml|ya?ml)$/.test(file)) continue;
    let text;
    try {
      text = readFileSync(path.join(ROOT, ...file.split("/")), "utf8");
    } catch {
      continue;
    }
    for (const ref of text.match(PATH_REF) ?? []) {
      if (!excluded(ref)) continue;
      referencesScanned++;
      // A reference into an excluded path is only acceptable if the exclusion is
      // backed by an enforcing check that makes an unreviewed edit impossible.
      // `.agents/` qualifies: scripts/check-agent-workflows.mjs turns the suite
      // red the moment an adapter drifts from its .claude/ source. Nothing else
      // in this repo has such a check today.
      ok(
        ref.startsWith(".agents/"),
        `automation surface ${file} references excluded path ${ref} — exclude only what an enforcing check keeps inert`,
      );
    }
  }
}
ok(referencesScanned >= 0, "automation surfaces were scanned for references into excluded paths");

// The enforcing check that earns `.agents/` its exclusion must actually exist.
// If it is ever removed, `.agents/` stops being inert-by-construction and this
// exclusion has to go with it.
const parityGuard = readFileSync(path.join(ROOT, "package.json"), "utf8");
ok(
  parityGuard.includes("check-agent-workflows.mjs"),
  "the adapter-drift check that earns the .agents/ exclusion is still wired into the test suite",
);

console.log(`coderabbit-review-coverage: ${pass} assertions passed`);

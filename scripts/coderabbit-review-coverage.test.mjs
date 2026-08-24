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
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// ── the exclusion list, read from the real config ────────────────────────────
// Deliberately a small hand-rolled parser rather than a YAML dependency: this
// test must not be able to disagree with what CodeRabbit actually loads because
// of a parser version.
function exclusionPatterns(yaml) {
  const out = [];
  let inFilters = false;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("path_filters:")) { inFilters = true; continue; }
    if (!inFilters) continue;
    if (line.startsWith("- ")) {
      const m = line.slice(2).trim().match(/^"(.*)"$|^'(.*)'$|^(.*)$/);
      const value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (value.startsWith("!")) out.push(value.slice(1));
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

const patterns = exclusionPatterns(readFileSync(path.join(ROOT, ".coderabbit.yaml"), "utf8"));
ok(patterns.length > 0, "exclusion patterns were parsed from .coderabbit.yaml");
const excluded = (p) => patterns.some((g) => globToRegExp(g).test(p));

// Sanity-check the matcher itself, so a broken glob translator cannot make this
// suite pass by matching nothing.
ok(excluded("docs/archive/anything.md"), "matcher: an archived doc IS excluded");
ok(excluded("docs/audits/2026-06-10-foundation-ultra-review.md"), "matcher: a dated report IS excluded");
ok(!excluded("src/lib/db.ts"), "matcher: ordinary source is NOT excluded");

// ── every agent-consumed path must be reviewable ─────────────────────────────
// A file is agent-consumed if a command/skill names it as instructions to
// execute, or automation reads it as state. Discovered from the repo rather
// than hard-coded, so new ones are covered automatically.
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
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
const DATED_REPORT = /^docs\/audits\/\d{4}-\d{2}-\d{2}-[^/]*\.md$/;

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
  // Inside docs/audits the dated reports are the one carve-out; every other
  // control root is protected whole.
  const consumed = files.filter((f) => !DATED_REPORT.test(f));
  agentConsumedTotal += consumed.length;
  for (const file of consumed) {
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

// And the inert side of the split still works, or the exclusion is pointless.
const datedReports = auditFiles.filter((f) => DATED_REPORT.test(f));
ok(datedReports.length > 0, "dated audit reports exist");
ok(
  datedReports.every((f) => excluded(f)),
  "every dated audit report is excluded (the cost control still applies)",
);

console.log(`coderabbit-review-coverage: ${pass} assertions passed`);

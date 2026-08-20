#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEol } from "./normalize-eol.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const TARGET_ROOT = path.join(ROOT, ".agents");

function unix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const output = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(full));
    else if (entry.isFile()) output.push(full);
  }
  return output;
}

function commandTitle(markdown, fallback) {
  // A "# ..." line inside a ``` fence (e.g. a bash comment in an example) is not
  // a heading — strip fenced blocks before looking for the H1.
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "");
  const heading = withoutFences.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function buildExpected() {
  const expected = new Map();
  const skillsRoot = path.join(ROOT, ".claude", "skills");
  const skillNames = new Set();

  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    skillNames.add(entry.name);
    const sourceRoot = path.join(skillsRoot, entry.name);
    for (const source of walkFiles(sourceRoot)) {
      const relativeWithinSkill = path.relative(sourceRoot, source);
      expected.set(unix(path.join("skills", entry.name, relativeWithinSkill)), readFileSync(source, "utf8"));
    }
  }

  const commandsRoot = path.join(ROOT, ".claude", "commands");
  for (const commandFile of readdirSync(commandsRoot).filter((name) => name.endsWith(".md")).sort()) {
    const name = commandFile.replace(/\.md$/, "");
    if (skillNames.has(name)) continue;
    const source = readFileSync(path.join(commandsRoot, commandFile), "utf8");
    const title = commandTitle(source, name);
    const description = `Use when the user asks for the CRX ${title} workflow; loads the canonical command from .claude/commands/${commandFile}.`;
    const adapter = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${title}\n\nRead \`.claude/commands/${commandFile}\` from the active repository root completely and follow it as the source of truth.\n\nShared safety and approval rules remain in \`AGENTS.md\`.\n`;
    expected.set(`skills/${name}/SKILL.md`, adapter);
  }

  expected.set("README.md", `# Codex Agent Workflows\n\nThis directory is generated from \`.claude/skills/\` and \`.claude/commands/\`.\n\n- Edit the Claude source files.\n- Run \`node scripts/sync-agent-workflows.mjs --write\`.\n- Verify with \`node scripts/sync-agent-workflows.mjs --check\`.\n- Shared hook implementations stay in \`.claude/hooks/\`; Codex invokes them through \`.codex/hooks.json\`.\n`);

  const managed = [...expected.keys()].sort();
  expected.set("generated-manifest.json", `${JSON.stringify({ version: 1, managed }, null, 2)}\n`);
  return expected;
}

function previousManagedFiles(targetRoot = TARGET_ROOT) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(targetRoot, "generated-manifest.json"), "utf8"));
    return Array.isArray(parsed.managed) ? parsed.managed : [];
  } catch {
    return [];
  }
}

export function writeExpected(expected, targetRoot = TARGET_ROOT) {
  const expectedNames = new Set(expected.keys());
  for (const stale of previousManagedFiles(targetRoot)) {
    if (!expectedNames.has(stale)) rmSync(path.join(targetRoot, stale), { force: true });
  }
  for (const [relative, content] of expected) {
    const target = path.join(targetRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    // Write the LF form, then compare the target's RAW bytes against it. Skill and
    // command mirrors are byte copies of their .claude sources, so a CRLF-smudged
    // source used to make --write copy CRLF straight into .agents/**.
    //
    // Do NOT normalize the target before comparing. That was the first attempt at
    // this fix and it is a no-op on the case that matters: a CRLF mirror
    // normalizes to `canonical`, the write is skipped, and the file stays CRLF
    // while --write prints "Synced". Comparing raw is what makes the "run
    // --write" remedy the health check prints actually repair a smudged mirror.
    // It is still idempotent - an already-LF mirror equals `canonical` byte for
    // byte, so the common case writes nothing.
    // Compare BYTES, not decoded strings. Decoding maps any invalid UTF-8 byte to
    // U+FFFD, so a corrupt target could decode equal to canonical text containing
    // that character and be skipped - the same shape of bug as the CRLF one above,
    // where the comparison was looser than the write.
    const canonical = Buffer.from(normalizeEol(content), "utf8");
    if (!existsSync(target) || !readFileSync(target).equals(canonical)) {
      writeFileSync(target, canonical);
    }
  }
  console.log(`Synced ${expected.size - 2} Codex workflow file(s) from .claude.`);
}

// Compare adapter content IGNORING line endings. The generator emits LF and
// .gitattributes pins .agents/** to LF, but a checkout where core.autocrlf still
// rewrote a file to CRLF would otherwise report identical text as "stale" — a
// false failure that bricked commits in fresh worktrees (2026-07-16 scaffolding
// review). Line endings are not content drift; the committed form is LF-pinned
// regardless, so normalizing here tests what the check is FOR (real drift).
// `normalizeEol` is shared with scripts/agent-health-check.mjs: the two used to
// define "in sync" differently, so the same commit could FAIL one and PASS the
// other. Keep the single definition in scripts/normalize-eol.mjs.

function checkExpected(expected) {
  const mismatches = [];
  for (const [relative, content] of expected) {
    const target = path.join(TARGET_ROOT, relative);
    if (!existsSync(target)) mismatches.push(`${relative} is missing`);
    else if (normalizeEol(readFileSync(target, "utf8")) !== normalizeEol(content)) mismatches.push(`${relative} is stale`);
  }
  const actualFiles = walkFiles(TARGET_ROOT)
    .map((file) => unix(path.relative(TARGET_ROOT, file)))
    .filter((relative) => !relative.startsWith("session-state/"));
  for (const extra of actualFiles.filter((relative) => !expected.has(relative))) {
    mismatches.push(`${extra} is not generated from .claude`);
  }
  if (mismatches.length > 0) {
    for (const mismatch of mismatches) console.error(`FAIL ${mismatch}`);
    console.error("Run: node scripts/sync-agent-workflows.mjs --write");
    process.exit(1);
  }
  console.log(`PASS - ${expected.size - 2} Codex workflow file(s) match .claude sources.`);
}

// Run the CLI only when this file IS the entry point. sync-agent-workflows.test.mjs
// imports writeExpected to prove the CRLF-mirror repair, and importing a module
// whose top level regenerates .agents/** would rewrite the real tree as a side
// effect of running the test suite. Compare resolved paths rather than basenames:
// .husky and CI invoke this as `node scripts/sync-agent-workflows.mjs --write`,
// check-agent-workflows.mjs spawns it by absolute path, and both must still run.
//
// Case-fold on Windows. `path.resolve` builds the entry path from process.cwd(),
// whose drive letter casing comes from whatever launched the shell, while
// fileURLToPath returns the casing in the module URL. A `C:` vs `c:` mismatch
// would silently skip the CLI, and the caller in check-agent-workflows.mjs keyed
// off the exit code alone - so a skipped --check would exit 0 and be reported as
// "synced" while checking nothing. That caller now also requires the PASS line;
// this comparison is the other half of closing that fail-silent path.
export function isEntryPoint(argvPath, moduleUrl) {
  if (!argvPath) return false;
  const normalize = (value) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(argvPath) === normalize(fileURLToPath(moduleUrl));
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  const mode = process.argv[2] || "--check";
  const expected = buildExpected();
  if (mode === "--write") writeExpected(expected);
  else if (mode === "--check") checkExpected(expected);
  else {
    console.error("Usage: node scripts/sync-agent-workflows.mjs --write|--check");
    process.exit(2);
  }
}

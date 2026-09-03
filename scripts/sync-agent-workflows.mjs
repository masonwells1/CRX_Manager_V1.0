#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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
  // Union of what we own now, what the last sync owned, and every importer
  // directory previously recorded - see previousManifest() for why this must
  // survive the wholesale rewrite of `managed`.
  const prior = previousManifest();
  const owned = durableOwnedImporterDirs();
  for (const key of [...managed, ...prior.managed]) {
    const dir = importerDirOf(key);
    if (dir) owned.add(dir);
  }
  const ownedImporterDirs = [...owned].sort();
  expected.set(
    "generated-manifest.json",
    `${JSON.stringify({ version: 1, managed, ownedImporterDirs }, null, 2)}\n`,
  );
  return expected;
}

// The manifest carries TWO kinds of memory, and they expire differently.
//
// `managed` is the current file list: it is rewritten wholesale on every --write,
// so it only ever describes the last sync.
//
// `ownedImporterDirs` is durable and MONOTONIC. Deleting a canonical `.claude`
// command named `source-command-*` makes --write prune its mirror and then
// rewrite `managed` without it; the directory itself survives if anything else is
// left inside, and a `managed`-only memory would forget we ever owned it - the
// next --check would wave the survivor through as importer litter while its stale
// instructions stayed under .agents/. Carrying the DIRECTORY forward keeps
// ownership across that rewrite. It grows only when a canonical command is itself
// named `source-command-*` (normally never, so the list is normally empty), and a
// stale entry only ever makes the check stricter - a genuine importer directory
// reusing that exact name fails loudly instead of being exempted.
// `known` separates the two cases a bare empty result used to conflate:
//
//   - NO manifest at all: a real answer. Nothing has been generated yet, so
//     nothing is owned, and the exemption may apply. `known: true`.
//   - a manifest that EXISTS but cannot be read or parsed: NOT an answer. The
//     ownership record is unavailable, not empty. `known: false`.
//
// Returning `[]` for both is the same defect this module has now produced three
// times: a check that cannot determine something answers with the most
// permissive value, and a corrupt manifest would silently hand every importer
// directory the exemption. Callers must fail closed on `known: false`.
function previousManifest(targetRoot = TARGET_ROOT) {
  const file = path.join(targetRoot, "generated-manifest.json");
  if (!existsSync(file)) return { managed: [], ownedImporterDirs: [], known: true };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      managed: Array.isArray(parsed.managed) ? parsed.managed : [],
      ownedImporterDirs: Array.isArray(parsed.ownedImporterDirs) ? parsed.ownedImporterDirs : [],
      known: true,
    };
  } catch {
    return { managed: [], ownedImporterDirs: [], known: false };
  }
}

function previousManagedFiles(targetRoot = TARGET_ROOT) {
  return previousManifest(targetRoot).managed;
}

// git, with any inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE stripped. This
// check runs inside the pre-commit hook, where those variables are set and point
// at the hook's own view - inheriting them makes `-C ROOT` a lie and has already
// broken fixture tests in this repo.
function git(args) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  env.MSYS_NO_PATHCONV = "1";
  return spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", env });
}

// Ownership must not be shrinkable by editing the one file that records it.
//
// previousManifest() reads the WORKING TREE, and buildExpected() regenerates the
// manifest from what it read there - so the `ownedImporterDirs` field certifies
// itself. Drop a name from it by hand, or lose one to a careless merge
// resolution, and --check reproduces the reduced set, compares it against the
// reduced file, finds them equal, and passes. The survivor in that directory is
// then classified as importer litter again: exactly the silent widening the
// field exists to prevent (Codex P2, PR #565).
//
// So anchor it outside that file: union the working tree with the git INDEX and
// HEAD blobs. Ownership can then only ever grow. A dropped name is restored into
// `expected`, the working-tree manifest no longer matches, and --check reports
// `generated-manifest.json is stale` - a loud failure with a one-command remedy
// instead of a quiet loss of coverage.
function gitManifestOwnedDirs(targetRoot = TARGET_ROOT) {
  const rel = unix(
    path.join(path.relative(ROOT, targetRoot) || ".agents", "generated-manifest.json"),
  );
  const out = new Set();
  for (const rev of [":", "HEAD:"]) {
    const result = git(["show", `${rev}${rel}`]);
    if (result.status !== 0 || !result.stdout) continue;
    try {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed.ownedImporterDirs)) {
        for (const dir of parsed.ownedImporterDirs) out.add(dir);
      }
    } catch {
      // An unparseable blob records no ownership. It cannot SHRINK the set -
      // the working tree and the other revision are still unioned in.
    }
  }
  return out;
}

// Every importer directory this generator has ever owned, from any source git or
// the working tree can still see.
function durableOwnedImporterDirs(targetRoot = TARGET_ROOT) {
  const owned = gitManifestOwnedDirs(targetRoot);
  for (const dir of previousManifest(targetRoot).ownedImporterDirs) owned.add(dir);
  return owned;
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

// The Codex CLI's "Import from other apps" (`/import`) writes its own adapters
// into .agents/skills/ as `source-command-<name>/SKILL.md`. They are NOT ours and
// never can be: the importer rewrites the instruction text with a case-insensitive
// claude -> Codex substitution, so the copies point at a `.Codex/hooks/` path that
// does not exist. Nothing in this repo invokes them. There is no off-switch in the
// binary, and .gitignore cannot help because the sweep below reads the directory
// directly. Left unclassified they are 24 "not generated from .claude" failures
// that block EVERY commit in the checkout they land in (C:\CRX_Manager, 2026-08-31
// through 2026-09-02).
//
// Mason's 2026-09-02 decision: keep them VISIBLE, do not delete them. So they are
// reported on every run and excluded from the pass/fail verdict — foreign litter,
// not drift in a file we generate.
//
// Classify by REGION, not by an enumeration of the 24 names: any path under a
// `skills/<importer-prefixed-dir>/` that this generator does not itself produce.
//
// Three narrowing conditions, each closing a hole Codex found on PR #565. The
// exemption applies ONLY to a directory that is
//
//   1. not currently generated  — a path in `expected` is filtered out upstream,
//      but that is not enough on its own: see (2);
//   2. not PREVIOUSLY generated — if `generated-manifest.json` ever owned a file
//      in that directory, the directory is ours. Without this, deleting a
//      canonical `.claude` command named `source-command-*` would drop its
//      mirror out of `expected`, this filter would then call the orphan
//      "importer litter", and stale instructions would survive `--check`. It
//      also fixes the sibling case: when `skills/source-command-demo/SKILL.md`
//      IS generated, a hand-added `manual.md` beside it stays drift, because
//      ownership is decided per DIRECTORY, not per file. "Previously" means the
//      manifest's DURABLE `ownedImporterDirs`, not just its current `managed`
//      list: `--write` rewrites `managed` wholesale, so reading only that would
//      forget the directory one sync after the canonical command was deleted —
//      exactly when a survivor inside it still needs catching;
//   3. not tracked or staged in git — the exemption is for untracked
//      working-tree litter. Once someone `git add -A`s the importer output it is
//      becoming part of the repo, and mangled instructions must fail the parity
//      check rather than ride in silently. This condition FAILS CLOSED: if git
//      cannot be consulted the tracking state is unknown, so no directory is
//      exempted at all and the litter is reported as ordinary drift. It used to
//      fail open — a git failure read as "nothing is tracked", which is the most
//      permissive possible answer and would have exempted staged adapters at
//      exactly the moment the check could no longer tell (CodeRabbit, PR #565).
//
// Together these keep the invariant the exemption could otherwise break:
// `.agents/` is generated solely from `.claude/`.
const FOREIGN_SKILL_DIR_RE = /^skills\/(source-command-[^/]+)\//;

function importerDirOf(relativePath) {
  return FOREIGN_SKILL_DIR_RE.exec(relativePath)?.[1] ?? null;
}

export function classifyExtras(extraRelativePaths, options = {}) {
  const {
    expectedKeys = [],
    previouslyManaged = [],
    previouslyOwnedDirs = [],
    trackedPaths = [],
    // Whether git could actually be consulted. False means "unknown", and an
    // unknown tracking state must never buy an exemption - see condition (3).
    trackingKnown = true,
  } = options;

  // Any directory this generator owns now, or owned before, is OURS.
  const ownedDirs = new Set(previouslyOwnedDirs);
  for (const key of [...expectedKeys, ...previouslyManaged]) {
    const dir = importerDirOf(key);
    if (dir) ownedDirs.add(dir);
  }
  const tracked = new Set(trackedPaths);

  const extras = [];
  const foreignDirs = new Set();
  for (const relative of extraRelativePaths) {
    const dir = importerDirOf(relative);
    if (dir && trackingKnown && !ownedDirs.has(dir) && !tracked.has(relative)) foreignDirs.add(dir);
    else extras.push(relative);
  }
  return { extras, foreignDirs: [...foreignDirs].sort() };
}

// Paths under .agents/ that git already knows about (tracked or staged), as
// TARGET_ROOT-relative unix paths, plus whether git could be consulted at all.
//
// `known: false` means the answer is UNKNOWN, not "nothing is tracked". Those
// are opposite defaults: the latter is the most permissive reading possible and
// would hand the exemption to every importer path precisely when the check can
// no longer tell whether they had been staged. Callers must fail closed on it.
//
// An empty result with `known: true` is a real answer - nothing is tracked yet -
// and still allows the exemption.
function gitKnownTargetPaths(targetRoot = TARGET_ROOT) {
  const rel = unix(path.relative(ROOT, targetRoot)) || ".agents";
  const out = new Set();
  let known = true;
  for (const args of [["ls-files", "-z", "--", rel], ["diff", "--cached", "--name-only", "-z", "--", rel]]) {
    const r = git(args);
    if (r.status !== 0) { known = false; continue; }
    if (!r.stdout) continue;
    for (const line of r.stdout.split("\0")) {
      if (!line) continue;
      const withinTarget = unix(path.relative(rel, line));
      if (withinTarget && !withinTarget.startsWith("..")) out.add(withinTarget);
    }
  }
  return { paths: [...out], known };
}

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
  const prior = previousManifest();
  const gitKnown = gitKnownTargetPaths();
  const { extras, foreignDirs } = classifyExtras(
    actualFiles.filter((relative) => !expected.has(relative)),
    {
      expectedKeys: [...expected.keys()],
      previouslyManaged: prior.managed,
      previouslyOwnedDirs: [...durableOwnedImporterDirs()],
      trackedPaths: gitKnown.paths,
      // The exemption needs BOTH provenance sources to have actually answered.
      // Either one reporting "unknown" withholds it - see previousManifest()
      // and gitKnownTargetPaths().
      trackingKnown: gitKnown.known && prior.known,
    },
  );
  if (!gitKnown.known) {
    console.error("NOTE git could not report which .agents/ paths are tracked; the importer-directory exemption is withheld and any such files are reported as drift.");
  }
  if (!prior.known) {
    console.error("NOTE generated-manifest.json exists but could not be parsed, so the ownership record is unavailable; the importer-directory exemption is withheld and any such files are reported as drift.");
  }
  for (const extra of extras) {
    mismatches.push(`${extra} is not generated from .claude`);
  }
  // Report on stdout, ahead of the verdict. check-agent-workflows.mjs surfaces
  // only the FIRST stdout line as its note, so leading with this is what keeps
  // the litter visible through `npm run agent-health` too. Its PASS matcher is
  // `/^PASS - \d+ .../m`, which still finds the verdict line below.
  if (foreignDirs.length > 0) {
    console.log(`WARNING: ignoring ${foreignDirs.length} foreign .agents/skills/source-command-*/ director${foreignDirs.length === 1 ? "y" : "ies"} written by the Codex CLI /import feature - not generated here, safe to delete by hand.`);
    console.log(`  Their text is mangled (claude -> Codex), so references like .Codex/hooks/ are broken. They are neither checked nor synced.`);
    for (const name of foreignDirs) console.log(`  - skills/${name}/`);
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

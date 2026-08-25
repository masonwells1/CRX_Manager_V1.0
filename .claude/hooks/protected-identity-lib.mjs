// Shared protected-file IDENTITY check.
//
// Pathname-shaped guards can be defeated by giving a protected file a second
// name. A hard link is the sharp case: it is not a link at the path level but a
// second directory entry for the same file data, so `realpath` returns the
// alias's own innocuous pathname and every pattern misses. A directory junction
// launders the protected path out of the command text as well.
//
// Blocking every way to CREATE such an alias is unbounded — `mklink /H`, `ln`,
// `cp -l`, `link`, `busybox cp -l`, PowerShell `New-Item`, `fsutil`, and any
// language runtime with a link() binding. Blocking every way to WRITE through
// one is bounded: MCP file tools, the native Write/Edit tools, and the native
// patch route. So identity is checked at the write boundary by all three, and
// link-creation denial in the shell classifier is defence-in-depth rather than
// the boundary itself.
//
// Identity is device + inode/file-ID, which is exactly what a second pathname
// cannot disguise (Codex CRX-SEC-01, 2026-08-23/24).
//
// A protected file is NOT an alias of itself. The first cut compared identities
// alone, so editing a protected hook at its own real path matched its own
// identity and denied — the guard's own error text says "edit the real path",
// which was the one thing it refused. Left in place it would have made the
// harness unmaintainable through the agent tools the moment it was wired onto a
// second write route. The comparison is therefore identity AND a differing
// pathname (2026-08-24).
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

// Assembled rather than written literally: the shell classifier denies commands
// that name the protected maintenance producer, and this file is read by tools
// that would otherwise trip that check on their own source.
const protectedProducerName = ["apply-live-testdata-maintenance-", "20260812.mjs"].join("");

// Windows pathnames are case-insensitive; a case-variant spelling of the real
// path is the same file, not a second name for it.
function pathKey(candidate) {
  const resolved = path.resolve(String(candidate || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function fileIdentity(target) {
  try {
    const stat = statSync(target);
    if (!stat.isFile()) return "";
    // A filesystem that cannot report a real inode/file-ID (reported as 0) gives
    // no identity signal; never let that read as "matches nothing".
    if (!stat.ino) return "";
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return "";
  }
}

// Resolve the deepest existing ancestor and re-attach the missing tail. A file
// that does not exist yet cannot be realpath'd, but the JUNCTION it would be
// created through already can — which is how a not-yet-created proof file is
// caught. Shared so the MCP route and the native write/patch route cannot drift.
export function canonicalizeThroughExistingAncestor(target) {
  const original = path.resolve(target);
  let current = original;
  const missing = [];
  for (;;) {
    try {
      const canonical = realpathSync.native(current);
      return path.resolve(canonical, ...missing.reverse());
    } catch (error) {
      if (!error || !["ENOENT", "ENOTDIR"].includes(error.code)) return original;
      const parent = path.dirname(current);
      if (parent === current) return original;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

// Every directory that holds Git control files for this checkout.
//
// In a LINKED WORKTREE `<root>/.git` is a POINTER FILE, not a directory, so
// `readdirSync(<root>/.git)` throws ENOTDIR and the swallowed error left every
// Git control file unprotected — including the shared `config`, which lives in
// the common directory of the main checkout and is never under `<root>` at all.
// The pointer names the per-worktree gitdir; `<gitdir>/commondir` names the
// shared one. Both hold settings that decide what Git EXECUTES, so both are
// protected (Codex, 2026-08-24).
export function gitControlDirectories(root) {
  const pointer = path.join(root, ".git");
  let gitDir = pointer;
  try {
    if (statSync(pointer).isFile()) {
      const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(readFileSync(pointer, "utf8"));
      if (!match) return [pointer];
      gitDir = path.resolve(root, match[1]);
    }
  } catch {
    return [];
  }
  const directories = [gitDir];
  try {
    const commonRaw = readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    if (commonRaw) {
      const commonDir = path.resolve(gitDir, commonRaw);
      if (path.resolve(commonDir) !== path.resolve(gitDir)) directories.push(commonDir);
    }
  } catch {
    // An ordinary (non-linked) repository: the gitdir IS the common directory.
  }
  return directories;
}

// identity -> the protected file's OWN pathname. The pathname is what lets a
// caller tell "this IS the protected file" from "this is a second name for it".
export function protectedFileIdentityPaths(root) {
  const byIdentity = new Map();
  const add = (candidate) => {
    const identity = fileIdentity(candidate);
    if (!identity || byIdentity.has(identity)) return;
    byIdentity.set(identity, path.resolve(candidate));
  };
  const addDirectory = (directory, matches) => {
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !matches(entry.name)) continue;
      add(path.join(directory, entry.name));
    }
  };
  addDirectory(path.join(root, ".claude", "hooks"), (name) => /\.mjs$/i.test(name));
  addDirectory(path.join(root, "supabase", "migrations"), (name) => /\.sql$/i.test(name));
  addDirectory(root, (name) => /^\.env(\.[\w-]+)?$/i.test(name));
  add(path.join(root, ".claude", "settings.json"));
  add(path.join(root, "scripts", protectedProducerName));
  add(path.join(root, ".gitignore"));
  // In a linked worktree this is a regular POINTER FILE. Path matching blocks
  // the real `.git` spelling, but a pre-existing hard-link alias keeps an
  // innocuous pathname and would otherwise be absent from this identity map.
  // In an ordinary checkout `.git` is a directory, so add() safely ignores it.
  add(path.join(root, ".git"));
  // Git's own control files decide what Git EXECUTES: `core.fsmonitor`,
  // `core.attributesfile`, and filter definitions all run a program on the next
  // ordinary Git command. A write here is arbitrary code execution on the next
  // `git status`, so they belong in the protected set (Codex CRX-SEC-01,
  // 2026-08-24).
  for (const gitDir of gitControlDirectories(root)) {
    addDirectory(gitDir, (name) => /^config(\.worktree)?$/i.test(name));
    addDirectory(path.join(gitDir, "info"), (name) => /^(attributes|exclude)$/i.test(name));
    addDirectory(path.join(gitDir, "hooks"), () => true);
  }
  add(path.join(root, ".gitattributes"));
  // package.json chooses the programs every `npm run` executes, and the shell
  // classifier's npm-script-body check reads it — so a write here is both
  // arbitrary execution and a way to blind that check.
  add(path.join(root, "package.json"));
  // The harness that DECIDES whether a change may land, and the proofs it mints.
  // review-proof-guard.mjs already covers these by path and command TEXT; text
  // is exactly what a second pathname defeats, so they need the identity
  // dimension too. stop-wrap-ack.json is deliberately excluded: it is the one
  // designed agent-writable valve in that directory, and protecting it by
  // identity would deny the legitimate ack write at its own real path.
  addDirectory(path.join(root, ".claude", "session-state"), (name) => name !== "stop-wrap-ack.json");
  addDirectory(path.join(root, ".codex", "hooks"), (name) => /\.mjs$/i.test(name));
  add(path.join(root, ".codex", "hooks.json"));
  addDirectory(path.join(root, ".husky"), () => true);
  addDirectory(path.join(root, ".github", "workflows"), (name) => /\.ya?ml$/i.test(name));
  for (const script of [
    "write-codex-push-proof.mjs",
    "run-claude-review.mjs",
    "overnight-codex-gate.mjs",
    "remove-applied-ledger-entry.mjs",
    "agent-manifest-parity.mjs",
  ]) add(path.join(root, "scripts", script));
  return byIdentity;
}

export function protectedFileIdentities(root) {
  return new Set(protectedFileIdentityPaths(root).keys());
}

// Pathname-shaped protection for the control files above. Identity alone cannot
// cover them: a file that does not exist yet has no inode, and CREATING
// `.git/info/attributes` is itself the attack. Mirrors the pathname patterns the
// MCP tool guard applies to the same files, so neither write route is narrower
// than the other.
export function protectedControlPathReason(absTarget) {
  const surface = String(absTarget || "").replace(/\\/g, "/").replace(/\/+$/, "");
  // The `.git` POINTER of a linked worktree. Rewriting it repoints the entire
  // checkout at an attacker-chosen gitdir — every config, hook, and index that
  // Git then obeys — so it is protected by pathname; in a linked worktree it is
  // an ordinary file an editor can create or overwrite.
  if (/(^|\/)\.git$/i.test(surface)) return "the Git directory pointer";
  if (/(^|\/)\.git(\/[^/]+)*\/config(\.worktree)?$/i.test(surface)) return "a Git configuration file";
  if (/(^|\/)\.git(\/[^/]+)*\/info\/(attributes|exclude)$/i.test(surface)) return "a Git attributes or exclude file";
  if (/(^|\/)\.git(\/[^/]+)*\/hooks(?:\/|$)/i.test(surface)) return "a Git hook path";
  if (/(^|\/)\.gitattributes$/i.test(surface)) return "a Git attributes file";
  if (/(^|\/)\.gitconfig$/i.test(surface)) return "a Git configuration file";
  if (/(^|\/)\.config\/git\/(config|ignore)$/i.test(surface)) return "a Git configuration file";
  if (/(^|\/)\.gitignore$/i.test(surface)) return "a Git ignore file";
  return "";
}

// Creating a NEW file in the review state directory is the forge that identity
// cannot see: a brand-new file has no inode to compare, and a junction keeps the
// supplied pathname from ever spelling `session-state`, so the text matchers in
// review-proof-guard miss it too. Canonicalising through the existing ancestor
// resolves the junction and exposes the real destination.
//
// The ack valve stays open, matched CASE-SENSITIVELY for parity with
// review-proof-guard's ACK_VALVE_RE — a case-variant name is denied like any
// other basename.
export function protectedProofCreationReason(absTarget) {
  const surface = canonicalizeThroughExistingAncestor(absTarget).replace(/\\/g, "/");
  if (!/(^|\/)\.claude\/session-state(\/|$)/i.test(surface)) return "";
  if (/(^|\/)\.claude\/session-state\/stop-wrap-ack\.json$/.test(surface)) return "";
  return "the wrapper-owned review state directory";
}

// True when `absTarget` is a SECOND pathname for a protected file. Callers use
// this only after their own pathname patterns miss, so the ordinary deny path
// costs nothing extra. Unreadable protected files simply contribute no identity;
// the pathname patterns remain the primary boundary.
//
// The protected file's own path is not a second name for itself — that edit is
// the legitimate one every other guard is there to inspect.
export function aliasesProtectedFile(absTarget, root) {
  const identity = fileIdentity(absTarget);
  if (!identity) return false;
  const ownPath = protectedFileIdentityPaths(root).get(identity);
  if (!ownPath) return false;
  return pathKey(absTarget) !== pathKey(ownPath);
}

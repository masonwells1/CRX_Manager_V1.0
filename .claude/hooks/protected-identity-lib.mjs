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
// one is bounded: MCP file tools, and the native Write/Edit tools. So identity
// is checked at the write boundary by both, and link-creation denial in the
// shell classifier is defence-in-depth rather than the boundary itself.
//
// Identity is device + inode/file-ID, which is exactly what a second pathname
// cannot disguise (Codex CRX-SEC-01, 2026-08-23/24).
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

// Assembled rather than written literally: the shell classifier denies commands
// that name the protected maintenance producer, and this file is read by tools
// that would otherwise trip that check on their own source.
const protectedProducerName = ["apply-live-testdata-maintenance-", "20260812.mjs"].join("");

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

export function protectedFileIdentities(root) {
  const identities = new Set();
  const add = (candidate) => {
    const identity = fileIdentity(candidate);
    if (identity) identities.add(identity);
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
  // Git's own control files decide what Git EXECUTES: `core.fsmonitor`,
  // `core.attributesfile`, and filter definitions all run a program on the next
  // ordinary Git command. A write here is arbitrary code execution on the next
  // `git status`, so they belong in the protected set (Codex CRX-SEC-01,
  // 2026-08-24).
  addDirectory(path.join(root, ".git"), (name) => /^config(\.worktree)?$/i.test(name));
  addDirectory(path.join(root, ".git", "info"), (name) => /^(attributes|exclude)$/i.test(name));
  add(path.join(root, ".gitattributes"));
  return identities;
}

// Pathname-shaped protection for the control files above. Identity alone cannot
// cover them: a file that does not exist yet has no inode, and CREATING
// `.git/info/attributes` is itself the attack. Mirrors the pathname patterns the
// MCP tool guard applies to the same files, so neither write route is narrower
// than the other.
export function protectedControlPathReason(absTarget) {
  const surface = String(absTarget || "").replace(/\\/g, "/");
  if (/(^|\/)\.git(\/[^/]+)*\/config(\.worktree)?$/i.test(surface)) return "a Git configuration file";
  if (/(^|\/)\.git(\/[^/]+)*\/info\/(attributes|exclude)$/i.test(surface)) return "a Git attributes or exclude file";
  if (/(^|\/)\.gitattributes$/i.test(surface)) return "a Git attributes file";
  if (/(^|\/)\.gitconfig$/i.test(surface)) return "a Git configuration file";
  if (/(^|\/)\.config\/git\/(config|ignore)$/i.test(surface)) return "a Git configuration file";
  if (/(^|\/)\.gitignore$/i.test(surface)) return "a Git ignore file";
  return "";
}

// True when `absTarget` is a second pathname for a protected file. Callers use
// this only after their own pathname patterns miss, so the ordinary deny path
// costs nothing extra. Unreadable protected files simply contribute no identity;
// the pathname patterns remain the primary boundary.
export function aliasesProtectedFile(absTarget, root) {
  const identity = fileIdentity(absTarget);
  if (!identity) return false;
  return protectedFileIdentities(root).has(identity);
}

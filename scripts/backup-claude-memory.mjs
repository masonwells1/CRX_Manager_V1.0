#!/usr/bin/env node
// Claude agent-memory off-site snapshot — the deterministic half of the
// /backup-claude-memory flow.
//
// WHY THIS EXISTS: the agent memory notes live ONLY on Mason's machine, under
// ~/.claude/projects/<encoded-project>/memory/. Nothing backs them up. They are
// also the one thing that CANNOT go in this repo: CRX_Manager_V1.0 is PUBLIC and
// the notes carry real commission payouts naming real people. So the memory dir
// is gitignored here (see .gitignore) and the durable copy goes to the PRIVATE
// repo masonwells1/CRX_Backups — the same place the weekly encrypted DB dump goes.
//
// WHY THIS SHAPE: mirrors scripts/backup-db.mjs. That script does everything that
// does NOT need credentials, and the driving Claude session does the part that
// does (there, the MCP dumps; here, the git push to the private repo). This
// script therefore never touches the network and never sees a token — it stages
// and verifies a snapshot on disk, and the session commits it.
//
//   --stage <dir>        copy every *.md from the source memory dir into <dir>,
//                        write <dir>/manifest.json (per-file sha256 + bytes), and
//                        verify the copy byte-for-byte against the source
//   --source <dir>       source memory dir; auto-discovered when omitted
//   --verify <dir>       re-check an existing staged dir against its own manifest
//                        (use before committing, and after a restore)
//
// Safety properties:
//   - read-only against the source: it is only ever opened for reading
//   - never deletes anything outside <dir>, and never recursively force-deletes
//     (`rm -rf` is hard-blocked in this repo); stale *.md in <dir> are removed
//     file-by-file so a shrinking memory set cannot leave orphans behind
//   - every staged file is re-read and hashed AFTER writing — a truncated or
//     partial copy FAILS the run rather than silently shipping a broken backup
//   - refuses to stage an empty source (a wrong --source path must not quietly
//     produce a valid-looking empty backup that overwrites a good one)
//
// Usage:
//   node scripts/backup-claude-memory.mjs --stage <dir> [--source <dir>]
//   node scripts/backup-claude-memory.mjs --verify <dir>
// Exit:   0 = OK, 1 = verification failure, 2 = usage error.
// Deps:   none (node builtins only).

import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { canonicalRepoId } from "../.claude/hooks/codex-push-lib.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = "manifest.json";
const INDEX_FILE = "MEMORY.md";
// One spelling of the manifest kind, shared by the writer and both readers, so a
// rename can never leave a validator silently accepting the old value.
const SNAPSHOT_KIND = "claude-agent-memory-snapshot";

function usage(msg) {
  if (msg) console.error(`USAGE ERROR: ${msg}\n`);
  console.error(
    `Usage:\n` +
    `  node scripts/backup-claude-memory.mjs --stage <dir> [--source <dir>]\n` +
    `  node scripts/backup-claude-memory.mjs --verify <dir>\n\n` +
    `  --stage <dir>   copy the memory *.md files into <dir>, write ${MANIFEST},\n` +
    `                  and verify every staged file against the source\n` +
    `  --source <dir>  source memory dir (auto-discovered when omitted)\n` +
    `  --verify <dir>  re-check a staged dir against its own ${MANIFEST}`
  );
  process.exit(2);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// lstat, not stat: a symlink named `a.md` reports as a regular file through stat,
// so a link in the source would have copied whatever it pointed at into the
// backup, and a link in the STAGING directory would have been written through —
// putting the notes into another repository's file, a config file, or back over
// the source itself (Codex's fourteenth 2026-07-30 review). Nothing here follows
// a link now: a symlink is simply not one of the files this script handles.
// Seam for the tests. Creating a symbolic link on Windows needs Developer Mode or
// elevation, which a test suite cannot assume, so the suite substitutes a stat
// that reports one — exercising the REAL refusal path rather than skipping it.
// Production always uses lstatSync.
let linkStat = lstatSync;
export function __setLinkStat(fn) { linkStat = fn || lstatSync; }

const mdFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .filter((f) => linkStat(path.join(dir, f)).isFile())
    .sort();

// Refuse to write THROUGH a link. The destination check above decides which
// repository the directory belongs to; a symlink inside it escapes that decision
// entirely, so the write is refused rather than redirected.
function symlinkRefusal(dest) {
  let info;
  try { info = linkStat(dest); } catch { return null; }    // does not exist yet — normal
  if (!info.isSymbolicLink()) return null;
  return (
    `FAIL: refusing to write — ${dest} is a symbolic link.\n` +
    `      Writing through it would put the notes wherever it points, outside the\n` +
    `      destination this run verified. Remove the link and re-run.`
  );
}

// Claude Code stores memory at ~/.claude/projects/<encoded-project>/memory. The
// encoding is not ours to reproduce, so discover instead of deriving: take every
// memory dir that actually holds the index file, and prefer a CRX one.
function discoverSource() {
  const root = path.join(os.homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  const candidates = readdirSync(root)
    .map((name) => ({ name, dir: path.join(root, name, "memory") }))
    .filter(({ dir }) => existsSync(path.join(dir, INDEX_FILE)));
  if (candidates.length === 0) return null;
  const crx = candidates.filter(({ name }) => /crx/i.test(name));
  const pool = crx.length > 0 ? crx : candidates;
  // Deterministic pick: most files wins, name as the tie-break.
  pool.sort((a, b) => {
    const d = mdFiles(b.dir).length - mdFiles(a.dir).length;
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  return pool[0].dir;
}

// Is `child` inside `parent` (or the same directory)? Path-string comparison
// with a separator so `/docs` is not read as a parent of `/docs-archive`.
function isInside(child, parent) {
  const a = path.resolve(child);
  const b = path.resolve(parent);
  if (a === b) return true;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// The DESTINATION is the dangerous argument here, because staging PRUNES: it
// deletes top-level .md files the source no longer has. Codex's 2026-07-30
// pre-push review pointed out that `--stage .` would therefore delete the
// repository's own documentation. So a destination is only accepted when it is
// new, empty, or a previous snapshot written by THIS script — and pruning is
// limited to files that snapshot's own manifest recorded. Anything else fails
// BEFORE a single byte is written or deleted.
// Its first check is destinationIsPublishable(), defined below.
//
// The notes carry real names and commission amounts, and `CRX_Manager_V1.0` is
// PUBLIC. `.gitignore` covers the one documented directory (`docs/claude-memory/`),
// but the runbook says "<staging-dir>" without pinning it, so an agent that picked
// any other path inside this checkout would create tracked, publishable files —
// and a public commit is not undoable by a later delete. Codex's eighth 2026-07-30
// review found this. The off-site repo is deliberately unaffected: there the notes
// ARE tracked on purpose, which is the whole point of the backup — so the refusal
// is scoped to the app repo, not to "any git worktree".
//
// Round ten inverted the rule. Naming the one repo to refuse meant every OTHER
// repository was accepted by default — a wrong clone, a public fork, a replaced
// remote, a checkout with no remote at all — and the runbook goes on to commit and
// push whatever was staged. Codex's tenth 2026-07-30 review called that out, and
// it is right: for content that can never be un-published, the safe default is
// "no". So a tracked destination must now name the ONE private off-site repo, and
// everything else is refused. The two legitimate non-repo cases still work: a
// path git ignores (nothing there can be committed) and a directory outside any
// repository at all.
// Repository identity comes from the ONE canonicalizer in the hooks library
// (CLAUDE.md: `.claude/hooks/` is the single source of truth for shared guard
// logic). A second, weaker copy here is exactly how this check would drift out of
// agreement with the push guard — and it already had the same defect the guard
// did: `https://github.com/masonwells1/./CRX_Manager_V1.0.git` is the public repo,
// and a raw suffix match says it is not (Codex's ninth 2026-07-30 review).
const GUARDED_APP_REPO_ID = "github.com/masonwells1/crx_manager_v1.0";
// The ONE repository allowed to hold these notes as tracked files.
const BACKUP_REPO_ID = "github.com/masonwells1/crx_backups";
function nearestExisting(dir) {
  let current = path.resolve(dir);
  for (let hops = 0; hops < 64; hops += 1) {
    if (existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}
// git exports GIT_DIR (and friends) into every hook it runs, and those override
// `-C <dir>` discovery — so a probe run from inside a pre-commit hook answers for
// the hook's repository, not the destination's. That is how this check first went
// wrong: it refused a temp directory by reading THIS repo's remotes. Ask git about
// the path on disk and nothing else.
const GIT_DISCOVERY_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES",
];
// Read-only visibility lookup. Returns { visibility } when GitHub answered, or
// { reason } when it could not be asked. Never throws: the caller decides.
//
// The probe is swappable ONLY so the tests can exercise all three answers without
// a network call; nothing else imports this module. The default is the real
// lookup, and a test that forgets to restore it fails loudly on the next case.
let visibilityProbe = null;
export function __setVisibilityProbe(fn) { visibilityProbe = fn; }
function ghVisibility() {
  if (visibilityProbe) return visibilityProbe();
  const result = spawnSync(
    "gh",
    ["repo", "view", "masonwells1/CRX_Backups", "--json", "visibility", "-q", ".visibility"],
    { encoding: "utf8", timeout: 20000, windowsHide: true },
  );
  if (result.error) return { reason: `gh unavailable: ${result.error.code || result.error.message}` };
  if (result.status !== 0) return { reason: `gh exited ${result.status}: ${String(result.stderr || "").trim().split(/\r?\n/)[0] || "no output"}` };
  const visibility = String(result.stdout || "").trim();
  return visibility ? { visibility } : { reason: "gh returned no visibility field" };
}

// Backstop for the fourth credential shape nobody has thought of yet. The detector
// in destinationIsPublishable() is a list of known spellings, and every review
// round so far has found one it was missing — so no remote URL reaches output
// without the places a secret can hide stripped first, whether or not the detector
// recognised it. On a URL the detector accepts this is a no-op: a bare `git@` is
// the ordinary SSH spelling and is kept, so the runbook still prints the exact URL
// to push to. Exported because a backstop nobody can test is decoration.
export function redactUrl(url) {
  return String(url)
    .replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/]*)@/, (whole, head, userinfo) =>
      userinfo.toLowerCase() === "git" ? whole : `${head}***@`)
    .replace(/^([^@\s/\\]+)@(?=[^\s:/\\]{2,}:(?!\/))/, (whole, user) =>
      user.toLowerCase() === "git" ? whole : "***@")
    .replace(/[?#].*$/, "");
}

// `verb` only shapes the refusal wording. `--verify` runs this same check in the
// snapshot's FINAL location, because that is the directory the runbook commits and
// pushes from, and until round fifteen nothing checked it: the documented flow
// stages outside git (where every repository check is skipped by design), copies
// into a clone, and verifies there — so a wrong or public clone passed final
// verification and received the notes (Codex's fifteenth 2026-07-30 review).
// Neither path writes anything, so "Nothing was written" stays true for both.
function destinationIsPublishable(outDir, names, verb = "stage") {
  const probe = nearestExisting(outDir);
  const env = { ...process.env };
  for (const name of GIT_DISCOVERY_ENV) delete env[name];
  const git = (args, input) => spawnSync("git", ["-C", probe, ...args], { encoding: "utf8", env, input });
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return null;                       // not inside a git repo at all

  // Ask about files INSIDE the destination, not the destination itself: a
  // directory-only pattern (`docs/claude-memory/`) does not match a directory
  // that does not exist yet, and staging into a not-yet-created directory is the
  // normal case. A path beneath it matches either way — probed both ways on
  // git 2.54 before relying on it.
  //
  // EVERY file this run will write has to be ignored, not just one. Probing only
  // MEMORY.md meant a repository that ignores that single name — and nothing else —
  // read as safe, leaving every other note and the manifest tracked and publishable
  // (Codex's thirteenth 2026-07-30 review). Ignore rules are per-path, so "this one
  // is ignored" says nothing about the other 189. Anything short of all-ignored
  // falls through to repository validation below, which refuses unless the checkout
  // is the private backup repo — so a partially-ignored path fails CLOSED, as does
  // a git that cannot answer at all.
  //
  // `-z` on both sides is required, not tidiness: without it git C-quotes any
  // path it considers unusual — every Windows path, because of the backslashes —
  // and the echoed lines then match nothing, which read as "none ignored".
  const wanted = [MANIFEST, ...(names ?? [])].map((name) => path.resolve(outDir, name));
  const answer = git(["check-ignore", "-z", "--stdin"], `${wanted.join("\0")}\0`);
  if (answer.status === 0 || answer.status === 1) {
    const ignored = new Set(
      String(answer.stdout || "").split("\0").filter(Boolean).map((line) => path.resolve(line)),
    );
    if (wanted.length > 0 && wanted.every((file) => ignored.has(file))) return null;
  }

  // Tracked, then. Only the private off-site repo may hold these notes.
  //
  // Read the PUSH destinations, not "any URL git mentions". A remote can fetch
  // from one place and push to another (`git remote set-url --push`), so a clone
  // whose fetch URL is the private backup and whose pushurl is a public repo
  // passed a some()-over-every-URL check — and the runbook's next step is a push
  // (Codex's eleventh 2026-07-30 review). `git remote -v` prints a `(fetch)` and a
  // `(push)` line per remote; only the `(push)` line says where a push lands.
  // Every push destination must be the backup repo: one wrong remote in the
  // checkout is one wrong `git push <name>` away from publishing these notes.
  const pushUrls = String(git(["remote", "-v"]).stdout || "")
    .split(/\r?\n/)
    .filter((line) => /\(push\)\s*$/.test(line))
    .map((line) => line.trim().split(/\s+/)[1] || "")
    .filter(Boolean);

  // A remote URL can carry a credential (`https://<token>@github.com/...`), and
  // canonical identity deliberately ignores it — so a token-bearing URL was
  // accepted and then printed for the runbook to reuse, putting it into terminal
  // output, transcripts and shell history (Codex's twelfth 2026-07-30 review).
  // Refuse the URL outright rather than print a redacted version of it: a remote
  // that needs an inline token is misconfigured, and the fix (a credential helper,
  // or SSH) is one command. `ssh://git@host/...` and `git@host:...` are the
  // ordinary SSH spellings — a bare username is not a credential.
  //
  // Three shapes carry a secret, not one. Round twelve only recognised
  // `scheme://userinfo@`, which is what git prints for an HTTPS token, and missed
  // the other two completely — both canonicalized as the allowed backup repo and
  // were then printed verbatim (Codex's sixteenth 2026-07-30 review, reproduced by
  // probe before this fix):
  //   1. `scheme://userinfo@host/…` — refuse unless it is the plain `ssh://git@`.
  //   2. `token@host:path` — scp-style, with NO scheme at all, so a pattern
  //      anchored on `://` never even looked at it. A bare `git@` is the ordinary
  //      SSH spelling; any other username in that position is a credential.
  //   3. `…?access_token=…` or `…#…` — a query or fragment. Canonical identity
  //      drops both, so the URL read as the backup repo and printed with the token
  //      still attached. A git remote never needs either.
  const credentialBearing = (url) => {
    const text = String(url);
    if (/[?#]/.test(text)) return true;
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)@/.exec(text);
    if (scheme) return scheme[2].includes(":") || !/^ssh$/i.test(scheme[1]);
    const scp = /^([^@\s/\\]+)@[^\s:/\\]{2,}:(?!\/)/.exec(text);
    if (scp) return scp[1].toLowerCase() !== "git";
    return false;
  };
  const credentialed = pushUrls.filter(credentialBearing);
  if (credentialed.length > 0) {
    return (
      `FAIL: refusing to ${verb} — a push remote in this checkout embeds a credential in its URL.\n` +
      `      (The URL is not reproduced here on purpose.) The runbook prints and reuses the\n` +
      `      verified push URL, so a token in it would end up in terminal output, transcripts\n` +
      `      and shell history. Re-point the remote at the plain SSH or HTTPS URL and let a\n` +
      `      credential helper supply the secret, then re-run. Nothing was written.`
    );
  }

  if (pushUrls.length > 0 && pushUrls.every((url) => canonicalRepoId(url) === BACKUP_REPO_ID)) {
    // Being the right repository is not the same as still being private. A
    // visibility flip on GitHub would silently turn every future snapshot into a
    // publication, and nothing on disk would look different (Codex round 10). Ask
    // GitHub while we are here — and PARK when the answer cannot be had. Warning
    // and continuing was itself a finding (round eleven): publication is
    // effectively permanent, so "probably still private" is not a good enough
    // basis for staging into the very directory the runbook then commits and
    // pushes. Staging anywhere git ignores, or outside a repo, never reaches here.
    const seen = ghVisibility();
    if (seen.visibility && seen.visibility.toUpperCase() !== "PRIVATE") {
      return (
        `FAIL: refusing to ${verb} — GitHub reports masonwells1/CRX_Backups is ${seen.visibility}.\n` +
        `      The off-site snapshot is only safe while that repository is PRIVATE. Set it back to\n` +
        `      private, then re-run. Nothing was written.`
      );
    }
    if (!seen.visibility) {
      return (
        `FAIL: refusing to ${verb} — could not confirm masonwells1/CRX_Backups is still private\n` +
        `      (${seen.reason}). This directory gets committed and pushed, and these notes name\n` +
        `      real people and real money, so an unproven-private destination is a park, not a\n` +
        `      warning. Fix the check (\`gh auth status\`, or come back online) and re-run — or\n` +
        `      stage into a path outside the repo if you only wanted a local copy. Nothing was\n` +
        `      written.`
      );
    }
    console.log(`Destination verified: this checkout pushes only to ${redactUrl(pushUrls[0])}, which GitHub reports PRIVATE.`);
    return null;
  }

  const where = pushUrls.some((url) => canonicalRepoId(url) === GUARDED_APP_REPO_ID)
    ? `the PUBLIC CRX Manager checkout`
    : pushUrls.length === 0
      ? `a git checkout with no push remote, so where it would end up cannot be determined`
      : `a git checkout that pushes to ${redactUrl(pushUrls[0])}, not the off-site backup repo`;
  return (
    `FAIL: refusing to ${verb} into ${outDir} — it is inside ${where}\n` +
    `      (${top.stdout.trim()}), and git does not ignore it, so the notes (real names,\n` +
    `      real commission amounts) would become committable there. These notes may be\n` +
    `      tracked in exactly one repository: masonwells1/CRX_Backups. Stage into that\n` +
    `      clone, or into a path the repo ignores (docs/claude-memory/). Nothing was written.`
  );
}

function assertSafeDestination(outDir, source, names) {
  const publishable = destinationIsPublishable(outDir, names);
  if (publishable) return publishable;
  if (isInside(source, outDir)) {
    return `FAIL: refusing to stage into ${outDir} — the memory source lives inside it. Pick a dedicated directory.`;
  }
  if (isInside(outDir, source)) {
    return `FAIL: refusing to stage into ${outDir} — it is inside the memory source. Pick a dedicated directory.`;
  }
  if (!existsSync(outDir)) return null;                       // new directory: nothing to clobber
  if (!statSync(outDir).isDirectory()) return `FAIL: destination is not a directory: ${outDir}`;
  if (readdirSync(outDir).length === 0) return null;          // empty directory: nothing to clobber

  const manifestPath = path.join(outDir, MANIFEST);
  if (!existsSync(manifestPath)) {
    return (
      `FAIL: destination is not empty and holds no ${MANIFEST}: ${outDir}\n` +
      `      Staging deletes stale .md files, so it only ever writes into a new,\n` +
      `      empty, or previously-staged directory. Nothing was changed.`
    );
  }
  let previous;
  try {
    previous = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return `FAIL: ${MANIFEST} in ${outDir} is not valid JSON — refusing to treat it as a snapshot. Nothing was changed.`;
  }
  if (previous?.kind !== SNAPSHOT_KIND || !Array.isArray(previous.files)) {
    return `FAIL: ${MANIFEST} in ${outDir} is not a memory snapshot manifest. Nothing was changed.`;
  }
  return { previous };
}

// Credential shapes that must never be snapshotted. Deliberately narrow: these
// match the STRUCTURE of a real key, not the word "key", so an agent note that
// merely discusses secrets does not fail the run. A false negative is possible;
// this is a backstop under the human read, not a replacement for it.
const SECRET_RES = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "private key block"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, "GitHub fine-grained PAT"],
  [/\bsbp_[a-f0-9]{40,}\b/, "Supabase access token"],
  [/\bsb_secret_[A-Za-z0-9_-]{20,}\b/, "Supabase secret key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/, "API secret key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  // A service_role JWT is the single most dangerous string in this project: it
  // bypasses every RLS policy. Match the JWT header shape, not the word.
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "JWT (possible service_role key)"],
  // Agent notes legitimately record connection-string SHAPES with the password
  // written as a placeholder (`<pw>`, `${VAR}`, `…`). Those are documentation, not
  // credentials, so the password segment must not start with a placeholder
  // delimiter and must not contain one.
  [/\bpostgres(?:ql)?:\/\/[^:\s]+:(?![<{$])[^@\s<>{}$]{6,}@/, "database URL with inline password"],
];
// Scans BUFFERS, not paths. Codex's fourth 2026-07-30 review found a race in the
// earlier path-based version: staging read every file once to scan it and a
// second time to copy it, so a memory written between those two reads could land
// in the permanent snapshot having never been scanned. The caller now reads each
// file exactly once and hands the same bytes to this scan and to the writer.
function scanForSecrets(entries) {
  const hits = [];
  for (const { name, buf } of entries) {
    const lines = buf.toString("utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [re, label] of SECRET_RES) {
        // Never echo the matched text — printing it would copy the credential
        // into a terminal log, which is the thing this check exists to prevent.
        if (re.test(line)) hits.push({ name, line: index + 1, label });
      }
    });
  }
  return hits;
}

function stage(outDir, sourceArg) {
  const source = sourceArg || discoverSource();
  if (!source) {
    console.error(
      `FAIL: no memory dir found under ~/.claude/projects/*/memory (looked for ${INDEX_FILE}).\n` +
      `      Pass --source <dir> explicitly.`
    );
    return 1;
  }
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    console.error(`FAIL: source is not a directory: ${source}`);
    return 1;
  }

  const names = mdFiles(source);
  if (names.length === 0) {
    // A typo'd --source must never overwrite a good backup with an empty one.
    console.error(`FAIL: source has no .md files — refusing to stage an empty snapshot: ${source}`);
    return 1;
  }
  if (!names.includes(INDEX_FILE)) {
    console.error(`FAIL: source is missing ${INDEX_FILE} — that is not a memory dir: ${source}`);
    return 1;
  }

  // Codex's 2026-07-30 review, second finding: the notes are copied verbatim into
  // git history, and a private repo is access control, not content control — git
  // history is permanent and readable to anyone who ever gets the repo. The notes
  // are deliberately NOT encrypted (a cloud session has to be able to read them,
  // which was the whole point), so the compensating control is that a credential
  // must never enter the snapshot in the first place. This scan runs BEFORE any
  // file is written and aborts the whole staging run, so nothing reaches a commit.
  //
  // Read every note ONCE, here, and carry those exact bytes through the scan and
  // the copy below. Reading again at copy time would leave a window in which a
  // concurrent session could add a credential to a note after it was cleared
  // (Codex round-4, 2026-07-30). The notes are a few hundred KB; holding them in
  // memory costs nothing and closes the window completely.
  const entries = names.map((name) => ({ name, buf: readFileSync(path.join(source, name)) }));
  const secrets = scanForSecrets(entries);
  if (secrets.length > 0) {
    console.error(
      `FAIL: refusing to stage — ${secrets.length} possible secret(s) found in the memory notes.\n` +
      secrets.slice(0, 10).map((hit) => `      ${hit.name}:${hit.line} — ${hit.label}`).join("\n") +
      (secrets.length > 10 ? `\n      ... and ${secrets.length - 10} more` : "") +
      `\n      Remove the credential from the note (and rotate it), then re-run. Nothing was written.`
    );
    return 1;
  }

  const destination = assertSafeDestination(outDir, source, names);
  if (typeof destination === "string") {
    console.error(destination);
    return 1;
  }
  const prunable = new Set((destination?.previous?.files ?? []).map((entry) => entry.name));

  mkdirSync(outDir, { recursive: true });

  // Retire the OLD manifest before overwriting a single note. The notes are copied
  // in place, so a run that dies partway leaves a mixture of new and old files —
  // and with the old manifest still sitting there, `--verify` would compare the new
  // directory against a description of the previous snapshot and call the result
  // corrupt, or (worse) pass by luck. Codex's ninth 2026-07-30 review flagged the
  // gap: the runbook promised a failed staging leaves the previous snapshot intact,
  // and in-place copying cannot honour that. Removing the manifest first cannot
  // restore the old files, but it makes the half-written state UNMISTAKABLE —
  // `--verify` fails closed on a missing manifest, so an incomplete snapshot can
  // never be mistaken for a good one. The recoverable copy is git: in the backup
  // clone the previous snapshot is one `git restore` away.
  const manifestPath = path.join(outDir, MANIFEST);
  // Checked before the unlink: existsSync says false for a DANGLING link, which
  // would then survive to be written through.
  const linkedManifest = symlinkRefusal(manifestPath);
  if (linkedManifest) { console.error(linkedManifest); return 1; }
  if (existsSync(manifestPath)) unlinkSync(manifestPath);

  const files = [];
  let totalBytes = 0;
  for (const { name, buf } of entries) {
    // `buf` is the SAME buffer the secret scan above inspected — not a re-read.
    const dest = path.join(outDir, name);
    const linked = symlinkRefusal(dest);
    if (linked) { console.error(linked); return 1; }
    writeFileSync(dest, buf);
    // Re-read what actually landed: a short write must fail the run, not ship.
    const wrote = readFileSync(dest);
    const digest = sha256(buf);
    if (sha256(wrote) !== digest || wrote.length !== buf.length) {
      console.error(`FAIL: staged copy does not match source: ${name}`);
      return 1;
    }
    files.push({ name, bytes: buf.length, sha256: digest });
    totalBytes += buf.length;
  }

  // Drop staged files the source no longer has, one by one — never a recursive
  // delete. Without this, a renamed or deleted memory would linger forever.
  // Only files the PREVIOUS manifest recorded are eligible: this script deletes
  // nothing it did not itself write, so a stray .md that a human put in the
  // staging directory survives instead of being silently destroyed.
  const keep = new Set(names);
  let pruned = 0;
  for (const stale of mdFiles(outDir)) {
    if (!keep.has(stale) && prunable.has(stale)) {
      unlinkSync(path.join(outDir, stale));
      pruned += 1;
    }
  }

  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        kind: SNAPSHOT_KIND,
        source,
        completed_at: new Date().toISOString(),
        file_count: files.length,
        total_bytes: totalBytes,
        files,
      },
      null,
      2
    )}\n`
  );

  console.log(`Source:  ${source}`);
  console.log(`Staged:  ${outDir}`);
  console.log(`Files:   ${files.length} (${(totalBytes / 1024).toFixed(1)} KB)${pruned ? `, pruned ${pruned} stale` : ""}`);
  console.log(`Verified every staged file against the source. OK.`);
  return 0;
}

function verify(dir) {
  const manifestPath = path.join(dir, MANIFEST);
  if (!existsSync(manifestPath)) {
    console.error(`FAIL: no ${MANIFEST} in ${dir}`);
    return 1;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    console.error(`FAIL: ${MANIFEST} is not valid JSON`);
    return 1;
  }

  // Validate the manifest ITSELF before trusting anything it says. Codex's
  // fourth 2026-07-30 review pointed out that a directory containing nothing but
  // `{}` as its manifest passed: `manifest.files ?? []` made the comparison loop
  // run zero times and the run reported OK. "Verified" then meant "there was
  // nothing to check", which is the opposite of what this command is for.
  if (manifest?.kind !== SNAPSHOT_KIND) {
    console.error(`FAIL: ${MANIFEST} is not a ${SNAPSHOT_KIND} manifest (kind: ${JSON.stringify(manifest?.kind)})`);
    return 1;
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    console.error(`FAIL: ${MANIFEST} lists no files — an empty snapshot is never valid.`);
    return 1;
  }
  const malformed = manifest.files.filter(
    (entry) => !entry || typeof entry.name !== "string" || !Number.isInteger(entry.bytes) || typeof entry.sha256 !== "string",
  );
  if (malformed.length > 0) {
    console.error(`FAIL: ${MANIFEST} has ${malformed.length} entr(ies) missing name/bytes/sha256.`);
    return 1;
  }
  if (!manifest.files.some((entry) => entry.name === INDEX_FILE)) {
    console.error(`FAIL: ${MANIFEST} does not list ${INDEX_FILE} — that is not a memory snapshot.`);
    return 1;
  }
  if (manifest.file_count !== manifest.files.length) {
    console.error(`FAIL: ${MANIFEST} says file_count=${manifest.file_count} but lists ${manifest.files.length} files.`);
    return 1;
  }
  const declaredBytes = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
  if (manifest.total_bytes !== declaredBytes) {
    console.error(`FAIL: ${MANIFEST} says total_bytes=${manifest.total_bytes} but its entries sum to ${declaredBytes}.`);
    return 1;
  }

  // WHERE this snapshot sits matters as much as whether its hashes match, and
  // this is the only check that sees the final location. The runbook stages, copies
  // into a clone, and verifies there — and `stage()`'s repository, push-URL and
  // privacy checks all ran against the STAGING directory, which the documented flow
  // puts outside git entirely, where every one of them is skipped by design. So a
  // wrong clone, a public fork, or a repo whose push URL was re-pointed passed the
  // final check and was committed from (Codex's fifteenth 2026-07-30 review). The
  // names come from the manifest, which is validated above, so the ignore probe
  // covers exactly the files that are actually here.
  const unsafeHere = destinationIsPublishable(dir, manifest.files.map((entry) => entry.name), "verify");
  if (unsafeHere) {
    console.error(unsafeHere);
    return 1;
  }

  const problems = [];
  for (const entry of manifest.files) {
    const file = path.join(dir, entry.name);
    if (!existsSync(file)) {
      problems.push(`missing: ${entry.name}`);
      continue;
    }
    const buf = readFileSync(file);
    if (buf.length !== entry.bytes) problems.push(`size differs: ${entry.name}`);
    else if (sha256(buf) !== entry.sha256) problems.push(`content differs: ${entry.name}`);
  }
  // Every entry, not just the `.md` ones. Using mdFiles() here meant a stray
  // `.env`, `.pem`, or JSON credential file sat in the snapshot directory
  // unhashed, unscanned for secrets, and silently verified as OK — and from
  // there into permanent git history, which is not undoable. Codex's seventh
  // 2026-07-30 review found it: the staging step only ever copies `.md`, but the
  // documented procedure tells an agent to copy the staged directory wholesale,
  // so what verification actually has to answer is "is anything here that the
  // manifest does not vouch for", regardless of its extension.
  const listed = new Set(manifest.files.map((e) => e.name));
  for (const name of readdirSync(dir).sort()) {
    if (name === MANIFEST || listed.has(name)) continue;
    const kind = statSync(path.join(dir, name)).isDirectory() ? "directory" : "file";
    problems.push(`not in manifest: ${name} (unexpected ${kind})`);
  }

  if (problems.length > 0) {
    console.error(`FAIL: ${problems.length} problem(s) in ${dir}`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(
    `OK: ${manifest.files.length} files match ${MANIFEST} ` +
    `(snapshot taken ${manifest.completed_at}).`
  );
  return 0;
}

function main(argv) {
  // A flag's value must not be another flag. Without this, `--stage --source x`
  // reads "--source" as the destination and this script happily creates a
  // directory literally named `--source`, reporting success — the worst outcome
  // for a backup tool, because the real destination is left stale and untouched.
  const flag = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const value = argv[i + 1];
    return value === undefined || value.startsWith("--") ? null : value;
  };

  const stageDir = flag("--stage");
  const verifyDir = flag("--verify");
  if (stageDir && verifyDir) usage("pass either --stage or --verify, not both");
  if (!stageDir && !verifyDir) usage("nothing to do");
  if (stageDir === null && argv.includes("--stage")) usage("--stage needs a directory");
  if (verifyDir === null && argv.includes("--verify")) usage("--verify needs a directory");

  return stageDir ? stage(stageDir, flag("--source")) : verify(verifyDir);
}

// Exported so the tests can call the real functions rather than re-implementing
// them. Importing this file must therefore NOT run the CLI, hence the
// invoked-directly check below.
export { scanForSecrets, stage, verify, SNAPSHOT_KIND, MANIFEST, INDEX_FILE };


const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Exit 1 means "the snapshot is not trustworthy" — a check ran and failed. An
// unexpected crash (permissions, a dangling symlink, a short read) is a
// different thing and must not wear the same code, or the runbook's exit
// contract is a lie and a broken environment reads as a failed verification.
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`FAIL: ${error?.message ?? error}`);
    process.exit(3);
  }
}

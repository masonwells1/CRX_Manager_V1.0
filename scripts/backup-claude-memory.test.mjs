#!/usr/bin/env node
// Tests for the agent-memory off-site snapshot (scripts/backup-claude-memory.mjs).
// Codex's fourth 2026-07-30 review asked for manifest and scan/copy-race coverage
// after finding that `verify()` passed a directory whose manifest was just `{}`.
// Run: node scripts/backup-claude-memory.test.mjs

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  INDEX_FILE,
  MANIFEST,
  SNAPSHOT_KIND,
  __setGitSpawn,
  __setDirRead,
  __setLinkStat,
  __setRemoteRead,
  __setVisibilityProbe,
  ghProbeAnswer,
  ghProbeCommand,
  redactUrl,
  remoteReadCommand,
  scanForSecrets,
  stage,
  unsafeSnapshotName,
  verify,
  verifyRemote,
} from "./backup-claude-memory.mjs";

const sha256Hex = (text) => createHash("sha256").update(Buffer.from(text)).digest("hex");

// Staging into the off-site clone asks GitHub whether that repo is still private.
// The suite answers that question itself: a unit test must not depend on the
// network, on `gh` being installed, or on anyone being logged in. Each case that
// cares sets its own answer and restores this one.
__setVisibilityProbe(() => ({ visibility: "PRIVATE" }));

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "backup-claude-memory.mjs");
let pass = 0;
const ok = (condition, message) => { assert.ok(condition, message); pass += 1; };
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); pass += 1; };

const root = mkdtempSync(path.join(os.tmpdir(), "backup-memory-test-"));
const fresh = (name) => { const dir = path.join(root, name); mkdirSync(dir, { recursive: true }); return dir; };
const quiet = (fn) => {
  // These functions report to the console by design; a passing suite should not
  // print their expected failure messages.
  const { log, error } = console;
  console.log = () => {}; console.error = () => {};
  try { return fn(); } finally { console.log = log; console.error = error; }
};
// Same, but hands back what would have been printed — for checking that a refusal
// does NOT reproduce something secret it was handed.
const captured = (fn) => {
  const { log, error } = console;
  let said = "";
  const sink = (...args) => { said += `${args.join(" ")}\n`; };
  console.log = sink; console.error = sink;
  try { return { value: fn(), said }; } finally { console.log = log; console.error = error; }
};
const readManifest = (dir) => JSON.parse(readFileSync(path.join(dir, MANIFEST), "utf8"));
const writeManifest = (dir, manifest) => writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

function makeSource(name, notes) {
  const dir = fresh(name);
  for (const [file, body] of Object.entries(notes)) writeFileSync(path.join(dir, file), body);
  return dir;
}

try {
  // ── happy path: stage then verify ─────────────────────────────────────────
  const source = makeSource("source", {
    [INDEX_FILE]: "# Memory Index\n- [a](a.md) — hook\n",
    "a.md": "---\nname: a\n---\n\nA note about a commission split.\n",
    "b.md": "---\nname: b\n---\n\nAnother note.\n",
  });
  const staged = path.join(root, "staged");
  eq(quiet(() => stage(staged, source)), 0, "staging a real memory dir succeeds");

  const manifest = readManifest(staged);
  eq(manifest.kind, SNAPSHOT_KIND, "manifest records the snapshot kind");
  eq(manifest.file_count, 3, "manifest counts every .md file");
  eq(manifest.files.length, manifest.file_count, "file_count matches the entry list");
  eq(
    manifest.total_bytes,
    manifest.files.reduce((sum, entry) => sum + entry.bytes, 0),
    "total_bytes is the sum of the entries",
  );
  eq(quiet(() => verify(staged)), 0, "a freshly staged snapshot verifies");

  // The bytes recorded in the manifest are the bytes on disk in the source —
  // this is the property the single-read change protects.
  for (const entry of manifest.files) {
    eq(
      readFileSync(path.join(staged, entry.name)).length,
      readFileSync(path.join(source, entry.name)).length,
      `staged copy is byte-identical in length: ${entry.name}`,
    );
  }

  // ── the round-4 finding: an empty/whatever manifest must NOT verify ───────
  {
    const bogus = fresh("bogus-empty-manifest");
    writeManifest(bogus, {});
    eq(quiet(() => verify(bogus)), 1, "a directory whose manifest is `{}` fails verification");
  }
  {
    const wrongKind = fresh("bogus-kind");
    writeManifest(wrongKind, { kind: "something-else", files: [], file_count: 0, total_bytes: 0 });
    eq(quiet(() => verify(wrongKind)), 1, "a manifest of the wrong kind fails verification");
  }
  {
    const emptyList = fresh("bogus-empty-list");
    writeManifest(emptyList, { kind: SNAPSHOT_KIND, files: [], file_count: 0, total_bytes: 0 });
    eq(quiet(() => verify(emptyList)), 1, "a snapshot listing zero files fails verification");
  }
  {
    // Every note present and hashed correctly, but MEMORY.md is not among them:
    // that is not a memory snapshot, it is a directory of loose notes.
    const noIndex = fresh("bogus-no-index");
    const kept = manifest.files.filter((entry) => entry.name !== INDEX_FILE);
    for (const entry of kept) writeFileSync(path.join(noIndex, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(noIndex, {
      kind: SNAPSHOT_KIND,
      files: kept,
      file_count: kept.length,
      total_bytes: kept.reduce((sum, entry) => sum + entry.bytes, 0),
    });
    eq(quiet(() => verify(noIndex)), 1, `a snapshot without ${INDEX_FILE} fails verification`);
  }
  {
    const badCount = fresh("bogus-count");
    for (const entry of manifest.files) writeFileSync(path.join(badCount, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(badCount, { ...manifest, file_count: manifest.file_count + 1 });
    eq(quiet(() => verify(badCount)), 1, "a file_count that disagrees with the entry list fails verification");
  }
  {
    const badTotal = fresh("bogus-total");
    for (const entry of manifest.files) writeFileSync(path.join(badTotal, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(badTotal, { ...manifest, total_bytes: manifest.total_bytes + 1 });
    eq(quiet(() => verify(badTotal)), 1, "a total_bytes that disagrees with the entries fails verification");
  }
  {
    const malformed = fresh("bogus-entry");
    writeManifest(malformed, { kind: SNAPSHOT_KIND, files: [{ name: "a.md" }], file_count: 1, total_bytes: 0 });
    eq(quiet(() => verify(malformed)), 1, "an entry missing bytes/sha256 fails verification");
  }

  // ── tamper detection still works ──────────────────────────────────────────
  {
    const tampered = fresh("tampered");
    for (const entry of manifest.files) writeFileSync(path.join(tampered, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(tampered, manifest);
    eq(quiet(() => verify(tampered)), 0, "control: the copied snapshot verifies before tampering");
    writeFileSync(path.join(tampered, "a.md"), "edited after the snapshot was taken\n");
    eq(quiet(() => verify(tampered)), 1, "an edited note fails verification");
  }
  {
    const extra = fresh("extra-file");
    for (const entry of manifest.files) writeFileSync(path.join(extra, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(extra, manifest);
    writeFileSync(path.join(extra, "unlisted.md"), "not in the manifest\n");
    eq(quiet(() => verify(extra)), 1, "a note that is not in the manifest fails verification");
  }
  // Codex's seventh 2026-07-30 review: the extra-file check only looked at `.md`,
  // so anything else in the snapshot directory was neither hashed nor scanned for
  // secrets and still verified OK — then went into git history, permanently.
  // Staging only ever copies `.md`, but the documented procedure tells an agent to
  // copy the staged directory wholesale, so verification is the backstop.
  for (const stray of ["stray.env", "id_rsa.pem", "credentials.json", "notes.txt"]) {
    const dir = fresh(`extra-${stray}`);
    for (const entry of manifest.files) writeFileSync(path.join(dir, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(dir, manifest);
    eq(quiet(() => verify(dir)), 0, `control: ${stray} case verifies before the stray file lands`);
    writeFileSync(path.join(dir, stray), "AKIAIOSFODNN7EXAMPLE\n");
    eq(quiet(() => verify(dir)), 1, `a stray ${stray} fails verification`);
  }
  {
    const withDir = fresh("extra-subdir");
    for (const entry of manifest.files) writeFileSync(path.join(withDir, entry.name), readFileSync(path.join(staged, entry.name)));
    writeManifest(withDir, manifest);
    mkdirSync(path.join(withDir, "secrets"));
    writeFileSync(path.join(withDir, "secrets", "key.pem"), "-----BEGIN PRIVATE KEY-----\n");
    eq(quiet(() => verify(withDir)), 1, "a subdirectory in the snapshot fails verification");
  }

  // ── secret scan: scans BUFFERS, not paths (the race fix) ──────────────────
  // A true concurrent-modification race cannot be scripted deterministically
  // here, so this asserts the mechanism that removes it: the scanner is handed
  // bytes and reports on THOSE bytes. Under the previous path-based signature
  // this call could not be written at all — it would have re-read the clean file
  // from disk and reported nothing, which is exactly the gap Codex found.
  {
    const decoy = makeSource("decoy", { [INDEX_FILE]: "clean\n", "a.md": "clean on disk\n" });
    const token = `gh${"p"}_${"A".repeat(36)}`;              // shape only, not a real token
    const hits = scanForSecrets([
      { name: "a.md", buf: Buffer.from(`notes\n${token}\n`) },
      { name: INDEX_FILE, buf: readFileSync(path.join(decoy, INDEX_FILE)) },
    ]);
    eq(hits.length, 1, "the scan follows the buffer it was given, not the file on disk");
    eq(hits[0].name, "a.md", "the hit names the right note");
    eq(hits[0].line, 2, "the hit names the right line");
    ok(!JSON.stringify(hits).includes(token), "a hit never echoes the matched credential");
  }
  {
    for (const assignment of [
      `SUPABASE_DB_PASSWORD=${"A".repeat(40)}`,
      `service_role_key: "${"B".repeat(40)}"`,
      `API_SECRET=${"C".repeat(32)}`,
    ]) {
      eq(
        scanForSecrets([{ name: "a.md", buf: Buffer.from(assignment) }]).length,
        1,
        "named sensitive assignments are refused even without a vendor token prefix",
      );
    }
    eq(
      scanForSecrets([{ name: "a.md", buf: Buffer.from("SUPABASE_DB_PASSWORD=<password>") }]).length,
      0,
      "a named placeholder remains documentation",
    );
  }

  // ── staging aborts on a secret, and writes nothing ────────────────────────
  {
    const dirty = makeSource("dirty-source", {
      [INDEX_FILE]: "# Memory Index\n",
      "leak.md": `key: sb${"p"}_${"a".repeat(40)}\n`,
    });
    const target = path.join(root, "never-written");
    eq(quiet(() => stage(target, dirty)), 1, "staging refuses a source containing a credential shape");
    ok(!readdirSafe(target), "nothing is written when the scan trips");
  }

  // ── documentation shapes are not credentials ──────────────────────────────
  {
    const documented = makeSource("documented-source", {
      [INDEX_FILE]: "# Memory Index\n",
      "shape.md": "connection string shape: postgresql://user:<password>@host:5432/db\n",
    });
    const target = path.join(root, "documented-staged");
    eq(quiet(() => stage(target, documented)), 0, "a placeholder password is documentation, not a credential");
  }

  // ── refuses an empty or non-memory source ─────────────────────────────────
  {
    const empty = fresh("empty-source");
    eq(quiet(() => stage(path.join(root, "from-empty"), empty)), 1, "an empty source is refused");
    const noIndex = makeSource("no-index-source", { "a.md": "note\n" });
    eq(quiet(() => stage(path.join(root, "from-no-index"), noIndex)), 1, `a source without ${INDEX_FILE} is refused`);
  }

  // ── round 8: never stage into a publishable spot in the PUBLIC app repo ───
  // The runbook says "<staging-dir>" without pinning it. A staging directory
  // inside the public CRX checkout that .gitignore does not cover would put real
  // names and commission amounts one `git add` away from a public commit — which
  // a later delete does not undo. The refusal is scoped to the app repo BY REMOTE,
  // because the genuine off-site flow stages into the PRIVATE backup clone, where
  // the notes are tracked on purpose.
  {
    const notes = makeSource("repo-source", {
      [INDEX_FILE]: "# Memory Index\n- [a](a.md) — hook\n",
      "a.md": "---\nname: a\n---\n\nCommission split for a real person.\n",
    });
    // Repository discovery is a security decision, not a best-effort hint.
    // Only Git's explicit "not a repository" answer permits an outside-repo
    // destination; missing Git and every ambiguous discovery failure park.
    {
      const unavailable = path.join(root, "git-unavailable-destination");
      __setGitSpawn(() => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) }));
      const run = captured(() => stage(unavailable, notes));
      eq(run.value, 1, "unavailable Git fails repository discovery closed");
      ok(/could not determine whether this destination is inside a repository/.test(run.said), "the refusal explains the ambiguity");
      ok(!readdirSafe(unavailable), "and unavailable Git writes nothing");
      __setGitSpawn();
    }
    {
      const unsafe = path.join(root, "git-discovery-error-destination");
      __setGitSpawn(() => ({ status: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository", error: undefined }));
      const run = captured(() => stage(unsafe, notes));
      eq(run.value, 1, "safe.directory and other discovery errors fail closed");
      ok(/could not determine whether this destination is inside a repository/.test(run.said), "the discovery error is not treated as outside Git");
      ok(!readdirSafe(unsafe), "and a discovery error writes nothing");
      __setGitSpawn();
    }
    // The scrubbed environment is NOT optional. git exports GIT_DIR into every
    // hook it runs, and `git init` under an inherited GIT_DIR re-initialises THAT
    // repository instead of the directory named by `-C` — which, the first time
    // this suite ran inside the pre-commit hook, flipped the real CRX repo to
    // core.bare=true and broke every worktree until it was set back. Never spawn
    // git from a test without clearing these.
    const cleanEnv = { ...process.env };
    for (const name of [
      "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_PREFIX",
      "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES",
    ]) delete cleanEnv[name];
    const makeRepo = (name, remoteUrl, ignoreBody) => {
      const dir = fresh(name);
      const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: cleanEnv });
      const init = git("init", "-q");
      assert.equal(init.status, 0, `test fixture: git init failed in ${dir}: ${init.stderr}`);
      const inside = git("rev-parse", "--show-toplevel").stdout.trim();
      assert.ok(
        inside && path.resolve(inside) === path.resolve(dir),
        `test fixture: git init landed on ${inside}, not ${dir} — refusing to touch another repository`,
      );
      git("remote", "add", "origin", remoteUrl);
      if (ignoreBody) writeFileSync(path.join(dir, ".gitignore"), ignoreBody);
      return dir;
    };

    const publicRepo = makeRepo(
      "public-app-repo",
      "https://github.com/masonwells1/CRX_Manager_V1.0.git",
      "docs/claude-memory/\n",
    );
    const exposed = path.join(publicRepo, "scratch-notes");
    eq(quiet(() => stage(exposed, notes)), 1, "staging into an unignored path in the public app repo is refused");
    ok(!readdirSafe(exposed), "the refusal happens before anything is written");

    // The one documented, ignored destination still works.
    const allowed = path.join(publicRepo, "docs", "claude-memory");
    eq(quiet(() => stage(allowed, notes)), 0, "the ignored docs/claude-memory/ destination is still allowed");

    // An SSH remote spelling of the same repo is the same repo.
    const sshRepo = makeRepo("public-app-repo-ssh", "git@github.com:masonwells1/CRX_Manager_V1.0", "");
    eq(
      quiet(() => stage(path.join(sshRepo, "notes"), notes)), 1,
      "the ssh spelling of the app remote is recognised as the same repo",
    );

    // Round 9: so is a spelling that only a URL parser resolves. A raw suffix
    // match called this an unrelated repository and let the notes through.
    const dottedRepo = makeRepo("public-app-repo-dotted", "https://github.com/masonwells1/./CRX_Manager_V1.0.git", "");
    eq(
      quiet(() => stage(path.join(dottedRepo, "notes"), notes)), 1,
      "a `.` segment in the remote does not disguise the public repo",
    );

    // The private off-site clone is a different repo — staging there is the point.
    const backupRepo = makeRepo("private-backup-repo", "https://github.com/masonwells1/CRX_Backups.git", "");
    eq(
      quiet(() => stage(path.join(backupRepo, "claude-memory"), notes)), 0,
      "staging into the private backup clone is allowed even though the files are tracked there",
    );

    // ── round 26: Git can rewrite a verified URL immediately before push ─────
    // `git remote -v` keeps showing the approved private repository, while these
    // settings cause the later push to use a different address. Cover all three
    // configuration sources the real process can inherit.
    {
      const credentialMarker = "credential-marker-for-test";
      const localKey = `url.https://${credentialMarker}@example.invalid/local/.pushInsteadOf`;
      const localDest = path.join(backupRepo, "claude-memory-local-url-rewrite");
      try {
        assert.equal(
          spawnSync(
            "git",
            ["-C", backupRepo, "config", "--local", localKey, "https://github.com/masonwells1/CRX_Backups.git"],
            { encoding: "utf8", env: cleanEnv },
          ).status,
          0,
          "test fixture: could not set the local URL rewrite",
        );
        const run = captured(() => stage(localDest, notes));
        eq(run.value, 1, "a local pushInsteadOf rewrite is refused");
        ok(/URL rewrite settings are active/.test(run.said), "and the refusal explains the hidden redirect");
        ok(!run.said.includes(credentialMarker), "and the refusal never prints URL user information from the setting name");
        ok(!readdirSafe(localDest), "and the local rewrite is refused before anything is written");
      } finally {
        spawnSync("git", ["-C", backupRepo, "config", "--local", "--unset-all", localKey], {
          encoding: "utf8", env: cleanEnv,
        });
      }
    }
    {
      const globalFile = path.join(root, "round-26-global.gitconfig");
      const globalKey = "url.https://example.invalid/global/.insteadOf";
      const previous = process.env.GIT_CONFIG_GLOBAL;
      try {
        assert.equal(
          spawnSync(
            "git",
            ["config", "--file", globalFile, globalKey, "https://github.com/masonwells1/CRX_Backups.git"],
            { encoding: "utf8", env: cleanEnv },
          ).status,
          0,
          "test fixture: could not set the isolated global URL rewrite",
        );
        process.env.GIT_CONFIG_GLOBAL = globalFile;
        const dest = path.join(backupRepo, "claude-memory-global-url-rewrite");
        const run = captured(() => stage(dest, notes));
        eq(run.value, 1, "a global insteadOf rewrite is refused");
        ok(!readdirSafe(dest), "and the global rewrite is refused before anything is written");
      } finally {
        if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previous;
      }
    }
    {
      const previous = new Map(
        ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]
          .map((name) => [name, process.env[name]]),
      );
      try {
        process.env.GIT_CONFIG_COUNT = "1";
        process.env.GIT_CONFIG_KEY_0 = "url.https://example.invalid/inherited/.pushInsteadOf";
        process.env.GIT_CONFIG_VALUE_0 = "https://github.com/masonwells1/CRX_Backups.git";
        const dest = path.join(backupRepo, "claude-memory-inherited-url-rewrite");
        const run = captured(() => stage(dest, notes));
        eq(run.value, 1, "an inherited pushInsteadOf rewrite is refused");
        ok(!readdirSafe(dest), "and the inherited rewrite is refused before anything is written");
      } finally {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }
    eq(
      quiet(() => stage(path.join(backupRepo, "claude-memory-url-rewrite-cleared"), notes)),
      0,
      "clearing every URL rewrite restores the ordinary private-backup path",
    );

    // A plain directory outside any repo is unaffected.
    eq(quiet(() => stage(path.join(root, "plain-destination"), notes)), 0, "a destination outside any repo still works");

    // git exports GIT_DIR into every hook it runs, and it overrides `-C <dir>`
    // discovery. The first cut of this check inherited it and answered for the
    // HOOK's repository — which made an innocent destination look like the public
    // app repo. Caught by the pre-commit hook itself; pinned here.
    {
      const inherited = process.env.GIT_DIR;
      process.env.GIT_DIR = path.join(publicRepo, ".git");
      try {
        eq(
          quiet(() => stage(path.join(root, "hook-env-destination"), notes)), 0,
          "an inherited GIT_DIR does not decide which repo the destination is in",
        );
      } finally {
        if (inherited === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = inherited;
      }
    }

    // ── round 10: a tracked destination must be the ONE private backup repo ──
    // Naming only the repo to refuse accepted every other repository by default —
    // a wrong clone, a public fork, a replaced remote — and the runbook commits and
    // pushes whatever was staged. The rule is an allowlist now.
    const strangerRepo = makeRepo("someone-elses-repo", "https://github.com/someone-else/notes.git", "");
    eq(
      quiet(() => stage(path.join(strangerRepo, "claude-memory"), notes)), 1,
      "an unrelated repository is refused, not accepted by default",
    );
    const forkRepo = makeRepo("public-fork-repo", "https://github.com/masonwells1/CRX_Backups_fork.git", "");
    eq(
      quiet(() => stage(path.join(forkRepo, "claude-memory"), notes)), 1,
      "a repo whose name merely resembles the backup repo is refused",
    );
    const remoteless = makeRepo("no-remote-repo", "", "");
    eq(
      quiet(() => stage(path.join(remoteless, "claude-memory"), notes)), 1,
      "a checkout with no remote is refused — where it would end up cannot be determined",
    );
    // An ignored path is still fine anywhere: nothing there can be committed.
    const ignoringStranger = makeRepo("stranger-that-ignores", "https://github.com/someone-else/notes.git", "claude-memory/\n");
    eq(
      quiet(() => stage(path.join(ignoringStranger, "claude-memory"), notes)), 0,
      "an ignored destination is allowed even in an unrelated repo",
    );
    // Round 13: ignore rules are per-path. A repo that ignores the index file and
    // nothing else left every other note, and the manifest, tracked and
    // publishable — while the one-file probe read the destination as safe.
    const partialIgnorer = makeRepo(
      "stranger-that-ignores-one-file",
      "https://github.com/someone-else/notes.git",
      `claude-memory/${INDEX_FILE}\n`,
    );
    const partial = path.join(partialIgnorer, "claude-memory");
    eq(
      quiet(() => stage(partial, notes)), 1,
      "ignoring only the index file does not license the rest of the snapshot",
    );
    ok(!readdirSafe(partial), "and nothing is written when it is refused");
    const manifestOnlyIgnorer = makeRepo(
      "stranger-that-ignores-the-manifest",
      "https://github.com/someone-else/notes.git",
      "claude-memory/manifest.json\n",
    );
    eq(
      quiet(() => stage(path.join(manifestOnlyIgnorer, "claude-memory"), notes)), 1,
      "ignoring only the manifest does not license the notes either",
    );

    // Being the right repository is not the same as still being private.
    try {
      __setVisibilityProbe(() => ({ visibility: "PUBLIC" }));
      const flipped = path.join(backupRepo, "claude-memory-public");
      eq(quiet(() => stage(flipped, notes)), 1, "staging is refused when GitHub says the backup repo is public");
      ok(!readdirSafe(flipped), "and nothing is written when it is refused");

      // Round 11: offline or without `gh` the check cannot answer, and it used to
      // warn and continue. Publication is permanent and this directory is what the
      // runbook commits and pushes, so an unproven-private destination parks.
      __setVisibilityProbe(() => ({ reason: "gh unavailable: ENOENT" }));
      const unproven = path.join(backupRepo, "claude-memory-offline");
      eq(
        quiet(() => stage(unproven, notes)), 1,
        "an unanswerable visibility check parks the snapshot rather than warning",
      );
      ok(!readdirSafe(unproven), "and nothing is written when it cannot be proven private");
    } finally {
      __setVisibilityProbe(() => ({ visibility: "PRIVATE" }));
    }

    // ── round 22: the right repository, reached by a courier ─────────────────
    // A `relay://` URL canonicalizes to exactly the approved backup repository id
    // while git hands the objects to a `git-remote-relay` program; and an
    // inherited GIT_SSH_COMMAND replaces ssh for the push the runbook performs
    // next. The branch already owned a detector for the second and never called
    // it from here.
    {
      const courier = makeRepo("courier-scheme-repo", "relay://github.com/masonwells1/CRX_Backups.git", "");
      const landing = path.join(courier, "claude-memory");
      const run = captured(() => stage(landing, notes));
      eq(run.value, 1, "a push remote whose scheme git does not implement is refused");
      ok(/transport git does not implement/.test(run.said), "and the refusal says why the repository name is not enough");
      ok(!run.said.includes("relay://"), "without reprinting the URL");
      ok(!readdirSafe(landing), "and nothing is written");
    }
    for (const [name, url] of [
      ["file-scheme-repo", "file://github.com/masonwells1/CRX_Backups.git"],
      ["http-scheme-repo", "http://github.com/masonwells1/CRX_Backups.git"],
      ["git-scheme-repo", "git://github.com/masonwells1/CRX_Backups.git"],
    ]) {
      const repo = makeRepo(name, url, "");
      const landing = path.join(repo, "claude-memory");
      const run = captured(() => stage(landing, notes));
      eq(run.value, 1, `${name}: a non-GitHub HTTPS backup transport is refused`);
      ok(/explicit GitHub HTTPS URL/.test(run.said), `${name}: and the refusal names the required transport`);
      ok(!readdirSafe(landing), `${name}: and nothing is written`);
    }
    {
      const dest = path.join(backupRepo, "claude-memory-inherited-ssh");
      const previous = process.env.GIT_SSH_COMMAND;
      try {
        process.env.GIT_SSH_COMMAND = "sh -c 'ssh relay git-receive-pack notes.git'";
        const run = captured(() => stage(dest, notes));
        eq(run.value, 1, "an inherited transport variable is refused even with a verified URL");
        ok(/GIT_SSH_COMMAND/.test(run.said), "and the refusal names it");
        ok(!readdirSafe(dest), "and nothing is written");
      } finally {
        if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
        else process.env.GIT_SSH_COMMAND = previous;
      }
    }
    {
      const keepalive = path.join(backupRepo, "claude-memory-keepalive");
      const previous = process.env.GIT_SSH_COMMAND;
      try {
        process.env.GIT_SSH_COMMAND = "ssh -o ServerAliveInterval=20";
        eq(quiet(() => stage(keepalive, notes)), 0, "and the documented keepalive shape still snapshots");
      } finally {
        if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
        else process.env.GIT_SSH_COMMAND = previous;
      }
    }

    // ── round 21: the right repository, delivered by the wrong program ────────
    // Everything above proves WHICH repository the remote URL names. It does not
    // prove git uses its own transport to get there: `core.sshCommand` replaces
    // the ssh binary and `remote.<name>.receivepack` names the program on the far
    // side, so a verified URL can still be delivered by an arbitrary relay.
    for (const [key, value] of [
      ["core.sshCommand", "ssh -i /tmp/relay"],
      ["remote.origin.receivepack", "/tmp/relay"],
    ]) {
      const dest = path.join(backupRepo, `claude-memory-relay-${key.replace(/[^a-z]/gi, "")}`);
      try {
        assert.equal(
          spawnSync("git", ["-C", backupRepo, "config", key, value], { encoding: "utf8", env: cleanEnv }).status,
          0,
          `test fixture: could not set ${key}`,
        );
        const run = captured(() => stage(dest, notes));
        eq(run.value, 1, `staging is refused when the checkout configures ${key}`);
        ok(/name a program to\s+carry the push/.test(run.said), "and the refusal explains why the verified URL proves nothing");
        ok(run.said.includes(key.toLowerCase()), "and names the setting to unset");
        ok(!readdirSafe(dest), "and nothing is written when the transport is unaccountable");
      } finally {
        spawnSync("git", ["-C", backupRepo, "config", "--unset", key], { encoding: "utf8", env: cleanEnv });
      }
    }
    {
      const recovered = path.join(backupRepo, "claude-memory-relay-cleared");
      eq(quiet(() => stage(recovered, notes)), 0, "and unsetting them restores an ordinary snapshot");
    }

    // ── round 11: a push can land somewhere the fetch URL never mentions ──────
    // `git remote set-url --push` splits the two. Reading "any URL git mentions"
    // accepted a clone that FETCHES from the private backup and PUSHES to a public
    // repo — and the very next runbook step is a push.
    {
      const split = makeRepo("split-push-repo", "https://github.com/masonwells1/CRX_Backups.git", "");
      const setUrl = spawnSync(
        "git",
        ["-C", split, "remote", "set-url", "--push", "origin", "https://github.com/masonwells1/CRX_Manager_V1.0.git"],
        { encoding: "utf8", env: cleanEnv },
      );
      assert.equal(setUrl.status, 0, `test fixture: set-url --push failed: ${setUrl.stderr}`);
      const landing = path.join(split, "claude-memory");
      eq(quiet(() => stage(landing, notes)), 1, "a private fetch URL does not excuse a public push URL");
      ok(!readdirSafe(landing), "and nothing is written when the push destination is wrong");
    }
    // ── round 12: a remote URL can carry a token, and this one gets printed ───
    // Canonical identity ignores credentials, so a token-bearing URL for the RIGHT
    // repo was accepted — and then echoed for the runbook to reuse.
    {
      const tokened = makeRepo(
        "tokened-backup-repo",
        "https://ghp_EXAMPLETOKENVALUE0000000000@github.com/masonwells1/CRX_Backups.git",
        "",
      );
      const landing = path.join(tokened, "claude-memory");
      const run = captured(() => stage(landing, notes));
      eq(run.value, 1, "a credential-bearing push URL is refused");
      ok(!readdirSafe(landing), "and nothing is written");
      ok(!/ghp_EXAMPLETOKENVALUE/.test(run.said), "and the refusal does not reprint the token");
    }
    // A bare `git@` username is the ordinary SSH spelling, not a credential.
    {
      const ssh = makeRepo("ssh-backup-repo", "git@github.com:masonwells1/CRX_Backups.git", "");
      const landing = path.join(ssh, "claude-memory");
      const run = captured(() => stage(landing, notes));
      eq(run.value, 1, "an SSH remote is refused because OpenSSH configuration can redirect it");
      ok(/explicit GitHub HTTPS URL/.test(run.said), "the refusal names the required unambiguous transport");
      ok(!readdirSafe(landing), "and nothing is written");
    }
    // ── round 16: the token detector only knew ONE of the three shapes ───────
    // Round 12 matched `scheme://userinfo@`, which is what git prints for an HTTPS
    // token. scp-style credentials carry no scheme at all, and a query or fragment
    // is dropped from canonical identity — so both read as the allowed backup repo
    // and were printed with the secret still attached.
    {
      const shapes = [
        ["scp-style-token-repo", "ghp_EXAMPLETOKENVALUE0000000000@github.com:masonwells1/CRX_Backups.git"],
        ["query-token-repo", "https://github.com/masonwells1/CRX_Backups.git?access_token=ghp_EXAMPLETOKENVALUE0000000000"],
        ["fragment-token-repo", "https://github.com/masonwells1/CRX_Backups.git#ghp_EXAMPLETOKENVALUE0000000000"],
      ];
      for (const [name, url] of shapes) {
        const repo = makeRepo(name, url, "");
        const landing = path.join(repo, "claude-memory");
        const run = captured(() => stage(landing, notes));
        eq(run.value, 1, `${name}: a credential in this shape is refused`);
        ok(!readdirSafe(landing), `${name}: and nothing is written`);
        ok(!/ghp_EXAMPLETOKENVALUE/.test(run.said), `${name}: and the token is never echoed`);
      }
    }
    // The redaction backstop, tested directly. It has to be: by design the detector
    // above refuses every shape that carries a secret, so nothing reachable through
    // stage() exercises redaction — and a backstop nobody can test is decoration.
    // These are the shapes a FUTURE detector gap would hand it.
    {
      const T = "ghp_EXAMPLETOKENVALUE0000000000";
      eq(redactUrl(`https://${T}@github.com/masonwells1/CRX_Backups.git`),
        "https://***@github.com/masonwells1/CRX_Backups.git", "https userinfo is masked");
      eq(redactUrl(`https://user:${T}@github.com/masonwells1/CRX_Backups.git`),
        "https://***@github.com/masonwells1/CRX_Backups.git", "so is a user:password pair");
      eq(redactUrl(`${T}@github.com:masonwells1/CRX_Backups.git`),
        "***@github.com:masonwells1/CRX_Backups.git", "and an scp-style token username");
      eq(redactUrl(`https://github.com/masonwells1/CRX_Backups.git?access_token=${T}`),
        "https://github.com/masonwells1/CRX_Backups.git", "a query string is dropped whole");
      eq(redactUrl(`https://github.com/masonwells1/CRX_Backups.git#${T}`),
        "https://github.com/masonwells1/CRX_Backups.git", "so is a fragment");
      // No-ops: the runbook prints this URL and says to push to exactly it, so a
      // legitimate remote must come through byte-identical.
      for (const url of [
        "https://github.com/masonwells1/CRX_Backups.git",
        "git@github.com:masonwells1/CRX_Backups.git",
        "ssh://git@github.com/masonwells1/CRX_Backups.git",
      ]) {
        eq(redactUrl(url), url, `an ordinary remote is printed unchanged: ${url}`);
      }
    }
    // The refusal MESSAGE is a second leak channel: a wrong-repo remote gets its
    // URL printed. Redaction is the backstop for a shape the detector misses.
    {
      const wrong = makeRepo(
        "stranger-with-token-repo",
        "https://ghp_EXAMPLETOKENVALUE0000000000@github.com/someone-else/notes.git",
        "",
      );
      const run = captured(() => stage(path.join(wrong, "claude-memory"), notes));
      eq(run.value, 1, "a stranger's repo is refused whether or not its URL carries a token");
      ok(!/ghp_EXAMPLETOKENVALUE/.test(run.said), "and the wrong-destination message does not print it either");
    }

    // One good remote does not license a second, wrong one: `git push <name>` picks.
    {
      const extra = makeRepo("backup-plus-stray-repo", "https://github.com/masonwells1/CRX_Backups.git", "");
      const added = spawnSync(
        "git",
        ["-C", extra, "remote", "add", "mirror", "https://github.com/someone-else/notes.git"],
        { encoding: "utf8", env: cleanEnv },
      );
      assert.equal(added.status, 0, `test fixture: remote add failed: ${added.stderr}`);
      eq(
        quiet(() => stage(path.join(extra, "claude-memory"), notes)), 1,
        "every push destination must be the backup repo, not just one of them",
      );
    }

    // ── round 15: the FINAL location is what gets committed, so verify checks it ─
    // The documented flow stages outside git — where every repository check is
    // skipped by design, because nothing outside a repo can be committed — then
    // copies into a clone and runs `--verify` there. Until now `--verify` only
    // compared hashes, so the clone that actually receives the notes was never
    // asked which repository it is, where it pushes, or whether GitHub still calls
    // it private. A wrong or public clone passed the final check.
    {
      const outside = path.join(root, "verify-staged-outside-git");
      eq(quiet(() => stage(outside, notes)), 0, "staging outside git still succeeds");
      eq(quiet(() => verify(outside)), 0, "and verifying it there is fine — nothing outside a repo is committable");

      const copySnapshot = (from, to) => {
        mkdirSync(to, { recursive: true });
        for (const name of readdirSync(from)) writeFileSync(path.join(to, name), readFileSync(path.join(from, name)));
      };

      const wrongClone = makeRepo("verify-wrong-clone", "https://github.com/someone-else/notes.git", "");
      const wrongDest = path.join(wrongClone, "claude-memory");
      copySnapshot(outside, wrongDest);
      eq(
        quiet(() => verify(wrongDest)), 1,
        "a byte-perfect snapshot sitting in the wrong clone fails verification on WHERE it is",
      );

      const publicClone = makeRepo("verify-public-app-clone", "https://github.com/masonwells1/CRX_Manager_V1.0.git", "");
      const publicDest = path.join(publicClone, "claude-memory");
      copySnapshot(outside, publicDest);
      eq(quiet(() => verify(publicDest)), 1, "and so does one sitting in the PUBLIC app repo");

      // The legitimate final location still passes, or the check would be useless.
      const goodDest = path.join(backupRepo, "claude-memory-final");
      copySnapshot(outside, goodDest);
      eq(quiet(() => verify(goodDest)), 0, "the private backup clone verifies");

      // Privacy is re-asked at the final location too: a repo that went public
      // between staging and committing must not pass the last check before a push.
      try {
        __setVisibilityProbe(() => ({ visibility: "PUBLIC" }));
        eq(quiet(() => verify(goodDest)), 1, "a backup repo that has gone public fails final verification");
        __setVisibilityProbe(() => ({ reason: "gh unavailable: ENOENT" }));
        eq(quiet(() => verify(goodDest)), 1, "and so does one whose visibility cannot be confirmed");
      } finally {
        __setVisibilityProbe(() => ({ visibility: "PRIVATE" }));
      }
    }
  }

  // ── round 9: a staging run that dies partway cannot pass as complete ──────
  // The notes are copied in place, so a failure mid-copy leaves a mixture of new
  // and old files. With the PREVIOUS manifest still sitting there, that mixture
  // was described by a manifest that no longer matched it. Codex's ninth
  // 2026-07-30 review called it out against the runbook's promise. The manifest is
  // now retired before the first byte is written, so the half-written directory
  // fails `--verify` closed instead of being graded against a stale description.
  {
    const dest = fresh("interrupted-destination");
    const before = makeSource("interrupted-source-a", {
      [INDEX_FILE]: "# index\n- one\n",
      "a.md": "first snapshot\n",
    });
    eq(quiet(() => stage(dest, before)), 0, "the first snapshot stages cleanly");
    eq(quiet(() => verify(dest)), 0, "and verifies");

    // An unexpected directory is rejected while the previous snapshot is
    // verified during preflight, before staging overwrites any existing note.
    mkdirSync(path.join(dest, "zz-crash.md"), { recursive: true });
    const after = makeSource("interrupted-source-b", {
      [INDEX_FILE]: "# index\n- two\n",
      "a.md": "second snapshot\n",
      "zz-crash.md": "this write cannot land\n",
    });
    eq(quiet(() => stage(dest, after)), 1, "an invalid previous snapshot aborts before writing");
    ok(
      readdirSync(dest).includes(MANIFEST),
      "the preflight refusal preserves the previous manifest",
    );
    eq(quiet(() => verify(dest)), 1, "so verify refuses the half-written snapshot");
    eq(
      readFileSync(path.join(dest, "a.md"), "utf8"), "first snapshot\n",
      "and no existing note is overwritten before previous-snapshot validation",
    );
  }

  // A previous manifest can authorize deletion only after its recorded bytes
  // still verify. Corrupting the hash must preserve the otherwise-prunable file.
  {
    const before = makeSource("prune-authority-before", {
      [INDEX_FILE]: "# index\n",
      "stale.md": "keep unless the old manifest is valid\n",
    });
    const after = makeSource("prune-authority-after", { [INDEX_FILE]: "# index\n" });
    const dest = fresh("prune-authority-dest");
    eq(quiet(() => stage(dest, before)), 0, "prune-authority fixture stages");
    const bad = readManifest(dest);
    bad.files.find((entry) => entry.name === "stale.md").sha256 = "0".repeat(64);
    writeManifest(dest, bad);
    eq(quiet(() => stage(dest, after)), 1, "a corrupted previous manifest cannot authorize pruning");
    ok(existsSync(path.join(dest, "stale.md")), "the unrelated stale note remains untouched");
  }

  // Post-push verification reads every remote object and checks its exact hash.
  {
    const remoteDir = fresh("remote-proof");
    const source = makeSource("remote-proof-source", {
      [INDEX_FILE]: "# index\n",
      "a.md": "exact remote bytes\n",
    });
    eq(quiet(() => stage(remoteDir, source)), 0, "remote-proof fixture stages");
    const localManifest = readFileSync(path.join(remoteDir, MANIFEST));
    const manifest = JSON.parse(localManifest);
    const files = new Map([
      [MANIFEST, localManifest],
      ...manifest.files.map((entry) => [entry.name, readFileSync(path.join(remoteDir, entry.name))]),
    ]);
    const reader = (apiPath, raw) => {
      if (!raw) {
        return {
          status: 0,
          stdout: Buffer.from(JSON.stringify([...files.keys()].map((name) => ({ name })))),
        };
      }
      const name = decodeURIComponent(apiPath.split("/").at(-1));
      return files.has(name) ? { status: 0, stdout: files.get(name) } : { status: 1, stdout: Buffer.alloc(0) };
    };
    try {
      __setRemoteRead(reader);
      eq(quiet(() => verifyRemote(remoteDir)), 0, "every exact remote byte verifies");
      files.set("a.md", Buffer.from("changed by a clean filter\n"));
      eq(quiet(() => verifyRemote(remoteDir)), 1, "a remotely altered note fails SHA-256 verification");
    } finally {
      __setRemoteRead(null);
    }
  }

  // ── round 25: never overwrite an existing hard-linked destination file ───
  // Unlike a symlink, a hard link reports as a regular file. Writing it in
  // place changes every name for that inode, including files outside the
  // verified snapshot directory.
  {
    const notes = makeSource("hardlink-source", {
      [INDEX_FILE]: "# Memory Index\n- [a](a.md) — hook\n",
      "a.md": "new private note\n",
    });
    const dest = fresh("hardlink-destination");
    eq(quiet(() => stage(dest, notes)), 0, "hard-link fixture begins with a valid snapshot");

    const outsideDir = fresh("hardlink-outside");
    const outside = path.join(outsideDir, "unrelated-public-file.md");
    writeFileSync(outside, "new private note\n");
    unlinkSync(path.join(dest, "a.md"));
    linkSync(outside, path.join(dest, "a.md"));

    const hardLinkRun = captured(() => stage(dest, notes));
    eq(hardLinkRun.value, 1, "staging refuses an existing hard-linked note");
    ok(/multiple hard links/i.test(hardLinkRun.said), "the refusal names the multiple-hard-link hazard");
    eq(
      readFileSync(outside, "utf8"), "new private note\n",
      "and the other hard-link name remains untouched",
    );

    // Prove the replacement strategy independently of the nlink refusal. Hide
    // the hard-link count at the test seam: staging may proceed, but replacing
    // the directory entry must still leave the outside inode unchanged.
    const atomicDest = fresh("hardlink-atomic-destination");
    eq(quiet(() => stage(atomicDest, notes)), 0, "atomic fixture begins with a valid snapshot");
    const atomicOutside = path.join(outsideDir, "atomic-outside.md");
    writeFileSync(atomicOutside, "new private note\n");
    unlinkSync(path.join(atomicDest, "a.md"));
    linkSync(atomicOutside, path.join(atomicDest, "a.md"));
    const changedNotes = makeSource("hardlink-atomic-updated-source", {
      [INDEX_FILE]: "# Memory Index\n- [a](a.md) — hook\n",
      "a.md": "updated private note\n",
    });
    const linkedDest = path.resolve(atomicDest, "a.md");
    try {
      __setLinkStat((p) => {
        const info = lstatSync(p);
        if (path.resolve(p) === linkedDest) Object.defineProperty(info, "nlink", { value: 1 });
        return info;
      });
      eq(quiet(() => stage(atomicDest, changedNotes)), 0, "atomic replacement remains safe if link-count detection misses");
      eq(readFileSync(path.join(atomicDest, "a.md"), "utf8"), "updated private note\n", "the snapshot receives the new note");
      eq(
        readFileSync(atomicOutside, "utf8"), "new private note\n",
        "while the former hard-link target still remains untouched",
      );
    } finally {
      __setLinkStat(null);
    }
  }

  // ── round 14: never follow a symbolic link, in either direction ───────────
  // A link named `a.md` reports as a regular file through stat, so the source
  // side would copy whatever it points at into the backup, and the destination
  // side would write the notes THROUGH the link — outside the directory whose
  // repository was just verified. Creating a symlink on Windows needs Developer
  // Mode or elevation; where it is not permitted the case is skipped rather than
  // silently passing.
  {
    const notes = makeSource("symlink-source", {
      [INDEX_FILE]: "# Memory Index\n- [a](a.md) — hook\n",
      "a.md": "---\nname: a\n---\n\nreal note\n",
    });
    const outsideDir = fresh("symlink-outside");
    const outside = path.join(outsideDir, "someone-elses-file.md");
    writeFileSync(outside, "do not overwrite me\n");
    const dest = fresh("symlink-destination");
    let realLink = true;
    try {
      symlinkSync(outside, path.join(dest, "a.md"));
    } catch {
      realLink = false;
    }
    if (realLink) {
      eq(quiet(() => stage(dest, notes)), 1, "staging refuses to write through a real symlink");
      eq(
        readFileSync(outside, "utf8"), "do not overwrite me\n",
        "and the file the link pointed at is untouched",
      );
      rmSync(path.join(dest, "a.md"), { force: true });
    }

    // Where the OS would not create one, substitute a stat that reports it. This
    // runs the same refusal in the same place — only the "is it a link?" answer
    // is supplied by the test.
    const asLink = { isFile: () => false, isSymbolicLink: () => true };
    const linkedPath = path.resolve(dest, "a.md");
    try {
      __setLinkStat((p) => (path.resolve(p) === linkedPath ? asLink : lstatSync(p)));
      eq(quiet(() => stage(dest, notes)), 1, "staging refuses to write through a symlink in the destination");
      eq(
        readFileSync(outside, "utf8"), "do not overwrite me\n",
        "and the file the link pointed at is untouched",
      );
      ok(!readdirSync(dest).includes(MANIFEST), "the run stops before a manifest is written");
    } finally {
      __setLinkStat(null);
    }

    // The same rule on the source side: a linked note is not one of the files
    // this script copies, so its target never reaches the backup.
    const sneaky = makeSource("symlink-sneaky-source", {
      [INDEX_FILE]: "# Memory Index\n",
      "b.md": "stand-in for a link\n",
    });
    const sneakyPath = path.resolve(sneaky, "b.md");
    const out = fresh("symlink-source-destination");
    try {
      __setLinkStat((p) => (path.resolve(p) === sneakyPath ? asLink : lstatSync(p)));
      eq(quiet(() => stage(out, sneaky)), 0, "a source symlink does not stop the run");
    } finally {
      __setLinkStat(null);
    }
    ok(
      !readdirSync(out).includes("b.md"),
      "but the linked note is not copied — its target never enters the backup",
    );
  }

  // ── round 17: a manifest name is a file name, never a path ────────────────
  // Verification used to accept any string as a name and `path.join` it. An entry
  // that climbed out of the directory hashed a file elsewhere and reported the
  // snapshot OK — verified bytes git would never store as that note.
  {
    const good = makeSource("traversal-source", {
      [INDEX_FILE]: "# Memory Index\n- [a](a.md) — hook\n",
      "a.md": "---\nname: a\n---\n\nreal note\n",
    });
    const dest = fresh("traversal-staged");
    eq(quiet(() => stage(dest, good)), 0, "a normal snapshot stages");
    const clean = readManifest(dest);
    eq(quiet(() => verify(dest)), 0, "and verifies");

    // The bytes an escaping entry would hash: identical content, parked outside.
    const outsideDir = fresh("traversal-outside");
    const decoyBody = "---\nname: decoy\n---\n\nnot the note\n";
    writeFileSync(path.join(outsideDir, "decoy.md"), decoyBody);

    for (const [label, name] of [
      ["parent traversal", "../traversal-outside/decoy.md"],
      ["windows traversal", "..\\traversal-outside\\decoy.md"],
      ["absolute path", path.join(outsideDir, "decoy.md")],
      ["bare dot-dot", ".."],
      ["the manifest itself", MANIFEST],
      ["a non-note", "notes.tar"],
      ["an empty name", ""],
    ]) {
      const entry = { name, bytes: Buffer.byteLength(decoyBody), sha256: sha256Hex(decoyBody) };
      writeManifest(dest, {
        ...clean,
        files: [...clean.files, entry],
        file_count: clean.files.length + 1,
        total_bytes: clean.total_bytes + entry.bytes,
      });
      const run = captured(() => verify(dest));
      eq(run.value, 1, `verify refuses a manifest entry that ${label}`);
      ok(/not plain snapshot file names/.test(run.said), `and says why (${label})`);
    }

    // Same file twice: counts and totals can be made to agree while a real note
    // goes unhashed.
    const first = clean.files[0];
    writeManifest(dest, {
      ...clean,
      files: [...clean.files, { ...first }],
      file_count: clean.files.length + 1,
      total_bytes: clean.total_bytes + first.bytes,
    });
    eq(quiet(() => verify(dest)), 1, "verify refuses a manifest that lists the same file twice");

    // And a snapshot file that is a LINK rather than a regular file: readFileSync
    // follows it, so the hash matched something git would never store.
    writeManifest(dest, clean);
    eq(quiet(() => verify(dest)), 0, "the restored good manifest verifies again");
    const linkedPath = path.resolve(dest, clean.files[0].name);
    const asLink = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
    try {
      __setLinkStat((p) => (path.resolve(p) === linkedPath ? asLink : lstatSync(p)));
      const run = captured(() => verify(dest));
      eq(run.value, 1, "verify refuses a snapshot file that is a symbolic link");
      ok(/not a regular file/.test(run.said), "and names it as one");
    } finally {
      __setLinkStat(null);
    }

    // Round 19: the same hole one level up. Round 17 made every snapshot FILE
    // prove it is regular and left the manifest reading normally, so a manifest
    // symlinked to a valid manifest elsewhere passed while git recorded only the
    // link — and the stray-entry scan excludes that name unconditionally, so
    // nothing else would have noticed.
    const manifestPath = path.resolve(dest, MANIFEST);
    try {
      __setLinkStat((p) => (path.resolve(p) === manifestPath ? asLink : lstatSync(p)));
      const run = captured(() => verify(dest));
      eq(run.value, 1, "verify refuses a manifest that is itself a symbolic link");
      ok(/is a symbolic link/.test(run.said), "and says so plainly");
    } finally {
      __setLinkStat(null);
    }
    eq(quiet(() => verify(dest)), 0, "and the real manifest still verifies");

    // A stray entry the manifest does not vouch for is still reported, and a
    // dangling link there no longer throws ENOENT out of the whole run.
    const danglingPath = path.resolve(dest, "stray.md");
    writeFileSync(danglingPath, "stray\n");
    try {
      __setLinkStat((p) => (path.resolve(p) === danglingPath ? asLink : lstatSync(p)));
      const run = captured(() => verify(dest));
      eq(run.value, 1, "an unlisted entry still fails verification");
      ok(/not in manifest: stray\.md \(unexpected symbolic link\)/.test(run.said), "and is described as a link");
    } finally {
      __setLinkStat(null);
    }
  }

  // ── round 17: the privacy question must reach github.com ──────────────────
  // `gh repo view masonwells1/CRX_Backups` resolves against whatever host GH_HOST
  // names. A PRIVATE answer from an enterprise server would have authorized
  // staging toward the PUBLIC github.com repo of the same name. Three independent
  // pins, each tested: a full github.com URL as the argument, the host-selecting
  // variables stripped from the child environment, and the URL gh says it
  // answered about compared to the expected one.
  {
    const spec = ghProbeCommand({ GH_HOST: "ghe.example.com", GITHUB_HOST: "ghe.example.com", PATH: "/usr/bin" });
    eq(spec.args[2], "https://github.com/masonwells1/CRX_Backups", "the probe asks about the exact full github.com URL");
    ok(!spec.args.some((a) => /^masonwells1\//.test(a)), "never a bare owner/repo, which GH_HOST would redirect");
    eq(spec.env.GH_HOST, undefined, "GH_HOST is stripped from the child environment");
    eq(spec.env.GITHUB_HOST, undefined, "and GITHUB_HOST");
    eq(spec.env.GH_ENTERPRISE_TOKEN, undefined, "and the enterprise token");
    eq(spec.env.PATH, "/usr/bin", "the rest of the environment is passed through");

    const remoteSpec = remoteReadCommand("repos/masonwells1/CRX_Backups/contents/claude-memory", false, {
      GH_HOST: "ghe.example.com", GITHUB_HOST: "ghe.example.com", PATH: "/usr/bin",
    });
    eq(remoteSpec.args[2], "github.com", "remote byte verification pins github.com explicitly");
    eq(remoteSpec.env.GH_HOST, undefined, "remote verification also strips GH_HOST");
    eq(remoteSpec.env.GITHUB_HOST, undefined, "and GITHUB_HOST");

    const answered = (body) => ghProbeAnswer({ status: 0, stdout: JSON.stringify(body) });
    eq(
      answered({ visibility: "PRIVATE", url: "https://github.com/masonwells1/CRX_Backups" }).visibility,
      "PRIVATE",
      "the real repo answering PRIVATE is accepted",
    );
    ok(
      answered({ visibility: "PRIVATE", url: "https://ghe.example.com/masonwells1/CRX_Backups" }).reason,
      "a PRIVATE from another host is NOT an answer about this repo",
    );
    ok(answered({ visibility: "PRIVATE" }).reason, "and neither is an answer that names no repository");
    ok(
      answered({ visibility: "PRIVATE", url: "https://github.com/someoneelse/CRX_Backups" }).reason,
      "nor a same-named repo under another owner",
    );
    ok(ghProbeAnswer({ status: 0, stdout: "not json" }).reason, "unreadable output is not an answer");
    ok(ghProbeAnswer({ status: 1, stderr: "boom" }).reason, "a non-zero exit is not an answer");
    ok(ghProbeAnswer({ error: { code: "ENOENT" } }).reason, "gh missing is not an answer");
  }

  // ── round 17: unsafeSnapshotName, directly ────────────────────────────────
  {
    for (const name of ["MEMORY.md", "a.md", "project_foo-bar.md", "UPPER.MD"]) {
      eq(unsafeSnapshotName(name), null, `${name} is an ordinary snapshot name`);
    }
    for (const name of ["../a.md", "..\\a.md", "/etc/a.md", "C:a.md", "a.md:stream", "..", ".", "", MANIFEST, "a.txt", "a\0.md"]) {
      ok(unsafeSnapshotName(name), `${JSON.stringify(name)} is refused`);
    }
    ok(unsafeSnapshotName(null), "a non-string is refused");
  }

  // ── round 17: staging refuses a source name it could not later verify ─────
  {
    const weird = makeSource("weird-name-source", { [INDEX_FILE]: "# Memory Index\n" });
    writeFileSync(path.join(weird, "ordinary.md"), "fine\n");
    const dest = fresh("weird-name-dest");
    eq(quiet(() => stage(dest, weird)), 0, "ordinary source names stage");

    // Windows cannot hold a file called `a:b.md` — that spelling means a drive or
    // an alternate data stream there — so the listing is supplied instead of the
    // filesystem. Same refusal, same place, only the directory read is stubbed.
    const dest2 = fresh("weird-name-dest-2");
    // Compared as raw text, not via path.resolve: on Windows `path.resolve` reads
    // the colon in `a:b.md` as a drive letter, which is precisely why the name is
    // refused — and would make the comparison miss.
    try {
      __setDirRead((dir) => (path.resolve(dir) === path.resolve(weird) ? [INDEX_FILE, "a:b.md"] : readdirSync(dir)));
      __setLinkStat((p) => (String(p).endsWith("a:b.md")
        ? { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
        : lstatSync(p)));
      const run = captured(() => stage(dest2, weird));
      eq(run.value, 1, "staging refuses a source name verification would later reject");
      ok(/not plain snapshot names/.test(run.said), "and says which name and why");
      ok(!readdirSync(dest2).includes(MANIFEST), "and no manifest is written");
    } finally {
      __setDirRead(null);
      __setLinkStat(null);
    }
  }

  // ── the CLI still runs when invoked directly ──────────────────────────────
  // The module now exports its functions, which required suppressing the CLI on
  // import. Prove the command Mason actually runs did not become a no-op.
  {
    const result = spawnSync(process.execPath, [SCRIPT, "--verify", staged], { encoding: "utf8" });
    eq(result.status, 0, `CLI --verify exits 0 on a good snapshot: ${result.stderr}`);
    ok(/OK: 3 files match/.test(result.stdout), "CLI --verify reports the file count");
    const bad = spawnSync(process.execPath, [SCRIPT, "--verify", path.join(root, "bogus-empty-manifest")], { encoding: "utf8" });
    eq(bad.status, 1, "CLI --verify exits 1 on the empty-manifest directory");
    const flagAsValue = spawnSync(process.execPath, [SCRIPT, "--stage", "--source", "x"], { encoding: "utf8" });
    eq(flagAsValue.status, 2, "CLI rejects a flag-shaped --stage value with usage status 2");
    const missingVerify = spawnSync(process.execPath, [SCRIPT, "--verify"], { encoding: "utf8" });
    eq(missingVerify.status, 2, "CLI rejects a missing --verify directory with usage status 2");
    const twoOperations = spawnSync(process.execPath, [SCRIPT, "--stage", staged, "--verify", staged], { encoding: "utf8" });
    eq(twoOperations.status, 2, "CLI rejects two operations with usage status 2");
    const missingSource = spawnSync(process.execPath, [SCRIPT, "--stage", staged, "--source"], { encoding: "utf8" });
    eq(missingSource.status, 2, "CLI rejects a missing --source directory with usage status 2");
    const sourceAsFlag = spawnSync(process.execPath, [SCRIPT, "--stage", staged, "--source", "--verify"], { encoding: "utf8" });
    eq(sourceAsFlag.status, 2, "CLI rejects a flag-shaped --source value with usage status 2");
    const unknownFlag = spawnSync(process.execPath, [SCRIPT, "--verify", staged, "--mystery", "x"], { encoding: "utf8" });
    eq(unknownFlag.status, 2, "CLI rejects unknown arguments with usage status 2");
  }

  console.log(`OK - backup-claude-memory checks passed (${pass} assertions).`);
} finally {
  __setGitSpawn();
  rmSync(root, { recursive: true, force: true });
}

// True when `dir` exists and holds anything at all.
function readdirSafe(dir) {
  try { return readdirSync(dir).length > 0; } catch { return false; }
}

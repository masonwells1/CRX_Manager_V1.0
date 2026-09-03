#!/usr/bin/env node
// Regression test for the --write repair path of scripts/sync-agent-workflows.mjs.
//
// Why this file exists: on 2026-08-19 the write path was "fixed" to normalize the
// target before comparing it, which is a no-op on the only case that matters. A
// CRLF mirror normalizes to the canonical LF form, so the write was skipped, the
// file stayed CRLF, and --write still printed "Synced". Two independent reviewers
// and a live proof against a CRLF *source* all missed it, because the source case
// and the mirror case fail differently. CodeRabbit caught it on PR #425.
//
// writeExpected() takes an explicit targetRoot so this runs against a temp
// directory and never touches the real .agents/** tree.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";

import {
  classifyExtras,
  gitEnvironment,
  isEntryPoint,
  previousManifest,
  writeExpected,
} from "./sync-agent-workflows.mjs";

const targetRoot = mkdtempSync(path.join(os.tmpdir(), "crx-sync-write-"));

try {
  // The two entries writeExpected() subtracts from its count (README + manifest)
  // are irrelevant here; any Map of relative-path -> content exercises the loop.
  const expected = new Map([
    ["skills/demo/SKILL.md", "line one\nline two\n"],
    ["README.md", "readme\n"],
    ["generated-manifest.json", '{"version":1,"managed":[]}\n'],
  ]);

  // A mirror smudged to CRLF must be repaired to LF. This is the assertion the
  // normalize-before-compare version silently failed.
  mkdirSync(path.join(targetRoot, "skills", "demo"), { recursive: true });
  const smudged = path.join(targetRoot, "skills", "demo", "SKILL.md");
  writeFileSync(smudged, "line one\r\nline two\r\n");
  assert.ok(readFileSync(smudged, "utf8").includes("\r\n"), "fixture must start out CRLF");

  writeExpected(expected, targetRoot);

  assert.equal(
    readFileSync(smudged, "utf8"),
    "line one\nline two\n",
    "--write must rewrite a CRLF mirror to LF, not skip it as already in sync",
  );

  // ...and it must be idempotent: a second run over an already-LF tree leaves the
  // bytes untouched. (Raw comparison is what keeps this true — the canonical form
  // equals the file byte for byte, so nothing is rewritten.)
  //
  // Assert on mtime, not content. Content alone also passes when writeExpected
  // rewrites every file with identical bytes on every run, which is exactly the
  // claim this block is here to disprove — the same "proof weaker than the claim"
  // trap that let the CRLF-mirror bug ship.
  const untouched = new Date("2000-01-01T00:00:00.000Z");
  utimesSync(smudged, untouched, untouched);
  writeExpected(expected, targetRoot);
  assert.equal(readFileSync(smudged, "utf8"), "line one\nline two\n");
  assert.equal(
    statSync(smudged).mtime.getTime(),
    untouched.getTime(),
    "an in-sync mirror must not be rewritten at all, not merely rewritten identically",
  );

  // A source carrying CRLF must still land as LF in the mirror. This is the case
  // the original fix DID cover; keep it pinned so a future edit cannot trade one
  // half of the repair for the other.
  const crlfSource = new Map([
    ["skills/demo/SKILL.md", "alpha\r\nbeta\r\n"],
    ["README.md", "readme\n"],
    ["generated-manifest.json", '{"version":1,"managed":[]}\n'],
  ]);
  writeExpected(crlfSource, targetRoot);
  assert.equal(
    readFileSync(smudged, "utf8"),
    "alpha\nbeta\n",
    "a CRLF source must be normalized to LF on the way into the mirror",
  );

  // Real content drift is still written through, EOL handling notwithstanding.
  const changed = new Map([
    ["skills/demo/SKILL.md", "alpha\nCHANGED\n"],
    ["README.md", "readme\n"],
    ["generated-manifest.json", '{"version":1,"managed":[]}\n'],
  ]);
  writeExpected(changed, targetRoot);
  assert.equal(readFileSync(smudged, "utf8"), "alpha\nCHANGED\n");
  // ── entry-point detection ────────────────────────────────────────────────
  // The CLI is guarded by isEntryPoint() so importing this module (which the
  // assertions above do) cannot regenerate the real .agents/** tree. A false
  // negative here is the dangerous direction: the CLI would silently not run,
  // `--check` would exit 0 with no output, and check-agent-workflows.mjs would
  // report "synced" having checked nothing.
  const selfUrl = new URL("./sync-agent-workflows.mjs", import.meta.url).href;
  const selfPath = fileURLToPath(selfUrl);

  assert.equal(isEntryPoint(selfPath, selfUrl), true, "absolute path must be recognized (CI spawn)");
  assert.equal(
    isEntryPoint(path.relative(process.cwd(), selfPath), selfUrl),
    true,
    "relative path must be recognized (husky / npm script invocation)",
  );
  assert.equal(isEntryPoint(undefined, selfUrl), false, "no argv[1] is not an entry point");
  assert.equal(
    isEntryPoint(path.join(path.dirname(selfPath), "normalize-eol.mjs"), selfUrl),
    false,
    "a different file must not be treated as the entry point",
  );

  // Windows drive-letter casing: process.cwd() carries whatever casing launched
  // the shell, import.meta.url carries the module URL's. A plain === would skip
  // the CLI on a `c:` vs `C:` mismatch.
  if (process.platform === "win32" && /^[A-Za-z]:/.test(selfPath)) {
    const flipped = selfPath[0] === selfPath[0].toUpperCase()
      ? selfPath[0].toLowerCase() + selfPath.slice(1)
      : selfPath[0].toUpperCase() + selfPath.slice(1);
    assert.equal(
      isEntryPoint(flipped, pathToFileURL(selfPath).href),
      true,
      "drive-letter casing must not decide whether the CLI runs",
    );
  }
  // ── foreign Codex-import directories ─────────────────────────────────────
  // The Codex CLI's /import feature writes source-command-<name>/SKILL.md into
  // .agents/skills/. Those are not generated here and blocked every commit in
  // the checkout they landed in. classifyExtras() splits them out of the verdict
  // WITHOUT widening the check for anything else.
  //
  // Every assertion below was mutation-proved load-bearing: dropping the `[^/]+`
  // to `[^/]*` reddens the bare-prefix case; dropping the trailing `/` from the
  // pattern reddens the sibling-file case; removing the classification entirely
  // reddens the first case.
  {
    const foreign = classifyExtras([
      "skills/source-command-ship/SKILL.md",
      "skills/source-command-ship/extra.md",
      "skills/source-command-parked/SKILL.md",
    ]);
    assert.deepEqual(foreign.extras, [], "importer directories must not count as drift");
    assert.deepEqual(
      foreign.foreignDirs,
      ["source-command-parked", "source-command-ship"],
      "each importer directory is reported ONCE, sorted, however many files it holds",
    );

    // The exemption must stay narrow. An ordinary stray file is still drift —
    // this is the check that would have caught a blanket "ignore extras" fix.
    const mixed = classifyExtras([
      "skills/source-command-ship/SKILL.md",
      "skills/NOT-OURS.md",
      "README.stray",
    ]);
    assert.deepEqual(
      mixed.extras,
      ["skills/NOT-OURS.md", "README.stray"],
      "a stray file outside an importer directory must still be reported as drift",
    );
    assert.deepEqual(mixed.foreignDirs, ["source-command-ship"]);

    // Near-misses that must NOT be exempted: the prefix as a bare directory name
    // with nothing after it, the prefix as a FILE rather than a directory, and
    // the prefix appearing anywhere other than the first path segment under
    // skills/. Each of these is a path the generator could legitimately own.
    const nearMisses = classifyExtras([
      "skills/source-command-/SKILL.md",
      "skills/source-command-ship.md",
      "skills/real/source-command-ship/SKILL.md",
      "source-command-ship/SKILL.md",
    ]);
    assert.deepEqual(
      nearMisses.foreignDirs,
      [],
      "only skills/source-command-<name>/... is foreign; near-miss shapes stay checked",
    );
    assert.equal(nearMisses.extras.length, 4, "every near-miss is still reported as drift");

    // ── the three narrowing conditions (Codex, PR #565) ────────────────────
    // Each closes a way the exemption could have let non-generated instructions
    // live in .agents/ unchallenged. Drop the corresponding option from
    // classifyExtras and exactly one of these goes red.

    // (a) A directory the generator PREVIOUSLY owned stays ours. Otherwise
    //     deleting a canonical `.claude` command named source-command-* drops
    //     its mirror out of `expected`, and the orphan would be waved through as
    //     importer litter while its stale instructions remain on disk.
    const orphaned = classifyExtras(["skills/source-command-demo/SKILL.md"], {
      previouslyManaged: ["skills/source-command-demo/SKILL.md"],
    });
    assert.deepEqual(orphaned.foreignDirs, [], "a formerly generated directory is not importer litter");
    assert.deepEqual(
      orphaned.extras,
      ["skills/source-command-demo/SKILL.md"],
      "an orphaned mirror of a deleted canonical command is still drift",
    );

    // (b) Ownership is per DIRECTORY, not per file. When the generator emits
    //     skills/source-command-demo/SKILL.md, a hand-added sibling in that same
    //     directory is drift — not litter — even though the sibling itself is
    //     never in `expected`.
    const sibling = classifyExtras(["skills/source-command-demo/manual.md"], {
      expectedKeys: ["skills/source-command-demo/SKILL.md"],
    });
    assert.deepEqual(sibling.foreignDirs, [], "a canonical directory is never reclassified as foreign");
    assert.deepEqual(
      sibling.extras,
      ["skills/source-command-demo/manual.md"],
      "an extra file beside a generated adapter stays drift",
    );

    // (c) The exemption is for UNTRACKED working-tree litter only. Once the
    //     importer output is staged or tracked it is becoming part of the repo,
    //     and mangled instructions must fail the parity check rather than ride
    //     in silently. Proven live as well: staging the fixture turned --check
    //     from PASS to `FAIL ... is not generated from .claude`.
    const staged = classifyExtras(["skills/source-command-ship/SKILL.md"], {
      trackedPaths: ["skills/source-command-ship/SKILL.md"],
    });
    assert.deepEqual(staged.foreignDirs, [], "tracked importer output is not exempt");
    assert.deepEqual(
      staged.extras,
      ["skills/source-command-ship/SKILL.md"],
      "staged or tracked importer files must fail the check",
    );

    // (d) DELIBERATELY NOT COVERED, and pinned here so the gap is visible.
    //     Sequence Codex found: a generated source-command-demo/ also holds an
    //     extra manual.md; the canonical command is deleted; --write prunes
    //     SKILL.md and rewrites `managed` without the directory. On the next
    //     --check, `previouslyManaged` no longer mentions it, so (a) cannot fire
    //     and the surviving manual.md IS waved through as litter.
    //
    //     A durable `ownedImporterDirs` field used to cover this, reconstructed
    //     from the git index, HEAD and every merge parent. That layer drew a
    //     review finding every round without converging - eight across eight
    //     rounds, one of them introduced by the fix for the round before it - so
    //     Mason cut it on 2026-09-03. Nothing in .claude/ is named
    //     `source-command-*`, so this sequence cannot occur today; the cost if it
    //     ever did is an unreferenced instruction file under .agents/.
    const afterRewrite = classifyExtras(["skills/source-command-demo/manual.md"], {
      expectedKeys: ["README.md"],
      previouslyManaged: [],
    });
    assert.deepEqual(
      afterRewrite.foreignDirs,
      ["source-command-demo"],
      "ACCEPTED GAP: once --write rewrites `managed`, a formerly generated directory is treated as litter",
    );
    assert.deepEqual(afterRewrite.extras, []);
    // Case (b) above already pins the half that still holds: while the canonical
    // command exists, a hand-added sibling beside its adapter is still drift.

    // (e) UNKNOWN tracking state must not buy an exemption. gitKnownTargetPaths
    //     used to answer a git failure with an empty list, which reads as
    //     "nothing is tracked" - the most permissive answer available, handed
    //     out at exactly the moment the check can no longer tell whether the
    //     importer output had been staged. It now reports `known: false` and the
    //     exemption is withheld (CodeRabbit, PR #565).
    const trackingUnknown = classifyExtras(["skills/source-command-ship/SKILL.md"], {
      trackedPaths: [],
      trackingKnown: false,
    });
    assert.deepEqual(trackingUnknown.foreignDirs, [], "unknown tracking state grants no exemption");
    assert.deepEqual(
      trackingUnknown.extras,
      ["skills/source-command-ship/SKILL.md"],
      "when git cannot be consulted, importer paths are reported as drift",
    );

    // (f) The SAME shape, from the other provenance source. A manifest that
    //     exists but cannot be parsed means the record of what the last sync
    //     generated is UNAVAILABLE, not empty; conflating the two would hand a
    //     corrupt manifest the exemption for every importer directory.
    //     checkExpected() ands both signals together, so this is the identical
    //     withholding.
    const manifestUnavailable = classifyExtras(["skills/source-command-ship/SKILL.md"], {
      trackingKnown: false, // gitKnown.known && prior.known, with prior unusable
    });
    assert.deepEqual(manifestUnavailable.foreignDirs, [], "an unreadable manifest grants no exemption");
    assert.deepEqual(
      manifestUnavailable.extras,
      ["skills/source-command-ship/SKILL.md"],
      "a corrupt manifest reports importer paths as drift instead of exempting them",
    );

    // ...and the untracked twin of (c) still passes, so the fix did not simply
    // delete the exemption. An empty tracked list with `known: true` is a real
    // answer - nothing staged yet - and must still exempt.
    const untracked = classifyExtras(["skills/source-command-ship/SKILL.md"]);
    assert.deepEqual(untracked.foreignDirs, ["source-command-ship"]);
    assert.deepEqual(untracked.extras, [], "untracked importer litter is still exempt");
  }

  // (g) The staged-path guard has to read the index git is actually committing.
  //     `git commit <paths>` hands its hooks a TEMPORARY index holding exactly
  //     the candidate tree via GIT_INDEX_FILE; this helper used to delete that
  //     variable along with the repository redirects, so the guard inspected the
  //     default index and a partial commit could carry an imported adapter in
  //     unseen (Codex P2, PR #565). The redirects still have to go - they are
  //     absolute and outrank `-C ROOT`.
  {
    const commonDir = path.join(targetRoot, ".git");
    const candidateIndex = path.join(commonDir, "index.tmp-abc123");
    const kept = gitEnvironment(
      {
        GIT_DIR: "/elsewhere/.git",
        GIT_WORK_TREE: "/elsewhere",
        GIT_INDEX_FILE: candidateIndex,
      },
      { commonDir },
    );
    assert.equal(kept.GIT_DIR, undefined, "GIT_DIR outranks -C ROOT and must be stripped");
    assert.equal(kept.GIT_WORK_TREE, undefined, "GIT_WORK_TREE must be stripped");
    assert.equal(
      kept.GIT_INDEX_FILE,
      candidateIndex,
      "the candidate index for THIS repository must survive, or a partial commit is inspected against the wrong index",
    );

    // A relative value is resolved against the cwd git invoked the hook from,
    // not against ROOT, which is where `-C ROOT` would otherwise re-root it.
    const relative = gitEnvironment(
      { GIT_INDEX_FILE: "index.tmp-rel" },
      { commonDir, cwd: commonDir },
    );
    assert.equal(relative.GIT_INDEX_FILE, path.join(commonDir, "index.tmp-rel"));

    // ...but only for THIS repository. core.hooksPath has pointed at a foreign
    // checkout on this machine, and honoring its index would have us report on
    // an unrelated repository's staged files.
    const foreign = gitEnvironment(
      { GIT_INDEX_FILE: path.join(targetRoot, "other-repo", ".git", "index") },
      { commonDir },
    );
    assert.equal(
      foreign.GIT_INDEX_FILE,
      undefined,
      "an index belonging to another repository is discarded, not trusted",
    );

    // With no git dir resolvable there is nothing to validate against, so the
    // stray value is dropped rather than honored.
    const unresolvable = gitEnvironment({ GIT_INDEX_FILE: candidateIndex }, { commonDir: null });
    assert.equal(unresolvable.GIT_INDEX_FILE, undefined);
  }

  // (h) The manifest records `managed` and nothing else. The durable
  //     `ownedImporterDirs` field - and with it the git index / HEAD /
  //     MERGE_HEAD reconstruction that kept it honest - was cut on 2026-09-03.
  //     Pinned here so a future change cannot quietly reintroduce the field
  //     without also reintroducing the eight findings' worth of provenance
  //     handling it needs to be safe.
  {
    const manifest = JSON.parse(readFileSync(path.join(targetRoot, "generated-manifest.json"), "utf8"));
    assert.deepEqual(
      Object.keys(manifest).sort(),
      ["managed", "version"],
      "the manifest carries only `version` and `managed`",
    );
  }

  // (i) Valid JSON of the WRONG SHAPE is not an answer either. previousManifest()
  //     used to read `parsed.managed` off whatever parsed, fall back to `[]` when
  //     it was not an array, and still report `known: true` - so `[]`,
  //     `"text"` or `{"managed":"invalid"}` all read as a confident "nothing was
  //     managed". checkExpected() ands `prior.known` into `trackingKnown`, so
  //     that confident-but-wrong empty is what hands a corrupt manifest the
  //     importer exemption for every source-command-* directory. It must fail
  //     closed, exactly like the unparseable branch (CodeRabbit, PR #565).
  {
    const shapeRoot = path.join(targetRoot, "manifest-shapes");
    mkdirSync(shapeRoot, { recursive: true });
    const manifestPath = path.join(shapeRoot, "generated-manifest.json");
    const write = (text) => writeFileSync(manifestPath, text);

    // No manifest at all stays a real answer: nothing has been generated yet.
    assert.deepEqual(previousManifest(shapeRoot), { managed: [], known: true });

    for (const [label, text] of [
      ["unparseable", "{not json"],
      ["a top-level array", "[]"],
      ["a top-level string", '"text"'],
      ["a top-level null", "null"],
      ["a top-level number", "7"],
      ["managed as a string", '{"version":1,"managed":"invalid"}'],
      ["managed as an object", '{"version":1,"managed":{}}'],
      ["managed missing", '{"version":1}'],
      ["managed holding non-strings", '{"version":1,"managed":["ok.md",42]}'],
      // The version must be present and EXACT, or a manifest written by some other
      // generator is parsed on a guess and treated as authoritative (Codex, PR #565).
      ["version missing", '{"managed":[]}'],
      ["version null", '{"version":null,"managed":[]}'],
      ["version from a future writer", '{"version":2,"managed":[]}'],
      ["version as a string", '{"version":"1","managed":[]}'],
      // Every entry is joined onto the target root and passed to rmSync() by --write,
      // so an entry that can ESCAPE that root is not merely odd, it is a delete outside
      // .agents/. `managed: ["../package.json"]` used to prune a repository file.
      ["a parent-escaping entry", '{"version":1,"managed":["../package.json"]}'],
      ["a deep parent-escaping entry", '{"version":1,"managed":["skills/../../package.json"]}'],
      ["a windows-separator entry", '{"version":1,"managed":["..\\\\.git\\\\index"]}'],
      ["a posix-absolute entry", '{"version":1,"managed":["/etc/passwd"]}'],
      ["a drive-absolute entry", '{"version":1,"managed":["C:/Windows/system32/drivers/etc/hosts"]}'],
      ["an empty entry", '{"version":1,"managed":[""]}'],
      ["a dot segment", '{"version":1,"managed":["./README.md"]}'],
      ["a doubled separator", '{"version":1,"managed":["skills//SKILL.md"]}'],
      ["a NUL in an entry", '{"version":1,"managed":["README.md\\u0000.evil"]}'],
    ]) {
      write(text);
      assert.deepEqual(
        previousManifest(shapeRoot),
        { managed: [], known: false },
        `${label} must report the record as UNAVAILABLE, not as an empty managed list`,
      );
    }

    // ...and the real shape still answers, so this did not simply disable the
    // provenance source it is guarding.
    write('{"version":1,"managed":["skills/demo/SKILL.md"]}\n');
    assert.deepEqual(previousManifest(shapeRoot), {
      managed: ["skills/demo/SKILL.md"],
      known: true,
    });
    write('{"version":1,"managed":[]}\n');
    assert.deepEqual(
      previousManifest(shapeRoot),
      { managed: [], known: true },
      "a well-formed manifest with an empty managed list is a real answer",
    );

    // An INHERITED `managed` must not satisfy the check. With Object.prototype
    // polluted anywhere in the process, a bare property read on `{"version":1}`
    // returns the inherited array and the record reads as authoritative-and-empty
    // (Codex, PR #565). `Object.hasOwn` is what closes it.
    write('{"version":1}');
    Object.defineProperty(Object.prototype, "managed", {
      value: [],
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      assert.deepEqual(
        previousManifest(shapeRoot),
        { managed: [], known: false },
        "an inherited `managed` must not make a schema-invalid manifest authoritative",
      );
    } finally {
      delete Object.prototype.managed;
    }
    assert.equal(({}).managed, undefined, "the prototype fixture must be torn down");

    rmSync(shapeRoot, { recursive: true, force: true });
  }

  // (j) --write PRUNES by deleting `path.join(targetRoot, entry)` for every manifest
  //     entry no longer generated. An entry that escapes the target root therefore
  //     deletes a file outside .agents/ - `managed: ["../package.json"]` removed a
  //     repository file (Codex, PR #565). Two layers now stop it: previousManifest()
  //     refuses the manifest outright, and the prune loop independently re-checks
  //     containment because a delete does not get to assume its caller validated.
  //     Asserted end to end on a real file outside the target root.
  {
    const escapeRoot = mkdtempSync(path.join(os.tmpdir(), "crx-sync-escape-"));
    const targetInside = path.join(escapeRoot, "agents");
    mkdirSync(targetInside, { recursive: true });
    const outsider = path.join(escapeRoot, "package.json");
    writeFileSync(outsider, '{"name":"must-survive"}\n');
    writeFileSync(
      path.join(targetInside, "generated-manifest.json"),
      '{"version":1,"managed":["../package.json","skills/../../package.json"]}\n',
    );

    writeExpected(
      new Map([
        ["README.md", "readme\n"],
        ["generated-manifest.json", '{"version":1,"managed":[]}\n'],
      ]),
      targetInside,
    );

    assert.equal(
      readFileSync(outsider, "utf8"),
      '{"name":"must-survive"}\n',
      "a manifest entry that escapes the target root must never delete a file outside it",
    );
    rmSync(escapeRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(targetRoot, { recursive: true, force: true });
}

console.log("OK - sync-agent-workflows --write repairs CRLF mirrors; Codex-import dirs are quarantined, not ignored.");

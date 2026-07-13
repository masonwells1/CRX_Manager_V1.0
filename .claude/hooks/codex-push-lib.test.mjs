#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";

import {
  claudeProofValid,
  contentIsRisky,
  gitPushCwd,
  mainPushIsForced,
  mainPushSource,
  proofValid,
  riskyFiles,
} from "./codex-push-lib.mjs";

const now = Date.parse("2026-07-13T18:00:00.000Z");
const sha = "a".repeat(40);

assert.equal(mainPushSource("git push origin HEAD:main", "feature"), "HEAD");
assert.equal(mainPushSource("git -C ../repo push origin release:main", "feature"), "release");
assert.equal(mainPushSource("git push origin :main", "feature"), "DELETE");
assert.equal(mainPushSource("git push origin feature", "feature"), null);

assert.equal(mainPushIsForced("git push origin main --force", "feature"), true);
assert.equal(mainPushIsForced("git push origin main -f", "feature"), true);
assert.equal(mainPushIsForced("git push origin main --force-with-lease", "feature"), true);
assert.equal(mainPushIsForced("git push origin main --force-with-lease=refs/heads/main:abc", "feature"), true);
assert.equal(mainPushIsForced("git push origin +HEAD:main", "feature"), true);
assert.equal(mainPushIsForced("git push origin \"+HEAD:main\"", "feature"), true);
assert.equal(mainPushIsForced("git -C . push --force origin main", "feature"), true);
assert.equal(mainPushIsForced("git push -uf origin main", "feature"), true);
assert.equal(mainPushIsForced("git push origin feature --force", "feature"), false);
assert.equal(mainPushIsForced("git push origin HEAD:main", "feature"), false);

assert.equal(gitPushCwd("git -C ../repo push origin HEAD:main", "C:/work/current"), path.resolve("C:/work/repo"));
assert.equal(gitPushCwd("git -C .. -C sibling push origin HEAD:main", "C:/work/current"), path.resolve("C:/work/sibling"));

assert.deepEqual(riskyFiles(["src/pages/Home.tsx", "supabase/migrations/1.sql"]), ["supabase/migrations/1.sql"]);
assert.equal(contentIsRisky("+ const total_cents = 100"), true);
assert.equal(contentIsRisky("+ const title = 'ordinary'"), false);

const codexProof = { codex_ran: true, verdict: "clean", head_sha: sha, timestamp: new Date(now).toISOString() };
assert.equal(proofValid(codexProof, sha, now), true);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now - 30 * 60 * 1000).toISOString() }, sha, now), true);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now - 30 * 60 * 1000 - 1).toISOString() }, sha, now), false);
assert.equal(proofValid({ ...codexProof, timestamp: new Date(now + 1).toISOString() }, sha, now), false);
assert.equal(proofValid({ ...codexProof, head_sha: "" }, sha, now), false);

const claudeProof = { claude_ran: true, verdict: "blockers-fixed", head_sha: sha, timestamp: new Date(now).toISOString() };
assert.equal(claudeProofValid(claudeProof, sha, now), true);
assert.equal(claudeProofValid({ ...claudeProof, claude_ran: false }, sha, now), false);
assert.equal(claudeProofValid({ ...claudeProof, verdict: "ship" }, sha, now), false);
assert.equal(claudeProofValid({ ...claudeProof, head_sha: "b".repeat(40) }, sha, now), false);
assert.equal(claudeProofValid({ ...claudeProof, timestamp: new Date(now + 60_000).toISOString() }, sha, now), false);

console.log("OK - codex push shared library checks passed.");

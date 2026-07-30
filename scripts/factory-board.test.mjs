#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFactoryBoardServer,
  escapeHtml,
  projectFactoryBoardState,
  renderFactoryBoard,
  safeEvidencePath,
} from "./factory-board.mjs";
import { resolveFactoryPaths } from "./factory-state-lib.mjs";

let pass = 0;
const ok = (value, message) => { assert.ok(value, message); pass++; };
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); pass++; };
const throws = (fn, pattern, message) => { assert.throws(fn, pattern, message); pass++; };

eq(escapeHtml(`<script>"x"&'y'</script>`), "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;", "HTML escaping covers active characters");

const snapshot = {
  held: false,
  holdReason: "",
  warning: "",
  jobs: [{
    id: "job-1",
    title: `<img src=x onerror="alert(1)">`,
    stage: "awaiting-morning-review",
    behaviorSummary: "A $500 split shows $250 and $250.",
    blocker: "",
    evidence: [{ label: "Browser proof", kind: "screenshot", filename: "abc-proof.png" }],
    reviews: [{ reviewer: "codex", model: "gpt-5.6-sol", verdict: "clean", filename: "review.json", sha256: "c".repeat(64) }],
    lastActivity: "2026-07-30T12:00:00.000Z",
  }],
};
const html = renderFactoryBoard(snapshot);
ok(!html.includes("<img src=x"), "ticket title cannot inject HTML");
ok(html.includes("&lt;img src=x"), "escaped title remains readable");
ok(html.includes("Ready for your review"), "friendly stage label is rendered");
ok(html.includes("Browser proof"), "machine-attached proof is visible");
ok(html.includes("Independent codex review: CLEAN"), "independent reviewer receipt is visible");
ok(html.includes("@media (max-width:640px)"), "board has a narrow viewport layout");
ok(!/<form|<button|method=/i.test(html), "board contains no mutation controls");
const projected = projectFactoryBoardState({
  schemaVersion: 1,
  held: false,
  holdReason: "",
  degraded: false,
  warning: "",
  jobs: [{
    ...snapshot.jobs[0],
    sessionId: "private-owner-session",
    laneSessionId: "private-lane-session",
    evidence: [{
      ...snapshot.jobs[0].evidence[0],
      sourceCommand: "npm run test:factory",
      sha256: "a".repeat(64),
      verified: true,
      baseSha: "b".repeat(40),
    }],
  }],
});
const projectedJson = JSON.stringify(projected);
ok(!projectedJson.includes("private-owner-session"), "board API projection omits owner chat session identifiers");
ok(!projectedJson.includes("private-lane-session"), "board API projection omits lane session identifiers");
ok(!projectedJson.includes('"baseSha"'), "board API projection omits internal proof base metadata");
ok(projectedJson.includes('"reviewer":"codex"'), "board API includes the independent reviewer identity");

const empty = renderFactoryBoard({ held: false, holdReason: "", warning: "", jobs: [] });
ok(empty.includes("No factory jobs yet"), "empty state tells Mason what happens next");

const degraded = renderFactoryBoard({
  held: false,
  holdReason: "",
  warning: "The final event was interrupted.",
  jobs: [],
});
ok(degraded.includes("Ledger warning"), "degraded ledger state is visible");

const root = mkdtempSync(path.join(tmpdir(), "crx-factory-board-"));
const env = { CRX_FACTORY_TEST_MODE: "1", CRX_FACTORY_TEST_STATE_DIR: path.join(root, "state") };
const paths = resolveFactoryPaths(root, env);
throws(() => safeEvidencePath(paths, "..", "x.txt"), /Unsafe identifier/, "job traversal is rejected");
throws(() => safeEvidencePath(paths, "job-1", "../x.txt"), /Unsafe evidence filename/, "file traversal is rejected");

const server = createFactoryBoardServer({ cwd: root, env });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const page = await fetch(base);
eq(page.status, 200, "board GET succeeds");
ok((await page.text()).includes("Factory Board"), "served page is the board");
const post = await fetch(base, { method: "POST" });
eq(post.status, 405, "state-changing HTTP methods are refused");
const api = await fetch(`${base}/api/state`);
eq(api.status, 200, "read-only state endpoint succeeds");
await new Promise((resolve) => server.close(resolve));

rmSync(root, { recursive: true, force: true });
console.log(`factory-board: ${pass} assertions passed`);

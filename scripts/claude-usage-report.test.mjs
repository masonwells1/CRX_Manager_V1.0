import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./claude-usage-report.mjs", import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), "claude-usage-prompts-"));
const timestamp = "2026-09-04T12:00:00Z";
const user = (content) => ({ type: "user", timestamp, message: { content } });
const assistant = (id, content = []) => ({
  type: "assistant", timestamp,
  message: { id, model: "fixture-model", content, usage: { input_tokens: 10, output_tokens: 2 } },
});
const writeRecords = (file, records) => writeFileSync(file, records.map(JSON.stringify).join("\n") + "\n");
try {
  const project = path.join(root, "CRX-fixture");
  const subagents = path.join(project, "main", "subagents");
  mkdirSync(subagents, { recursive: true });
  writeRecords(path.join(project, "main.jsonl"), [
    user("Review my usage."),
    user([{ type: "text", text: "Keep the report concise." }]),
    assistant("main-response"),
  ]);
  writeRecords(path.join(subagents, "agent-fixture.jsonl"), [
    user("Parent agent instructions, not Mason's words."),
    user([{ type: "text", text: "Another agent instruction." }]),
    assistant("sub-response", [{ type: "tool_use", id: "sub-tool", name: "Read", input: { file_path: "fixture.txt" } }]),
    user([{ type: "tool_result", tool_use_id: "sub-tool", is_error: true, content: "REVIEW PROOF GUARD: fixture refusal" }]),
  ]);
  const result = spawnSync(process.execPath, [script, "--root", root, "--start", "2026-09-04", "--end", "2026-09-05"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /main sessions 1 \| subagent transcripts 1 \| human prompts 2 \| API calls 2 \| unique tool calls 1/);
  assert.match(result.stdout, /"review-proof":1/);
  console.log("claude-usage-report: parent prompts counted; subagent prompts excluded; subagent usage and denials retained");

  // --denials writes refused command text verbatim, so its destination must not sit inside a git
  // checkout, where a later broad `git add` would commit it (Codex App review of #613 at 1097d85e6).
  // The rule is by shape — any ancestor owning a `.git` entry — not by this checkout's name, so a
  // sibling worktree or an unrelated repository is refused the same way.
  const windowArgs = ["--root", root, "--start", "2026-09-04", "--end", "2026-09-05"];
  const repoRoot = path.resolve(path.dirname(script), "..");
  const fakeCheckout = path.join(root, "some-checkout");
  mkdirSync(path.join(fakeCheckout, "nested", "deeper"), { recursive: true });
  writeFileSync(path.join(fakeCheckout, ".git"), "gitdir: elsewhere\n");
  for (const [label, destination] of [
    ["this checkout", path.join(repoRoot, "usage-denials-fixture.json")],
    ["a directory marked as a checkout by a .git file", path.join(fakeCheckout, "nested", "deeper", "out.json")],
    ["a relative path resolved against a checkout cwd", "usage-denials-fixture.json"],
  ]) {
    const refused = spawnSync(process.execPath, [script, ...windowArgs, "--denials", destination], { encoding: "utf8", cwd: label.startsWith("a relative") ? fakeCheckout : undefined });
    assert.equal(refused.status, 2, `--denials into ${label} must exit 2 (stderr: ${refused.stderr})`);
    assert.match(refused.stderr, /refuses to write inside a git checkout/, `--denials into ${label} must say why`);
    const wouldBe = path.isAbsolute(destination) ? destination : path.join(fakeCheckout, destination);
    assert.equal(existsSync(wouldBe), false, `--denials into ${label} must not create the file`);
  }
  const scratchOut = path.join(root, "scratch", "out.json");
  mkdirSync(path.dirname(scratchOut), { recursive: true });
  const allowed = spawnSync(process.execPath, [script, ...windowArgs, "--denials", scratchOut], { encoding: "utf8" });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(readFileSync(scratchOut, "utf8"), /REVIEW PROOF GUARD: fixture refusal/, "a scratch destination outside any checkout receives the denials");
  console.log("claude-usage-report: --denials refuses every destination inside a git checkout and writes to a scratch path");
} finally {
  rmSync(root, { recursive: true, force: true });
}

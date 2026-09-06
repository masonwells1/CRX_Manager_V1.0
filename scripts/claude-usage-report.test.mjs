import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
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
// The --denials export is an adjudication record, so it has to carry the WHOLE refused command and
// the WHOLE guard reason. The old code clipped the command at 300 characters and the reason at 160
// (and only ever saw the first 400 characters of the reason), so a long refusal was exported
// without the part that says what actually happened (Codex GitHub App P2, PR #613). Both fixtures
// below run past every one of those bounds and end in a sentinel, so a re-introduced clip drops the
// sentinel and fails the assertions.
const longCommand = `node scripts/probe.mjs ${"x".repeat(360)} --tail=COMMAND_TAIL_KEPT`;
const longReason = `REVIEW PROOF GUARD: ${"the reason continues ".repeat(30)}REASON_TAIL_KEPT`;
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
    assistant("sub-response", [{ type: "tool_use", id: "sub-tool", name: "Bash", input: { command: longCommand } }]),
    user([{ type: "tool_result", tool_use_id: "sub-tool", is_error: true, content: longReason }]),
  ]);
  // A DIRECTORY named like a transcript under subagents/ must be skipped, not
  // streamed: the main loop checked isDirectory() but the subagent loop only
  // checked mtime, so createReadStream raised EISDIR and the report crashed
  // (CodeRabbit review of #613 at 336ad30f0). Its mtime is "now", inside the
  // pre-filter, so it reaches the reader on the old code.
  mkdirSync(path.join(subagents, "folder-named-like-a-transcript.jsonl"));
  const result = spawnSync(process.execPath, [script, "--root", root, "--start", "2026-09-04", "--end", "2026-09-05"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `the report must survive a directory named *.jsonl under subagents/: ${result.stderr}`);
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
  // A parent that is a symlink or junction INTO the checkout keeps the spelled path clear of
  // `.git` while the file lands inside it (Codex App review of #613 at 18c2faf17); the export
  // must canonicalise the nearest existing parent before deciding. A junction needs no privilege
  // on Windows; on Linux it is a directory symlink.
  const symlinkedParent = path.join(root, "export-alias");
  let aliased = false;
  try { symlinkSync(path.join(fakeCheckout, "nested"), symlinkedParent, "junction"); aliased = true; } catch { /* filesystem without directory symlinks */ }
  for (const [label, destination] of [
    ["this checkout", path.join(repoRoot, "usage-denials-fixture.json")],
    ["a directory marked as a checkout by a .git file", path.join(fakeCheckout, "nested", "deeper", "out.json")],
    ["a relative path resolved against a checkout cwd", "usage-denials-fixture.json"],
    ...(aliased ? [["a symlinked parent that points into a checkout", path.join(symlinkedParent, "out.json")]] : []),
  ]) {
    const refused = spawnSync(process.execPath, [script, ...windowArgs, "--denials", destination], { encoding: "utf8", cwd: label.startsWith("a relative") ? fakeCheckout : undefined });
    assert.equal(refused.status, 2, `--denials into ${label} must exit 2 (stderr: ${refused.stderr})`);
    assert.match(refused.stderr, /refuses to write inside a git checkout/, `--denials into ${label} must say why`);
    const wouldBe = path.isAbsolute(destination) ? destination : path.join(fakeCheckout, destination);
    assert.equal(existsSync(wouldBe), false, `--denials into ${label} must not create the file`);
  }
  if (!aliased) console.log("claude-usage-report: directory symlink creation refused by the OS — symlinked-parent case skipped");
  const scratchOut = path.join(root, "scratch", "out.json");
  mkdirSync(path.dirname(scratchOut), { recursive: true });
  const allowed = spawnSync(process.execPath, [script, ...windowArgs, "--denials", scratchOut], { encoding: "utf8" });
  assert.equal(allowed.status, 0, allowed.stderr);
  const exported = readFileSync(scratchOut, "utf8");
  assert.match(exported, /REVIEW PROOF GUARD: /, "a scratch destination outside any checkout receives the denials");
  assert.match(exported, /COMMAND_TAIL_KEPT/, "the export must carry the whole refused command, not a 300-character prefix");
  assert.match(exported, /REASON_TAIL_KEPT/, "the export must carry the whole guard reason, not a 160-character prefix");
  console.log("claude-usage-report: --denials refuses every destination inside a git checkout, writes to a scratch path, and keeps whole commands and reasons");
} finally {
  rmSync(root, { recursive: true, force: true });
}

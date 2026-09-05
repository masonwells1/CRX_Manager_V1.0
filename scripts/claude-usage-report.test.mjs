import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
} finally {
  rmSync(root, { recursive: true, force: true });
}

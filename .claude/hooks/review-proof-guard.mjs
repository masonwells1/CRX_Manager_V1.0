#!/usr/bin/env node

// Review proof files are outputs of the real Claude/Codex CLI wrappers. Direct
// tool or shell access would let an agent self-certify the gate, so deny it for
// both agents. The wrappers write internally and never name the proof path in
// their tool command, so legitimate proof creation still works.

import { readFileSync } from "node:fs";

import {
  reviewProofPathMentioned,
  reviewStateDirectoryMentioned,
} from "./codex-push-lib.mjs";

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const input = payload?.tool_input || payload?.toolInput || {};
const toolName = String(payload?.tool_name || payload?.toolName || "");
const hookCwd = String(payload?.cwd || input.cwd || input.workdir || "");
const pathCandidates = [
  input.file_path,
  input.filePath,
  input.path,
  input.target,
  input.source,
  input.destination,
];
if (pathCandidates.some((candidate) => reviewProofPathMentioned(candidate))) {
  deny("REVIEW PROOF GUARD: Claude/Codex review proof files are wrapper-owned. Run the real review workflow; do not write, edit, move, or delete proof JSON directly.");
}

const command = String(input.command ?? input.cmd ?? "");
if (reviewProofPathMentioned(command)) {
  deny("REVIEW PROOF GUARD: direct shell access to Claude/Codex review proof JSON is blocked. Run the real review wrapper instead.");
}

// Claude's Bash cwd persists across calls. Deny entering the wrapper-owned
// state directory, and fail closed on shell activity already running there, so
// a two-call `cd` + bare-filename write cannot evade the path matcher.
const shellTool = /(?:bash|powershell|shell|terminal)/i.test(toolName);
const changesDirectory = /(?:^|[;&|\r\n()]|\s)(?:cd(?:\s+\/d)?|chdir|pushd|set-location)\s+/i.test(command);
if (shellTool && changesDirectory && reviewStateDirectoryMentioned(command)) {
  deny("REVIEW PROOF GUARD: the review state directory is wrapper-owned and cannot become an interactive shell working directory.");
}
if (shellTool && reviewStateDirectoryMentioned(hookCwd)) {
  deny("REVIEW PROOF GUARD: shell commands from the wrapper-owned review state directory are blocked. Return to the repository root and run the real review wrapper.");
}

process.exit(0);

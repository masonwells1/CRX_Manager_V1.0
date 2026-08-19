#!/usr/bin/env node

// Review proof files are outputs of the real Claude/Codex CLI wrappers. Direct
// tool or shell access would let an agent self-certify the gate, so deny it for
// both agents. The wrappers write internally and never name the proof path in
// their tool command, so legitimate proof creation still works.

import { readFileSync } from "node:fs";

import {
  extractPatchDestinations,
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
  // Patch-style tools (Codex apply_patch) carry the DESTINATION inside a
  // free-form payload rather than a path field (Codex round-4). Scan only the
  // patch's destination headers, NOT its whole body — added prose may
  // legitimately mention proof paths in documentation (Codex round-5). Write's
  // `content` is likewise deliberately not scanned; its target is file_path.
  ...[input.patch, input.diff, input.input, input.changes].flatMap((payloadText) => extractPatchDestinations(payloadText)),
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
//
// 2026-08-18: check the ACTUAL cd/pushd/Set-Location target, not "a cd token
// exists anywhere AND the state dir is mentioned anywhere". The old conjunction
// denied legitimate commands like `cd <worktree-root> && ls .claude/session-state`
// (read-only listing after a cd to somewhere unrelated). Targets that cannot be
// resolved statically (contain $VAR/%VAR%/backtick) stay fail-closed whenever
// the command also mentions the state directory.
const shellTool = /(?:bash|powershell|shell|terminal)/i.test(toolName);

// Deny targets that enter the state dir, either directly or as a component
// step (`cd .claude` then `cd session-state` must not assemble the cwd).
function cdTargetEntersStateDir(target) {
  const t = String(target || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (/\.claude\/session-state/i.test(t)) return true;
  const parts = t.split("/").filter(Boolean);
  if (parts.some((p) => /^session-state$/i.test(p))) return true;
  return /^\.claude$/i.test(parts[parts.length - 1] || "");
}

// Capture the whole argument run of each cd-like invocation, then resolve its
// target token by token (CodeRabbit PR #423): `cd -- <dir>`, `cd -P <dir>`,
// `Set-Location -Path <dir>` / `-Path:<dir>`, and shell-joined quoting like
// `.claude/"session-state"` must all resolve to the real destination instead
// of an option token. Quotes are stripped EVERYWHERE in a token, not just at
// its edges, because the shell joins quoted segments into one path.
const CD_CMD_RE = /(?:^|[;&|\r\n()]|\s)(?:cd|chdir|pushd|set-location)((?:\s+(?:"[^"]*"|'[^']*'|[^\s;&|()]+))*)/gi;
const CD_ARG_RE = /"[^"]*"|'[^']*'|[^\s;&|()]+/g;
if (shellTool) {
  for (const match of command.matchAll(CD_CMD_RE)) {
    let target = "";
    for (const raw of match[1].match(CD_ARG_RE) || []) {
      const token = raw.replace(/["']/g, "");
      if (token === "--" || /^\/d$/i.test(token)) continue;
      if (token.startsWith("-")) {
        // `-Path:<dir>` / `--path=<dir>` carry the value attached; a bare flag
        // like `-P` or `-LiteralPath` takes it from the next token instead.
        const attached = /^-[^:=]*[:=](.+)$/.exec(token);
        if (!attached) continue;
        target = attached[1];
        break;
      }
      target = token;
      break;
    }
    // Bash drops an unquoted backslash before the next character, so
    // `session-\state` executes as `session-state` (CodeRabbit PR #423 round
    // 2). Check the decoded form too; the RAW form still covers Windows
    // `\`-separated paths, where the backslash is a real separator.
    const decoded = target.replace(/\\(.)/g, "$1");
    const unresolvable = /[$%`]/.test(target);
    if (cdTargetEntersStateDir(target) || cdTargetEntersStateDir(decoded) || (unresolvable && reviewStateDirectoryMentioned(command))) {
      deny("REVIEW PROOF GUARD: the review state directory is wrapper-owned and cannot become an interactive shell working directory.");
    }
  }
}
if (shellTool && reviewStateDirectoryMentioned(hookCwd)) {
  deny("REVIEW PROOF GUARD: shell commands from the wrapper-owned review state directory are blocked. Return to the repository root and run the real review wrapper.");
}

process.exit(0);

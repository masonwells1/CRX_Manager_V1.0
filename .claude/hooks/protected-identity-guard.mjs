#!/usr/bin/env node
// PreToolUse guard on every write route that can reach a file by pathname.
//
// The MCP tool guard already denies file tools whose target is a second pathname
// for a protected file. The native Write/Edit tools were one remaining route: an
// alias created by any means — `cp -l`, `link`, a junction hop, a language
// runtime's link() — could be edited under an innocent pathname, changing a
// protected hook, migration, settings file, or `.env` without ever naming it
// (Codex, 2026-08-24).
//
// The NATIVE PATCH route was the other, and it was open. The MCP guard's tool
// pattern is anchored to an `mcp__<server>__` prefix, so a bare `apply_patch`
// never matched it and exited unchecked; the manifest meanwhile declared this
// hook Claude-only on the stated grounds that the other agent "reaches the same
// check through its own file route". It did not. A patch also carries its
// DESTINATIONS inside a free-form body rather than a path field, so a guard that
// reads only `file_path` sees nothing to check even when it does run. Both are
// closed here: destinations are parsed out of the patch body, and every target
// in a single payload is checked rather than only the first — one patch can
// carry a benign file and a hostile one together (2026-08-24).
//
// Pathname-shaped protection for these tools lives in settings.json's permission
// rules and the sibling content hooks; this adds the one property a second
// pathname cannot fake. It is checked in addition to those, never instead.
import {
  aliasesProtectedFile,
  canonicalizeThroughExistingAncestor,
  fileIdentity,
  protectedControlPathReason,
  protectedFileIdentityPaths,
  protectedProofCreationReason,
} from "./protected-identity-lib.mjs";
import { extractPatchDestinations, normalizeToolInput } from "./codex-push-lib.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const MAX_PAYLOAD_CHARS = 1_000_000;
const MAX_UNIQUE_TARGETS = 256;
const MAX_PATCH_CONTENT_TARGETS = 16;
const PATCH_CONTENT_BUDGET_MS = 10_000;
const PATCH_CONTENT_HOOKS = [
  "sql-safety.mjs",
  "money-safety.mjs",
  "idempotency-body-check.mjs",
  "actor-binding-check.mjs",
  "rls-on-new-tables.mjs",
  "status-enum-check.mjs",
  "generated-column-check.mjs",
  "env-guard.mjs",
  "grant-change-guard.mjs",
];
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > MAX_PAYLOAD_CHARS) {
    out("deny", `PROTECTED IDENTITY GUARD: payload exceeds the ${MAX_PAYLOAD_CHARS}-character inspection budget and is denied fail-closed.`);
  }
}

function out(decision, reason) {
  if (decision === "allow") {
    process.stdout.write("");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function extractPatchEdits(text) {
  const sections = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    for (const filePath of current.paths) {
      if (!filePath || filePath === "/dev/null") continue;
      sections.push({ filePath, operation: current.operation, content: current.added.join("\n") });
    }
    current = null;
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    const native = /^\*{3}\s*(Add|Update|Delete)\s+File:\s*(.+?)\s*$/i.exec(line);
    if (native) {
      finish();
      current = { operation: native[1].toLowerCase(), paths: [native[2]], added: [] };
      continue;
    }
    const moved = /^\*{3}\s*Move(?:\s+to)?(?:\s+File)?:\s*(.+?)\s*$/i.exec(line);
    if (moved && current) {
      current.paths.push(moved[1]);
      continue;
    }
    const unified = /^\+{3}\s+(?:b\/)?(\S+)\s*$/.exec(line);
    if (unified) {
      finish();
      current = { operation: "update", paths: [unified[1]], added: [] };
      continue;
    }
    if (current && /^\+(?!\+\+)/.test(line)) current.added.push(line.slice(1));
  }
  finish();
  return sections;
}

function patchContentGuardReason(payload, patchBodies, cwd) {
  const edits = patchBodies.flatMap((body) => extractPatchEdits(body));
  if (edits.length === 0) return "Raw patch input named destinations but no per-file content sections could be resolved.";
  if (edits.length > MAX_PATCH_CONTENT_TARGETS) {
    return `Raw patch input touches more than ${MAX_PATCH_CONTENT_TARGETS} content targets and is denied fail-closed.`;
  }
  const deadline = Date.now() + PATCH_CONTENT_BUDGET_MS;
  for (const edit of edits) {
    const resolvedFilePath = path.isAbsolute(edit.filePath) ? path.resolve(edit.filePath) : path.resolve(cwd, edit.filePath);
    const toolInput = edit.operation === "add"
      ? { file_path: resolvedFilePath, content: edit.content }
      : { file_path: resolvedFilePath, new_string: edit.content };
    const synthetic = JSON.stringify({ ...payload, tool_name: edit.operation === "add" ? "Write" : "Edit", tool_input: toolInput });
    for (const hookName of PATCH_CONTENT_HOOKS) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "Raw patch content inspection exceeded its shared deadline and is denied fail-closed.";
      const result = spawnSync(process.execPath, [path.join(cwd, ".claude", "hooks", hookName)], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
        input: synthetic,
        timeout: Math.min(remaining, 1_500),
      });
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error || result.status !== 0) {
        return `Raw patch content inspection could not run ${hookName} and is denied fail-closed.`;
      }
      const output = String(result.stdout || "").trim();
      if (!output) continue;
      let parsed;
      try {
        parsed = JSON.parse(output);
      } catch {
        return `Raw patch content inspection received invalid output from ${hookName} and is denied fail-closed.`;
      }
      if (parsed?.hookSpecificOutput?.permissionDecision === "deny") {
        return parsed.hookSpecificOutput.permissionDecisionReason || `${hookName} denied the patch content.`;
      }
    }
  }
  return "";
}

try {
  const payload = raw.trim() ? JSON.parse(raw) : null;

  // Codex's `apply_patch` delivers its payload as a RAW STRING, not an object.
  // Discarding every non-object `tool_input` extracted no destination at all and
  // fell straight through to allow — leaving open the exact route this hook
  // exists to close, while the tests passed because they wrapped the patch in
  // `{patch: …}`, a shape the real tool never sends (exact-review High, PR #432).
  // The normalizer is shared with review-proof-guard so neither route can learn
  // this and leave the other behind.
  const { input, rawBody: rawStringBody } = normalizeToolInput(payload?.tool_input);
  const isPatchTool = /apply[_-]?patch/i.test(String(payload?.tool_name || ""));
  const patchBodies = [input.patch, input.diff, input.input, input.changes, rawStringBody]
    .filter((body) => typeof body === "string" && body);

  // Write uses file_path; Edit uses file_path too. Accept the common spellings
  // so a future tool shape cannot slip past by naming the field differently.
  // Patch-style tools carry the destination inside a free-form payload instead,
  // so parse the patch's destination headers as well. Only the headers, never
  // the whole body: added prose may legitimately mention a protected path, and
  // scanning content would deny ordinary documentation edits.
  const candidates = [
    input.file_path,
    input.path,
    input.filePath,
    input.target,
    input.source,
    input.destination,
    ...patchBodies
      .flatMap((body) => extractPatchDestinations(body)),
  ].filter((candidate) => typeof candidate === "string" && candidate);

  if (candidates.length === 0) out("allow");

  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const seen = new Set();
  const targets = [];
  for (const target of candidates) {
    const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd, target);
    const key = process.platform === "win32" ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ target, abs });
    if (targets.length > MAX_UNIQUE_TARGETS) {
      out("deny", `PROTECTED IDENTITY GUARD: payload names more than ${MAX_UNIQUE_TARGETS} unique destinations and is denied fail-closed.`);
    }
  }
  const protectedIdentities = protectedFileIdentityPaths(cwd);

  for (const { target, abs } of targets) {

    // Git control files decide what Git EXECUTES on the next ordinary command, so
    // they are checked by pathname as well as identity: a file that does not exist
    // yet has no inode, and creating one is itself the attack. The canonical
    // surface is checked alongside the resolved one so a junction hop cannot keep
    // the supplied pathname from ever spelling the control file, the same way
    // protectedProofCreationReason already canonicalises internally.
    const controlReason = protectedControlPathReason(abs)
      || protectedControlPathReason(canonicalizeThroughExistingAncestor(abs));
    if (controlReason) {
      out(
        "deny",
        `PROTECTED IDENTITY GUARD: ${target} is ${controlReason}. Settings there choose programs Git runs on the next command, so edit it deliberately outside the agent tools.`,
      );
    }

    // Creating a new file in the review state directory forges a proof the gate
    // will later trust. Canonicalised first, so a junction cannot launder the
    // destination out of the pathname.
    const proofReason = protectedProofCreationReason(abs);
    if (proofReason) {
      out(
        "deny",
        `PROTECTED IDENTITY GUARD: ${target} resolves into ${proofReason}. Review proofs are minted by the review wrapper; an agent that can create one can certify its own change.`,
      );
    }

    // A patch changes bytes before the content-specific hooks can see a normal
    // Write/Edit payload. Existing protected control files therefore deny even
    // at their canonical pathname; allowing only aliases here would let a raw
    // patch rewrite the guard that decides whether its next action is safe.
    if (isPatchTool && protectedIdentities.has(fileIdentity(abs))) {
      out(
        "deny",
        `PROTECTED IDENTITY GUARD: raw patch input cannot modify the protected canonical file ${target}. Use the guarded Write/Edit route.`,
      );
    }

    if (aliasesProtectedFile(abs, cwd, protectedIdentities)) {
      out(
        "deny",
        `PROTECTED IDENTITY GUARD: ${target} is a second pathname for a protected file (same device and inode). Edit the real path so the guard hooks can inspect the change.`,
      );
    }
  }

  if (isPatchTool) {
    const contentReason = patchContentGuardReason(payload, patchBodies, cwd);
    if (contentReason) out("deny", `PROTECTED IDENTITY GUARD: ${contentReason}`);
  }
} catch (err) {
  // FAIL-OPEN, but loud: a broken guard must never brick the session. The
  // pathname-shaped protections still apply on this route.
  process.stderr.write(`protected-identity-guard.mjs internal error (allowing): ${err && err.message ? err.message : err}\n`);
  out("allow");
}

out("allow");

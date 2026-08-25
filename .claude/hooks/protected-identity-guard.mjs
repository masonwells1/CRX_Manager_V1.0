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
  protectedControlPathReason,
  protectedFileIdentityPaths,
  protectedProofCreationReason,
} from "./protected-identity-lib.mjs";
import { extractPatchDestinations, normalizeToolInput } from "./codex-push-lib.mjs";
import path from "node:path";

const MAX_PAYLOAD_CHARS = 1_000_000;
const MAX_UNIQUE_TARGETS = 256;
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
    ...[input.patch, input.diff, input.input, input.changes, rawStringBody]
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

    if (aliasesProtectedFile(abs, cwd, protectedIdentities)) {
      out(
        "deny",
        `PROTECTED IDENTITY GUARD: ${target} is a second pathname for a protected file (same device and inode). Edit the real path so the guard hooks can inspect the change.`,
      );
    }
  }
} catch (err) {
  // FAIL-OPEN, but loud: a broken guard must never brick the session. The
  // pathname-shaped protections still apply on this route.
  process.stderr.write(`protected-identity-guard.mjs internal error (allowing): ${err && err.message ? err.message : err}\n`);
  out("allow");
}

out("allow");

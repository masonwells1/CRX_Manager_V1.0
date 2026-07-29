#!/usr/bin/env node
// Read-only commit-identity guard. This deliberately checks Git's resolved
// author and committer identities, not just config keys, because environment
// overrides are what Git will actually write into the commit object.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ALLOWED_GIT_IDENTITY = Object.freeze({
  name: "Mason",
  email: "mason@croprxsolutions.com",
});

// Git var emits: Name <email> unix-timestamp ±HHMM. Parse every field instead
// of comparing only a prefix/suffix: a consistently polluted identity must not
// pass merely because it looks like a valid Git identity.
const GIT_IDENT_RE = /^([^<>\r\n]+) <([^<>\s\r\n]+)> ([0-9]+) ([+-][0-9]{4})$/;

function trimOneTrailingLineEnding(value) {
  const text = String(value ?? "");
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

export function parseGitIdentity(value) {
  const match = GIT_IDENT_RE.exec(trimOneTrailingLineEnding(value));
  if (!match) return null;
  return Object.freeze({
    name: match[1],
    email: match[2],
    timestamp: match[3],
    timezone: match[4],
  });
}

function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function checkLocalGitIdentity(run = runGit) {
  const failures = [];
  for (const [label, variable] of [["author", "GIT_AUTHOR_IDENT"], ["committer", "GIT_COMMITTER_IDENT"]]) {
    let identity = null;
    try {
      identity = parseGitIdentity(run(["var", variable]));
    } catch {
      failures.push(`${label} identity could not be resolved`);
      continue;
    }
    if (!identity || identity.name !== ALLOWED_GIT_IDENTITY.name || identity.email !== ALLOWED_GIT_IDENTITY.email) {
      failures.push(`${label} identity must resolve exactly to ${ALLOWED_GIT_IDENTITY.name} <${ALLOWED_GIT_IDENTITY.email}>`);
    }
  }

  let bare = null;
  try {
    bare = trimOneTrailingLineEnding(run(["config", "--bool", "core.bare"]));
  } catch {
    failures.push("core.bare could not be resolved");
  }
  if (bare !== null && bare !== "false") failures.push("core.bare must resolve exactly to false");

  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures) });
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const result = checkLocalGitIdentity();
  if (!result.ok) {
    for (const failure of result.failures) process.stderr.write(`GIT IDENTITY GUARD: ${failure}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const GITHUB_COMMENT_LIMIT = 65_000;
const SENSITIVE_CONTENT_PATTERNS = [
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { label: "Supabase service-role reference", pattern: /\b(SUPABASE_SERVICE_ROLE|service_role)\b/i },
  { label: "JWT-looking token", pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: "secret-like env assignment", pattern: /^\s*[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|SERVICE_ROLE)[A-Z0-9_]*\s*=\s*\S+/im },
];

function usage() {
  return [
    "Usage: node scripts/post-agent-review-to-pr.mjs --pr <number> --file <path> [--dry-run|--confirm]",
    "",
    "Default is safe dry-run. Use --confirm to actually post through GitHub CLI.",
  ].join("\n");
}

export function parsePrCommentArgs(argv) {
  const parsed = {
    pr: null,
    file: null,
    dryRun: false,
    confirm: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pr") {
      parsed.pr = argv[++i] || null;
    } else if (arg === "--file") {
      parsed.file = argv[++i] || null;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--confirm") {
      parsed.confirm = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  if (parsed.help) return parsed;
  if (!parsed.pr) throw new Error(`--pr is required\n\n${usage()}`);
  if (!parsed.file) throw new Error(`--file is required\n\n${usage()}`);
  if (!parsed.confirm) parsed.dryRun = true;
  return parsed;
}

export function truncateForGitHubComment(content, limit = GITHUB_COMMENT_LIMIT) {
  if (content.length <= limit) return content;
  const marker = "\n\n[Comment truncated. Read the full local review file in the repo.]\n";
  return content.slice(0, Math.max(0, limit - marker.length)) + marker;
}

export function buildPrCommentBody({ sourceFile, content }) {
  return truncateForGitHubComment([
    "## Agent review attached",
    "",
    `Source file: \`${sourceFile}\``,
    "",
    "<details open>",
    "<summary>Review content</summary>",
    "",
    content.trim(),
    "",
    "</details>",
  ].join("\n"));
}

export function findSensitiveContentWarnings(content) {
  return SENSITIVE_CONTENT_PATTERNS
    .filter(({ pattern }) => pattern.test(content))
    .map(({ label }) => label);
}

function main() {
  let options;
  try {
    options = parsePrCommentArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }

    const filePath = path.isAbsolute(options.file) ? options.file : path.join(ROOT, options.file);
    if (!existsSync(filePath)) {
      throw new Error(`Review file not found: ${options.file}`);
    }

    const body = buildPrCommentBody({
      sourceFile: options.file,
      content: readFileSync(filePath, "utf8"),
    });
    const sensitiveWarnings = findSensitiveContentWarnings(body);

    if (options.dryRun) {
      // Scan BEFORE echoing: if the body contains a secret, do NOT print it —
      // printing would leak it to the terminal/transcript even on the safe
      // dry-run path. Refuse instead.
      if (sensitiveWarnings.length > 0) {
        console.error(`SENSITIVE CONTENT WARNING - ${sensitiveWarnings.join(", ")}`);
        console.error("Refusing to print the review body — it appears to contain a secret. Sanitize the file and re-run.");
        process.exit(1);
      }
      console.log(body);
      console.log("");
      console.log("DRY RUN - no GitHub comment posted. Re-run with --confirm to post.");
      process.exit(0);
    }

    if (sensitiveWarnings.length > 0) {
      throw new Error([
        "Refusing to post because the review appears to contain sensitive content:",
        ...sensitiveWarnings.map((warning) => `- ${warning}`),
        "Sanitize the file and rerun the dry-run before posting.",
      ].join("\n"));
    }

    // gh runs through cmd.exe on Windows (shell:true for the .cmd shim), so a PR
    // value with shell metacharacters could inject commands — constrain to digits.
    if (!/^\d+$/.test(String(options.pr))) {
      throw new Error(`Invalid --pr "${options.pr}" — must be a numeric PR number.`);
    }
    const tempFile = path.join(os.tmpdir(), `crx-agent-review-pr-${options.pr}-${Date.now()}.md`);
    writeFileSync(tempFile, body, "utf8");
    const result = spawnSync("gh", ["pr", "comment", options.pr, "--body-file", tempFile], {
      cwd: ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout || `gh exited ${result.status}\n`);
      process.exit(result.status || 1);
    }

    process.stdout.write(result.stdout || `Posted agent review to PR #${options.pr}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

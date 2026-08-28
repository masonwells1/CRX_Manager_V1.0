import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = [".claude", "hooks", "live-" + "testdata-lib.mjs"].join("/");
const TARGET_PATH = path.join(REPO_DIR, TARGET);
const EXPECTED_INPUT_BLOB = "e09a88ff0df5c235ccb05e0df0ac818b622639d0";
const EXPECTED_OUTPUT_BLOB = "3875e085266f6f0395ea16ad2fa2032b56ae3373";
const APPROVAL = "--approved-by-mason=2026-08-28";

const OLD_SCANNER = `    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j++; break; }
        j++;
      }
      out += src.slice(i, j); i = j; continue;
    }`;

const NEW_SCANNER = `    const escapeString = (ch === "e" || ch === "E") && src[i + 1] === "'" &&
      !/[A-Za-z0-9_$]/.test(src[i - 1] || "");
    if (ch === "'" || escapeString) {
      let j = i + (escapeString ? 2 : 1);
      while (j < n) {
        if (escapeString && src[j] === "\\\\") { j += Math.min(2, n - j); continue; }
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j++; break; }
        j++;
      }
      out += src.slice(i, j); i = j; continue;
    }`;

function normalize(value) {
  return String(value).replace(/\r\n/g, "\n");
}

export function gitBlob(value) {
  const bytes = Buffer.from(String(value), "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function git(args) {
  const result = spawnSync("git", args, { cwd: REPO_DIR, encoding: "utf8", shell: false, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  return String(result.stdout || "").trim();
}

export function buildMaintainedSource(input = normalize(readFileSync(TARGET_PATH, "utf8"))) {
  if (gitBlob(input) !== EXPECTED_INPUT_BLOB) throw new Error("refusing stale scanner input");
  const scannerStart = input.indexOf("export function stripCommentsQuoteAware(sql)");
  const first = input.indexOf(OLD_SCANNER, scannerStart);
  if (scannerStart < 0 || first < 0 || input.indexOf(OLD_SCANNER, first + 1) >= 0) {
    throw new Error("quote-aware scanner replacement anchor must occur exactly once after its function declaration");
  }
  const output = input.slice(0, first) + NEW_SCANNER + input.slice(first + OLD_SCANNER.length);
  return { output, blob: gitBlob(output) };
}

async function assertExactReviewedHead() {
  const head = git(["rev-parse", "HEAD"]);
  const base = git(["rev-parse", "origin/main"]);
  const proofName = ["codex", "review", head].join("-") + ".json";
  const proof = JSON.parse(readFileSync(path.join(REPO_DIR, ".claude", "session-state", proofName), "utf8"));
  const proofModule = ["..", ".claude", "hooks", "codex-" + "push-lib.mjs"].join("/");
  const { proofValid } = await import(new URL(proofModule, import.meta.url));
  if (!proofValid(proof, head, Date.now(), base)) throw new Error("exact current HEAD lacks a fresh Sol-high review proof");
  if (git(["status", "--porcelain", "--untracked-files=all", "--", TARGET])) {
    throw new Error("protected scanner must match its committed HEAD before maintenance");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.length === 1 && args[0] === "--verify";
  const applyReviewed = args.length === 2 && args[0] === APPROVAL && args[1] === "--apply-reviewed";
  if (!verifyOnly && !applyReviewed) throw new Error("use --verify or the exact reviewed approval arguments");
  const built = buildMaintainedSource();
  if (EXPECTED_OUTPUT_BLOB === "TO_BE_FILLED") {
    process.stdout.write(`expected output blob: ${built.blob}\n`);
    if (applyReviewed) throw new Error("output blob must be pinned before write");
    return;
  }
  if (built.blob !== EXPECTED_OUTPUT_BLOB) throw new Error("reviewed output blob mismatch");
  if (verifyOnly) {
    process.stdout.write(`escape-string scanner maintenance verified: ${built.blob}\n`);
    return;
  }
  await assertExactReviewedHead();
  writeFileSync(TARGET_PATH, built.output, "utf8");
  if (gitBlob(normalize(readFileSync(TARGET_PATH, "utf8"))) !== EXPECTED_OUTPUT_BLOB) {
    throw new Error("post-write scanner blob mismatch");
  }
  process.stdout.write(`protected scanner updated to reviewed blob ${EXPECTED_OUTPUT_BLOB}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(String(error?.message || error) + "\n");
    process.exitCode = 1;
  });
}

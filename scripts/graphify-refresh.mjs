#!/usr/bin/env node
// Local-only CRX architecture-map refresher. The graph is intentionally
// gitignored: it is a fast navigation aid for agents, not a source of truth
// or a production artifact. Source and live DB evidence still win.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RELEVANT = /^(src\/|supabase\/(?:migrations|functions)\/|scripts\/|\.graphifyignore$|package\.json$|tsconfig(?:\.[^/]+)?\.json$|vite\.config\.ts$|vercel\.json$)/;

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) {
    // A MISSING optional tool (graphify not installed — e.g. a cloud/CI
    // container) is a graceful SKIP, not a failure: the pre-push hook documents
    // graphify as "an optional local navigation aid" and continues past it. Only
    // the tool's genuine absence exits 0 here; any other spawn error still fails.
    if (result.error.code === "ENOENT") {
      console.log(`Graphify not installed — skipping local architecture-map refresh (optional aid).`);
      process.exit(0);
    }
    console.error(`Graphify refresh blocked: could not run ${command} (${result.error.message}).`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function changedFiles() {
  const result = spawnSync("git", ["diff", "--name-only", "origin/main...HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function workingTreeChanged(file) {
  const result = spawnSync("git", ["status", "--porcelain", "--", file], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function graphCoverage(graphPath) {
  if (!existsSync(graphPath)) return null;
  try {
    const graph = JSON.parse(readFileSync(graphPath, "utf8"));
    const sources = (graph.nodes ?? []).map((node) =>
      String(node.source_file ?? "").replaceAll("\\", "/"),
    );
    return {
      nodes: sources.length,
      links: (graph.links ?? graph.edges ?? []).length,
      source: sources.filter((file) => file.startsWith("src/") || file.includes("/src/")).length,
      migrations: sources.filter(
        (file) => file.startsWith("supabase/migrations/") || file.includes("/supabase/migrations/"),
      ).length,
      functions: sources.filter(
        (file) => file.startsWith("supabase/functions/") || file.includes("/supabase/functions/"),
      ).length,
      staging: sources.filter(
        (file) => file.startsWith("scripts/.staging-migrations/") || file.includes("/scripts/.staging-migrations/"),
      ).length,
    };
  } catch {
    return null;
  }
}

function hasCoreCoverage(coverage) {
  return Boolean(
    coverage &&
      coverage.nodes > 0 &&
      coverage.links > 0 &&
      coverage.source > 0 &&
      coverage.migrations > 0 &&
      coverage.functions > 0 &&
      coverage.staging === 0,
  );
}

function freshExtract(graphPath) {
  for (const generated of [graphPath, path.join(ROOT, "graphify-out", ".graphify_analysis.json")]) {
    if (existsSync(generated)) unlinkSync(generated);
  }
  run("graphify", ["extract", ".", "--code-only", "--out", ".", "--force"]);
}

const onlyIfRelevant = process.argv.includes("--if-relevant");
const filesSinceMain = onlyIfRelevant ? changedFiles() : null;
if (onlyIfRelevant) {
  if (filesSinceMain && !filesSinceMain.some((file) => RELEVANT.test(file))) {
    console.log("Graphify: no architecture-relevant changes since origin/main; refresh skipped.");
    process.exit(0);
  }
}

run("graphify", ["--version"]);
const graphPath = path.join(ROOT, "graphify-out", "graph.json");
const ignoreChanged = filesSinceMain?.includes(".graphifyignore") || workingTreeChanged(".graphifyignore");
if (existsSync(graphPath) && !ignoreChanged) run("graphify", ["update", ".", "--force"]);
else freshExtract(graphPath);

let coverage = graphCoverage(graphPath);
if (!hasCoreCoverage(coverage)) {
  console.warn("Graphify: cached graph failed core coverage; rebuilding from source.");
  freshExtract(graphPath);
  coverage = graphCoverage(graphPath);
}
if (!hasCoreCoverage(coverage)) {
  console.error(`Graphify refresh blocked: incomplete core coverage (${JSON.stringify(coverage)}).`);
  process.exit(1);
}
process.env.GRAPHIFY_VIZ_NODE_LIMIT ??= "10000";
run("graphify", ["cluster-only", ".", "--no-label"]);
console.log(`Graphify: current local architecture map refreshed (${JSON.stringify(coverage)}).`);

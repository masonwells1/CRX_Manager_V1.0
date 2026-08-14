#!/usr/bin/env node
// Tests for bash-safety-lib.mjs (dangerous-command patterns + npm-script
// indirection, FIX 2) and a couple of LIVE invocations of bash-safety.mjs
// itself (benign command allowed, dangerous command denied).
// Run: node .claude/hooks/bash-safety.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkMaintenanceProducerInvocation,
  checkDangerousCommand,
  checkCommandDeep,
  checkMigrationModify,
  checkOneShotReplayCommand,
  extractNpmRunNames,
  maintenanceProducerCommandMentioned,
  resolveNpmScriptChain,
  readPackageScripts,
} from "./bash-safety-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

// ── direct dangerous-command patterns (unchanged behavior) ────────────────
ok(checkDangerousCommand("git push --force origin main"), "force push blocked");
ok(checkDangerousCommand("git push -f origin main"), "force push -f blocked");
ok(checkDangerousCommand("git reset --hard HEAD~1"), "hard reset blocked");
ok(checkDangerousCommand("git checkout ."), "discard-all checkout blocked");
ok(checkDangerousCommand("git clean -fd"), "git clean -f blocked");
ok(checkDangerousCommand("npm test -- --no-verify"), "--no-verify blocked");
ok(checkDangerousCommand("rm -rf src"), "rm -rf src blocked");
ok(checkDangerousCommand("rm -rf supabase"), "rm -rf supabase blocked");
ok(checkDangerousCommand("git add file.txt .env"), "staging .env blocked");
ok(checkDangerousCommand("npx supabase db push"), "supabase db push blocked");
ok(checkDangerousCommand("supabase db push"), "bare (non-npx) supabase db push blocked — 2026-07-16 review B1");
ok(checkDangerousCommand("cd repo && supabase db push --linked"), "supabase db push blocked mid-compound-command");
ok(checkDangerousCommand("supabase migration up"), "bare supabase migration up blocked — sibling live-apply spelling");
ok(checkDangerousCommand("npx supabase migration up --linked"), "npx supabase migration up blocked");
ok(checkDangerousCommand("supabase db reset"), "supabase db reset blocked");
ok(checkDangerousCommand("dropdb mydb"), "dropdb blocked");
ok(checkDangerousCommand("git branch -D main"), "force-delete main blocked");
ok(checkDangerousCommand("git push --mirror origin"), "push --mirror blocked");
ok(checkDangerousCommand("git filter-branch --force"), "filter-branch blocked");
ok(checkDangerousCommand("rm -rf /etc"), "rm -rf /etc blocked (outside scratch allowlist)");
ok(checkDangerousCommand("npm run nuke"), "npm run nuke blocked (literal script name)");
ok(checkDangerousCommand('psql -c "DROP TABLE customers;"'), "psql DROP TABLE blocked");
ok(checkDangerousCommand('supabase db query "DROP TABLE customers;"'), "Supabase db query DROP TABLE blocked");
ok(checkDangerousCommand('supabase db execute "TRUNCATE customers;"'), "Supabase db execute TRUNCATE blocked");
ok(!checkDangerousCommand("npm run build"), "npm run build allowed");
ok(!checkDangerousCommand("git status"), "git status allowed");
ok(!checkDangerousCommand("git push origin feature/x"), "ordinary feature push allowed");
ok(!checkDangerousCommand(""), "empty command allowed");
ok(!checkDangerousCommand(null), "null command allowed (no throw)");

// ── maintenance producer: current outer shell guard closes the pre-bootstrap
//    TOCTOU gap before the generated production-action guard is installed. ──
for (const command of [
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --approved-by-mason=2026-08-12 --protect-producer",
]) {
  eq(checkMaintenanceProducerInvocation(command), null, `exact producer invocation allowed by shell guard: ${command}`);
}
for (const command of [
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify; Write-Output chained",
  "[IO.File]::WriteAllText('scripts/apply-live-testdata-maintenance-20260812.mjs','owned'); node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify --unknown",
  "node scripts/apply-live-testdata-maintenance-20260812.mjs --protect-producer --approved-by-mason=2026-08-12",
  "node \"scripts/apply-live-testdata-maintenance-20260812.mjs\" --verify",
  "node scripts\\apply-live-testdata-maintenance-20260812.mjs --verify",
  "cmd /c node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  "env FLAG=1 node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
]) {
  ok(maintenanceProducerCommandMentioned(command), `producer spelling recognized by shell guard: ${command}`);
  ok(checkDangerousCommand(command), `non-literal producer invocation denied by shell guard: ${command}`);
}

// ── net-new: shell-redirect .env write (2026-07-13, shared with mcp-tool-guard) ──
ok(checkDangerousCommand("echo SECRET=x > .env"), "shell-redirect write to .env blocked");
ok(checkDangerousCommand("echo SECRET=x >> .env.local"), "shell-redirect append to .env.local blocked");
ok(checkDangerousCommand("echo SECRET=x | tee .env"), "tee to .env blocked");
ok(!checkDangerousCommand("cat .env.example"), "reading .env.example is not a write, allowed");

// ── migration-modify check (unchanged) ─────────────────────────────────────
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bash-safety-migtest-"));
  try {
    const migDir = path.join(tmp, "supabase", "migrations");
    mkdirSync(migDir, { recursive: true });
    const existing = path.join(migDir, "20260101000000_existing.sql");
    writeFileSync(existing, "select 1;");
    ok(
      checkMigrationModify(`echo "x" >> supabase/migrations/20260101000000_existing.sql`, tmp),
      "redirect-modify of an EXISTING migration file blocked"
    );
    ok(
      !checkMigrationModify(`echo "x" >> supabase/migrations/20260102000000_new.sql`, tmp),
      "redirect to a NEW (not-yet-existing) migration file allowed"
    );
    ok(!checkMigrationModify("echo hi", tmp), "unrelated command allowed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── FIX 2: npm-script indirection ──────────────────────────────────────────
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bash-safety-npmtest-"));
  try {
    const pkg = {
      scripts: {
        safe: "vite build",
        dangerous: "git push --force origin main",
        producer: "node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
        "chain:a": "npm run chain:b",
        "chain:b": "npm run chain:c",
        "chain:c": "rm -rf src",
        // 5-deep chain: the dangerous command sits at hop 5 (depth 4), one past
        // the maxDepth=3 cap — proves the cap is a real boundary, not just
        // documentation. cap-a..cap-d (depths 0-3) ARE resolved; cap-e (depth 4)
        // is not, so its dangerous body is never inspected.
        "chain:cap-a": "npm run chain:cap-b",
        "chain:cap-b": "npm run chain:cap-c",
        "chain:cap-c": "npm run chain:cap-d",
        "chain:cap-d": "npm run chain:cap-e",
        "chain:cap-e": "git reset --hard HEAD~1",
      },
    };
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify(pkg, null, 2));

    eq(extractNpmRunNames("npm run dangerous").length, 1, "extracts one npm run target");
    eq(extractNpmRunNames("npm run safe && npm run dangerous").length, 2, "extracts multiple npm run targets");

    const scripts = readPackageScripts(tmp);
    ok(scripts && typeof scripts === "object", "readPackageScripts reads the temp package.json");
    eq(resolveNpmScriptChain(scripts, "chain:a").length, 3, "resolves a 3-deep chain (a, b, c bodies)");

    ok(!checkCommandDeep("npm run safe", tmp), "npm run safe stays allowed");
    ok(checkCommandDeep("npm run dangerous", tmp), "npm run dangerous is caught via its resolved script body");
    ok(checkCommandDeep("npm run producer", tmp), "producer invocation hidden in an npm script is denied");
    ok(
      checkCommandDeep("npm run chain:a", tmp),
      "a dangerous command hidden 2 levels deep behind chained npm scripts is caught (FIX 2)"
    );
    // Depth cap is a real boundary: cap-a..cap-d (depths 0-3) are resolved, but
    // the dangerous command lives one hop further (cap-e, depth 4) and is
    // never fetched — documents the intentional bound, not an oversight.
    eq(resolveNpmScriptChain(scripts, "chain:cap-a").length, 4, "depth cap resolves exactly 4 bodies (depths 0-3)");
    ok(
      !checkCommandDeep("npm run chain:cap-a", tmp),
      "a dangerous command one hop past the depth-3 cap is NOT caught (documented bound)"
    );

    // Unreadable/missing package.json → warn-and-allow, never throw or block.
    const missingDir = path.join(tmp, "does-not-exist");
    let threw = false;
    let result;
    try { result = checkCommandDeep("npm run dangerous", missingDir); } catch { threw = true; }
    ok(!threw, "missing package.json does not throw");
    eq(result, null, "missing package.json warn-and-allows (no block) for the script-body check");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── one-shot DATA migration direct-execution containment (2026-08-10) ─────
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bash-safety-one-shot-"));
  try {
    const stem = "20260810025159_backfill_stale_line_profit";
    const migDir = path.join(tmp, "supabase", "migrations");
    const baselineDir = path.join(tmp, "supabase", "baselines");
    mkdirSync(migDir, { recursive: true });
    mkdirSync(baselineDir, { recursive: true });
    const sql = "DO $x$ BEGIN UPDATE public.order_items SET profit = 1; END $x$;\n";
    const source = path.join(migDir, `${stem}.sql`);
    const renamed = path.join(tmp, "renamed-copy.sql");
    const extensionless = path.join(tmp, "renamed-copy");
    const safeExtensionless = path.join(tmp, "read-only-query");
    writeFileSync(source, sql);
    writeFileSync(renamed, sql);
    writeFileSync(extensionless, sql);
    writeFileSync(safeExtensionless, "select 1;\n");
    writeFileSync(
      path.join(baselineDir, "one-shot-migrations.json"),
      JSON.stringify({ one_shot: { [stem]: "historical population-bound repair" } }),
    );

    ok(checkOneShotReplayCommand(`psql -f supabase/migrations/${stem}.sql`, tmp), "psql original one-shot path is blocked");
    ok(checkOneShotReplayCommand("Get-Content renamed-copy.sql | psql", tmp), "renamed byte-identical one-shot file is blocked");
    ok(checkOneShotReplayCommand(`psql -c \"${sql}\"`, tmp), "pasted full one-shot body is blocked");
    ok(checkOneShotReplayCommand(`supabase sql --file supabase/migrations/${stem}.sql`, tmp), "Supabase CLI one-shot replay is blocked");
    ok(checkOneShotReplayCommand("supabase sql --file=renamed-copy.sql", tmp), "Supabase --file= byte-identical replay is blocked");
    ok(checkOneShotReplayCommand("psql --file=renamed-copy.sql", tmp), "psql --file= byte-identical replay is blocked");
    ok(checkOneShotReplayCommand("psql -f renamed-copy", tmp), "psql extensionless byte-identical replay is blocked");
    ok(checkOneShotReplayCommand("psql -frenamed-copy", tmp), "psql attached -f extensionless replay is blocked");
    ok(checkOneShotReplayCommand("psql --file=renamed-copy", tmp), "psql --file= extensionless replay is blocked");
    ok(checkOneShotReplayCommand("supabase sql --file renamed-copy", tmp), "Supabase extensionless replay is blocked");
    ok(checkOneShotReplayCommand("Get-Content renamed-copy | psql", tmp), "PowerShell extensionless pipeline replay is blocked");
    ok(checkOneShotReplayCommand("cat renamed-copy | psql", tmp), "Bash extensionless pipeline replay is blocked");
    ok(checkOneShotReplayCommand("psql < renamed-copy", tmp), "extensionless psql input redirection replay is blocked");
    eq(checkOneShotReplayCommand("psql -f read-only-query", tmp), null, "unrelated extensionless SQL file stays allowed");
    ok(
      checkOneShotReplayCommand("cd /tmp && psql -f renamed-copy.sql", tmp),
      "relative psql replay after Bash cd is blocked instead of resolving from the hook cwd",
    );
    ok(
      checkOneShotReplayCommand("Set-Location C:\\temp; psql --file=renamed-copy.sql", tmp),
      "relative psql replay after PowerShell Set-Location is blocked",
    );
    ok(
      checkOneShotReplayCommand(`supabase db query --linked --file supabase/migrations/${stem}.sql`, tmp),
      "Supabase db query one-shot replay is blocked",
    );
    ok(
      checkOneShotReplayCommand(`supabase db execute --file supabase/migrations/${stem}.sql`, tmp),
      "Supabase db execute one-shot replay is blocked",
    );
    eq(checkOneShotReplayCommand('psql -c "select 1"', tmp), null, "unrelated read-only psql command stays allowed");
    eq(
      checkOneShotReplayCommand('supabase db query --linked "select 1"', tmp),
      null,
      "unrelated read-only Supabase db query stays allowed",
    );

    writeFileSync(path.join(baselineDir, "one-shot-migrations.json"), "not json");
    ok(checkOneShotReplayCommand('psql -c "select 1"', tmp), "unreadable one-shot registry fails closed for database execution");
    ok(
      checkOneShotReplayCommand('supabase db query --linked "select 1"', tmp),
      "unreadable one-shot registry also fails closed for Supabase db query",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── LIVE: bash-safety.mjs itself — benign allowed, dangerous denied ────────
function runHook(payload) {
  return spawnSync(process.execPath, [path.join(__dirname, "bash-safety.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
}
let r = runHook({ tool_name: "Bash", tool_input: { command: "npm run build" } });
eq(r.status, 0, "bash-safety.mjs exits 0 on benign command");
ok(!r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs allows npm run build");

r = runHook({ tool_name: "Bash", tool_input: { command: "git push --force origin main" } });
eq(r.status, 0, "bash-safety.mjs exits 0 on dangerous command");
ok(r.stdout.includes('"permissionDecision":"deny"'), "bash-safety.mjs denies a force push");

r = runHook({
  tool_name: "PowerShell",
  tool_input: {
    command: "[IO.File]::WriteAllText('scripts/apply-live-testdata-maintenance-20260812.mjs','owned'); node scripts/apply-live-testdata-maintenance-20260812.mjs --verify",
  },
});
eq(r.status, 0, "bash-safety.mjs exits 0 after denying a chained producer rewrite");
ok(r.stdout.includes('"permissionDecision":"deny"'), "current shell guard denies the exact producer TOCTOU reproduction");

for (const command of [
  "git push origin feature/test --force",
  "git push --all origin --force",
  "git push origin --all --force",
  "git -C . push origin feature/test -uf",
  "git push origin +feature/test",
  "git push --all origin",
  "git push origin --branches",
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  eq(r.status, 0, `bash-safety exits 0 after denying: ${command}`);
  ok(r.stdout.includes('"permissionDecision":"deny"'), `bash-safety denies force/bulk push: ${command}`);
}

// ── Codex P1 round 3: valid npm option forms must still resolve script names ──
eq(extractNpmRunNames("npm run --silent dangerous")[0], "dangerous", "npm run --silent <name> resolves the name, not the flag");
eq(extractNpmRunNames("npm -s run dangerous")[0], "dangerous", "npm -s run <name> resolves");
eq(extractNpmRunNames("npm run-script dangerous")[0], "dangerous", "npm run-script alias resolves");
eq(extractNpmRunNames("npm --loglevel=silent run dangerous")[0], "dangerous", "npm --opt=value run <name> resolves");

// ── Codex P1 round 4: npm pre/post lifecycle scripts ride along ──────────────
{
  const scripts = { build: "vite build", prebuild: "git push --force origin main" };
  const chain = resolveNpmScriptChain(scripts, "build");
  ok(chain.includes("git push --force origin main"), "prebuild lifecycle script is resolved with npm run build");
}
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bashsafety-lifecycle-"));
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      scripts: { build: "echo building", postbuild: "git reset --hard HEAD~1" },
    }));
    ok(checkCommandDeep("npm run build", tmp), "dangerous POSTbuild lifecycle script is blocked");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Codex P2 round 4: tracked .env templates are exempt from the redirect ban ─
eq(checkDangerousCommand("node gen-template.js > .env.example"), null, "redirect to .env.example (template) allowed");
eq(checkDangerousCommand("cat base > .env.staging.example"), null, "redirect to .env.staging.example allowed");
ok(checkDangerousCommand("echo SECRET > .env.staging"), ".env.staging (real env) still blocked");

// ── Codex P2 2026-07-13: .env redirect with NO space after > must be caught ──
ok(checkDangerousCommand("echo SECRET>.env"), "no-space redirect to .env blocked");
ok(checkDangerousCommand("echo SECRET >.env"), "space-before-only redirect to .env blocked");
ok(checkDangerousCommand("echo SECRET>>.env.production"), "no-space append to .env.production blocked");
eq(checkDangerousCommand("echo hello > notes.txt"), null, "redirect to a non-.env file still allowed");
eq(checkDangerousCommand("dotenv -e .env.test -- npm run test"), null, "mentioning .env without a redirect still allowed");

// ── Codex P1 2026-07-13: npm-resolved script bodies must also hit the
//    migration-immutability check, not just the dangerous-command table ──────
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "bashsafety-npm-mig-"));
  try {
    mkdirSync(path.join(tmp, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(tmp, "supabase", "migrations", "20260101000000_existing.sql"), "select 1;\n");
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      scripts: { sneaky: "echo '-- tweak' >> supabase/migrations/20260101000000_existing.sql" },
    }));
    ok(checkCommandDeep("npm run sneaky", tmp), "npm script that appends to an EXISTING migration is blocked");
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      scripts: { fine: "echo ok > supabase/migrations/20990101000000_brand_new.sql" },
    }));
    eq(checkCommandDeep("npm run fine", tmp), null, "npm script writing a NEW (non-existent) migration file is allowed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`bash-safety: ${pass} assertions passed`);

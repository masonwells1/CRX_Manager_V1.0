#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(condition, message) { assert.ok(condition, message); pass++; }

function patchFor(filePath, content, toolName = "mcp__codex__apply_patch") {
  const added = content.split("\n").map((line) => `+${line}`).join("\n");
  return {
    tool_name: toolName,
    tool_input: {
      input: `*** Begin Patch\n*** Add File: ${filePath}\n${added}\n*** End Patch`,
    },
  };
}

function run(payload, projectDir = path.resolve(here, "..", "..")) {
  return spawnSync(process.execPath, [path.join(here, "patch-guard-fanout.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

function expectDeny(name, payload, token) {
  const result = run(payload);
  ok(result.status === 0, `${name}: fanout exits cleanly`);
  ok(result.stdout.includes('"permissionDecision":"deny"'), `${name}: bad patch is denied`);
  ok(result.stdout.includes(token), `${name}: denial names the owning guard`);
}

expectDeny(
  "sql-safety",
  patchFor("supabase/migrations/20990101000010_bad.sql", "SELECT pg_get_functiondef('public.is_admin()'::regprocedure);"),
  "SQL SAFETY VIOLATION"
);
expectDeny(
  "money-safety",
  patchFor("src/lib/bad-money.ts", "const amount = parseFloat(total_cents);"),
  "MONEY SAFETY"
);
expectDeny(
  "idempotency-body-check",
  patchFor(
    "supabase/migrations/20990101000011_bad.sql",
    "CREATE OR REPLACE FUNCTION public.bad_rpc(p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE customers SET name = 'x'; END; $$;"
  ),
  "IDEMPOTENCY VIOLATION"
);
expectDeny(
  "rls-on-new-tables",
  patchFor("supabase/migrations/20990101000012_bad.sql", "CREATE TABLE public.unprotected_data (id uuid PRIMARY KEY);"),
  "RLS VIOLATION"
);
expectDeny(
  "status-enum-check",
  patchFor("supabase/migrations/20990101000013_bad.sql", "UPDATE public.invoices SET status = 'void';"),
  "CHECK CONSTRAINT VIOLATION"
);
expectDeny(
  "generated-column-check",
  patchFor("supabase/migrations/20990101000014_bad.sql", "UPDATE public.invoices SET balance_cents = 0;"),
  "GENERATED COLUMN VIOLATION"
);
expectDeny(
  "env-guard",
  patchFor(".env.production", "SUPABASE_SERVICE_ROLE_KEY=secret"),
  "ENV GUARD"
);

const literalTool = run(patchFor("C:/repo/src/lib/bad-money.ts", "const amount = parseFloat(totalCents);", "apply_patch"));
ok(literalTool.stdout.includes('"permissionDecision":"deny"'), "literal apply_patch is covered");

for (const field of ["patch", "diff", "input", "changes"]) {
  const fixture = patchFor("src/lib/bad-money.ts", "const amount = parseFloat(totalCents);");
  const patchText = fixture.tool_input.input;
  fixture.tool_input = { [field]: patchText };
  ok(run(fixture).stdout.includes('"permissionDecision":"deny"'), `${field} payload field is covered`);
}

const multiFilePayload = {
  tool_name: "mcp__codex__apply_patch",
  tool_input: {
    input: `*** Begin Patch
*** Add File: docs/safe.md
+safe
*** Add File: .env.local
+SECRET=value
*** End Patch`,
  },
};
const multiFile = run(multiFilePayload);
ok(multiFile.stdout.includes('"permissionDecision":"deny"'), "unsafe second file in a multi-file patch is denied");
ok(multiFile.stdout.includes(".env.local"), "multi-file denial preserves the unsafe file path");

const safe = run(patchFor("docs/safe.md", "safe text"));
ok(safe.status === 0, "safe patch exits cleanly");
ok(safe.stdout.includes('"permissionDecision":"allow"'), "safe patch is allowed");

const tempRoot = mkdtempSync(path.join(tmpdir(), "crx-patch-fanout-"));
try {
  mkdirSync(path.join(tempRoot, "src", "lib"), { recursive: true });
  writeFileSync(
    path.join(tempRoot, "src", "lib", "existing.ts"),
    "const amount = Number(total_cents);\nexport { amount };\n"
  );
  const updatePayload = {
    tool_name: "mcp__codex__apply_patch",
    tool_input: {
      input: `*** Begin Patch
*** Update File: src/lib/existing.ts
@@
-const amount = Number(total_cents);
+const amount = parseFloat(total_cents);
 export { amount };
*** End Patch`,
    },
  };
  const update = run(updatePayload, tempRoot);
  ok(update.stdout.includes('"permissionDecision":"deny"'), "updated file is checked from its reconstructed postimage");
  ok(update.stdout.includes("MONEY SAFETY"), "update reconstruction reaches the owning guard");

  writeFileSync(path.join(tempRoot, ".env.example"), "SAFE=value\n");
  const movePayload = {
    tool_name: "apply_patch",
    tool_input: {
      input: `*** Begin Patch
*** Update File: .env.example
*** Move to: .env.local
*** End Patch`,
    },
  };
  const movedEnv = run(movePayload, tempRoot);
  ok(movedEnv.stdout.includes('"permissionDecision":"deny"'), "move into a protected env path is denied");
  ok(movedEnv.stdout.includes(".env.local"), "move denial names the protected destination");

  const missingRelevant = run({
    tool_name: "apply_patch",
    tool_input: {
      input: `*** Begin Patch
*** Update File: src/lib/missing.ts
@@
-old
+new
*** End Patch`,
    },
  }, tempRoot);
  ok(missingRelevant.stdout.includes('"permissionDecision":"deny"'), "unreconstructable safety-relevant update fails closed");
  ok(missingRelevant.stdout.includes("could not reconstruct"), "reconstruction failure is explicit");

  const missingScriptSql = run({
    tool_name: "apply_patch",
    tool_input: {
      input: `*** Begin Patch
*** Update File: scripts/missing.sql
@@
-old
+new
*** End Patch`,
    },
  }, tempRoot);
  ok(missingScriptSql.stdout.includes('"permissionDecision":"deny"'), "unreconstructable SQL outside migrations also fails closed");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

const largePatchSections = Array.from({ length: 31 }, (_, index) =>
  `*** Add File: src/lib/bounded-${index}.ts\n+export const value${index} = ${index};`
).join("\n");
const bounded = run({
  tool_name: "mcp__codex__apply_patch",
  tool_input: { input: `*** Begin Patch\n${largePatchSections}\n*** End Patch` },
});
ok(bounded.stdout.includes('"permissionDecision":"deny"'), "oversized safety fanout fails closed before timeout");
ok(bounded.stdout.includes("bounded limit"), "oversized denial explains how to split the patch");

for (const manifestPath of [".claude/settings.json", ".codex/hooks.json"]) {
  const manifest = JSON.parse(readFileSync(path.join(path.resolve(here, "..", ".."), manifestPath), "utf8"));
  const prePatch = manifest.hooks.PreToolUse.find(({ matcher }) => matcher === "(^|__)apply_patch$");
  const postPatch = manifest.hooks.PostToolUse.find(({ matcher }) => matcher === "(^|__)apply_patch$");
  ok(
    prePatch?.hooks?.some(({ command, commandWindows }) =>
      `${command || ""} ${commandWindows || ""}`.includes("patch-guard-fanout.mjs")
    ),
    `${manifestPath}: pre-patch fanout is wired`
  );
  ok(
    postPatch?.hooks?.some(({ command, commandWindows }) =>
      `${command || ""} ${commandWindows || ""}`.includes("patch-posttool-fanout.mjs")
    ),
    `${manifestPath}: post-patch fanout is wired`
  );
}

console.log(`patch-guard-fanout: ${pass} assertions passed`);
